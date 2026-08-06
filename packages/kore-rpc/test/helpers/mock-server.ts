/**
 * A scriptable TCP server that speaks the kore-rpc framing — the test double
 * behind `transport.test.ts` and `client.test.ts`.
 *
 * It is deliberately *not* a kore-rpc implementation. It knows three things:
 * that requests arrive `\n`-terminated (which is our transport's framing, not
 * the protocol's — the real server needs no delimiter), that a `cancel` may
 * arrive out of band while a request is still being answered, and that a
 * response is one line plus `\n`. Everything else is scripted, byte for byte,
 * by the caller.
 *
 * # The script
 *
 * An ordered list of {@link MockStep}s, one per *payload* request; `cancel`
 * notifications do not consume a step. Each step can assert on the request it
 * received, delay before answering, answer with fixed text or with a function
 * of the request, write raw bytes instead of a framed line, dribble its
 * response out in small chunks, and declare what to answer with if a `cancel`
 * arrives while it is still pending.
 *
 * # Connections
 *
 * Each connection gets its own cursor into the *same* script, starting at step
 * 0 — the simplest thing that supports the one multi-connection case the tests
 * need (two transports, same canned answers). Requests are recorded globally,
 * in arrival order, across all connections. Steps of one connection run
 * strictly one after another: a step's `delayMs` gates the *next* request's
 * step too, so a script never interleaves with itself.
 *
 * # Cancels
 *
 * Two independent knobs, because two different servers behave two different
 * ways and both are real:
 *
 * - {@link MockStep.onCancel} answers the **interrupted request's** id — the
 *   documented `Server.hs:112-134` behaviour, where the cancel itself is never
 *   answered.
 * - {@link MockServerOptions.onStrayCancel} answers the **cancel's own** id,
 *   as its own line — what `kore-rpc-dev`'s `Server.hs:113` and booster's
 *   `Proxy.hs:340` do (`-32601 Cancel not supported`).
 *
 * They compose: a server may do both, in which case the cancel answer goes out
 * first (it is written the moment the notification arrives) and the pending
 * step's `onCancel` follows.
 *
 * # Assertion failures
 *
 * A throw from a step's `expect` cannot be propagated to the test — it happens
 * on a socket callback, with no `await` above it — so it is recorded in
 * {@link MockServer.errors} and re-thrown by {@link MockServer.check}. Call
 * `check()` before the end of any test whose steps assert. The step still
 * answers, so the client under test does not hang on a failed assertion.
 */

import { Buffer } from "node:buffer";
import { createServer, type Server, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { isJsonRecord } from "./assert.ts";

/** A parsed request line, or the raw text if it was not JSON. */
export type MockRequest = Record<string, unknown>;

/** One scripted request→response exchange. */
export interface MockStep {
  /**
   * Assert on the request. A throw is recorded in {@link MockServer.errors}
   * rather than propagated — see the header.
   */
  readonly expect?: (request: MockRequest) => void;

  /** The response line, or a function of the request producing it. */
  readonly respond: string | ((request: MockRequest) => string);

  /** How long to wait before answering. The window a `cancel` can land in. */
  readonly delayMs?: number;

  /**
   * Write {@link respond} verbatim, with no `\n` appended.
   *
   * The only way to produce the byte streams a well-behaved server never
   * would: an empty line, a truncated document, two responses at once.
   */
  readonly raw?: boolean;

  /** Split the response across TCP segments of this many bytes. */
  readonly chunkSize?: number;

  /** How long to wait between chunks — forces them into separate segments. */
  readonly chunkDelayMs?: number;

  /**
   * What to answer the *pending* request with if a `cancel` arrives while this
   * step is still waiting out its `delayMs`.
   *
   * This is the real server's behaviour (`Server.hs:112-134`): the cancel
   * itself is never answered, the in-flight request is answered with
   * `-32000 Request cancelled` instead, and the connection stays open. Without
   * this field a `cancel` is recorded and otherwise ignored.
   */
  readonly onCancel?: string;
}

/** Server-wide options — see the header's "Cancels" section. */
export interface MockServerOptions {
  /**
   * Answer every `cancel` notification with a line of its own, addressed to the
   * **cancel's** id.
   *
   * A string is the whole response line; a function receives the parsed cancel
   * request, so a test can echo its id. Omitted, a cancel is answered by
   * nothing, which is what the real `kore-rpc` server does.
   */
  readonly onStrayCancel?: string | ((cancel: MockRequest) => string);
}

/** Per-connection state: where in the script it is, and what it owes. */
interface Connection {
  readonly socket: Socket;
  index: number;
  buffer: Buffer;
  /** Resolves early when a `cancel` lands during a delayed step. */
  cancelled: (() => void) | undefined;
  wasCancelled: boolean;
  /** Tail of this connection's step chain, so steps never interleave. */
  steps: Promise<void>;
}

/**
 * `-32000 Request cancelled` for a given id — the exact object
 * `Server.hs:134`'s `cancelError` produces, as a response line.
 */
export function cancelledResponse(id: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message: "Request cancelled", data: null },
  });
}

/**
 * `-32601 Cancel not supported` for a given id — what `kore-rpc-dev`
 * (`dev-tools/kore-rpc-dev/Server.hs:113`) and the booster proxy
 * (`booster/tools/booster/Proxy.hs:340`) answer a `cancel` with, as a response
 * line. Note the id is the **cancel's**, not the interrupted request's.
 */
