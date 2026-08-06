# Fixture provenance

Every file here is **byte-for-byte what the upstream repositories carry** —
none of it is hand-authored, reformatted, or trimmed. This package is a
hand-transcription of the kore-rpc JSON-RPC protocol, and a hand-transcription
is not self-verifying; these fixtures are the evidence. `SHA256SUMS` (in this
directory) records a checksum for every fixture file; regenerate with the
command at the bottom of this document.

Several tiers here are **byte-exact compact JSON** (`kore-rpc-server/*.golden`
is one physical line each). Running a formatter over this directory destroys
the oracle. The workspace `.oxfmtrc.json` / `.oxlintrc.json` ignore every
`fixtures` directory by that bare pattern — see the "Formatter exclusion" note
at the end.

## Where everything was read from

| Repo | Identity at copy time |
| --- | --- |
| `runtimeverification/k` | tag `v7.1.337`, commit `4a46d1231473b599c699160132fd6e76a5c46406` |
| `runtimeverification/haskell-backend` (the `haskell-backend` submodule that k tag pins, at `haskell-backend/src/main/native/haskell-backend`) | tag `v0.1.155`, commit `38afc81fc9414f1e11e609b01a43a436b613bd2d` |

Copied **2026-08-05** out of local checkouts at exactly those commits, with
`cp` (no `git show` needed). Both checkouts were verified before copying:
`git rev-parse HEAD` matched the commits above, `git tag --points-at HEAD`
matched the tags above, and `git status --porcelain` was **empty** for both —
i.e. clean trees, no local modifications, no untracked files. These are the
same two identities `packages/kore/fixtures/PROVENANCE.md` records.

Path abbreviations below: `K` = the k checkout, `HB` = the haskell-backend
submodule checkout inside it.

| dir | files | bytes | upstream root |
| --- | ---: | ---: | --- |
| `smoke/` | 4 | 19,718 | `K:k-distribution/tests/smoke/krpc-test/` |
| `pyk-rpc/` | 13 | 38,601 | `K:pyk/src/tests/integration/test-data/pyk-rpc-{print,kast}/` |
| `kore-rpc-server/` | 131 | 118,084 | `HB:test/rpc-server/` |
| `booster-rpc/` | 202 | 769,560 | `HB:booster/test/rpc-integration/` |
| `classification/` | 9 | 298,787 | `HB:booster/test/jsonrpc-examples/` |
| **total** | **359** | **1,244,750** | |

No vendored file exceeds 1 MB. The largest is
`classification/foundry-proof.implies.request` at 176,230 bytes. Nothing was
excluded on size grounds *within* the selections below; the multi-megabyte
directories that were excluded wholesale are listed per section.

## `smoke/` — the krpc happy path and the only parse-error pair (4 files)

From `K:k-distribution/tests/smoke/krpc-test/`: `plus-request.json`,
`plus-response.json`, `rubbish-request.json`, `rubbish-response.json`.

Upstream these are driven by that directory's `Makefile`, which kompiles
`../imp.k` for both the haskell and llvm backends, starts `kore-rpc-booster`,
and runs `kore-rpc-client --port P send <stem>-request.json --expect
<stem>-response.json` (Makefile lines 44-53). So:

- the `*-request.json` files are **complete request envelopes** sent verbatim
  (`send` mode = "send the JSON as-is"), not params fragments;
- the `*-response.json` files are `kore-rpc-client` `--expect` files, therefore
  pretty-printed and compared **structurally**, not byte-exactly — same
  semantics as `booster-rpc/` below.

`rubbish-request.json` is 8 bytes of non-JSON; `rubbish-response.json` is the
corpus's only `-32700` parse-error response.

**Not copied:** the `Makefile` (build/driver harness, needs a live server and
a kompiled IMP) and the `.k` sources it kompiles.

## `pyk-rpc/` — pyk's rpc-print / rpc-kast corpus (13 files)

Two source directories, each kept in its own subdirectory:

- `pyk-rpc/print/` (8 files) — every `*.json` in
  `K:pyk/src/tests/integration/test-data/pyk-rpc-print/`: one execute request,
  five execute responses (`depth-bound`, `terminal-rule`, `cut-point-rule`,
  `branching`, `stuck`), one simplify request, one simplify response. Driven
  upstream by `TestRpcPrint` in `K:pyk/src/tests/integration/test_pyk.py:101-131`.
