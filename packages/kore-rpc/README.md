# @kframework-ts/kore-rpc

A TypeScript client and codec for **kore-rpc** — the JSON-RPC protocol spoken by
the K Framework haskell-backend's symbolic-execution servers (`kore-rpc`,
`kore-rpc-booster`, `booster-dev`, `kore-rpc-dev`).

> **Unofficial.** Not affiliated with, endorsed by, or supported by Runtime
> Verification, Inc. or the K Framework maintainers.

## Why this exists

This is the **protocol layer**, and it is the last one missing if you want to
drive the haskell backend from TypeScript. The monorepo already covers the two
layers underneath it:

| layer           | package                   | what it owns                                                                                 |
| --------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| **data**        | `@kframework-ts/kore`     | KORE and KORE-JSON — the `{"format":"KORE",…}` envelope every term-valued field here carries |
| **translation** | `@kframework-ts/konvert`  | KAST ⇄ KORE, the conversion a K-level consumer needs on both ends                            |
| **protocol**    | `@kframework-ts/kore-rpc` | the five methods, the framing, the errors, the logs, a client, a spawner, a session recorder |

The split is pyk's own: `KoreClient` speaks the wire, and `CTermSymbolic` layers
K-level meaning on top of it. Nothing here depends on `konvert`; combine them
yourself, exactly as pyk does.

```sh
npm install @kframework-ts/kore-rpc   # or: bun add / pnpm add / yarn add
```

One workspace dependency (`@kframework-ts/kore`) and nothing else. ESM only,
with types. Node 20+, Bun 1.3+.

## The client, end to end

```ts
import { KoreClient, koreJson, tcpTransport } from "@kframework-ts/kore-rpc";
import { parsePattern } from "@kframework-ts/kore";

const client = new KoreClient(await tcpTransport("localhost", 41011, { timeout: 30_000 }), { label: "my-proof" });
try {
  const result = await client.execute(koreJson(parsePattern(configuration)), { maxDepth: 100, module: "IMP" });
  if (result.reason === "branching") {
    for (const next of result.nextStates) console.log(next.term);
  }
} finally {
  client.close();
}
```

`execute`, `implies`, `simplify`, `getModel` and `addModule` are the five
methods; `interrupt()` is the `cancel` side channel; `lastRequestId` is what a
server log line is keyed by.

`ExecuteResult` is a discriminated union on `reason`, so `result.nextStates` is
available on `branching` and `cut-point-rule` and does not typecheck anywhere
else. `reason: "vacuous"`, `"aborted"` and `"timeout"` are **successes** — an
unhelpful verdict is not an exception. Upstream is one flat record, so a
`Maybe` field a reason does not own (a `rule` beside `stuck`, say) is still
legal wire data: it is carried raw in `result.offReasonFields` rather than
dropped, and decode→encode stays byte-identical for anything `Types.hs` admits.

### The transport is a seam, not a socket

`KoreClient`'s constructor takes a `Transport`: three methods (`request`,
`interrupt`, `close`) over **already-serialized JSON text**. `tcpTransport` is
the real one, a `node:net` socket with pyk's connect-retry loop and a line
splitter that is uncapped by default — real EVM configurations arrive as
multi-megabyte single lines, so nothing may impose a maximum of its own.

Because the seam is text in and text out, the entire codec half of this package
is testable with no sockets at all, and a runtime with no `node:net` (a browser
behind a WebSocket bridge, Deno, an in-memory double) can bring its own
transport and still use `KoreClient` unchanged.

- **`maxLineBytes` is the opt-in cap**, off by default.
  `tcpTransport(host, port, { maxLineBytes })` fails the transport as soon as
  the bytes buffered for one response line pass it — mid-line, without waiting
  for a newline that may never come. Leave it off against a real kore-rpc
  server: every possible value is a size at which _valid_ answers start
  failing, and the big lines are the big proofs. Set it when the peer is not
  trusted to be one (a proxy, a fuzzer, anything reachable from outside),
  where an endless line is a denial of service rather than a configuration.

