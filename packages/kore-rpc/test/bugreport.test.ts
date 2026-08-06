/**
 * `src/bugreport.ts` — the tar encoder, the report, and the recording
 * transport.
 *
 * The load-bearing test here is the **byte-level** one at the bottom: a fixed
 * scripted session must produce `test/data/bug-report.tar` exactly. Two things
 * ride on those bytes and neither is checkable by reading the code. The first
 * is that the archive is a *GNU tar* archive in the sense `kore-rpc-client
 * run-tarball` and `tar(1)` both mean — the golden was verified byte-identical
 * to Python `tarfile`'s `GNU_FORMAT` output, which is the writer pyk itself
 * uses (see `test/data/README.md`). The second is determinism: the whole point
 * of deviating from pyk on mode/mtime/uid is that two runs of one proof produce
 * two identical files, and a byte comparison is the only assertion that says
 * so.
 *
 * `readTar` below is a deliberately small reader — enough to name the members
 * and read their contents — so the golden is asserted for what it *means* as
 * well as for what it is. A change that breaks the layout fails the member
 * assertions with a readable diff; a change that only shifts a header byte
 * fails the byte assertion.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  BUG_REPORT_MODE,
  BugReport,
  MemoryBugReportSink,
  TAR_BLOCK_SIZE,
  TAR_RECORD_SIZE,
  bugReport,
  fileBugReportSink,
  recordingTransport,
  sanitizeSegment,
  tarEndOfArchive,
  tarMember,
  tarPathFor,
} from "../src/bugreport.ts";
import type { Transport } from "../src/transport.ts";
import { rejection } from "./helpers/assert.ts";
import {
  CANCEL,
  DEFINITION_PATH,
  GOLDEN_MEMBERS,
  REQUEST,
  RESPONSE,
  goldenSessionBytes,
  scriptedTransport,
} from "./helpers/bug-report-session.ts";

//////////////////////
// A tar reader     //
//////////////////////

const DECODER = new TextDecoder();

/** One member of an archive, as `readTar` reports it. */
interface TarEntry {
  readonly name: string;
  readonly contents: string;
  readonly mode: number;
  readonly mtime: number;
}

/** Read a NUL- or space-terminated field. */
function field(block: Uint8Array, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return DECODER.decode(end < 0 ? raw : raw.subarray(0, end)).trim();
}

/**
 * A minimal GNU tar reader: regular files and `././@LongLink` name prefixes.
 *
 * It also *checks* what it reads — the magic, the type flag and the header
 * checksum — so a malformed archive fails here rather than being reported as a
 * missing member.
 */
function readTar(archive: Uint8Array): readonly TarEntry[] {
  const entries: TarEntry[] = [];
  let pendingName: string | undefined;

  for (let offset = 0; offset + TAR_BLOCK_SIZE <= archive.length;) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    offset += TAR_BLOCK_SIZE;

    expect(field(header, 257, 8)).toBe("ustar");

    let sum = 0;
    for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    expect(field(header, 148, 8)).toBe(sum.toString(8).padStart(6, "0"));

    const size = Number.parseInt(field(header, 124, 12), 8);
    const body = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "L") {
      // The stored long name is NUL-terminated; drop the terminator.
      pendingName = DECODER.decode(body.subarray(0, size - 1));
      continue;
    }
    expect(type).toBe("0");

    entries.push({
      name: pendingName ?? field(header, 0, 100),
      contents: DECODER.decode(body),
      mode: Number.parseInt(field(header, 100, 8), 8),
      mtime: Number.parseInt(field(header, 136, 12), 8),
    });
    pendingName = undefined;
  }

  return entries;
}

/** The `[name, contents]` pairs of an archive, for comparing against a script. */
function membersOf(archive: Uint8Array): readonly (readonly [string, string])[] {
  return readTar(archive).map((entry) => [entry.name, entry.contents] as const);
}

//////////////////////
// The encoder      //
//////////////////////

