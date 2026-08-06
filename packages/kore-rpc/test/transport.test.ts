/**
 * The transport suite — the byte layer, over real loopback TCP sockets.
 *
 * Nothing here parses a kore-rpc message; `TcpTransport` does not know what a
 * request is. What is under test is the seven properties `src/transport.ts`
 * claims: the framing (a trailing `\n` on requests, one `\n`-terminated line
 * per response), the uncapped line splitter, reassembly across TCP segments,
 * the empty line as a fatal error, pyk's connect-retry policy, strict
 * single-flight serialization, and what a `close` does to a pending request.
 *
 * The one thing a mock cannot prove is that a *real* kore-rpc server accepts a
 * newline-terminated request; the argument is the server's own read path
 * (`Server.hs:78-103`, a streaming JSON decoder over the socket, for which the
 * terminator is inter-document whitespace), and `cat req.json | nc` is the
 * reproduction.
 */

import { Buffer } from "node:buffer";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";
import { TcpTransport, TransportClosedError, TransportError, tcpTransport } from "../src/index.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defined, jsonRecord, jsonString, parseJsonRecord, rejection } from "./helpers/assert.ts";
import { type MockStep, MockServer, cancelNotSupportedResponse } from "./helpers/mock-server.ts";

//////////////////////////
// Fixtures and helpers //
//////////////////////////

/**
 * The hand-authored byte streams a conforming server never produces —
 * `test/data/malformed-responses.json`, whose README records that they are ours
 * and not vendored. Keeping them in a file rather than inline makes the set
 * enumerable: what the transport is expected to survive is a list, and it is
 * that list.
 */
const MALFORMED = parseJsonRecord(
  readFileSync(join(import.meta.dir, "data", "malformed-responses.json"), "utf8"),
  "malformed-responses.json",
);

/** One named case's raw bytes. */
function malformed(name: string): string {
  const cases = MALFORMED["cases"];
  if (!Array.isArray(cases)) throw new TypeError("Expected `cases` to be an array");
  const found = cases.map((entry) => jsonRecord(entry, "case")).find((entry) => jsonString(entry, "name") === name);
  return jsonString(defined(found, `the ${name} case`), "bytes");
}

/** Every server a test started, closed after it whatever happened. */
const running: MockServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
});

async function mock(...script: MockStep[]): Promise<MockServer> {
  const server = await MockServer.start(script);
  running.push(server);
  return server;
}

/** A transport pointed at a mock, registered for teardown by its own test. */
function connectTo(server: MockServer): Promise<TcpTransport> {
  return tcpTransport("127.0.0.1", server.port);
}