### One request in flight, always

The server runs **one worker thread per socket**
(`kore-rpc-types/src/Kore/JsonRpc/Server.hs:178-183`), so a connection is
strictly single-flight. `TcpTransport` serializes internally: concurrent
`request` calls queue, and the second one's bytes do not reach the wire until
the first response line has been read. There is no id→promise pipelining map
here because there is nothing to pipeline.

**Parallelism means more sockets**, sized server-side by `GHCRTS=-N<n>` — an
environment variable, not a CLI flag. Open _n_ transports against one server
started with _n_ threads.

### `cancel` is a notification, not a request

`client.interrupt()` writes a `\n`-prefixed `cancel` onto the live socket and
reads nothing for it. What settles is the **pending** call, normally by
rejecting with `-32000 Request cancelled` (`isCancelledError` tells that one
from a real failure). The leading newline is load-bearing: it terminates
whatever partial request may already be on the stream so the cancel parses as
its own document. The connection stays usable afterwards — that is the entire
point of the side channel, and it is why `interrupt` is public rather than an
internal detail of a timeout you do not have (see below).

The real `kore-rpc` server never answers a cancel, but `kore-rpc-dev` and the
booster proxy both do, with `-32601 Cancel not supported` addressed to the
**cancel's** id. `TcpTransport` recognizes and drops that line rather than
handing it to the pending call, which would put every later response one
request behind, forever.

### `implies` is tri-state

```ts
const result = await client.implies(antecedent, consequent);
result.status; // "valid" | "invalid" | "indeterminate"
```

The prose specification says `implies` returns `valid: bool`. It does not, and
has not for a long time (`Types.hs:186-196`). pyk collapses the three to a
boolean; this package keeps them, because a caller deciding whether to
**escalate** needs to tell "proved false" from "gave up", and one bit cannot.

## Errors

Every JSON-RPC `error` member maps to a typed class. Codes 1–9 are **positional**
— the 1-based constructor index of `JsonRpcBackendError`, with upstream's own
comment freezing the order (`Error.hs:67-71`) — so they are transcribed as a
literal table rather than derived.

|   code | wire message               | class                  | `data` shape                                    |
| -----: | -------------------------- | ---------------------- | ----------------------------------------------- |
|      1 | `Could not parse pattern`  | `ParseError`           | object **or** bare string (legacy kore)         |
|      2 | `Could not verify pattern` | `PatternError`         | **array** of `{error, context?, term?}`         |
|      3 | `Could not find module`    | `UnknownModuleError`   | bare string (the module name)                   |
|      4 | `Implication check error`  | `ImplicationError`     | `{error, context?, term?}`                      |
|      5 | `Smt solver error`         | `SmtSolverError`       | `{error, term?}`                                |
|      6 | `Aborted`                  | `AbortedError`         | bare string — **kore-only**                     |
|      7 | `Multiple states`          | `MultipleStatesError`  | bare string                                     |
|      8 | `Invalid module`           | `InvalidModuleError`   | `{error, context?}`                             |
|      9 | `Duplicate module name`    | `DuplicateModuleError` | bare string                                     |
| −32700 | parse error                | `DefaultError`         | JSON-RPC 2.0; `id` is `null`                    |
| −32600 | invalid request            | `DefaultError`         | JSON-RPC 2.0                                    |
| −32601 | method not found           | `DefaultError`         | also `Not implemented` / `Cancel not supported` |
| −32602 | invalid params             | `DefaultError`         | the offending params, echoed                    |
| −32603 | internal error             | `DefaultError`         | JSON-RPC 2.0                                    |
| −32000 | `Request cancelled`        | `DefaultError`         | what a `cancel` produces — `isCancelledError`   |
| −32001 | cancel inside a batch      | `DefaultError`         |                                                 |
| −32002 | `Runtime error`            | `DefaultError`         | object **or** bare value (the proxy)            |
| −32003 | `Unsupported option`       | `DefaultError`         | how a booster rejects `step-timeout`            |
| −32032 | `Server error`             | `DefaultError`         | declared by the proxy, never raised at v0.1.155 |