describe("tarMember", () => {
  test("a short name is one header plus one padded data block", () => {
    const member = tarMember("a/b.json", new TextEncoder().encode("hi"));
    expect(member.length).toBe(2 * TAR_BLOCK_SIZE);
    const [entry] = readTar(member);
    expect(entry?.name).toBe("a/b.json");
    expect(entry?.contents).toBe("hi");
  });

  test("the deterministic header fields are the deviation's, not the machine's", () => {
    const [entry] = readTar(tarMember("x", new Uint8Array(0)));
    expect(entry?.mode).toBe(BUG_REPORT_MODE);
    expect(entry?.mtime).toBe(0);
    // uid, gid, uname and gname are zero and empty; a header carrying this
    // machine's would make the golden below unreproducible anywhere else.
    const header = tarMember("x", new Uint8Array(0)).subarray(0, TAR_BLOCK_SIZE);
    expect(field(header, 108, 8)).toBe("0000000");
    expect(field(header, 116, 8)).toBe("0000000");
    expect(field(header, 265, 32)).toBe("");
    expect(field(header, 297, 32)).toBe("");
  });

  test("both header spellings are overridable", () => {
    const [entry] = readTar(tarMember("x", new Uint8Array(0), { mode: 0o600, mtime: 1_700_000_000 }));
    expect(entry?.mode).toBe(0o600);
    expect(entry?.mtime).toBe(1_700_000_000);
  });

  test("a name over 99 bytes gets a GNU long-name prefix entry", () => {
    const name = `${"d".repeat(120)}/x_request.json`;
    const member = tarMember(name, new TextEncoder().encode("body"));
    // long-name header + long-name data + real header + real data
    expect(member.length).toBe(4 * TAR_BLOCK_SIZE);
    expect(field(member.subarray(0, TAR_BLOCK_SIZE), 0, 100)).toBe("././@LongLink");
    const [entry] = readTar(member);
    expect(entry?.name).toBe(name);
    expect(entry?.contents).toBe("body");
  });

  test("a 99-byte name still fits the header, a 100-byte one does not", () => {
    expect(tarMember("n".repeat(99), new Uint8Array(0)).length).toBe(TAR_BLOCK_SIZE);
    expect(tarMember("n".repeat(100), new Uint8Array(0)).length).toBe(3 * TAR_BLOCK_SIZE);
  });

  test("a multi-byte name is measured in bytes and survives the round trip", () => {
    // 40 three-byte characters is 120 bytes, so this takes the long-name path
    // even though the string is 40 characters long.
    const name = "★".repeat(40);
    const [entry] = readTar(tarMember(name, new Uint8Array(0)));
    expect(entry?.name).toBe(name);
  });
});

describe("tarEndOfArchive", () => {
  test("is at least two zero blocks and lands on a record boundary", () => {
    for (const body of [0, TAR_BLOCK_SIZE, 8 * TAR_BLOCK_SIZE, TAR_RECORD_SIZE]) {
      const end = tarEndOfArchive(body);
      expect(end.length).toBeGreaterThanOrEqual(2 * TAR_BLOCK_SIZE);
      expect(end.every((byte) => byte === 0)).toBe(true);
      expect((body + end.length) % TAR_RECORD_SIZE).toBe(0);
    }
  });
});

//////////////////////
// Paths and names  //
//////////////////////

describe("tarPathFor", () => {
  test("reproduces pathlib's with_suffix, oddities included", () => {
    expect(tarPathFor("report")).toBe("report.tar");
    expect(tarPathFor("report.json")).toBe("report.tar");
    expect(tarPathFor("report.tar")).toBe("report.tar");
    // `with_suffix` replaces the *last* suffix only.
    expect(tarPathFor("report.tar.gz")).toBe("report.tar.tar");
    // A leading dot is not a suffix in pathlib.
    expect(tarPathFor(".hidden")).toBe(".hidden.tar");
    // A dot in a directory name is not the file's suffix.
    expect(tarPathFor("out.d/report")).toBe("out.d/report.tar");
  });
});

