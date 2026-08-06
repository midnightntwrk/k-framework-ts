# Execution traces

An execution trace is a machine-readable oracle for facts that a program's
final verdict cannot reveal: which semantic rule ran, the order in which rules
ran, and the concrete terms matched by each rule.

## Contract

### R1 — caller-owned output

The caller chooses where trace data is written. A run must not mutate a shared
kompiled definition directory.

### R2 — one trace per run

The caller can associate every trace with exactly one input without scanning a
shared directory or inferring ownership from process identifiers. At least 16
concurrent runs must produce one attributable trace per input with no cross-run
entries.

### R3 — stable rule identity

Each rewrite record provides the full K rule identifier, source label, source
path and location, and declaring module. Metadata absent from the definition is
represented explicitly rather than causing the record to be dropped.

### R4 — concrete substitution

Each rule attempt records its variable-to-term substitution in a versioned
machine-readable format. Two inputs that reach the same conditional rule with
different operands must have equal rule identities and substitutions containing
the different operands.

### R5 — execution order

Records preserve the order in which rule attempts occurred and carry a
monotonic index.

### R6 — deterministic output

The same definition, input, and options produce byte-identical output. The
format contains no timestamps, random identifiers, or host-dependent metadata
beyond source paths embedded in the definition. The conformance check compares
at least ten independent runs as bytes.

### R7 — machine-readable and streamable

The persisted representation is JSON Lines: one complete record per line. The
backend output can be consumed incrementally so a timeout or crash does not
discard records already emitted.

### R8 — filtering

Callers can filter rule attempts without changing the retained records' original
indices. Source-side filtering is preferable for high-volume traces; a
deterministic client-side filter satisfies the data contract.

### R9 — measured cost

The implementation publishes a reproducible comparison of the same workload
with and without tracing, including runtime overhead and trace size.

### R10 — failure preserves evidence

A parse failure, semantic rejection, trap, timeout, or runtime failure returns
the trace bytes successfully emitted plus the process outcome. An empty valid
trace is distinct from a missing or truncated trace.

## Record shape

The common consumer-facing shape is:

```ts
interface ExecutionTraceRecord {
  readonly index: number;
  readonly outcome: "success" | "failure";
  readonly ruleId: string | null;
  readonly resolved: boolean;
  readonly label: string | null;
  readonly source: string | null;
  readonly location: readonly [number, number, number, number] | null;
  readonly module: string | null;
  readonly origin: string;
  readonly reason: string | null;
  readonly substitution: Readonly<Record<string, unknown>> | null;
}
```

Fields remain present when their value is unknown so downstream readers do not
need format-dependent absence rules.

## Available interfaces

K exposes three trace-like interfaces:

| interface             | order | rule identity                          | substitution            | package                     |
| --------------------- | ----- | -------------------------------------- | ----------------------- | --------------------------- |
| LLVM coverage log     | yes   | full `UNIQUE_ID`                       | no                      | `@kframework-ts/kcovr`      |
| kore-rpc execute logs | yes   | full rule id when supplied             | no in supported servers | `@kframework-ts/cterm`      |
| LLVM proof hints      | yes   | ordinal resolved to full rule metadata | yes                     | `@kframework-ts/prooftrace` |

LLVM proof hints implement the complete per-step oracle. The other interfaces
serve coverage and symbolic-execution logging.

### LLVM proof hints

Compile with `--llvm-proof-hint-instrumentation` and run the generated
interpreter with `--proof-output`. The backend writes a binary event stream
containing rule ordinals, candidate substitutions, side-condition outcomes,
function calls, hooks, and configurations.

`@kframework-ts/prooftrace` provides bounds-checked readers, ordinal-to-rule
resolution, source attribution, KORE-to-KAST conversion, deterministic JSONL,
filtering, and native-runner helpers that preserve process status. The rich
header is generated once per definition; each traced run uses the definition's
native LLVM interpreter without a JVM or long-lived server.

This path satisfies R1–R6, the machine-readable part of R7, R8, and the
semantic-rejection and parse-failure cases of R10. Incremental file following
and the R9 benchmark are tracked in
[`packages/prooftrace/ROADMAP.md`](../packages/prooftrace/ROADMAP.md).

An LLVM runtime `abort()` can leave a zero-byte hint file because the backend
does not flush its buffered writer. The package reports that as a malformed or
missing trace, not a valid empty trace.

### kore-rpc execute logs

An `execute` request with rewrite logging enabled returns ordered log entries.
`@kframework-ts/cterm` joins them against a KAST or KORE definition and emits
the deterministic record shape above.

The supported Haskell and booster servers populate rule identity but construct
successful rewrite records with `substitution` and `rewritten-term` unset. The
protocol type permits those fields, so the assembler preserves them if a server
provides them. Branching rule identifiers arrive on `next-states`, not in the
rewrite-log array, and are joined by the symbolic-execution caller.

This path provides attribution and ordering for deterministic symbolic steps.
It is response-buffered and cannot satisfy R4 with the supported servers.

### LLVM coverage logs

`kompile --coverage` instruments semantic rules with a logger. Each successful
rewrite appends its `UNIQUE_ID` to a text file in execution order. The LLVM
runtime accepts two process-wide environment variables:

- `K_LOG_DIR` selects the output directory; and
- `K_LOG_PREFIX` prefixes the `{pid}_coverage.txt` filename.

A caller can isolate concurrent runs by assigning a separate existing directory
or prefix to each process. These variables are runtime implementation details,
not a documented K command-line contract. A nonexistent `K_LOG_DIR` can block a
run while the runtime retries the path.

Coverage logs contain no substitution or matched term. `@kframework-ts/kcovr`
reads them, resolves rules, and produces coverage reports.

## Choosing an interface

- Use `prooftrace` when substitutions or rejected side-condition attempts are
  part of the oracle.
- Use kore-rpc logs while driving symbolic execution through a server when
  ordered rule identity is sufficient.
- Use coverage logs for hit counts and Cobertura reporting.

All three formats are tied to upstream source contracts. Each owning package
exports a source manifest and a `check-k` command for drift detection.

Corpus scheduling, mutation selection, coverage aggregation, and interactive
trace presentation remain consumer responsibilities.