All of them extend `KoreRpcError`, which keeps the numeric `code` and the raw
`data` that pyk's hierarchy discards. **Shapes are tolerated**: pyk crashes on
code 2's real array payload and on a context-less code 4, so this decoder
accepts every shape either server produces, and nothing is lost when one is
unrecognized — `error.data` always holds the payload verbatim.

Codes 6 and 7 have no pyk class at all; they are added here because a caller
that wants to retry on the legacy server needs to tell an abort from an
arbitrary failure.

## Starting a server

The spawner is a **separate entry point**, so the client half never links
`child_process`:

```ts
import { koreRpcServer } from "@kframework-ts/kore-rpc/server";

const server = await koreRpcServer({
  kompiledDir: "imp-kompiled",
  moduleName: "IMP",
  llvmKompiledDir: "imp-llvm-kompiled", // ← this, and only this, selects the booster
  haskellThreads: 4,
});
// server.host, server.port, server.pid; await server.close() when done.
```

- **The selection rule is pyk's, exactly**: `koreRpcServer` starts
  `kore-rpc-booster` **iff `llvmKompiledDir` is given** (`rpc.py:1591-1601`).
  Nothing sniffs the filesystem. `koreServer` and `boosterServer` are the two
  halves if you would rather be explicit.
- **The default legacy command is the bare `kore-rpc` name**, resolved through
  `PATH`. `npm run` and `bun run` prepend `node_modules/.bin`; pass an absolute
  `command` when the K distribution selection must be deterministic.
- **`haskellThreads` becomes `GHCRTS=-N<n>`**, prepended to any inherited
  `GHCRTS`. This is the only knob that makes a server able to answer more than
  one request at a time; pair it with that many transports.
- **Resolving means started, not ready.** There is no readiness signal in the
  protocol; `tcpTransport(host, port, { timeout })`'s connect-retry loop is the
  readiness mechanism, and pyk splits the two the same way.
- **`server.exited`** resolves with `{ code, signal }` when the process ends and
  never rejects, so a server that died on a usage error can be raced against the
  connect instead of burning the whole `timeout` retrying a corpse.
- `buildKoreServerCommand` / `buildBoosterServerCommand` are exported and
  **pure**, so the fiddly part — flag order, the booster's `--log-file`/`-l`
  divergence from the legacy `--log`/`--log-entries`, `--llvm-backend-library
interpreter.{so,dylib}`, and the per-binary numeric ranges (the two servers
  disagree about `--smt-timeout 0`, `--smt-retry-limit 0`, `--simplify-each 0`,
  `--smt-reset-interval` and `--log-format json`) — is testable without a
  process.

Two documented deviations from pyk live here. An **ephemeral port is allocated
by binding one and letting go**, rather than discovered from the process table
with psutil; the TOCTOU race that implies is real, and passing an explicit
`port` avoids it. And `close()` **escalates to `SIGKILL`** after a grace period
(pyk waits forever) — an orphaned prover holding a core and a Z3 is a worse
outcome than a truncated solver transcript. The kill goes to the child's whole
**process group**, and the wait is on the process's `exit` plus a short flush
window rather than on stdio EOF, so a `kore-rpc` installed as a wrapper script
cannot leave `await server.close()` hanging on a grandchild that inherited the
pipes. pyk's `--not-log-context` flag is
also deliberately not emitted: no such option exists in the v0.1.155 booster
CLI, so passing it would make the server exit with a usage error.

## Recording a session you can replay — `BugReport`

When a backend misbehaves inside a long proof, the only useful artifact is a
self-contained reproduction. `@kframework-ts/kore-rpc/bugreport` writes pyk's
`BugReport` tar (`pyk/src/pyk/utils.py:696-743`), which is the format RV's
backend maintainers accept and the one `kore-rpc-client run-tarball` replays.