describe("sanitizeSegment", () => {
  test("keeps what a path and a sequence file can both hold", () => {
    expect(sanitizeSegment("kore-rpc-1a2b-001")).toBe("kore-rpc-1a2b-001");
    expect(sanitizeSegment("proof.42_x")).toBe("proof.42_x");
  });

  test("a slash cannot smuggle in a directory level", () => {
    expect(sanitizeSegment("a/b")).toBe("a_b");
    expect(sanitizeSegment("../../etc")).toBe(".._.._etc");
  });

  test("an empty segment becomes a name rather than vanishing", () => {
    expect(sanitizeSegment("")).toBe("_");
    expect(sanitizeSegment("///")).toBe("___");
  });
});

//////////////////////
// The report       //
//////////////////////

function freshReport(files: Readonly<Record<string, string>> = {}): {
  report: BugReport;
  sink: MemoryBugReportSink;
} {
  const encoder = new TextEncoder();
  const sink = new MemoryBugReportSink(
    new Map(Object.entries(files).map(([path, contents]) => [path, encoder.encode(contents)])),
  );
  return { report: new BugReport(sink), sink };
}

describe("BugReport", () => {
  test("the archive is valid after every single member", () => {
    const { report, sink } = freshReport();
    expect(readTar(sink.archive)).toEqual([]);
    report.addFileContents("one", "a.txt");
    expect(membersOf(sink.archive)).toEqual([["a.txt", "one"]]);
    report.addFileContents("two", "b.txt");
    expect(membersOf(sink.archive)).toEqual([
      ["a.txt", "one"],
      ["b.txt", "two"],
    ]);
    // Every intermediate state is a whole number of records, as pyk's is.
    expect(sink.archive.length % TAR_RECORD_SIZE).toBe(0);
  });

  test("sequence/ and commands/ share one counter, zero-padded to three", () => {
    const { report, sink } = freshReport();
    report.addRequest("x/y/1_request.json");
    report.addCommand(["echo", "hi"]);
    report.addRequest("x/y/1_response.json");
    expect(membersOf(sink.archive)).toEqual([
      ["sequence/000", "x/y/1_request.json"],
      ["commands/001.sh", "#!/usr/bin/env bash\nset -euxo pipefail\necho hi\n"],
      ["sequence/002", "x/y/1_response.json"],
    ]);
    expect(report.commandId).toBe(3);
  });

  test("a sequence file's contents are exactly the member name it orders", () => {
    // This identity is what `RpcClient.hs:580-584` looks requests up by; a
    // trailing newline or a normalized path would silently unorder the replay.
    const { report, sink } = freshReport();
    report.addFileContents("{}", "kore_rpc/1/a-001_request.json");
    report.addRequest("kore_rpc/1/a-001_request.json");
    const entries = readTar(sink.archive);
    expect(entries[1]?.contents).toBe(entries[0]?.name);
  });

  test("addFile archives once per input path and remembers the arcname", () => {
    const { report, sink } = freshReport({ "/k/definition.kore": "[]" });
    report.addFile("/k/definition.kore", "definition.kore");
    report.addFile("/k/definition.kore", "llvm_definition/definition.kore");
    expect(membersOf(sink.archive)).toEqual([["definition.kore", "[]"]]);
    expect([...report.fileRemap]).toEqual([["/k/definition.kore", "definition.kore"]]);
  });

  test("addCommand rewrites archived paths, including paths inside them", () => {
    const { report, sink } = freshReport({ "/k/definition.kore": "[]", "/k/dt": "" });
    report.addFile("/k/definition.kore", "definition.kore");
    report.addFile("/k/dt", "llvm_definition/dt");
    report.addCommand(["kore-rpc", "/k/definition.kore", "--dt", "/k/dt/index.bin", "--other", "/elsewhere"]);
    const script = readTar(sink.archive).at(-1)?.contents ?? "";
    expect(script).toBe(
      "#!/usr/bin/env bash\nset -euxo pipefail\n" +
        "kore-rpc definition.kore --dt llvm_definition/dt/index.bin --other /elsewhere\n",
    );
  });

  test("newInstanceId counts from one", () => {
    const { report } = freshReport();
    expect(report.newInstanceId()).toBe("1");
    expect(report.newInstanceId()).toBe("2");
  });
});