/** A port nothing is listening on: bind an ephemeral one, then give it up. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address !== null && typeof address !== "string" ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

//////////////////////////
// Framing              //
//////////////////////////

describe("framing", () => {
  test("round-trips a request and its response line", async () => {
    const server = await mock({
      expect: (request) => {
        expect(request["method"]).toBe("execute");
      },
      respond: '{"jsonrpc":"2.0","id":"a-001","result":{"ok":true}}',
    });
    const transport = await connectTo(server);

    try {
      const response = await transport.request('{"jsonrpc":"2.0","id":"a-001","method":"execute","params":{}}');
      // The terminator belongs to the framing, not to the payload.
      expect(response).toBe('{"jsonrpc":"2.0","id":"a-001","result":{"ok":true}}');
      expect(response.endsWith("\n")).toBe(false);
      server.check();
    } finally {
      transport.close();
    }
  });

  test("terminates the request bytes with a newline, and the cancel on both sides", async () => {
    // Byte-level, so a raw listener rather than the mock: this is the one
    // assertion about what leaves the socket, and it is the deviation from
    // pyk (`rpc.py:151` sends the bare bytes) that the header argues for.
    const chunks: Buffer[] = [];
    let client!: Socket;
    const server = createServer((socket) => {
      client = socket;
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).toString().includes("cancel")) {
          socket.write('{"jsonrpc":"2.0","id":"a-001","error":{"code":-32000,"message":"Request cancelled"}}\n');
        }
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(address !== null && typeof address !== "string" ? address.port : 0);
      });
    });

    const transport = await tcpTransport("127.0.0.1", port);
    try {
      const pending = transport.request('{"id":"a-001"}');
      // Give the request bytes a turn to land before the cancel follows them.
      await Bun.sleep(20);
      transport.interrupt('{"method":"cancel"}');
      await pending;

      expect(Buffer.concat(chunks).toString()).toBe('{"id":"a-001"}\n\n{"method":"cancel"}\n');
    } finally {
      transport.close();
      client.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});

//////////////////////////
// The line splitter    //
//////////////////////////

describe("the line splitter", () => {
  test("reads a multi-megabyte single-line response", async () => {
    // Real EVM configurations run to megabytes on one line (plan §2), which is
    // why the splitter may impose no cap. Generated in memory: five megabytes
    // is not a thing to put in `fixtures/`.
    const filler = "a".repeat(5_000_000);
    const line = JSON.stringify({ jsonrpc: "2.0", id: "big-001", result: { state: filler } });
    expect(line.length).toBeGreaterThan(5_000_000);

    const server = await mock({ respond: line });
    const transport = await connectTo(server);

    try {
      const response = await transport.request('{"id":"big-001"}');
      expect(response.length).toBe(line.length);
      expect(response).toBe(line);
    } finally {
      transport.close();
    }
  });

  test("reassembles a response split across TCP segments, multi-byte characters included", async () => {
    // 7 bytes at a time through a payload full of 2- and 3-byte characters, so
    // segments land mid-character. Decoding only whole lines is what makes
    // that a non-event.
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: "chunk-001",
      result: { note: "λ∀∃ — ünïcödé ✓", repeated: "π".repeat(40) },
    });

    const server = await mock({ respond: line, chunkSize: 7, chunkDelayMs: 1 });
    const transport = await connectTo(server);

    try {
      expect(await transport.request('{"id":"chunk-001"}')).toBe(line);
    } finally {
      transport.close();
    }
  });

  test("splits a segment carrying two lines, and rejects the unsolicited one", async () => {
    // The splitter must not assume one segment is one line. On a single-flight
    // connection the *second* line has no request to belong to, so the correct
    // reading is: answer the first, then poison — a server sending two
    // responses to one request has desynchronized the stream.
    const server = await mock({ respond: malformed("two-lines-one-write"), raw: true });
    const transport = await connectTo(server);

    try {
      expect(await transport.request('{"id":"s-001"}')).toBe('{"jsonrpc":"2.0","id":"x-001","result":1}');
      expect((await rejection(transport.request('{"id":"s-002"}'))).message).toMatch(/Unsolicited response line/u);
    } finally {
      transport.close();
    }
  });

  test("treats a whitespace-only line as empty too", async () => {
    // pyk's `readline().rstrip()` makes `"   "` and `""` the same thing, so
    // whitespace cannot smuggle a line past the check.
    const server = await mock({ respond: malformed("blank-then-response"), raw: true });
    const transport = await connectTo(server);

    try {
      expect((await rejection(transport.request('{"id":"w-001"}'))).message).toMatch(/Empty response received/u);
    } finally {
      transport.close();
    }
  });

  test("delivers a well-framed line that is not JSON, and lets the codec reject it", async () => {
    // Framing is the transport's only concern: a backend writing a crash
    // message to its socket has produced a *line*, and it is `decodeResponse`
    // that has an opinion about its contents.
    const server = await mock({ respond: malformed("not-json"), raw: true });
    const transport = await connectTo(server);

    try {
      expect(await transport.request('{"id":"j-001"}')).toBe("kore-rpc-booster: internal error");
    } finally {
      transport.close();
    }
  });

  test("treats an empty response line as fatal, and poisons the transport", async () => {
    // pyk `rpc.py:379-380`: `if not resp: raise RuntimeError('Empty response
    // received')`. Fatal rather than a rejected request, because the next line
    // can no longer be trusted to belong to the next request.
    const server = await mock({ respond: malformed("empty-line"), raw: true });
    const transport = await connectTo(server);

    try {
      expect((await rejection(transport.request('{"id":"e-001"}'))).message).toMatch(/Empty response received/u);
      // Poisoned: the same failure, not a hang, for every later request.
      expect((await rejection(transport.request('{"id":"e-002"}'))).message).toMatch(/Empty response received/u);
    } finally {
      transport.close();
    }
  });
});

//////////////////////////
// The opt-in line cap  //
//////////////////////////

/**
 * `maxLineBytes` — the cap the splitter does **not** have by default.
 *
 * The uncapped test above is the reason the default is uncapped; these are the
 * reason the option exists at all. What is under test is that the cap trips on
 * the bytes buffered rather than on a completed line (a peer that never sends a
 * newline is the case that matters), that tripping it is fatal rather than a
 * rejected request, and that a cap nothing reaches is invisible.
 */