```ts
import { KoreClient, tcpTransport } from "@kframework-ts/kore-rpc";
import { bugReport, recordingTransport } from "@kframework-ts/kore-rpc/bugreport";
import { koreRpcServer } from "@kframework-ts/kore-rpc/server";

const report = bugReport("proof-42.tar"); // any extension; it becomes .tar, as pyk does
const server = await koreRpcServer({ kompiledDir, moduleName: "IMP", bugReport: report });
const client = new KoreClient(
  recordingTransport(await tcpTransport(server.host, server.port, { timeout: 30_000 }), report, { id: "proof-42" }),
);
```

**Recording is a `Transport` decorator, not a client feature.** pyk records
inside `JsonRpcClient.request` because its transport is private; here the seam
is already text in and text out, so `recordingTransport` tees the exact bytes
that went on the wire — by construction, not by agreement — and `KoreClient` is
unchanged and unaware. Pass the same report to the server spawner and it seeds
the archive with what a replayer needs to stand the server back up.

```text
definition.kore                                  the haskell definition
server_version.txt                               `<server> --version`
server_instance.json                             {exe, module, extra_args}
llvm_definition/definition.kore                  booster only
llvm_version.txt                                 booster only
<id>/<instance>/<req-id>_request.json            one per request
<id>/<instance>/<req-id>_response.json           one per response
sequence/NNN                                     the member name it orders
commands/NNN.sh                                  a re-runnable command line
```

To replay:

```sh
tar xf proof-42.tar definition.kore server_instance.json   # + llvm_definition/ for a booster
kore-rpc definition.kore --module "$(jq -r .module server_instance.json)" --server-port 12341 &
kore-rpc-client run-tarball proof-42.tar --port 12341
```

`run-tarball` sends every recorded request in `sequence/` order and diffs each
answer against the recorded one, exiting non-zero on the first divergence. To
read a single file out of the archive by hand, or to turn a recorded response
into the next request, use the two commands below.

Two deviations from pyk, both deliberate:

- **The archive is deterministic, byte for byte.** pyk stamps every member with
  a temp file's mode, the process's uid/gid and the wall clock, so two identical
  sessions produce two different tarballs; here mode is `0644`, mtime `0`, and
  uid/gid/uname/gname are zero and empty (both overridable). A recording is then
  a diffable artifact, which is the whole point of leaving one. Nothing
  downstream reads those fields.
- **A `cancel` is recorded, out of sequence**, as `<req-id>_cancel.json`. pyk's
  `send_interrupt` never reaches its recorder, so upstream a cancelled request
  shows up as a request with a `-32000` answer and no trace of the cause. The
  name is inert to `run-tarball`, which only pairs `_request.json` with
  `_response.json`.

## Reading recorded traffic — `rpc-print` / `rpc-kast`

The manual RPC-debugging loop, as library functions and as two commands over
them. They are pyk's `pyk rpc-print` / `pyk rpc-kast`
(`pyk/src/pyk/__main__.py:136-236`), and they pair with the tarball above.

```sh
$ tar xf proof-42.tar && kore-rpc-ts rpc-print proof-42/1/proof-42-017_response.json
JSON RPC Response
id: proof-42-017
Method: execute
Depth: 3
Stop reason: branching
Number of next states: 2
State:
Lbl'-LT-'generatedTop'-GT-'{}(...)
...

$ kore-rpc-ts rpc-kast proof-42/1/proof-42-017_request.json proof-42/1/proof-42-017_response.json > next.json
```

`rpc-kast` builds a **new request** out of a reference request's envelope and
parameters plus the response's state, so a recorded `execute` response becomes
either the next `execute` or the `simplify` that asks what that state reduces
to — the reference's method decides. `rpcPrint` and `rpcKast` are exported from
the main entry point if you would rather call them than shell out.

