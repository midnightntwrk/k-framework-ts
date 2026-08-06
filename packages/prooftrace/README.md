# @kframework-ts/prooftrace

A reader for the **K LLVM backend's proof-hint stream** — the binary trace that
`kompile --llvm-proof-hint-instrumentation` plus `krun --proof-hint` emits,
carrying, per rewrite step, **the rule that fired and the substitution it
matched**.

Written from the llvm-backend's own specification and reference implementation
at **`v0.1.140`** (the submodule commit K **`v7.1.337`** pins). Zero runtime
dependencies outside this repository.

> **Unofficial.** Not affiliated with, endorsed by, or supported by Runtime
> Verification, Inc. or the K Framework maintainers.

## Install

```sh
npm install @kframework-ts/prooftrace   # or: bun add / pnpm add / yarn add
```

Depends on `@kframework-ts/kore`, `@kframework-ts/kast`,
`@kframework-ts/konvert` and `@kframework-ts/ktool`, and on **nothing from the
registry**. ESM only, with types. Node 20+, Bun 1.3+.

**No K installation is required to _read_ a trace.** Producing one needs
`<definitionDir>/interpreter`, a self-contained native binary; producing the
rich header needs `kore-rich-header` on `PATH`, once per definition. After that,
every traced run is a bare native spawn — no JVM, no server, nothing warming up.

## Why this exists

`panopticon/K` needs a per-step oracle: which rule fired, in what order, **and
on what term** (`docs/execution-traces.md` R3–R5, and R4 in particular). Three
interfaces could in principle answer:

| interface               | rule id             | order | **substitution**                                          | speed   |
| ----------------------- | ------------------- | ----- | --------------------------------------------------------- | ------- |
| `kompile --coverage`    | yes                 | yes   | **no** — one `UNIQUE_ID` per line, and no flag changes it | native  |
| kore-rpc `execute` logs | yes                 | yes   | **no** — both servers hard-code `substitution = Nothing`  | booster |
| **LLVM proof hints**    | yes (as an ordinal) | yes   | **yes**                                                   | native  |

The middle row was measured live at K v7.1.337 / haskell-backend v0.1.155 and
came back negative: `Booster/JsonRpc.hs:658-669` and `Kore/JsonRpc.hs:198-212`
construct the rewrite-success record with the field `Nothing`, and no request
option changes it. `docs/execution-traces.md` documents the interfaces and
their boundaries.
That left one path, and this package is it.

## The shape of it

```ts
import { readFile } from "node:fs/promises";
import { readKastDefinitionFromJson } from "@kframework-ts/kast";
import { parseDefinition } from "@kframework-ts/kore";
import {
  assembleProofTrace,
  generateProofHints,
  loadKoreRichHeader,
  ordinalRuleIndex,
  proofTraceContext,
  proofTraceToJsonl,
} from "@kframework-ts/prooftrace";

const dir = "./my-kompiled"; // kompiled with --llvm-proof-hint-instrumentation --emit-json

// Once per definition.
const header = await loadKoreRichHeader(`${dir}/definition.kore`);
const context = proofTraceContext(
  ordinalRuleIndex(parseDefinition(await readFile(`${dir}/definition.kore`, "utf8"), { lazyAxioms: true })),
  readKastDefinitionFromJson(await readFile(`${dir}/compiled.json`, "utf8")),
);

// Once per program.
const { hints } = await generateProofHints(dir, initialConfiguration);
const records = assembleProofTrace(hints, header, context);
await writeFile("trace.jsonl", proofTraceToJsonl(records));
```

One line of `trace.jsonl`, reformatted (the real thing is one line, no spaces):

```json
{
  "index": 0,
  "outcome": "failure",
  "ruleId": "c0e7197f4ae04259bf957d879c5206256f47d7f868d0a8b9dac905a0d2620be7",
  "resolved": true,
  "label": "GUARDED.halve-small",
  "source": "/tmp/kfts-prooftrace-fixture/guarded.k",
  "location": [25, 24, 25, 80],
  "module": "GUARDED",
  "origin": "llvm",
  "reason": "side condition failed",
  "substitution": {
    "VarN": {
      "format": "KAST",
      "version": 4,
      "term": {
        "node": "KApply",
        "label": { "node": "KLabel", "name": "s(_)_GUARDED-SYNTAX_Nat_Nat", "params": [] },
        "args": [
          {
            "node": "KApply",
            "label": { "node": "KLabel", "name": "z()_GUARDED-SYNTAX_Nat", "params": [] },
            "args": [],
            "arity": 0,
            "variable": false
          }
        ],
        "arity": 1,
        "variable": false
      }
    }
  }
}
```