export function cancelNotSupportedResponse(id: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: { code: -32601, message: "Cancel not supported" },
  });
}

/** A scriptable kore-rpc-shaped TCP server. See the module header. */
export class MockServer {
  private readonly server: Server;
  private readonly script: readonly MockStep[];
  private readonly options: MockServerOptions;
  private readonly connections = new Set<Connection>();

  /** Every request line received, parsed, in arrival order across connections. */
  readonly received: MockRequest[] = [];

  /** Assertion failures from step `expect`s — re-thrown by {@link check}. */
  readonly errors: Error[] = [];

  /** The ephemeral port the server is listening on. */
  readonly port: number;

  private constructor(server: Server, script: readonly MockStep[], port: number, options: MockServerOptions) {
    this.server = server;
    this.script = script;
    this.port = port;
    this.options = options;
    server.on("connection", (socket) => {
      this.onConnection(socket);
    });
  }

  /** Listen on an ephemeral port on the loopback interface. */
  static async start(script: readonly MockStep[], options: MockServerOptions = {}): Promise<MockServer> {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Expected an IP address from a TCP server"));
          return;
        }
        resolve(address.port);
      });
    });
    return new MockServer(server, script, port, options);
  }

  /** Re-throw the first recorded assertion failure, if any. */
  check(): void {
    const first = this.errors[0];
    if (first !== undefined) throw first;
  }

  /** Destroy every connection and stop listening. */
  async close(): Promise<void> {
    for (const connection of this.connections) connection.socket.destroy();
    this.connections.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  //////////////////////
  // Internals        //
  //////////////////////

  private onConnection(socket: Socket): void {
    const connection: Connection = {
      socket,
      index: 0,
      buffer: Buffer.alloc(0),
      cancelled: undefined,
      wasCancelled: false,
      steps: Promise.resolve(),
    };
    this.connections.add(connection);

    socket.on("data", (chunk: Buffer) => {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      for (;;) {
        const newline = connection.buffer.indexOf(0x0a);
        if (newline < 0) return;
        const line = connection.buffer.toString("utf8", 0, newline);
        connection.buffer = connection.buffer.subarray(newline + 1);
        // Our transport prefixes a cancel with `\n`, so blank lines are
        // expected on this side and are not the protocol error they are on the
        // response side.
        if (line.trim().length > 0) this.onLine(connection, line);
      }
    });
    socket.on("error", () => {
      // A client that destroys its socket mid-response is a case under test.
    });
    socket.on("close", () => {
      this.connections.delete(connection);
    });
  }

  private onLine(connection: Connection, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.errors.push(new Error(`Mock server received a non-JSON line: ${line}`, { cause: error }));
      return;
    }
    if (!isJsonRecord(parsed)) {
      this.errors.push(new Error(`Mock server received a non-object request: ${line}`));
      return;
    }
    const request: MockRequest = parsed;
    this.received.push(request);

    if (request["method"] === "cancel") {
      connection.wasCancelled = true;
      const { onStrayCancel } = this.options;
      if (onStrayCancel !== undefined && !connection.socket.destroyed) {
        // Its own line, addressed to the cancel's id, written immediately —
        // before whatever the interrupted request is eventually answered with.
        const body = typeof onStrayCancel === "function" ? onStrayCancel(request) : onStrayCancel;
        connection.socket.write(`${body}\n`);
      }
      connection.cancelled?.();
      return;
    }

    // Chained rather than fire-and-forget: two requests arriving before the
    // first step's `delayMs` elapsed must still be answered in order.
    connection.steps = connection.steps.then(async () => {
      try {
        await this.runStep(connection, request);
      } catch (error) {
        this.errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async runStep(connection: Connection, request: MockRequest): Promise<void> {
    const step = this.script[connection.index];
    if (step === undefined) {
      this.errors.push(new Error(`Mock server ran out of script at request ${connection.index + 1}`));
      return;
    }
    connection.index += 1;
    connection.wasCancelled = false;

    try {
      step.expect?.(request);
    } catch (error) {
      this.errors.push(error instanceof Error ? error : new Error(String(error)));
    }

    if (step.delayMs !== undefined && step.delayMs > 0) {
      await Promise.race([
        delay(step.delayMs),
        new Promise<void>((resolve) => {
          connection.cancelled = resolve;
        }),
      ]);
      connection.cancelled = undefined;
    }

    if (connection.socket.destroyed) return;

    if (connection.wasCancelled && step.onCancel !== undefined) {
      this.write(connection.socket, step.onCancel, step);
      return;
    }

    this.write(connection.socket, typeof step.respond === "function" ? step.respond(request) : step.respond, step);
  }

  private write(socket: Socket, body: string, step: MockStep): void {
    const text = step.raw === true ? body : `${body}\n`;
    if (step.chunkSize === undefined) {
      socket.write(text);
      return;
    }
    void this.writeChunked(socket, text, step.chunkSize, step.chunkDelayMs ?? 1);
  }

  private async writeChunked(socket: Socket, text: string, size: number, gapMs: number): Promise<void> {
    const bytes = Buffer.from(text, "utf8");
    for (let offset = 0; offset < bytes.length; offset += size) {
      if (socket.destroyed) return;
      socket.write(bytes.subarray(offset, offset + size));
      await delay(gapMs);
    }
  }
}