Differences from pyk worth knowing:

- **Terms print as KORE, not as pretty-printed K.** pyk's `rpc-print` takes a
  `definition_dir` and runs the state through `KPrint`; this package has no KAST
  layer by design (see the layer table above), so terms are rendered in the
  surface syntax the server itself speaks — which needs no kompiled definition
  and can be pasted straight back into a request.
- **Deterministic output.** pyk iterates a `set` of parameter keys, so the same
  file prints differently between runs. Here they are sorted, and values are
  JSON rather than Python `repr`.
- **Four more shapes are readable.** pyk detects the response method by exact
  key-list equality, which misreads any response carrying
  `haskell-log-entries` and crashes outright on `implies`, on `get-model` and
  on every error response. Dispatch here is on the discriminating member, and
  an error response is described rather than rejected.

## Byte-exact emission

`emitOrdered(value)` serializes a JSON value **the way a kore-rpc server does**:
`PrettyJson.keyOrder` (`Types.hs:298-342`) at every depth, no whitespace, no
trailing newline. `JSON.stringify` emits insertion order, so a response this
package builds and a response the server built are equal as values and different
as bytes. Closing that gap buys two things: golden tests that compare bytes —
the strongest oracle a vendored fixture can give — and recorded traffic that
diffs cleanly against a real session.

The key-order table includes a dead `"valid"` entry, a field renamed to `status`
before v0.1.155. It is transcribed anyway: the list is a _position_ table, and
dropping the entry would silently shift `implication`, `condition`, `module` and
everything after it, changing the bytes of every response carrying two of them.

Requests go out with plain `JSON.stringify`, as pyk's do — key order in a request
is not observable, and re-serializing a multi-megabyte state to reorder keys
nobody compares would be a real cost for no gain.

## How this is checked

A hand-transcription is not self-verifying. **359 files (1.24 MB) of upstream
test material are vendored** under `fixtures/`, byte for byte, with every path,
hash and comparison rule recorded in [`fixtures/PROVENANCE.md`](fixtures/PROVENANCE.md).
They are not shipped in the published package.

| tier               | files | comparison                  | what it is the only source of                                                                                                        |
| ------------------ | ----: | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `kore-rpc-server/` |   131 | **byte-exact** (40 goldens) | key order and compaction; codes 1–5 and −32602; the stateful 6-request `add-module` session                                          |
| `booster-rpc/`     |   202 | structural                  | real request envelopes with their own ids, `name-as-id`, codes 8 and 9, `indeterminate`, and two binaries answering the same request |
| `classification/`  |     9 | filename-is-the-oracle      | that the decoders _discriminate_; the lenient-parse cases (a stray `"xdoesnot"` param, pathological whitespace)                      |
| `pyk-rpc/`         |    13 | structural                  | pyk's own `rpc-print`/`rpc-kast` corpus — five execute halt reasons, and the two `rpc-kast` goldens that are `rpcKast`'s oracle      |
| `smoke/`           |     4 | structural                  | the krpc happy path and the corpus's only `−32700`                                                                                   |

Why the comparison differs per tier is upstream's decision, not a convenience:
`kore-rpc-server`'s harness does a raw `bytes != bytes` on what came off the
socket, while `kore-rpc-client --expect` re-encodes and compares _typed values_,
treating branching order and get-model substitutions as insignificant. Asserting
bytes on the second tier would be asserting something upstream does not.

On top of that: pyk's `test_client.py` data tables are transcribed row for row
(the one unavoidable hand-transcription, cited by line), the `cancel` exchange
and the transport-level byte-stream cases are hand-authored (`test/data/`, with
their derivation recorded), and the client runs against a scriptable mock over
real loopback sockets. The bug-report archive gets a **byte-level golden**
(`test/data/bug-report.tar`), verified byte-identical to Python `tarfile`'s
`GNU_FORMAT` output — the writer pyk itself uses — which is what makes "this is
a GNU tar in the sense `run-tarball` means" an assertion rather than a hope, and
what pins the determinism that format deviates from pyk for. **830 tests**, no K
installation, no network, nothing outside the repository.