- `pyk-rpc/kast/` (5 files) — every `*.json` **and** every `*.json.golden` in
  `.../pyk-rpc-kast/`: 3 inputs (`imp-execute-request.json`,
  `imp-simplify-request.json`, `imp-execute-depth-bound-response.json`) and the
  2 derived-request goldens
  (`imp-execute-request-from-execute-response.json.golden`,
  `imp-simplify-request-from-execute-response.json.golden`).

  The `.json.golden` files are the output of `pyk rpc-kast <reference-request>
  <input-response>` — a *new request* built by taking the reference request's
  params and substituting the term carried by the response
  (`test_pyk.py:147-188`). They are compared with `json.loads(...) ==
  json.loads(...)` (`test_pyk.py:186-188`), i.e. **structurally**, not
  byte-exactly.

**Not copied:** the 8 `*.pretty.golden` files in `pyk-rpc-print/`. Those are
pretty-printed *K* output of `pyk rpc-print`, an oracle for the K
pretty-printer (which needs a kompiled definition), not for the wire protocol.
Upstream even compares them as an unordered set of stripped lines
(`test_pyk.py:129-131`).

## `kore-rpc-server/` — byte-exact wire goldens (131 files)

From `HB:test/rpc-server/`, the full tree with the exclusions listed below.
Structure preserved exactly: `<method>/<case>/…` plus the top-level
`README.md` and the `add-module/{add,execute}/` session pair.

Kept: every `params.json`, `state.json`, `antecedent.json`, `consequent.json`,
every `*.golden`, every `README.md` (the top-level harness doc and the
per-case docs), and `execute/zero-steps/state.kore`.

### Comparison semantics a consumer MUST know

**1. The goldens are BYTE-EXACT single-line wire responses.**
`checkGolden` (`HB:test/rpc-server/runTests.py:79-104`) does a raw
`bytes != bytes` comparison of the golden against everything read off the
socket. Those bytes are what the server emitted: `jsonRpcServer` encodes with
aeson-pretty using `rpcJsonConfig{confIndent = Spaces 0, confTrailingNewline =
True}` (`HB:kore-rpc-types/src/Kore/JsonRpc/Server.hs:91-98`), so each golden
is one physical line with no inter-token whitespace and exactly one trailing
`\n`. Key order is **not** insertion order and **not** alphabetical: it is the
explicit `PrettyJson.keyOrder` list in
`HB:kore-rpc-types/src/Kore/JsonRpc/Types.hs:298-342` (`format`, `version`,
`term`, `tag`, …, `jsonrpc`, `id`, `reason`, `depth`, `rule`, `state`,
`next-states`, `substitution`, `predicate`, `valid`, …, `code`, `data`,
`timestamp`, `context`, `message`); keys absent from that list sort after the
listed ones. Reproducing these bytes requires implementing that key order.

**2. Requests are NOT stored — they are reconstructed.**
No request envelope exists on disk for this corpus. `runTests.py` builds each
one from the pieces, via `rpc_request_id1` (`runTests.py:44-50`, which is
`jsonrpcclient.request(method, params=params, id=1)` — i.e. `jsonrpc: "2.0"`,
`id: 1`, the method name, and the params object). Per method:

| method | reconstruction | runTests.py lines |
| --- | --- | --- |
| `execute` | `params = params.json`, then `params["state"] = state.json` | **160-172** (and again at 176-188 for the `--smt-tactic '(check-sat-using smt)'` re-run against the *same* goldens) |
| `implies` | `params = {"antecedent": antecedent.json, "consequent": consequent.json}` — there is no `params.json` for implies | 192-206 |
| `simplify` | `params = {"state": state.json}` | 211-221 |
| `get-model` | `params = {"state": state.json}` | 302-312 |

So the request for an `execute` case is exactly
`{"jsonrpc":"2.0","id":1,"method":"execute","params":{…params.json, "state": …state.json}}`.
Member order in the request is *not* load-bearing — requests are never
byte-compared, only responses are.

Caveat: `simplify/list-matching/params.json` exists on disk but the simplify
loop (`runTests.py:211-221`) never reads a `params.json`, so it is inert
upstream. It is vendored anyway, as-found.

**3. `get-model` goldens are authoritative ONLY on `result.satisfiable`.**
`runTests.py:152-156` routes `get-model` to `checkGoldenGetModel`
(`runTests.py:106-133`), which JSON-decodes both sides and compares **only**
`golden["result"]["satisfiable"]` against `response["result"]["satisfiable"]`.
The `substitution` in those goldens is whatever the SMT solver happened to
return on the day the golden was written and is **not stable** — do not assert
on it. (The booster client applies the same rule for get-model, see
`sameModuloModel` in `HB:booster/library/Booster/JsonRpc/Utils.hs:55-58`.)

