/**
 * The byte layer: what a kore-rpc connection is, as an interface, and the TCP
 * implementation of it.
 *
 * Transcribed from pyk's `SingleSocketTransport`
 * (`k/pyk/src/pyk/kore/rpc.py:110-168`) against the server's own framing
 * contract (`haskell-backend/kore-rpc-types/src/Kore/JsonRpc/Server.hs:91-98`
 * for the response framing, `:112-134` for what a `cancel` does to the request
 * already in flight).
 *
 * # The framing, in one paragraph
 *
 * Requests need no delimiter — the server decodes them with a streaming JSON
 * parser that skips whitespace — so pyk sends the bare bytes. Responses are
 * the asymmetric half: `confIndent = Spaces 0, confTrailingNewline = True`
 * means **one single-line JSON document per response, `\n`-terminated**, and
 * nothing else on the socket. One line in, one response out.
 *
 * # Deliberate deviations from pyk, and why
 *
 * 1. **A trailing `\n` after every request.** pyk writes `req.encode()` and
 *    nothing more (`rpc.py:162`). We append the terminator, which the server's
 *    parser skips as whitespace and which makes the request stream
 *    self-describing: a captured session is line-per-message in both
 *    directions, a mock server can split requests the same way it splits
 *    responses, and the `\n`-prefixed cancel (below) cannot glue itself
 *    onto a half-written request.
 * 2. **Connecting is a separate, awaitable step.** pyk connects inside
 *    `__init__` (`rpc.py:118-127`), which JavaScript cannot do: a constructor
 *    cannot be awaited, so a constructor that connects either blocks (it
 *    cannot) or hands back a half-live object whose first `request` has to
 *    join the connect. Hence {@link tcpTransport} / {@link TcpTransport.connect}
 *    — async factories returning an already-connected transport. The retry
 *    policy inside them is pyk's, unchanged.
 * 3. **`interrupt` writes a trailing newline too**, for the same reason as (1).
 *    The *leading* newline is pyk's and is load-bearing: it terminates
 *    whatever partial request may already be on the stream so the cancel
 *    parses as its own document (`rpc.py:155-159`).
 * 4. **Failures are typed.** pyk raises bare `RuntimeError`s; a caller that
 *    wants to distinguish "the server went away" from "I closed it" needs more
 *    than a message. {@link TransportError} and {@link TransportClosedError}.
 * 5. **A cancel that gets answered is absorbed.** pyk assumes no server ever
 *    replies to a `cancel` (`rpc.py:155-159`: "don't read the reply"), and on
 *    the real `kore-rpc` server it does not. Two other servers in the same tree
 *    do: `kore-rpc-dev` (`dev-tools/kore-rpc-dev/Server.hs:113`) and the
 *    booster proxy (`booster/tools/booster/Proxy.hs:340`) both answer with
 *    `-32601 Cancel not supported`, addressed to the **cancel's** id. Under
 *    pyk's assumption that line is handed to the pending request and every
 *    later response is one off forever. {@link TcpTransport.interrupt}
 *    therefore remembers the ids it cancelled with and
 *    {@link TcpTransport} drops a response line addressed to one of them —
 *    see {@link TcpTransport.onLine} for the bound that keeps this from
 *    costing anything on the multi-megabyte lines that matter.
 *
 * # One request at a time, and no timeout
 *
 * The server runs a single worker thread per socket (`Server.hs:178-183`), so
 * a connection is strictly single-flight and this transport serializes
 * internally: concurrent {@link Transport.request} calls queue, and the second
 * request's bytes are not written until the first response line has been read.
 * **Parallelism means more transports**, sized server-side by `GHCRTS=-N<n>`.
 * There is no id→promise pipelining map here because there is nothing to
 * pipeline.
 *
 * There is no request timeout either — the protocol has none. A caller that
 * wants one races the promise and calls `interrupt()`, which is exactly what
 * pyk does.
 */

import { Buffer } from "node:buffer";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

//////////////////////
// The seam         //
//////////////////////

