# @kframework-ts/cterm

Immutable, offline **constrained KAST terms** for the K Framework. A `CTerm`
holds one cell-shaped configuration and normalized matching-logic constraints;
`CSubst` holds a syntactic substitution plus additional constraints.

> **Unofficial.** This package is not affiliated with, endorsed by, or
> supported by Runtime Verification, Inc. or the K Framework maintainers.

This is a TypeScript transcription of pyk's `cterm` module at K
**v7.1.337**. The pure main entry point imports only
`@kframework-ts/kast`, needs neither a K installation nor network access, and
preserves pyk's persistence dictionaries. The separate `./symbolic` subpath
adds `konvert` and `kore-rpc`.

```ts
import { CSubst, CTerm } from "@kframework-ts/cterm";
import { kapply, kvariable } from "@kframework-ts/kast";

const pattern = new CTerm(kapply("<generatedTop>", [kapply("<k>", [kvariable("X")])]));
const state = new CTerm(kapply("<generatedTop>", [kapply("<k>", [kapply("foo")])]));

const subst = pattern.match(state); // Subst { X |-> foo() }
const constrained = new CSubst(subst ?? undefined).apply(pattern);
```

## Guarantees

- Construction is canonical: weak `#Top`/`#Bottom` are absorbing; constraints
  are flattened, structurally deduplicated, tautologies removed, and sorted by
  pyk's `(len(repr(term)), repr(term))` key.
- `toDict` / `fromDict` use pyk's `{ config, constraints }` and
  `{ subst, constraints }` data shapes, not a new KAST node or a KAST-JSON
  envelope.
- Matching is syntactic KAST matching. `matchWithConstraint` returns target
  constraints left after applying the configuration substitution; `match`
  succeeds only when none remain.
- `ctermAntiUnify`, `ctermsAntiUnify`, `ctermBuildRule`, and
  `ctermBuildClaim` stay pure wrappers over KAST operations.

## Symbolic adapter

`@kframework-ts/cterm/symbolic` is a separate async entry point. It accepts an
injected `KoreClient`-compatible object and codec, so importing it never starts
a server. It converts `CTerm.kast` through `konvert`, sends it to `kore-rpc`,
and returns the full RPC outcome alongside decoded CTerms/substitutions:

```ts
import { CTermSymbolic } from "@kframework-ts/cterm/symbolic";

const symbolic = new CTermSymbolic(client, definition);
const result = await symbolic.execute(state, { maxDepth: 100 });

console.log(result.reason); // "branching", "timeout", "aborted", …
console.log(result.raw); // the untouched kore-rpc result, including logs
```

`implies` preserves `valid | invalid | indeterminate`; it does not collapse an
indeterminate backend result into `false`. Its `csubst` is present **exactly
when** the status is `valid` — a valid response whose `condition` the backend
omitted yields the trivial `CSubst()`, since `csubst !== undefined` is how every
consumer asks "did the implication hold?". `execute` likewise preserves raw halt
reasons, aborted predicates, logs, and branch rule predicates. RHS-only
variables in `implies` are bound existentially by default; pass
`bindRhs: "forall"` to quantify them universally, or `bindRhs: "none"` to
leave them free.

An SMT-solver failure arrives as a `CTermSMTError` rather than the wire error,
carrying the offending pattern pretty-printed against the definition
(`cterm/symbolic.py:376-379`) instead of thousands of characters of escaped
KORE. Every other backend failure propagates untouched.

Pass `failureReason: true` to have a non-valid verdict diagnosed, exactly as
pyk's `failure_reason` does (`cterm/symbolic.py:330-359`): one extra `implies`
round trip asks whether the configurations alone match, and the result carries
either `failingCells` — `[cellName, antecedentCell => consequentCell]` pairs,
with a cell the consequent lacks rewritten to `.K` — or, when the
configurations _did_ match, the `remainingImplication` over the constraints.
The two are mutually exclusive. `@kframework-ts/kcfg`'s
`KCFGExplore.implicationFailureReason` renders exactly this data.

### Instance request policy

The constructor carries pyk's per-instance request defaults
(`cterm/symbolic.py:96-122`) and stamps them on every request it makes; a
per-call option of the same name always wins.

| option                  | default                   | applied to                               |
| ----------------------- | ------------------------- | ---------------------------------------- |
| `logSuccessfulRewrites` | `true`                    | `execute`                                |
| `logFailedRewrites`     | `false`                   | `execute`, and only when the above is on |
| `boosterOnly`           | `false`                   | `execute`, `simplify`, `implies`         |
| `haskellLogEntries`     | `HASKELL_LOGGING_ENTRIES` | requested when `haskellLogging` is on    |
| `haskellLogging`        | `false`                   | `execute`, `simplify`, `implies`         |

`logSuccessfulRewrites` defaulting on is what makes rule provenance exist:
without it the response has no `logs`, `KCFGExplore` has no rule ids to
resolve, and `./trace` has nothing to assemble. pyk derives its
`haskell-logging` switch from a `haskell_log_dir` it writes files into; this
adapter writes no files — the entries come back on `raw` — so the switch is
explicit instead.

## Execution traces