**4. `add-module/` is a stateful 6-request session on ONE socket.**
Unlike every other case here, `add-module` is not a single request/response.
`runTests.py:246-298` opens one server (definition `add-module/add/definition.kore`,
`--module TEST`) and one socket, then sends six requests in this fixed order,
checking each against a specific golden:

| # | request | golden |
| --- | --- | --- |
| 1 | `execute` with `params = {…add-module/execute/params.json ("module":"NEW"), "state": …}` | `add-module/execute/response-fail.golden` — error 3 `Could not find module`, `data: "NEW"` |
| 2 | `execute` with `params = {"state": …}` only (no `module`) | `add-module/execute/response-defaultmodule.golden` — stuck at `d` |
| 3 | `add-module` with `params = add-module/add/params.json` | `add-module/add/response.golden` — `{"module":"m8e723e34…"}` |
| 4 | the **same** `add-module` request again | the **same** `add-module/add/response.golden` — re-adding is idempotent |
| 5 | request #1 repeated verbatim | `add-module/execute/response-success.golden` — now stuck at `f` |
| 6 | request #2 repeated verbatim | `add-module/execute/response-defaultmodule.golden` again — the default module is unaffected |

The request objects are prepared once at `runTests.py:225-244` and reused, so
requests 1/5 and 2/6 are byte-identical; only the server's accumulated state
differs. This is the corpus's only evidence for add-module statefulness and
for the `"m" + sha256(moduleText)` module-id law.

### Excluded from `kore-rpc-server/`, and why

- **every `definition.kore`** — 15 of the 24 cases reach theirs through a
  symlink into `resources/`; the rest are 250 KB–735 KB inline files. Neither
  the links nor the targets were copied. `packages/kore/fixtures/definitions/`
  already vendors the two interesting ones (`empty`, `a-to-f`) for the KORE
  parser. A client needs the definition only to *run* a live server.
- **all `*.k` files** — K sources for the definitions above, including the
  symlink `simplify/list-matching/test.k → ../../execute/list-matching/test.k`.
- **`implies/refuse-macro-and-alias/`** — 16 MB (14.8 MB `definition.kore`,
  464 KB antecedent, 553 KB consequent) for one 347-byte golden.
- **`resources/`** — definitions and their `.k` sources only; every file in it
  is either a `definition.kore` or a `*.k`.
- **`Makefile`, `runTests.py`** — the driver harness. `runTests.py` is cited by
  line above rather than vendored, per instruction.
- **`default.nix`** — build harness, same category as the excluded `Makefile`,
  no fixture value. *(Deviation note: this was not on the explicit exclusion
  list; excluded by analogy and recorded here.)*

**Symlinks:** after excluding `definition.kore` and `*.k`, **no symlink
remained** in the selected set — all 131 files are upstream regular files, so
no `cp -L` resolution was needed for this directory. (`cp -L` was used anyway,
harmlessly.)

**Deviation note — `execute/zero-steps/state.kore` was kept.** It is not JSON
and not on the "keep" list, but it is also not on the exclusion list: it is the
textual-KORE intermediate from which `state.json` was generated, which the
upstream `README.md` (lines 49-53, 68-78) documents as an optional per-case
input. 5 KB, and it pairs a textual-KORE term with its KORE-JSON form — useful
to `@kframework-ts/kore`. Kept as-found.

## `booster-rpc/` — complete request envelopes, structural comparison (202 files)

Cherry-picked from `HB:booster/test/rpc-integration/`. Only these eight test
directories were taken, each preserved as `booster-rpc/<dir>/`:

| dir | files | bytes |
| --- | ---: | ---: |
| `test-pathological-add-module/` | 49 | 21,103 |
| `test-implies/` | 23 | 15,862 |
| `test-implies-smt/` | 16 | 72,626 |
| `test-implies2/` | 21 | 441,888 |
| `test-get-model/` | 21 | 37,926 |
| `test-a-to-f/` | 21 | 105,674 |
| `test-simplify/` | 34 | 49,050 |
| `test-module-addition/` | 17 | 25,431 |
| **total** | **202** | **769,560** |

Taken from each: `*.send`, `response-*.json`, `response-*.booster-dev`,
`response-*.kore-rpc-dev`, `params-*.json`, `state-*.execute`,
`state-*.simplify`, `state-*.get-model`, `state-*.add-module`, and `README*`.

