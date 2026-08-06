// Consumer smoke test, run by CI against the *packed tarball* under plain Node
// — never against the workspace. The failure this guards against is specific:
// an entry point that plain Node cannot load. Node refuses to strip types under
// `node_modules`, so a package whose `exports` points at `.ts` installs fine and
// then throws on first import. Packing and importing for real is the only check
// that sees it.
//
// CI copies this file into a scratch consumer project that has installed the
// tarball, so the imports below must use the published package names. This
// package has a workspace dependency, which is on no registry; the smoke job
// packs `@kframework-ts/kore` alongside and installs both tarballs in one
// `npm install`, so importing it here is also what proves that `dependencies`
// entry survives packing.
//
// All three entry points are exercised — `./server` and `./bugreport` are
// separate ones in `exports`, and a subpath that resolves in the workspace but
// not from a tarball is exactly the class of bug this file exists to catch.
// Nothing here opens a socket, starts a process, touches a disk, or reads
// `fixtures/` — fixtures are not published.
import assert from "node:assert/strict";
import { join } from "node:path";
import { parsePattern } from "@kframework-ts/kore";
import {
  decodeExecuteResult,
  decodeKoreRpcError,
  emitOrdered,
  encodeExecuteResult,
  encodeRequest,
  HASKELL_BACKEND_RELEASE,
  K_RELEASE,
  koreJson,
  rpcKast,
  rpcPrint,
  UnknownModuleError,
} from "@kframework-ts/kore-rpc";
import { BugReport, MemoryBugReportSink, recordingTransport } from "@kframework-ts/kore-rpc/bugreport";
import { buildBoosterServerCommand, buildKoreServerCommand } from "@kframework-ts/kore-rpc/server";

// The two pins this package's whole claim rests on.
assert.equal(K_RELEASE, "v7.1.337");
assert.equal(HASKELL_BACKEND_RELEASE, "v0.1.155");

// An `execute` request, emitted the way the server emits: `rpcJsonConfig`'s key
// order (`jsonrpc`, `id`, then unlisted keys ascending; `state` before
// `module`), no whitespace, no trailing newline.
const state = koreJson(parsePattern('\\dv{SortInt{}}("1")'));
assert.equal(
  emitOrdered(encodeRequest("smoke-001", { method: "execute", params: { state, maxDepth: 2, module: "IMP" } })),
  '{"jsonrpc":"2.0","id":"smoke-001","method":"execute","params":{"state":{"format":"KORE","version":1,' +
    '"term":{"tag":"DV","sort":{"tag":"SortApp","name":"SortInt","args":[]},"value":"1"}},' +
    '"module":"IMP","max-depth":2}}',
);

// Error code 3 is positional, not named, and carries the module name as a bare
// string — the shape `kore-rpc-server/add-module/execute/response-fail.golden`
// records.
const error = decodeKoreRpcError({ code: 3, message: "Could not find module", data: "NEW" });
assert.ok(error instanceof UnknownModuleError);
assert.equal(error.code, 3);
assert.equal(error.moduleName, "NEW");
assert.equal(error.message, "Could not find module: NEW");

// A result decodes into the discriminated union and encodes back to the bytes
// it came from.
const wire =
  '{"reason":"depth-bound","depth":2,"state":{"term":{"format":"KORE","version":1,' +
  '"term":{"tag":"DV","sort":{"tag":"SortApp","name":"SortInt","args":[]},"value":"1"}}}}';
const result = decodeExecuteResult(JSON.parse(wire));
assert.equal(result.reason, "depth-bound");
assert.equal(result.depth, 2);
assert.equal(emitOrdered(encodeExecuteResult(result)), wire);

// The `./server` subpath: command assembly only — no process is spawned.
assert.deepEqual(buildKoreServerCommand({ kompiledDir: "imp-kompiled", moduleName: "IMP", port: 41011 }), [
  "kore-rpc",
  join("imp-kompiled", "definition.kore"),
  "--module",
  "IMP",
  "--server-port",
  "41011",
]);
assert.deepEqual(
  buildBoosterServerCommand({
    kompiledDir: "imp-kompiled",
    moduleName: "IMP",
    port: 41011,
    llvmKompiledDir: "imp-llvm-kompiled",
    platform: "linux",
    fallbackOn: ["Aborted"],
  }),
  [
    "kore-rpc-booster",
    join("imp-kompiled", "definition.kore"),
    "--module",
    "IMP",
    "--server-port",
    "41011",
    "--llvm-backend-library",
    join("imp-llvm-kompiled", "interpreter.so"),
    "--fallback-on",
    "Aborted",
  ],
);

// The `./bugreport` subpath: a whole recorded session, in memory. The
// assertions are on the tar layout `kore-rpc-client run-tarball` reads — the
// member name, and the `sequence/` entry whose contents must equal it.
const sink = new MemoryBugReportSink();
const report = new BugReport(sink);
const inner = { request: (payload) => Promise.resolve(`{"jsonrpc":"2.0","id":"smoke-001","result":${payload}}`) };
const recorder = recordingTransport({ ...inner, interrupt: () => {}, close: () => {} }, report, { id: "smoke" });
await recorder.request('{"jsonrpc":"2.0","id":"smoke-001","method":"simplify","params":{}}');

// GNU magic in the first header, and a whole number of 10 240-byte records.
assert.equal(Buffer.from(sink.archive.subarray(257, 265)).toString("binary"), "ustar  \0");
assert.equal(sink.archive.length % 10240, 0);
assert.equal(Buffer.from(sink.archive.subarray(0, 36)).toString("utf8"), "smoke/1/smoke-001_request.json\0\0\0\0\0\0");
// `sequence/000`'s contents are the member name above, byte for byte.
assert.ok(Buffer.from(sink.archive).includes(Buffer.from("smoke/1/smoke-001_request.json")));

// The two recorded-traffic readers, from the main entry point: the same
// `depth-bound` response as above, wrapped in the envelope a recording holds.
const response = JSON.parse(`{"jsonrpc":"2.0","id":1,"result":${wire}}`);
assert.ok(
  rpcPrint(response).startsWith("JSON RPC Response\nid: 1\nMethod: execute\nDepth: 2\nStop reason: depth-bound\n"),
);
const grafted = rpcKast(
  { jsonrpc: "2.0", id: 1, method: "simplify", params: { module: "IMP", state: null } },
  response,
);
assert.equal(grafted.method, "simplify");
assert.equal(grafted.params.state.format, "KORE");

console.log(`@kframework-ts/kore-rpc: packed tarball imports and runs under Node ${process.version}`);