The one claim that cannot be made offline — that the backend's own tool
_accepts_ what this writes — was checked by hand and is recorded here rather
than asserted in CI: a session recorded against a live `kore-rpc` v0.1.155
replays clean through `kore-rpc-client run-tarball`, which finds the
`sequence/` index, sends both requests in the recorded order, matches both
responses, exits `0`, and ignores the extra `_cancel.json` member exactly as
the format analysis above predicts.

```sh
bun test
bun run check:types
bun run build
```

## Version support

There is **no protocol version and no capability handshake**. A server does not
say what it implements; you find out by error (`-32601`, `-32003`) or by
observing which fields come back. Unknown request fields are silently ignored,
which means a misspelled parameter is not an error — it is a parameter that
quietly did nothing. That is why encoding here is strict and decoding is lenient
only about _extension_.

This is a hand-transcription at haskell-backend **`v0.1.155`** / K
**`v7.1.337`** (the submodule commit that K tag pins):

```ts
import { K_RELEASE, HASKELL_BACKEND_RELEASE } from "@kframework-ts/kore-rpc";
// "v7.1.337", "v0.1.155" — assert these against your own K pin.
```

Where the Haskell and pyk disagree, the Haskell wins. Where the **prose
specification** disagrees with either, it is stale and loses to both — it still
documents `implies` as returning `valid: bool` and `get-model` as returning
`valid`, both of which would break a client written from it.

### "Does this hold at _my_ K release?" — ask it

```sh
$ npx --package @kframework-ts/kore-rpc kore-rpc-ts check-k v7.1.400
```

It fetches every file recorded in `TRANSCRIBED_FROM` at that release — the
haskell-backend tree is checked at the submodule commit the K tag pins, unless
you pass a second release explicitly — and compares sha256, reporting **two
tiers separately**:

- **format** (the six `Kore/JsonRpc/*.hs` files: the request/response records,
  the error taxonomy, the two log families, the framing): a diff here means this
  transcription must be re-verified. This tier decides the exit code: 0
  unchanged, 1 changed, 3 could not locate, 2 could not run.