### Comparison semantics a consumer MUST know

**1. Responses are PRETTY-PRINTED and compared STRUCTURALLY.**
These are not wire bytes. `kore-rpc-client --expect <file>` re-encodes the
received response with `Json.encodePretty' rpcJsonConfig`
(`HB:booster/tools/rpc-client/RpcClient.hs:787-790`) and then diffs it with
`diffJson expected prettyOutput` (`RpcClient.hs:771-785`). `diffJson`
(`HB:booster/library/Booster/JsonRpc/Utils.hs:48-70`) decodes **both** sides
into typed `KoreRpcJson` values and compares those — so whitespace and key
order are irrelevant, and it additionally treats two responses as identical
when they differ only by branching order of an `execute` result
(`sameModuloBranchOrder`, `Utils.hs:51-54`) or by the substitution of a
`get-model` result (`sameModuloModel`, `Utils.hs:55-58`). **Never** assert
these files byte-for-byte; decode and compare structurally, and expect
next-state order and get-model substitutions to be unstable.

**2. Request reconstruction is driven by the state file's SUFFIX.**
`runDirectoryTest.sh:105-127` globs `state-*.{execute,send,simplify,add-module,get-model}`,
derives `TESTNAME` from the middle, and dispatches on the suffix:

- `.send` — the file **is** a complete JSON-RPC envelope; sent as-is. (This is
  why `test-pathological-add-module/` and `test-implies*/` use `.send`: they
  are the only fixtures in the whole corpus carrying real request envelopes,
  including their `id` values and, for the add-module cases, `name-as-id`.)
- `.execute` / `.simplify` / `.get-model` / `.add-module` — the file is the
  *state* (or, for `add-module`, the module text); the client builds the
  request for that method and merges `params-<TESTNAME>.json` if it exists
  (`runDirectoryTest.sh:111-115`).

Expected response file: `response-<TESTNAME>.json`, or a per-binary variant —
see next.

**3. `.booster-dev` / `.kore-rpc-dev` are per-server-binary expected
responses for the same request.** `runDirectoryTest.sh:117-126` selects:

| expected file | used when the server binary is | what that binary is |
| --- | --- | --- |
| `response-X.booster-dev` | `booster-dev` | the booster (LLVM-assisted) rewriter **standalone**, with no kore fallback |
| `response-X.kore-rpc-dev` | `kore-rpc-dev` | the legacy Haskell `kore` server **standalone** |
| `response-X.json` | **everything else** — and as the fallback for `booster-dev`/`kore-rpc-dev` whenever the matching variant file does not exist | the default `server=${SERVER:-$bindir/kore-rpc-booster}` (`runDirectoryTest.sh:42`), i.e. the **`kore-rpc-booster` proxy** (booster first, kore fallback) |

Which binaries each directory is actually driven with is set by
`HB:scripts/booster-integration-tests.sh:27-72`:

| dir | servers run against it |
| --- | --- |
| `test-a-to-f` | `booster-dev`, `kore-rpc-dev`, `kore-rpc-booster` (lines 31-35) |
| `test-pathological-add-module` | `kore-rpc-dev`, `kore-rpc-booster` (lines 36-39) |
| `test-get-model`, `test-implies`, `test-implies2`, `test-implies-smt` | `booster-dev`, `kore-rpc-booster` (lines 40-43) |
| `test-simplify` | `booster-dev` only (lines 52-54) |
| `test-module-addition` | default case: `kore-rpc-booster` only (lines 69-71) |

So a `.json` file in `test-simplify/` is what **`booster-dev`** produced
(nothing else runs there), while a `.json` in `test-a-to-f/` is what the
**`kore-rpc-booster` proxy** produced *and* what `booster-dev`/`kore-rpc-dev`
must produce wherever no variant file overrides it. Read the pair
(`booster-integration-tests.sh` case + presence of a variant file) before
attributing a golden to a binary.

### Excluded from `booster-rpc/`, and why

- **the other 31 `test-*` directories** — not requested; the largest,
  `test-foundry-bug-report/`, is 92 MB (an unpacked pyk `--bug-report`
  tarball with a 13.7 MB response).
- **`resources/`** — 206 MB of `definition.kore` / `.dylib` / `.kompile`
  material. See the symlink note below for the one narrow exception.
- **`*.kore` files, definition files, `*.tar.gz`** — none matched the copy
  patterns anyway (verified: zero `.kore`/`.tar.gz` in the selected set).