/**
 * One kore-rpc connection, reduced to the three things a client needs.
 *
 * Payloads are **already-serialized JSON text**, in both directions: the
 * transport neither builds nor parses a request, which is what keeps the whole
 * codec half of this package testable with no sockets and usable from a
 * runtime that brings its own I/O (a browser over a WebSocket bridge, a Deno
 * `Deno.connect`, an in-memory double). {@link TcpTransport} is the real one.
 *
 * Implementations must honour three rules:
 *
 * - `request` resolves with **exactly one** response line, with no trailing
 *   newline, or rejects. It never resolves with an empty string.
 * - Calls are serialized. A second `request` may be issued before the first
 *   settles, and must not reach the wire until the first has.
 * - `interrupt` returns immediately and never waits for a reply, because a
 *   `cancel` has none. The in-flight `request` is what settles — normally by
 *   rejecting with the server's `-32000`.
 */
export interface Transport {
  /** Send one request; resolve with its one response line (no trailing `\n`). */
  request(payload: string): Promise<string>;

  /**
   * Write a `cancel` onto the live connection without awaiting anything.
   *
   * A no-op once the transport is closed or has failed: cancelling a
   * connection that is already gone is not an error, it is redundant.
   */
  interrupt(payload: string): void;

  /** Release the connection. Any in-flight `request` rejects. */
  close(): void;
}

//////////////////////
// Failures         //
//////////////////////

/**
 * Anything that went wrong at the byte layer, as opposed to in the protocol.
 *
 * The underlying `Error` — a socket's `ECONNRESET`, say — is attached as
 * `cause`; `Error`'s two-argument constructor is inherited unchanged.
 */
export class TransportError extends Error {
  override readonly name: string = "TransportError";
}

/**
 * The transport was closed — by {@link Transport.close}, or because the peer
 * hung up.
 *
 * Separate from {@link TransportError} because it is the one failure a caller
 * may well have caused on purpose: a pending `execute` rejecting with this
 * after a shutdown is orderly, while a pending `execute` rejecting with a
 * plain {@link TransportError} means the server died mid-answer.
 */
export class TransportClosedError extends TransportError {
  override readonly name = "TransportClosedError";
}

//////////////////////
// Framing          //
//////////////////////

/**
 * What every request is terminated with — see deviation (1) in the header.
 *
 * The server's `receiveBatchRequest` feeds a streaming `json` decoder, which
 * treats inter-document whitespace as separator, so this byte is invisible to
 * it and structural to everyone else.
 */
const REQUEST_TERMINATOR = "\n";

/** `\n` as a byte, for scanning a `Buffer` without decoding it first. */
const NEWLINE_BYTE = 0x0a;

/** pyk's `sleep(0.1)` between connection attempts (`rpc.py:147`). */
const RETRY_INTERVAL_MS = 100;

/**
 * The longest a response line may be and still be *considered* as a possible
 * answer to a `cancel` — see deviation (5).
 *
 * The heuristic, stated plainly: a cancel answer is a tiny error object
 * (`{"jsonrpc":"2.0","id":"…","error":{"code":-32601,"message":"Cancel not
 * supported"}}` is under 100 bytes, and there is no shape of it that approaches
 * this bound), whereas a real `execute` result is a multi-megabyte
 * configuration. Parsing every line twice to find the id would double the cost
 * of the one thing this transport is built to stream cheaply; parsing only
 * lines below this bound, and only while a cancel is actually outstanding,
 * costs nothing measurable and cannot miss a cancel answer any real server
 * emits.
 */
const CANCEL_ANSWER_MAX_CHARS = 4096;

//////////////////////
// Connecting       //
//////////////////////

/** Options for {@link tcpTransport}. */
export interface TcpTransportOptions {
  /**
   * How long to keep retrying a refused connection, in **milliseconds**.
   *
   * pyk's parameter is called `timeout` and is documented as seconds nowhere;
   * `rpc.py:136` builds `timedelta(milliseconds=timeout)` from it, so
   * milliseconds it is. Omitted means retry forever (pyk's `None`); negative
   * is a programming error and throws {@link RangeError} synchronously.
   */
  readonly timeout?: number;