That record is a **rule attempt that a side condition rejected** — same rule id,
same label, and the only thing distinguishing it from the successful attempt in
the sibling run is `VarN`. That is R4.

## Provenance: this package is not a pyk transcription

Every other package in this repository is a hand-transcription of pyk. This one
is not, and the difference is worth being explicit about.

pyk's counterpart is `pyk/src/pyk/kllvm/hints/prooftrace.py` — 610 lines of
Python that `import`s `kore_header`, `llvm_rewrite_trace`, `llvm_rule_event` and
the rest from `_kllvm.prooftrace`, a **C++ extension module**, and adds property
accessors. It contains no parser, no sentinels, no byte offsets, no grammar.
Transcribing it would produce a package that wraps nothing.

So the normative sources are the **llvm-backend's own**, and they live in a
different repository:

| tier        | files                                                                                                                                  | what it decides                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **format**  | `docs/proof-trace.md`, `docs/binary-kore-2.md`, `ProofTraceParser.h`, `deserializer.{h,cpp}`, `serializer.cpp`, `proof_trace_writer.h` | what the bytes are                 |
| **ordinal** | `lib/ast/definition.cpp`                                                                                                               | how an ordinal becomes a rule      |
| **api**     | pyk's `prooftrace.py`, `compiler.py`, `_kompiler.py`, `test_prooftrace.py`; `kore-{rich-header,proof-trace}/main.cpp`                  | the shape, the tools, the scenario |

`src/version.ts` carries the manifest with sha256s and line counts;
`prooftrace check-k <k-release>` re-checks it against any release, resolving the
llvm-backend commit from the K tag's submodule pin. The exit code reflects the
**format** tier only — `ordinal` and `api` drift is printed as advisory, and the
`ordinal` one is the line to read, because a change there is how this package
would start attributing steps to the wrong rules while still parsing perfectly.

## What is in the box

| module        | what it is                                                               |
| ------------- | ------------------------------------------------------------------------ |
| `cursor.ts`   | a bounds-checked little-endian byte cursor — `proof_trace_memory_buffer` |
| `header.ts`   | **binary KORE 2.0 rich header**: string, sort and symbol tables          |
| `binary.ts`   | **binary KORE 2.0 terms** → `@kframework-ts/kore` `Pattern`s             |
| `events.ts`   | the hint grammar → a typed event stream, whole-buffer or streaming       |
| `ordinals.ts` | ordinal → `LABEL` / `UNIQUE_ID` / source / location / module             |
| `records.ts`  | the join, projected to `@kframework-ts/cterm`'s JSONL record             |
| `generate.ts` | the two spawns that _produce_ the header and the hints                   |

### Formats supported

| format              | version | magic                  | source                                             |
| ------------------- | ------- | ---------------------- | -------------------------------------------------- |
| proof-hint stream   | **13**  | `HINT`, `PTRC`, `CHNK` | `ProofTraceParser.h:348`, `:374-404`               |
| binary KORE **2.0** | **1**   | `\x7FKR2`              | `docs/binary-kore-2.md`, `deserializer.cpp:38-160` |

Both are asserted at parse time and a mismatch is a typed
`ProofTraceVersionError` carrying `expected`, `found` and which stream
disagreed. Binary KORE **1.x** (`\x7FKORE`, `docs/binary-kore.md`) is a
different, unrelated format and is **not** read here — nothing in a hint stream
uses it.

### Events

All eight, with every field:

| event                      | sentinel      | carries                                        |
| -------------------------- | ------------- | ---------------------------------------------- |
| `rule`                     | `0x22`        | ordinal, **substitution**                      |
| `side-condition-enter`     | `0xEE`        | ordinal, **candidate substitution**            |
| `side-condition-exit`      | `0x33`        | ordinal, result                                |
| `function`                 | `0xDD`…`0x11` | name, relative position, args (slow mode only) |
| `function-exit`            | `0x55`        | ordinal, `isTail`                              |
| `hook`                     | `0xAA`…`0xBB` | hook name, symbol, position, args, result      |
| `pattern-matching-failure` | `0x44`        | function name                                  |
| `config`                   | `0xFF`        | a whole configuration                          |