//////////////////////
// The recorder     //
//////////////////////

describe("recordingTransport", () => {
  test("tees a round trip and indexes both halves, request first", async () => {
    const { report, sink } = freshReport();
    const inner = scriptedTransport();
    const transport = recordingTransport(inner, report, { id: "proof-42" });

    expect(await transport.request(REQUEST)).toBe(RESPONSE);
    expect(inner.seen).toEqual([`request:${REQUEST}`]);
    expect(membersOf(sink.archive)).toEqual([
      ["proof-42/1/proof-42-001_request.json", REQUEST],
      ["sequence/000", "proof-42/1/proof-42-001_request.json"],
      ["proof-42/1/proof-42-001_response.json", RESPONSE],
      ["sequence/001", "proof-42/1/proof-42-001_response.json"],
    ]);
  });

  test("the recorded bytes are the bytes on the wire, unaltered", async () => {
    // A payload with a multi-byte character and awkward whitespace: nothing
    // here reserializes, so it must come back identical.
    const payload = '{"jsonrpc":"2.0", "id":"σ-1", "method":"simplify", "params":{"note":"★"}}';
    const { report, sink } = freshReport();
    await recordingTransport(scriptedTransport("★"), report).request(payload);
    expect(readTar(sink.archive)[0]?.contents).toBe(payload);
    expect(readTar(sink.archive)[2]?.contents).toBe("★");
  });

  test("the default id is pyk's kore_rpc, and instances do not collide", async () => {
    const { report, sink } = freshReport();
    await recordingTransport(scriptedTransport(), report).request(REQUEST);
    await recordingTransport(scriptedTransport(), report).request(REQUEST);
    expect(readTar(sink.archive).map((entry) => entry.name)).toEqual([
      "kore_rpc/1/proof-42-001_request.json",
      "sequence/000",
      "kore_rpc/1/proof-42-001_response.json",
      "sequence/001",
      "kore_rpc/2/proof-42-001_request.json",
      "sequence/002",
      "kore_rpc/2/proof-42-001_response.json",
      "sequence/003",
    ]);
  });

  test("an id with a path separator in it cannot create a directory", async () => {
    const { report, sink } = freshReport();
    await recordingTransport(scriptedTransport(), report, { id: "a/b", instance: "c/d" }).request(
      '{"jsonrpc":"2.0","id":"x/y","method":"execute","params":{}}',
    );
    expect(readTar(sink.archive)[0]?.name).toBe("a_b/c_d/x_y_request.json");
  });

  test("a payload whose id is not where the envelope puts it falls back to a counter", async () => {
    const { report, sink } = freshReport();
    const transport = recordingTransport(scriptedTransport(), report);
    await transport.request('{"method":"execute","id":"buried","params":{}}');
    await transport.request("not json at all");
    expect(
      readTar(sink.archive)
        .map((entry) => entry.name)
        .filter((name) => name.endsWith("_request.json")),
    ).toEqual(["kore_rpc/1/request-001_request.json", "kore_rpc/1/request-002_request.json"]);
  });

  test("a numeric id is read too", async () => {
    const { report, sink } = freshReport();
    await recordingTransport(scriptedTransport(), report).request('{"jsonrpc":"2.0","id":17,"method":"execute"}');
    expect(readTar(sink.archive)[0]?.name).toBe("kore_rpc/1/17_request.json");
  });

  test("a cancel is archived but never sequenced", () => {
    const { report, sink } = freshReport();
    const inner = scriptedTransport();
    recordingTransport(inner, report, { id: "proof-42" }).interrupt(CANCEL);
    expect(inner.seen).toEqual([`interrupt:${CANCEL}`]);
    expect(membersOf(sink.archive)).toEqual([["proof-42/1/proof-42-001-cancel_cancel.json", CANCEL]]);
  });

  test("a request that never got an answer leaves a request with no response", async () => {
    const { report, sink } = freshReport();
    const failing: Transport = {
      request: () => Promise.reject(new Error("connection reset")),
      interrupt: (): void => {
        throw new Error("not reached");
      },
      close: (): void => {
        throw new Error("not reached");
      },
    };
    expect((await rejection(recordingTransport(failing, report).request(REQUEST))).message).toBe("connection reset");
    expect(membersOf(sink.archive)).toEqual([
      ["kore_rpc/1/proof-42-001_request.json", REQUEST],
      ["sequence/000", "kore_rpc/1/proof-42-001_request.json"],
    ]);
  });

  test("close is passed through", () => {
    const { report } = freshReport();
    const inner = scriptedTransport();
    recordingTransport(inner, report).close();
    expect(inner.seen).toEqual(["close"]);
  });
});