- **`README.md` and `runDirectoryTest.sh` at the `rpc-integration/` root** —
  driver harness; cited by line above instead. (Per-directory `README.md`
  files, which document the individual cases, *were* copied.)

### Symlinks resolved with `cp -L` (11 files)

Every one of these is an upstream symlink whose target lives under
`rpc-integration/resources/`. The *bytes* were copied into the destination
filename; no `resources/` directory exists here, and no `.kore`-suffixed file
was created.

| vendored path | upstream target | bytes |
| --- | --- | ---: |
| `test-a-to-f/state-branching.execute` | `resources/a-to-f/state-a.json` | 1,666 |
| `test-a-to-f/state-cut-point.execute` | `resources/a-to-f/state-c.json` | 1,665 |
| `test-a-to-f/state-depth-limit.execute` | `resources/a-to-f/state-c.json` | 1,665 |
| `test-a-to-f/state-terminal-rule.execute` | `resources/a-to-f/state-c.json` | 1,665 |
| `test-a-to-f/state-zero-steps.execute` | `resources/a-to-f/state-d.json` | 1,666 |
| `test-module-addition/state-01-from-c.execute` | `resources/a-to-f/state-c.json` | 1,665 |
| `test-module-addition/state-02-invalid-module.execute` | `resources/a-to-f/state-c.json` | 1,665 |
| `test-module-addition/state-03-add-new-module.add-module` | `resources/module-addition/module-addition-new.kore` | 1,442 |
| `test-module-addition/state-04-from-c-new.execute` | `resources/a-to-f/state-c.json` | 1,665 |
| `test-module-addition/state-05-from-c-again.execute` | `resources/a-to-f/state-c.json` | 1,665 |
| `test-module-addition/state-06-from-c-test.execute` | `resources/a-to-f/state-c.json` | 1,665 |

**Deviation note on the last-but-three row.** `state-03-add-new-module.add-module`
resolves to a file that is both *under `resources/`* and *named `*.kore`* —
two of this directory's exclusion rules. It was copied anyway because it is
1.4 KB of **request payload**, not a definition: it is the string that becomes
the `module` param of the `add-module` request in `test-module-addition`'s
6-step session, and without it that session (requests 03-06, the only booster
add-module-then-execute sequence vendored) cannot be reconstructed. The
destination file is not named `*.kore` and is not under a `resources/`
directory. Recorded here so the exception is explicit.

### Deviation note — one extra file kept, and two orphans

- `test-a-to-f/state-terminal-rule-with-logging.json` was copied even though
  its name matches none of the requested patterns. It completes the
  `params-terminal-rule-with-logging.json` / `response-terminal-rule-with-logging.json`
  triple already selected — our only booster `execute` fixture exercising
  `log-successful-rewrites` (12 KB response full of log entries). Note that
  because it ends in `.json` and not `.execute`, `runDirectoryTest.sh:105`
  does **not** glob it, so this test is currently **inert upstream**. It is
  vendored as data, not as a passing upstream case.
- `test-simplify/params-with-logging.json` is likewise an orphan upstream (no
  `state-with-logging.simplify`, no `response-with-logging.json`). It matched
  the requested `params-*.json` pattern and was copied as-found.

## `classification/` — the filename-encodes-the-type oracle (9 files)

From `HB:booster/test/jsonrpc-examples/`: `README.md` plus every **regular
file** at the top level.

Per that README, each filename's suffix declares the expected classification
by `decodeKoreRpc`, and `Test.Booster.JsonRpc.DiffTest` asserts the file
classifies that way:

| suffix | expected `KoreRpcType` |
| --- | --- |
| `.<method>.request` | `RpcReq <Method>` |
| `.<method>.response` | `RpcResp <Method>` |
| `.error.response` | `RpcErr` (`{message, code, details}`) |
| `.kore.json` | `RpcKore` — a bare KORE-JSON term, not an RPC message |
| `.random.json` | `RpcJs` — valid JSON of unknown type |
| `.error` | `NotRpcJs` — not valid JSON at all |

The vendored files and what each one is for:

| file | classification exercised |
| --- | --- |
| `add-module.error.response` | `RpcErr` |
| `depth-limit.spaghetti-formatted.execute.response` | `RpcResp Execute` under pathological whitespace |
| `foundry-proof.implies.request` | `RpcReq Implies`, 176 KB real-world |
| `foundry-proof.simplify.request` | `RpcReq Simplify`, 50 KB real-world |
| `foundry-proof2.simplify.request` | `RpcReq Simplify`, 57 KB real-world |
| `state-a.spaghetti-formatted.kore.json` | `RpcKore` under pathological whitespace |
| `state-a.unformatted.execute.request` | `RpcReq Execute`, minified |
| `with-logging.simplify.response` | `RpcResp Simplify` carrying log entries |