  /**
   * The largest a single response line may get before the transport gives up,
   * in **bytes**. Opt-in: omitted means uncapped.
   *
   * **Uncapped is the correct default against a real kore-rpc server**, and
   * not merely the lenient one. A response is one configuration on one line
   * and a real EVM configuration runs to megabytes with no upper bound the
   * protocol states, so any number chosen here would be a number at which this
   * client starts failing on *valid* answers — and it would fail on the big
   * proofs, i.e. the ones a caller cares most about. There is no framing
   * header to size the buffer from either (`Server.hs:91-98` is a newline and
   * nothing else), so a cap cannot be derived; it can only be guessed.
   *
   * Set it when the peer is **not** trusted to be a kore-rpc server — a proxy,
   * a fuzzer, a fixture replayer, anything reachable from outside — where an
   * endless line is a denial of service against this process's heap rather
   * than a big proof. Enforcement is mid-line: the transport fails as soon as
   * the bytes buffered pass the cap, without waiting for a newline that may
   * never arrive.
   *
   * A value that is not a positive integer is a programming error and throws
   * {@link RangeError} synchronously.
   */
  readonly maxLineBytes?: number;
}

/** Whether a failed `connect` was a refusal, the one error pyk retries on. */
function isConnectionRefused(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ECONNREFUSED";
}

