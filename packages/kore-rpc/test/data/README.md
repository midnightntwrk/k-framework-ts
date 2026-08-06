# `test/data/` — hand-authored, not vendored

Everything in this directory was **written by us**. None of it came from
`runtimeverification/k`, `runtimeverification/haskell-backend`, or any other
upstream tree, and none of it is covered by `fixtures/PROVENANCE.md` or
`fixtures/SHA256SUMS` — those record the _vendored_ corpus and only that.

The distinction matters in both directions:

- these files carry no upstream copyright, so `THIRD-PARTY-NOTICES.md` does not
  and must not list them;
- they are **not evidence** of what a real server does. A vendored golden is an
  oracle; a file here is a statement of what this package believes, written to
  exercise a code path the corpus does not reach. Where the belief is derived
  from something normative, the derivation is cited in the file itself and
  below.

## Why these exist at all

Some protocol behaviour has **no upstream fixture anywhere** — surveyed across
`k` v7.1.337 and haskell-backend v0.1.155 (pyk's test suites, `test/rpc-server`,
booster's `rpc-integration` and `jsonrpc-examples`, the k-distribution smoke
tests). The full list of gaps, so nobody re-searches:

- the `cancel` exchange (upstream only exercises it live, via
  `pyk/src/tests/integration/kore/test_interrupt.py`);
- batch requests, and with them error `-32001`;
- `reason: "timeout"` (reachable only via `step-timeout` against a live legacy
  server);
- the request params `step-timeout`, `moving-average-step-timeout`,
  `assume-state-defined` and `booster-only` appear in no recorded request;
- log-entry tags `fallback` and `processing-time` (no upstream producer exists
  at v0.1.155 either);
- error codes 6 (`Aborted`) and 7 (`Multiple states`);
- every transport-level byte-stream case: partial reads, the `\n`-prefixed
  cancel, malformed lines;
- `haskell-log-entries` content — deliberately: upstream itself asserts shape
  via `jq`, never a golden, because the content is timing-sensitive. Mirror
  that; do not invent a golden.

Params, tags and codes with no fixture are pinned by the unit suites instead
(`codec.test.ts`, `errors.test.ts`, `logs.test.ts`, from `Types.hs`/`Error.hs`/
`Log.hs` and pyk's `test_client.py` tables). The two gaps that are the _client
half's_ — the cancel exchange and the transport error paths — are covered by
the files here.

### `cancel-exchange.json`

The `cancel` side channel. No upstream fixture records one — the haskell-backend
test suites drive the server through a Python client that never cancels, and
booster's `rpc-integration` corpus is request/response pairs with no out-of-band
traffic at all.

Derived from, and only from:

- the request shape: pyk `k/pyk/src/pyk/kore/rpc.py:342-353`, which builds
  `{jsonrpc, id: f'{last_request_id}-cancel', method: 'cancel', params: {}}` and
  writes it with a leading newline (`rpc.py:155-159`);
- the response: `haskell-backend/kore-rpc-types/src/Kore/JsonRpc/Server.hs:134`,
  `cancelError = ErrorObj "Request cancelled" (-32000) Null` — sent as the
  answer to the **interrupted** request, carrying that request's id, never the
  cancel's;
- the follow-up pair: nothing normative, an ordinary `simplify` exchange
  included so a test can assert the connection survives a cancel, which is the
  property that matters and the one `Server.hs:112-134` is structured around.

### `malformed-responses.json`

Byte streams a conforming server never produces, needed because the transport's
error paths have no other way in. Each entry is a raw string written verbatim to
the socket (`MockStep.raw`), with a note on what it is meant to provoke.

The `empty-line` entry is the one with an upstream referent: pyk treats an empty
`readline()` as fatal (`rpc.py:379-380`), and that is the behaviour being
pinned.

### `bug-report.tar`

The bytes one fixed recording session produces — the golden `bugreport.test.ts`
compares against, and the only file here that is not text.

There is no upstream fixture for a `BugReport` archive: pyk ships the _writer_
(`k/pyk/src/pyk/utils.py:696-743`) and no example output, and
haskell-backend's `booster/test/rpc-integration/test-foundry-bug-report/` is an
already-unpacked and re-arranged directory, not a tarball. So this file is
generated, and the interesting question is what it was checked against.

**How it was produced.** `test/helpers/bug-report-session.ts` scripts one
session — the three server-side members `src/server.ts` writes, one
`addCommand`, then one request/response pair and one cancel through
`recordingTransport` — and returns the archive bytes. This file is that
function's output, written once. The test calls the same function, so the
golden and the script cannot drift apart.

**What it was checked against.** Two independent oracles, both run at the time
the file was written:

1. **Python's `tarfile` in `GNU_FORMAT`** — the writer pyk itself uses. The same
   members, written by `tarfile` with the header fields this package fixes
   (mode `0644`, mtime `0`, uid/gid `0`, empty uname/gname — deviation 1 in
   `src/bugreport.ts`), produce a **byte-identical** 10 240-byte file. That is
   the conformance statement: this is a GNU tar archive in the sense pyk's
   consumer means, not merely one this repository can read back.
2. **`tar(1)`** — `tar tvf` lists all nine members with no warnings, and
   `tar xf` extracts them, including the `././@LongLink`-prefixed long name the
   encoder is separately unit-tested on.

**What it is evidence of.** Determinism, mainly. Nothing in the archive may
depend on the clock, the user or the machine, because a recording is meant to be
diffable between two runs of one proof; a byte comparison is the only assertion
that says so, and this is that comparison's other half. It is _not_ evidence
about what a real server sends — the request and response inside it are
hand-written envelopes, and the rules at the top of this file apply.

**Regenerating it** (only after a deliberate format change, and re-run oracle 1
before believing the result):

```ts
import { writeFileSync } from "node:fs";
import { goldenSessionBytes } from "./test/helpers/bug-report-session.ts";
writeFileSync("test/data/bug-report.tar", await goldenSessionBytes());
```