//////////////////////
// On a real disk   //
//////////////////////

describe("fileBugReportSink", () => {
  test("writes a readable archive and re-reads what it archived", () => {
    const dir = mkdtempSync(join(tmpdir(), "kore-rpc-bugreport-"));
    try {
      const path = join(dir, "nested", "report.tar");
      const report = new BugReport(fileBugReportSink(path));
      report.addFileContents("hello", "a.txt");
      // Valid on disk *now*, not only once the session ends.
      expect(membersOf(readFileSync(path))).toEqual([["a.txt", "hello"]]);
      report.addFileContents("world", "b.txt");
      expect(membersOf(readFileSync(path))).toEqual([
        ["a.txt", "hello"],
        ["b.txt", "world"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an existing archive is removed, with a warning, rather than appended to", () => {
    const dir = mkdtempSync(join(tmpdir(), "kore-rpc-bugreport-"));
    try {
      const path = join(dir, "report.json");
      new BugReport(fileBugReportSink(tarPathFor(path))).addFileContents("first", "a.txt");
      const warnings: string[] = [];
      const second = bugReport(path, { onWarn: (message) => void warnings.push(message) });
      second.addFileContents("second", "b.txt");
      expect(warnings).toEqual([`Bug report exists, removing: ${join(dir, "report.tar")}`]);
      expect(membersOf(readFileSync(join(dir, "report.tar")))).toEqual([["b.txt", "second"]]);
      expect(second.description).toBe(join(dir, "report.tar"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

//////////////////////
// The golden       //
//////////////////////

describe("the recorded session", () => {
  test("holds the members the layout says it should", async () => {
    expect(membersOf(await goldenSessionBytes())).toEqual(GOLDEN_MEMBERS.map(([name, body]) => [name, body]));
  });

  test("is byte-identical to test/data/bug-report.tar", async () => {
    // See this file's header: the golden was checked against Python `tarfile`'s
    // GNU writer, so this comparison is a conformance assertion and not merely
    // a change detector. It is also the determinism assertion — nothing in the
    // archive may depend on the clock, the user or the machine.
    const golden = new Uint8Array(readFileSync(join(import.meta.dir, "data", "bug-report.tar")));
    expect(await goldenSessionBytes()).toEqual(golden);
  });

  test("is reproduced exactly by a second run", async () => {
    expect(await goldenSessionBytes()).toEqual(await goldenSessionBytes());
  });

  test("names a definition path that the remap actually rewrote", () => {
    // Guards the golden against becoming vacuous: if `addCommand` stopped
    // remapping, the script would still be *a* script, so assert the absolute
    // path is gone from it.
    const script = GOLDEN_MEMBERS.find(([name]) => name === "commands/000.sh")?.[1] ?? "";
    expect(script).not.toContain(DEFINITION_PATH);
    expect(script).toContain("kore-rpc definition.kore --module IMP");
  });
});