- **content** (pyk's `rpc.py`, `utils.py` and `__main__.py` plus their test
  oracle and CLI surface, the cabal file, the two servers' own behaviour,
  `kore-rpc-client`'s tarball reader, the stale prose spec): advisory, printed
  without affecting the exit code. It is where every behavioural note in this
  README came from, so "advisory" means _re-read this document_, not _ignore
  it_.

The same logic is exported as `checkKoreRpcSources` if you would rather call it
than shell out.

## The differences between the three servers

You are not talking to one implementation. `kore-rpc` is the legacy Haskell
server, `kore-rpc-booster` is a proxy that tries a fast concrete backend first
and falls back, and `booster-dev` / `kore-rpc-dev` are the halves in isolation.
They do not answer the same request the same way, and a client that assumes they
do will be wrong in production and not in testing.

| behaviour                        | legacy `kore-rpc`                                                     | `kore-rpc-booster` (the proxy)                                                                           |
| -------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `reason: "timeout"`              | yes — `step-timeout` elapsed                                          | **never**; `step-timeout` is rejected with `-32003`                                                      |
| `reason: "aborted"`              | **never**; becomes error code 6                                       | yes — booster gave up, caller decides whether to escalate                                                |
| `status: "indeterminate"`        | never — kore's checks are decisive                                    | only with `boosterOnly`; otherwise the proxy escalates it away                                           |
| `logs` on `implies` / `simplify` | never emitted (both hard-code `Nothing`), despite the spec's examples |                                                                                                          |
| `logFailedRewrites`              | **ignored**                                                           | honoured                                                                                                 |
| `assumeDefined` on `implies`     | —                                                                     | a **routing switch** (try booster first), not a semantic flag; booster's own `runImplies` never reads it |

**The proxy rewrites halt reasons after simplifying**
(`booster/tools/booster/Proxy.hs:456-698`), which is the trap most likely to
cost you a day:

- `branching` → `stuck` when every next-state simplifies to ⊥;
- `branching` → _silent continuation_ when exactly one branch survives — the
  proxy keeps executing, the extra steps are counted, and a synthetic log entry
  with `origin: "proxy"` is the only trace. So a `branching` result from the
  proxy always has at least two live branches;
- `cut-point-rule` → `vacuous`;
- `depth` is **accumulated across proxy legs**, not per leg.

One more finding, pinned in `test/substitution.test.ts` so nobody rediscovers
it: **`get-model` substitutions are not at the same sort on both servers.**
Booster emits them over `SortGeneratedTopCell` like every other substitution;
the legacy kore server emits them at the _state's_ own sort, e.g.
`\equals{SortInt{}, SortBool{}}(X : SortInt{}, …)`. pyk never notices, because
`GetModelResult.from_dict` keeps the raw pattern and never flattens it. So:
flatten `execute` and `implies` substitutions with `decodeSubstitution`, and
treat `get-model`'s as server-dependent.

Of the four `logs` tags in the type, only `rewrite` has a producer at v0.1.155 —
parse all four, expect one. `unknown-predicate` is documented and never emitted.
Unknown tags are kept raw rather than thrown on, which is where pyk raises.

## What is deliberately not here

- **No request timeout.** The protocol has none, and abandoning a promise leaves
  the server computing and the socket unsynchronized. Race the promise yourself
  and call `interrupt()` — pyk's own pattern.
- **No reconnection.** A connection is _stateful_: every `add-module` lives in
  that server's session, so a silent reconnect hands back an empty module table
  and the failure surfaces much later as a `Could not find module` you know you
  added. Replaying is the caller's job because the decision is the caller's.
- **No batching.** The server supports it and rejects a `cancel` inside one
  (`-32001`), but no consumer batches and a batch on a single-worker connection
  buys no parallelism.
- **No HTTP.** kore-rpc is raw TCP (`Server.hs:78-103`); pyk's `HttpTransport`
  exists and is never used against it.
- **No proxy emulation.** The behavioural differences above are documented, not
  re-implemented — a client that guessed what the proxy would have done would be
  a second, worse proxy.
- **No KAST.** Conversion is `@kframework-ts/konvert`'s job; this package moves
  KORE-JSON and nothing else.
- **No live-server suite.** Everything here is proven offline, against
  upstream's own recorded material. An env-gated suite against a real
  `kore-rpc-booster` (mirroring pyk's
  `tests/integration/kore/test_kore_client.py`) is the natural next step and
  would add the only things offline cannot: `reason: "timeout"`, error codes
  6/7 live, and pyk's per-server logging-divergence table
  (`EXECUTE_LOGGING_TEST_DATA`, `test_kore_client.py:484` — its _facts_ are
  already documented on the types; the table itself needs a server).
- **No session _replayer_.** Recording one is here (`BugReport` above, in pyk's
  tar layout); sending it back at a server is `kore-rpc-client run-tarball`'s
  job, which ships with the haskell backend and is upstream's own consumer.
  Writing a second one in TypeScript would mean re-implementing its
  response-diffing rules, and being subtly wrong about them is worse than
  shelling out.

## Licensing

Dual licensed under either of

- Apache License, Version 2.0 (`LICENSE-APACHE`)
- MIT license (`LICENSE-MIT`)

at your option. `MIT OR Apache-2.0` is the SPDX expression in `package.json`.

Separately, this package is a close transcription of BSD-3-Clause licensed
sources from the K Framework and the haskell-backend, and BSD-3-Clause's terms
continue to govern that transcribed material whichever of the two licenses above
you take this package under. Both required notices are carried in
**`THIRD-PARTY-NOTICES.md`**, which ships with the package.