Both instrumentation modes parse: `--llvm-proof-hint-instrumentation` and the
`-slow` variant differ only in how many events they contain.

## The requirements, answered

Against `docs/execution-traces.md`, and contrasted with the kore-rpc path
(`@kframework-ts/cterm`'s `trace.ts`) where the two differ.

| req                               | this path                      | notes                                                                                                                                                                       |
| --------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 caller-owned output            | **yes**                        | the hints path is an argument of the run; nothing is written into the definition directory, unlike `--coverage`                                                             |
| R2 one trace per run              | **yes**                        | one spawn, one buffer, returned to the caller                                                                                                                               |
| R3 id + label + location + module | **yes**                        | ordinal → axiom join; the id is the same `UNIQUE_ID` a kore-rpc trace reports, so the two files join                                                                        |
| **R4 substitution**               | **yes**                        | the whole point; KAST JSON v4, keys sorted, on every record                                                                                                                 |
| R5 ordering                       | **yes**                        | the stream is written as the run proceeds                                                                                                                                   |
| R6 determinism                    | **yes**                        | ten live traced runs → one distinct hint stream and one distinct JSONL                                                                                                      |
| R7 machine-readable               | **yes**                        | JSONL, byte-identical for byte-identical input                                                                                                                              |
| R7 _streamable_                   | **partly**                     | the backend writes as it goes and `proofTraceEvents` is a generator, but this package does not read files, so a caller wanting incremental output must tail the file itself |
| R8 filtering                      | client-side                    | `filterProofTrace`, and `index` is not renumbered                                                                                                                           |
| R9 cost                           | **the engine does not change** | this instruments the interpreter the consumer already runs; the number itself is not measured here                                                                          |
| R10 failing runs trace            | **yes**, with one caveat       | an unparseable input still leaves the eight-byte header, which parses to the empty trace. See below                                                                         |

### R10's caveat: two kinds of failing run

Measured at K v7.1.337, and worth knowing before this is trusted as an oracle
for rejected programs:

| how the run fails                                             | exit    | hint file                                                                                          |
| ------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| the **input does not parse** (`Syntax error at …`)            | 255     | **8 bytes** — the `HINT` magic and the version, which parse to the empty trace                     |
| the semantics rejects the program, or it traps                | 0       | complete, last step included                                                                       |
| the runtime **`abort()`s** — e.g. `No tag found for symbol …` | SIGABRT | **0 bytes**: `abort` skips the proof writer's flush, so the buffered header never reaches the file |

The first two are what R10 asks for and both hold. The third is a genuine
hole — a run that dies inside the runtime leaves nothing at all, not even the
header, and `parseProofTrace` on an empty buffer is a `ProofTraceError` rather
than an empty trace. It is a backend behaviour, not a reader one, and the
honest thing is to state it: a corpus runner should treat "zero-byte hint file"
as "the interpreter crashed", distinct from "empty trace".

## Deliberate deviations

Each is argued in the module header that owns it.

| deviation                                                              | why                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the record is **replicated** from `@kframework-ts/cterm`, not imported | `TraceEntry.origin` is typed against the haskell-backend's `LogOrigin`, and `"llvm"` is not one of its values. `test/interchange.test.ts` pins the two shapes against each other so replication cannot drift                                               |
| ordinals are resolved by **counting declarations**                     | the `ordinal{}("N")` attribute pyk's test greps for does not exist in `definition.kore`; `preprocess` adds it in memory (`definition.cpp:233-237`). See below                                                                                              |
| `LazyAxiom` is in the ordinal filter                                   | a lazily parsed axiom is tagged `"LazyAxiom"`, not `"Axiom"`; matching only the latter yields an empty index, silently                                                                                                                                     |
| a rejected side condition becomes an `outcome: "failure"` record       | it is a rule attempted and abandoned, which is exactly what cterm's `failure` means. `{ failures: false }` drops them                                                                                                                                      |
| pre-trace and nested events are **dropped by default**                 | a hint stream records every equation the backend applied; a kore-rpc trace records the program's steps. `{ preTrace: true, depth: Infinity }` gives you everything                                                                                         |
| a `hook` does **not** open a scope                                     | it carries its result inline and has no exit event; counting it would make the depth climb forever                                                                                                                                                         |
| the `inj` sort TODO is reproduced, not fixed                           | `read_v2` leaves an injection's result sort as the header wrote it (`deserializer.cpp:145-147`); "fixing" it would make this reader disagree with `kore-proof-trace` on the same bytes. `stripInjections` is exported for callers who want the tool's view |
| `patternLength` is exposed with the reference's bug                    | `pattern_len` counts string patterns only, so a large term with no domain values reports 4. `kore-proof-trace` prints exactly this number, and a reader comparing against it needs the same arithmetic                                                     |
| `generateProofHints` defaults to `check: false`                        | R10: a run that fails still wrote bytes, and throwing on the exit status would discard them                                                                                                                                                                |
| `generate.ts` does not use `llvmInterpretRaw`                          | ktool's wrapper reads its output file as UTF-8 (`stdio.ts:120`) and a hint stream is binary. Everything else — the argv builder, `runProcess`, `withStdinFile`, the `/dev/stdin` avoidance — is reused unchanged                                           |
| no writer                                                              | forging a hint stream is forging an oracle. The tests need one and keep it in `test/encode.ts`                                                                                                                                                             |

## How an ordinal becomes a rule

The one piece of this package that is a _convention_ rather than a byte layout,
and therefore the one most likely to break quietly.

An axiom's ordinal is **its zero-based position in the sequence of `axiom` and
`claim` declarations of `definition.kore`, in file order**. Nothing writes it
into the file; `kore_definition::preprocess` assigns it at load time
(`lib/ast/definition.cpp:222-237`) over the list `add_module` filled in
declaration order (`:51-71`). Three details are reproduced:

1. **Non-required axioms still consume an ordinal** — `next_ordinal++` runs
   before the `erase` at `:229`.
2. **Claims count**: the KORE parser gives `claim` a `kore_axiom_declaration`
   with `is_claim` set (`KOREParser.cpp:228`).
3. Alias expansion and `insert_reserved_symbols` add no declarations, so neither
   shifts the numbering.

**The pyk discrepancy.** pyk's own test resolves an ordinal by grepping the
definition text for `ordinal{}("N")` (`test_prooftrace.py:24-29`). That
attribute is **not in `definition.kore`** — `preprocess` adds it to the
in-memory axiom, which is why the test calls `definition.preprocess()` first and
greps `repr(definition)`. A reader that has only the file cannot use that path.
Counting is the same numbering by construction, and it is checked against
`kore-proof-trace`'s own resolution over three real traces.

## How this is known to be right

`test/reference.test.ts` renders this package's parse in `kore-proof-trace`'s
exact output format and diffs it, **byte for byte**, against what
`kore-proof-trace` actually printed, over three complete traced runs. One diff
covers the header's three tables, every term in the stream, all eight event
kinds, and 200+ ordinal resolutions per run. `test/live-k.test.ts` re-runs the
tool live and re-establishes the same diff against whatever K is installed.

If this package and the backend disagree about a single byte, that test says so.

## Errors

| class                    | when                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `ProofTraceError`        | a malformed byte, with `offset` — `xxd -s <offset>` lands on it                                 |
| `ProofTraceVersionError` | the stream declares a version this package does not read; carries `stream`, `expected`, `found` |

Nothing here returns `null` for "malformed", which the C++ does all the way up
(`ProofTraceParser.h:359-747`): a caller needs to know _where_ the stream
stopped making sense, and that is what this package is for.

## CLI

```sh
prooftrace read <header> <hints> [<definition.kore>] [--pre-trace] [--depth N|all] [--no-failures]
prooftrace check-k <k-release> [<llvm-backend-release>]
```

`read` writes JSONL to stdout. It omits substitutions: rendering KAST v4 needs
`compiled.json` as well, and a command that changed its record shape depending
on how many paths it got would be worse than one that says "use the library for
R4". Everything else — the id, the label, the source span, the order — is there.

## Licence

MIT OR Apache-2.0. See `THIRD-PARTY-NOTICES.md` for the BSD-3-Clause notices
that travel with a transcription of K's and the llvm-backend's sources.