`@kframework-ts/cterm/trace` joins an `execute` response's rewrite log against
a definition index and projects attributable, deterministic, machine-readable
records. It is pure: no processes, no filesystem.

```ts
import { assembleTrace, traceContext, traceRuleCounts, traceToJsonl } from "@kframework-ts/cterm/trace";

const context = traceContext(symbolic); // index once, reuse per program
const result = await symbolic.execute(start, { maxDepth: 1000 });
const trace = assembleTrace(result.raw.logs, context);

await Bun.write("trace.jsonl", traceToJsonl(trace));
console.log(traceRuleCounts(trace)); // per-rule fire counts for this run
```

Each record is `index`, `outcome`, `ruleId`, `resolved`, `label`, `source`,
`location`, `module`, `origin`, `reason`, `substitution` — every key always
present, `null` rather than absent. `traceToJsonl` is byte-identical for
byte-identical input: fixed key order, sorted substitution keys, no timestamps.
`traceRuleIndexFromKast` builds the join table from a `KDefinition` (what
`traceContext` uses, and what costs no I/O); `traceRuleIndexFromKore` builds
the same table from a parsed `definition.kore`.

**What a live server actually emits**, measured at K v7.1.337 /
haskell-backend v0.1.155 against both `kore-rpc` and `kore-rpc-booster`: one
`rewrite`/`success` entry per rewrite step, in order, carrying **the 64-character
rule id and nothing else**. `substitution` and `rewritten-term` are hard-coded
to `Nothing` by both servers (`Booster/JsonRpc.hs:658-669`,
`Kore/JsonRpc.hs:198-212`), so `TraceEntry.substitution` is `null` in practice;
the field is implemented because the protocol type is the contract. A
_branching_ step contributes no log entry at all — its rule ids arrive on
`nextStates[].ruleId` instead.

## Live K conformance

The repository carries an opt-in lane for the upstream `simple-proofs` and
multiple-definitions scenarios. It compiles the vendored definitions, starts a
Haskell `kore-rpc` server, and exercises the public symbolic adapter end to end:

```sh
KFRAMEWORK_TS_K_BIN=/path/to/k-7.1.337/bin \
KFRAMEWORK_TS_KOMPILE_CACHE=/tmp/kframework-ts-kompile-cache \
bun test packages/cterm/test/live-k.test.ts
```

The shared `@kframework-ts/ktool/testing` harness rejects any K release other
than v7.1.337. Without `KFRAMEWORK_TS_K_BIN`, these tests skip and the normal
workspace suite remains K-free. See `test/fixtures/live-k/PROVENANCE.md` for
the exact upstream sources and hashes.

## Rendering a CTerm

`CTermShow` is pyk's `cterm/show.py`, and it is pure: it takes a
`(term: KInner) => string` printer and returns lines. Nothing about it needs a
kompiled definition, so it stays in the main entry point; composing a real
printer into it is the caller's job.

```ts
import { CTermShow } from "@kframework-ts/cterm";

const show = new CTermShow(kprint.prettyPrint.bind(kprint), { minimize: false });
console.log(show.show(cterm).join("\n"));
```

Before printing, the configuration is rewritten in pyk's order: a cell holding
a single `_Set_`/`_List_`/`_Map_` is flattened so each item prints on its own
line; any application named in `omitLabels` becomes `...`; and `minimize` runs
`minimizeTerm`, keeping the variables the constraints mention. Constraints are
never rewritten — each prints prefixed `#And `, with continuation lines
indented two spaces. `let()` returns a reconfigured copy sharing the printer.

`@kframework-ts/kcfg/show` builds `NodePrinter`/`KCFGShow` on top of this, and
`@kframework-ts/proof/show` builds `APRProofShow` on top of that.

## Non-goals

This package does not start K processes or parse a compiled definition. The
optional symbolic entry point makes only the calls supplied by its injected
client; process management remains outside this package. For the same reason
`./trace` stops at the assembler: a corpus runner that spawns a server per
definition and writes a file per program composes `@kframework-ts/kore-rpc/server`
with `traceToJsonl`, and is the caller's, not this package's.

KCFG/proof graphs and `KProve` orchestration are intentionally left to
higher-level packages that consume this foundation. Pyk's `kcfg/show.py`,
`proof/show.py` and `tui.py` are not this package's business either — the
first two live in the sibling packages that own those artifacts, and the TUI
is not being ported at all.

## Version identity and source drift

```ts
import { K_RELEASE, checkCtermSources } from "@kframework-ts/cterm";

console.log(K_RELEASE); // "v7.1.337"
```

`checkCtermSources` takes an injected fetcher and compares the source hashes
recorded in `TRANSCRIBED_FROM`; it is deliberately pure and testable offline.
The same check is available to humans and CI:

```sh
cterm check-k v7.1.400
```

It exits `0` unchanged, `1` changed, `3` when K moved a source path, and `2`
when it could not run.

The package is ESM-only, supports Node 20+ and Bun 1.3+, and is dual-licensed
under MIT or Apache-2.0. See `THIRD-PARTY-NOTICES.md` for the BSD-3-Clause
notice carried from K/pyk.