describe("the line cap", () => {
  test("an over-cap response line rejects the request and poisons the transport", async () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: "cap-001", result: { filler: "a".repeat(4_000) } });
    const server = await mock({ respond: line });
    const transport = await tcpTransport("127.0.0.1", server.port, { maxLineBytes: 1024 });

    try {
      const failure = await rejection(transport.request('{"id":"cap-001"}'));
      expect(failure).toBeInstanceOf(TransportError);
      // Not a close: the peer did nothing orderly, it overran a limit we set.
      expect(failure).not.toBeInstanceOf(TransportClosedError);
      expect(failure.message).toMatch(/exceeds maxLineBytes \(1024\)/u);

      // The message names the observed size, not only the limit — which is the
      // difference between "too big" and a number to raise the cap to.
      const match = defined(/: (\d+) bytes buffered$/u.exec(failure.message), "the observed size in the message");
      expect(Number(defined(match[1], "the byte count"))).toBeGreaterThan(1024);

      // Fatal, like every other framing failure: the stream is no longer in
      // step, so no later request may be allowed to wait on it.
      expect((await rejection(transport.request('{"id":"cap-002"}'))).message).toMatch(/exceeds maxLineBytes/u);
    } finally {
      transport.close();
    }
  });

  test("the cap trips mid-line, on a peer that never sends a newline", async () => {
    // The whole point of checking bytes rather than lines: `raw` means no
    // terminator is ever written, so a cap that only fired on a complete line
    // would never fire at all and the buffer would grow until the heap gave up.
    const server = await mock({ respond: "x".repeat(9_000), raw: true });
    const transport = await tcpTransport("127.0.0.1", server.port, { maxLineBytes: 2048 });

    try {
      expect((await rejection(transport.request('{"id":"cap-003"}'))).message).toMatch(
        /exceeds maxLineBytes \(2048\)/u,
      );
    } finally {
      transport.close();
    }
  });

  test("a cap the traffic never approaches changes nothing", async () => {
    const server = await mock({ respond: '{"jsonrpc":"2.0","id":"cap-004","result":{"ok":true}}' });
    const transport = await tcpTransport("127.0.0.1", server.port, { maxLineBytes: 1_000_000 });

    try {
      expect(await transport.request('{"id":"cap-004"}')).toBe('{"jsonrpc":"2.0","id":"cap-004","result":{"ok":true}}');
    } finally {
      transport.close();
    }
  });

  test("a line exactly at the cap is delivered — the bound is inclusive", async () => {
    // Off-by-one, stated: `maxLineBytes` is the largest line that still works,
    // not the first that fails.
    const line = "z".repeat(64);
    const server = await mock({ respond: line });
    const transport = await tcpTransport("127.0.0.1", server.port, { maxLineBytes: 64 });

    try {
      expect(await transport.request('{"id":"cap-005"}')).toBe(line);
    } finally {
      transport.close();
    }
  });
});

//////////////////////////
// Connecting           //
//////////////////////////