/** One connection attempt, as a promise. */
function connectOnce(host: string, port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const onConnect = (): void => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    const onError = (error: Error): void => {
      socket.removeListener("connect", onConnect);
      socket.destroy();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

/**
 * pyk's `_create_connection` (`rpc.py:130-149`), retry policy included.
 *
 * The deadline is checked *before* each attempt, not after, which is what
 * makes `timeout: 0` fail without ever opening a socket — pyk's `while
 * datetime.now() < timeout_datetime` has the same shape and the same
 * consequence.
 */
async function connectWithRetry(host: string, port: number, timeout: number | undefined): Promise<Socket> {
  const deadline = timeout === undefined ? undefined : Date.now() + timeout;
  for (;;) {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new TransportError(`Connection timed out: ${host}:${port}`);
    }
    try {
      return await connectOnce(host, port);
    } catch (error) {
      if (!isConnectionRefused(error)) throw error;
      await delay(RETRY_INTERVAL_MS);
    }
  }
}

//////////////////////
// The TCP transport//
//////////////////////

/** The settled halves of the one request that may be in flight. */
interface Pending {
  readonly resolve: (line: string) => void;
  readonly reject: (error: Error) => void;
}

/**
 * A kore-rpc connection over `node:net` — pyk's `SingleSocketTransport`.
 *
 * Construct it with {@link tcpTransport} or {@link TcpTransport.connect}; the
 * constructor is private because a `TcpTransport` holding an unconnected
 * socket is not a thing this class can represent.
 *
 * # Reading
 *
 * Responses arrive as an **uncapped** line stream by default. A real EVM
 * configuration is a multi-megabyte single line, so nothing here imposes a
 * maximum of its own: no `readline` utility with a `maxBuffer`, no cap on the
 * pending-chunk list. The splitter works on `Buffer`s and only decodes UTF-8
 * once a whole line is in hand, which is also what makes a multi-byte
 * character split across two TCP segments a non-event — `0x0a` never occurs
 * inside a UTF-8 continuation byte, so a line boundary is always a character
 * boundary.
 *
 * A caller who does not trust the peer to be a kore-rpc server can opt into
 * one with {@link TcpTransportOptions.maxLineBytes}; that option's
 * documentation is also the argument for why the default is no cap at all.
 *
 * # Poisoning
 *
 * A socket error, an unexpected EOF, an empty response line or a
 * {@link close} all put the transport in a failed state permanently: the
 * in-flight request rejects, and every later request rejects with the same
 * error rather than hanging on a dead socket. There is no reconnection — see
 * `client.ts`'s header for why one would be actively harmful.
 */
export class TcpTransport implements Transport {
  private readonly socket: Socket;

  /** `host:port`, for messages — pyk's `_description` (`rpc.py:167-168`). */
  private readonly peer: string;

  /** Whole `Buffer` segments of the response line being assembled. */
  private readonly chunks: Buffer[] = [];

  private pending: Pending | undefined;

  /** Set once, on the first failure; every later call rejects with it. */
  private failure: Error | undefined;

  /**
   * The ids of every `cancel` written on this connection — deviation (5).
   *
   * Nothing is ever removed except by an answer arriving, and the normal case
   * is that no answer ever arrives, so ids accumulate for the life of the
   * transport. That is deliberate and harmless: an id is a short string, a
   * `cancel` is a rare event driven by a caller's timeout, and the alternative
   * — expiring entries — would reintroduce exactly the desynchronization this
   * set exists to prevent, on a server that answered slowly.
   */
  private readonly outstandingCancels = new Set<string | number>();

  /** Tail of the single-flight queue — see the header. */
  private queue: Promise<void> = Promise.resolve();

  /** The opt-in line cap, in bytes; `undefined` is uncapped and is the default. */
  private readonly maxLineBytes: number | undefined;

  private constructor(socket: Socket, peer: string, maxLineBytes: number | undefined) {
    this.socket = socket;
    this.peer = peer;
    this.maxLineBytes = maxLineBytes;
    socket.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on("error", (error: Error) => {
      this.fail(new TransportError(`Socket error on ${peer}: ${error.message}`, { cause: error }));
    });
    socket.on("close", () => {
      this.fail(new TransportClosedError(`Connection to ${peer} closed`));
    });
  }

  /**
   * Connect, retrying a refused connection every 100 ms until `timeout`
   * milliseconds have elapsed.
   *
   * @throws {RangeError} synchronously, before any I/O, if `timeout` is
   *   negative — pyk's `ValueError` (`rpc.py:131-132`) — or if `maxLineBytes`
   *   is anything but a positive integer.
   */
  static connect(host: string, port: number, options: TcpTransportOptions = {}): Promise<TcpTransport> {
    const { timeout, maxLineBytes } = options;
    if (timeout !== undefined && timeout < 0) {
      throw new RangeError(`Expected a non-negative timeout in milliseconds, got: ${timeout}`);
    }
    // A cap of zero, a fraction or a NaN is never what a caller meant, and
    // each would silently turn every response into a failure; validated here
    // rather than in the data path so it lands on the call that got it wrong.
    if (maxLineBytes !== undefined && (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0)) {
      throw new RangeError(`Expected a positive integer maxLineBytes, got: ${maxLineBytes}`);
    }
    return connectWithRetry(host, port, timeout).then(
      (socket) => new TcpTransport(socket, `${host}:${port}`, maxLineBytes),
    );
  }

  /**
   * How many bytes of a partial response line are buffered.
   *
   * Diagnostics, and the quantity {@link TcpTransportOptions.maxLineBytes} is
   * checked against — which is why the loop only ever runs with a cap set.
   */
  get bufferedBytes(): number {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    return total;
  }

  async request(payload: string): Promise<string> {
    // A promise-chain mutex: each call takes the previous call's release
    // promise as its gate and publishes its own before awaiting, so the order
    // requests reach the socket is the order `request` was called in.
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await this.send(payload);
    } finally {
      release();
    }
  }

  /**
   * Write a `cancel` onto the socket alongside the request already in flight —
   * pyk's `send_interrupt` (`rpc.py:155-159`).
   *
   * Nothing is read for it. The pending {@link request} is what settles, with
   * whatever the server decides to answer the *interrupted* request with,
   * which is normally the `-32000 Request cancelled` error object
   * (`Server.hs:134`). The connection stays usable afterwards; that is the
   * whole point of the side channel.
   *
   * The payload is parsed here — it is a tiny object this package built, not
   * server output — so that a server which *does* answer the cancel can be
   * told apart from one that does not; see deviation (5). A payload with no
   * readable `id` records nothing, which costs only the absorption.
   */
  interrupt(payload: string): void {
    if (this.failure !== undefined) return;
    this.rememberCancelId(payload);
    this.socket.write(`${REQUEST_TERMINATOR}${payload}${REQUEST_TERMINATOR}`);
  }

  close(): void {
    this.fail(new TransportClosedError(`Transport to ${this.peer} is closed`));
  }

  //////////////////////
  // Internals        //
  //////////////////////

  private send(payload: string): Promise<string> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.socket.write(`${payload}${REQUEST_TERMINATOR}`, (error) => {
        if (error) {
          this.fail(new TransportError(`Failed to send to ${this.peer}: ${error.message}`, { cause: error }));
        }
      });
    });
  }

  /**
   * Split one TCP segment into response lines.
   *
   * The single-chunk fast path matters: the common case is a whole response in
   * one segment, and taking it avoids both an array push and a `Buffer.concat`
   * copy of a payload that may be megabytes.
   */
  private onData(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(NEWLINE_BYTE, start);
      if (newline < 0) {
        // The cap is checked *here*, on a line that has no terminator yet, and
        // not only where a line completes: a peer that never sends a newline
        // is precisely the case the option exists for.
        if (start < chunk.length) {
          if (this.overLineCap(chunk.length - start)) return;
          this.chunks.push(chunk.subarray(start));
        }
        return;
      }
      if (this.overLineCap(newline - start)) return;

      let line: string;
      if (this.chunks.length === 0) {
        line = chunk.toString("utf8", start, newline);
      } else {
        this.chunks.push(chunk.subarray(start, newline));
        line = Buffer.concat(this.chunks).toString("utf8");
        this.chunks.length = 0;
      }

      start = newline + 1;
      this.onLine(line);
      if (this.failure !== undefined) return;
    }
  }

  /**
   * Whether `bytes` more of the line under assembly breaks
   * {@link TcpTransportOptions.maxLineBytes} — and, if so, poisons the
   * transport.
   *
   * The `undefined` check comes first and is the whole of the uncapped fast
   * path: with no cap there is no summation, no allocation and no branch
   * beyond this one, which is what keeps a multi-megabyte configuration as
   * cheap as it was before the option existed.
   *
   * `bytes` is what the current segment contributes, so the total is what is
   * already buffered plus that — an amount known before the line is decoded,
   * concatenated or even completed.
   */
  private overLineCap(bytes: number): boolean {
    const cap = this.maxLineBytes;
    if (cap === undefined) return false;
    const total = this.bufferedBytes + bytes;
    if (total <= cap) return false;
    this.fail(
      new TransportError(`Response line from ${this.peer} exceeds maxLineBytes (${cap}): ${total} bytes buffered`),
    );
    return true;
  }

  /**
   * One complete response line.
   *
   * The trailing `\r` strip is pyk's `readline().rstrip()` (`rpc.py:165`)
   * narrowed to the only whitespace a server could plausibly emit; the
   * emptiness check is pyk's `if not resp` (`rpc.py:379-380`), and it is
   * **fatal** rather than a rejected request — a server that put a bare
   * newline on the wire is not one whose next line can be trusted to belong to
   * the next request.
   */
  private onLine(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (line.trim().length === 0) {
      this.fail(new TransportError(`Empty response received from ${this.peer}`));
      return;
    }

    // Deviation (5): a line answering a `cancel` belongs to nobody. Drop it
    // before it can be mistaken for the pending request's answer — or, with
    // nothing pending, for an unsolicited line worth poisoning the connection
    // over.
    if (this.absorbCancelAnswer(line)) return;

    const pending = this.pending;
    if (pending === undefined) {
      this.fail(new TransportError(`Unsolicited response line from ${this.peer}`));
      return;
    }

    this.pending = undefined;
    pending.resolve(line);
  }

  /**
   * Record the id of a `cancel` we are about to write, if it has one.
   *
   * A parse failure or a non-scalar id is not an error: it only means this
   * cancel's answer, should one come, cannot be recognized — which is exactly
   * the behaviour before deviation (5) existed.
   */
  private rememberCancelId(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const id = (parsed as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") this.outstandingCancels.add(id);
  }

  /**
   * Whether this line is the answer to a `cancel`, and was therefore dropped.
   *
   * Two guards keep this off the hot path: the set is empty unless a `cancel`
   * was written on this connection, and the line must be shorter than
   * {@link CANCEL_ANSWER_MAX_CHARS} — see that constant for why the bound is
   * safe.
   */
  private absorbCancelAnswer(line: string): boolean {
    if (this.outstandingCancels.size === 0 || line.length >= CANCEL_ANSWER_MAX_CHARS) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const id = (parsed as { id?: unknown }).id;
    if (typeof id !== "string" && typeof id !== "number") return false;
    if (!this.outstandingCancels.has(id)) return false;
    this.outstandingCancels.delete(id);
    return true;
  }

  /** Reject whatever is in flight and poison the transport, idempotently. */
  private fail(error: Error): void {
    this.failure ??= error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(this.failure);
    this.chunks.length = 0;
    this.socket.destroy();
  }
}

/**
 * Connect a {@link TcpTransport}.
 *
 * @throws {RangeError} synchronously if `options.timeout` is negative, or if
 *   `options.maxLineBytes` is not a positive integer.
 */
export function tcpTransport(host: string, port: number, options: TcpTransportOptions = {}): Promise<TcpTransport> {
  return TcpTransport.connect(host, port, options);
}