### Symlinks SKIPPED (5) — mapping recorded instead

These five top-level entries are symlinks that duplicate material already
vendored (or already present) elsewhere. They were **not** copied; the mapping
is recorded here so the classification/README table can still be applied to
them by reference:

| symlink (not copied) | upstream target | where the bytes live here |
| --- | --- | --- |
| `depth-limit.execute.response` | `../rpc-integration/test-a-to-f/response-depth-limit.json` | `booster-rpc/test-a-to-f/response-depth-limit.json` |
| `terminal.execute.response` | `../rpc-integration/test-a-to-f/response-terminal-rule.json` | `booster-rpc/test-a-to-f/response-terminal-rule.json` |
| `params.random.json` | `../rpc-integration/test-a-to-f/params-cut-point.json` | `booster-rpc/test-a-to-f/params-cut-point.json` |
| `state-a.kore.json` | `../rpc-integration/resources/a-to-f/state-a.json` | `booster-rpc/test-a-to-f/state-branching.execute` (same bytes; see the `cp -L` table above) |
| `not-json.error` | `README.md` (this directory's own README) | `classification/README.md` |

Note the classification each *link name* asserts is a property of the **link
name**, not of the target's own name — e.g. `params.random.json` asserts that
`params-cut-point.json`'s bytes classify as `RpcJs` (valid JSON, not an RPC
message), and `not-json.error` asserts that a Markdown file classifies as
`NotRpcJs`. A test that wants those cases should read the vendored bytes under
the name in the right-hand column and assert the type implied by the
left-hand column.

**Not copied:** the `expected/` subdirectory. Those files are the rendered
output of the *pairwise diff* of every two files in the directory (named
`<file1>@<file2>`, per the README) — an oracle for booster's own diff renderer,
not for the protocol, and meaningless without the five skipped symlinks.

## Deliberately never vendored (recorded so nobody re-searches)

- `HB:booster/test/rpc-integration/resources/` — 206 MB.
- `HB:booster/test/rpc-integration/test-foundry-bug-report/` — 92 MB; it is
  the unpacked form of a pyk `--bug-report` tarball, and its 13.7 MB response
  is a good on-demand large-payload parse benchmark. Fetch from the checkout
  if ever needed; never commit.
- `HB:test/rpc-server/implies/refuse-macro-and-alias/` — 16 MB.
- `HB:test/rpc-server/resources/` — definitions only; the two interesting ones
  are already in `packages/kore/fixtures/definitions/`.

## License

Both upstream repositories are **BSD 3-Clause**:

- `runtimeverification/k` — `K:LICENSE.md`, "Copyright (c) 2010-2024,
  University of Illinois Board of Trustees and individual contributors."
- `runtimeverification/haskell-backend` — `HB:LICENSE`, "Copyright (c)
  2018-2021, Runtime Verification, Inc."

This document records **identity** (what was copied, from where, at which
commit). The package-level `THIRD-PARTY-NOTICES.md`, maintained separately,
carries the **notices** — mirroring how `packages/kore` splits the two.

## Formatter exclusion

The workspace `.oxfmtrc.json` and `.oxlintrc.json` ignore every `fixtures`
directory by that bare pattern, so nothing here can be reformatted by tooling.
(kast-json's PROVENANCE records the incident that motivated this.) This
matters more here than in any sibling package: `kore-rpc-server/*.golden` are
single-line byte-exact wire bytes, and reformatting them silently converts a
byte oracle into a structural one.

## Regenerating the checksum manifest

```sh
cd packages/kore-rpc/fixtures
sha256sum $(find . -type f ! -name SHA256SUMS ! -name PROVENANCE.md | LC_ALL=C sort) > SHA256SUMS
```

(Same form as `packages/kore/fixtures`, with `LC_ALL=C` added: this corpus is a
deep tree of punctuation-heavy filenames — `response-X->0.json`,
`state-add_module_twice-001.send`, `.booster-dev` vs `.json` — where a
locale-aware `sort` would order the manifest differently on different machines.
`LC_ALL=C` makes the file list byte-deterministic.)

Verify with:

```sh
cd packages/kore-rpc/fixtures && sha256sum -c SHA256SUMS --quiet
```
