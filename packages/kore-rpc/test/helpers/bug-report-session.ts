/**
 * The one scripted bug-report session that `test/data/bug-report.tar` is the
 * bytes of.
 *
 * It lives in a helper rather than inside `bugreport.test.ts` because the
 * golden was *generated* by calling this function and writing the result — so
 * the test that compares against the file and the script that produced it are
 * provably the same session, and re-generating after a deliberate format change
 * is one command rather than a hand edit of a binary.
 *
 * See `test/data/README.md` for the derivation and for the independent oracle
 * the file was checked against (Python's `tarfile` in `GNU_FORMAT`, the writer
 * pyk itself uses).
 */

import { BugReport, MemoryBugReportSink, recordingTransport } from "../../src/bugreport.ts";
import type { Transport } from "../../src/transport.ts";

/** The fake `definition.kore` the session archives, as a file the sink can read. */
export const DEFINITION_KORE = "[]\nmodule IMP\nendmodule []\n";

/** The path that definition is read from — remapped into `commands/000.sh` below. */
export const DEFINITION_PATH = "/tmp/imp-kompiled/definition.kore";

/** The one request the session records, exactly as `encodeRequest` would build it. */
export const REQUEST = '{"jsonrpc":"2.0","id":"proof-42-001","method":"execute","params":{"max-depth":1}}';

/** Its answer. */
export const RESPONSE = '{"jsonrpc":"2.0","id":"proof-42-001","result":{"reason":"stuck","depth":0}}';

/** The `cancel` written on the same connection — deviation (5) in `bugreport.ts`. */
export const CANCEL = '{"jsonrpc":"2.0","id":"proof-42-001-cancel","method":"cancel","params":{}}';

/** A transport that answers the one request and remembers what it was told. */
export function scriptedTransport(response = RESPONSE): Transport & { readonly seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    request(payload: string): Promise<string> {
      seen.push(`request:${payload}`);
      return Promise.resolve(response);
    },
    interrupt(payload: string): void {
      seen.push(`interrupt:${payload}`);
    },
    close(): void {
      seen.push("close");
    },
  };
}

/**
 * Every member the golden holds, in order — the assertion `bugreport.test.ts`
 * makes about what the bytes *mean*, as opposed to what they are.
 */
export const GOLDEN_MEMBERS: readonly (readonly [name: string, contents: string])[] = [
  ["definition.kore", DEFINITION_KORE],
  ["server_version.txt", "kore-rpc 0.1.155"],
  ["server_instance.json", '{"exe":"kore-rpc","module":"IMP","extra_args":["--smt-timeout","300"]}'],
  ["commands/000.sh", "#!/usr/bin/env bash\nset -euxo pipefail\nkore-rpc definition.kore --module IMP\n"],
  ["proof-42/1/proof-42-001_request.json", REQUEST],
  ["sequence/001", "proof-42/1/proof-42-001_request.json"],
  ["proof-42/1/proof-42-001_response.json", RESPONSE],
  ["sequence/002", "proof-42/1/proof-42-001_response.json"],
  ["proof-42/1/proof-42-001-cancel_cancel.json", CANCEL],
];

/** Run the scripted session into a fresh in-memory archive and return its bytes. */
export async function goldenSessionBytes(): Promise<Uint8Array> {
  const sink = new MemoryBugReportSink(new Map([[DEFINITION_PATH, new TextEncoder().encode(DEFINITION_KORE)]]));
  const report = new BugReport(sink);

  // The server half, in the order `server.ts` writes it.
  report.addFile(DEFINITION_PATH, "definition.kore");
  report.addFileContents("kore-rpc 0.1.155", "server_version.txt");
  report.addFileContents(
    JSON.stringify({ exe: "kore-rpc", module: "IMP", extra_args: ["--smt-timeout", "300"] }),
    "server_instance.json",
  );
  // A command whose second argument is the archived definition, so the golden
  // pins `addCommand`'s remapping too.
  report.addCommand(["kore-rpc", DEFINITION_PATH, "--module", "IMP"]);

  // The traffic half.
  const transport = recordingTransport(scriptedTransport(), report, { id: "proof-42" });
  await transport.request(REQUEST);
  transport.interrupt(CANCEL);

  return sink.archive;
}