describe("connecting", () => {
  test("throws a RangeError synchronously for a negative timeout", () => {
    // pyk raises `ValueError` before touching the network (`rpc.py:131-132`);
    // synchronous here too, so a caller that forgot to await still sees it.
    expect(() => tcpTransport("127.0.0.1", 1, { timeout: -1 })).toThrow(RangeError);
    expect(() => TcpTransport.connect("127.0.0.1", 1, { timeout: -1 })).toThrow(
      /Expected a non-negative timeout in milliseconds/u,
    );
  });

  test("throws a RangeError synchronously for a maxLineBytes that is not a positive integer", () => {
    // Zero, a fraction and a NaN would each turn every response into a failure
    // rather than doing nothing, so they are caught on the call that got them
    // wrong — before any socket exists, like the timeout above.
    for (const maxLineBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => tcpTransport("127.0.0.1", 1, { maxLineBytes })).toThrow(RangeError);
      expect(() => TcpTransport.connect("127.0.0.1", 1, { maxLineBytes })).toThrow(
        /Expected a positive integer maxLineBytes/u,
      );
    }
  });

  test("retries a refused connection until the listener appears", async () => {
    const port = await freePort();

    // Nothing is listening yet; the first attempts must be refused and retried
    // at ~100 ms, and the connection must succeed once the server shows up.
    const pending = tcpTransport("127.0.0.1", port, { timeout: 5_000 });
    const server = createServer((socket) => {
      socket.on("data", () => {
        socket.write('{"id":"late-001","result":"ok"}\n');
      });
    });
    await Bun.sleep(250);
    await new Promise<void>((resolve) => {
      server.listen(port, "127.0.0.1", resolve);
    });

    const transport = await pending;
    try {
      expect(await transport.request('{"id":"late-001"}')).toBe('{"id":"late-001","result":"ok"}');
    } finally {
      transport.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  test("gives up when the timeout elapses", async () => {
    const port = await freePort();
    const begun = Date.now();

    const failure = await rejection(tcpTransport("127.0.0.1", port, { timeout: 250 }));
    expect(failure).toBeInstanceOf(TransportError);
    expect(failure.message).toBe(`Connection timed out: 127.0.0.1:${port}`);
    expect(Date.now() - begun).toBeGreaterThanOrEqual(200);
  });

  test("a zero timeout never opens a socket", async () => {
    // pyk's loop tests the deadline before each attempt, so `timeout=0` fails
    // with zero attempts rather than one.
    const port = await freePort();
    expect(await rejection(tcpTransport("127.0.0.1", port, { timeout: 0 }))).toBeInstanceOf(TransportError);
  });
});

//////////////////////////
// Single flight        //
//////////////////////////

describe("single flight", () => {
  test("serializes concurrent requests strictly", async () => {
    // The server runs one worker per socket (`Server.hs:178-183`). Two
    // concurrent calls must reach the wire one after the other, with the
    // second's bytes not sent until the first's response line has been read.
    const events: string[] = [];

    const server = await mock(
      {
        expect: () => {
          events.push("received 1");
        },
        respond: () => {
          events.push("answered 1");
          return '{"id":"q-001","result":1}';
        },
        delayMs: 60,
      },
      {
        expect: () => {
          events.push("received 2");
        },
        respond: () => {
          events.push("answered 2");
          return '{"id":"q-002","result":2}';
        },
      },
    );
    const transport = await connectTo(server);

    try {
      const [first, second] = await Promise.all([
        transport.request('{"id":"q-001"}'),
        transport.request('{"id":"q-002"}'),
      ]);

      expect(first).toBe('{"id":"q-001","result":1}');
      expect(second).toBe('{"id":"q-002","result":2}');
      expect(events).toEqual(["received 1", "answered 1", "received 2", "answered 2"]);
      server.check();
    } finally {
      transport.close();
    }
  });

  test("keeps queued requests in call order", async () => {
    const server = await mock(
      { respond: '{"id":"o-001","result":1}', delayMs: 30 },
      { respond: '{"id":"o-002","result":2}' },
      { respond: '{"id":"o-003","result":3}' },
    );
    const transport = await connectTo(server);

    try {
      const responses = await Promise.all([
        transport.request('{"id":"o-001"}'),
        transport.request('{"id":"o-002"}'),
        transport.request('{"id":"o-003"}'),
      ]);
      expect(responses.map((r) => jsonRecord(JSON.parse(r), "response")["result"])).toEqual([1, 2, 3]);
      expect(server.received.map((r) => r["id"])).toEqual(["o-001", "o-002", "o-003"]);
    } finally {
      transport.close();
    }
  });
});

//////////////////////////
// Closing and failing  //
//////////////////////////

describe("closing", () => {
  test("rejects a pending request", async () => {
    const server = await mock({ respond: '{"id":"c-001","result":1}', delayMs: 5_000 });
    const transport = await connectTo(server);

    const pending = transport.request('{"id":"c-001"}');
    await Bun.sleep(20);
    transport.close();

    expect(await rejection(pending)).toBeInstanceOf(TransportClosedError);
    expect(await rejection(transport.request('{"id":"c-002"}'))).toBeInstanceOf(TransportClosedError);
  });

  test("rejects a pending request when the peer hangs up mid-answer", async () => {
    const server = createServer((socket) => {
      socket.on("data", () => {
        socket.write('{"id":"h-001","result":"trunca');
        socket.destroy();
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(address !== null && typeof address !== "string" ? address.port : 0);
      });
    });

    const transport = await tcpTransport("127.0.0.1", port);
    try {
      // An unterminated line is not a response: no `\n` ever arrives, and the
      // EOF is what settles the promise.
      expect(await rejection(transport.request('{"id":"h-001"}'))).toBeInstanceOf(TransportError);
    } finally {
      transport.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  test("interrupt after close is a no-op, not a throw", async () => {
    const server = await mock({ respond: '{"id":"n-001","result":1}' });
    const transport = await connectTo(server);
    transport.close();
    expect(() => {
      transport.interrupt('{"method":"cancel"}');
    }).not.toThrow();
  });

  test("an answered cancel is absorbed, not delivered to the pending request", async () => {
    // Deviation (5). The server answers the cancel's own id with -32601 and
    // *then* the interrupted request's id with -32000; only the second belongs
    // to anybody.
    const server = await MockServer.start(
      [
        {
          respond: '{"jsonrpc":"2.0","id":"c-001","error":{"code":-32000,"message":"Request cancelled"}}',
          delayMs: 50,
        },
        { respond: '{"jsonrpc":"2.0","id":"c-002","result":{"ok":true}}' },
      ],
      { onStrayCancel: (cancel) => cancelNotSupportedResponse(cancel["id"]) },
    );
    running.push(server);
    const transport = await connectTo(server);

    const pending = transport.request('{"id":"c-001","method":"execute"}');
    await Bun.sleep(20);
    transport.interrupt('{"jsonrpc":"2.0","id":"c-001-cancel","method":"cancel","params":{}}');

    const answer = parseJsonRecord(await pending, "the interrupted request's answer");
    expect(answer["id"]).toBe("c-001");

    // The connection is still in step: the next request gets its own answer.
    const next = parseJsonRecord(await transport.request('{"id":"c-002","method":"simplify"}'), "next");
    expect(next["id"]).toBe("c-002");
    transport.close();
  });

  test("a cancel answered with nothing in flight is dropped, not a poisoning", async () => {
    const server = await MockServer.start([{ respond: '{"jsonrpc":"2.0","id":"d-001","result":1}' }], {
      onStrayCancel: (cancel) => cancelNotSupportedResponse(cancel["id"]),
    });
    running.push(server);
    const transport = await connectTo(server);

    transport.interrupt('{"jsonrpc":"2.0","id":"cancel","method":"cancel","params":{}}');
    await Bun.sleep(30);

    // Without the absorption this was `Unsolicited response line`, permanently.
    const answer = parseJsonRecord(await transport.request('{"id":"d-001"}'), "answer");
    expect(answer["id"]).toBe("d-001");
    transport.close();
  });

  test("only the recorded cancel id is absorbed — an unrelated id still lands", async () => {
    // The absorption is keyed on the id this transport actually cancelled with,
    // not on "looks like an error object": a stray line with any other id is
    // still the protocol violation it was.
    const server = await MockServer.start([{ respond: '{"jsonrpc":"2.0","id":"e-001","result":1}', delayMs: 30 }], {
      onStrayCancel:
        '{"jsonrpc":"2.0","id":"someone-elses-id","error":{"code":-32601,"message":"Cancel not supported"}}',
    });
    running.push(server);
    const transport = await connectTo(server);

    const pending = transport.request('{"id":"e-001"}');
    await Bun.sleep(5);
    transport.interrupt('{"jsonrpc":"2.0","id":"e-001-cancel","method":"cancel","params":{}}');

    const answer = parseJsonRecord(await pending, "answer");
    expect(answer["id"]).toBe("someone-elses-id");
    transport.close();
  });
});
