# @kframework-ts/klean

`@kframework-ts/klean` generates a Lean 4 **shallow embedding** from compiled
KORE (`definition.kore`). It is the TypeScript sibling of `pyk.klean`, pinned
to K **v7.1.337** and Lean **4.30.0**.

> **Unofficial.** This package is not affiliated with, endorsed by, or
> supported by Runtime Verification, Inc. or the K Framework maintainers.

It starts from a compiled definition. It does not parse `.k` source, invoke
`kompile`, start Lean, or claim that generated code is a complete executable
semantics.

## Install

```sh
npm install @kframework-ts/klean
```

ESM only; Node 20+ and Bun 1.3+. The pure compiler depends only on
`@kframework-ts/kore`. The separate `@kframework-ts/klean/fs` entry point is
Node-only because it writes files.

## Pure generation

The main entry point is pure: it consumes a lazy or eager KORE source and
returns all proposed files, a manifest, and diagnostics. Nothing is written.

```ts
import { generateKleanProject, sourceFromKoreText } from "@kframework-ts/klean";

const source = sourceFromKoreText(definitionKore); // lazy axiom bodies by default
const project = generateKleanProject(source, {
  packageName: "klean-imp", // a bare lowercase kebab-case Lake package name
  libraryName: "KleanImp", // optional; defaults to PascalCase packageName
  ruleLabels: ["step"], // optional, exact and repeatable
  deriveBeq: true,
  deriveDecidableEq: true,
});

if (project.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
  throw new Error("generation is incomplete");
}
console.log(project.files.get("KleanImp/Rewrite.lean"));
```

`sourceFromKompiled` adapts a `KompiledDefinition`-shaped object without
making `@kframework-ts/kompiled` a dependency. Projection forces only axiom
bodies it needs.

`packageName` is deliberately a **bare lowercase kebab-case** name (for
example, `klean-imp`), not an npm scope such as `@scope/klean-imp`. It is both
the Lake package name and the destination directory leaf; rejecting separators
and scopes keeps the filesystem writer's one-project transaction unambiguous.

The returned files are the Lake project shell and its five modules:

```text
KleanImp.lean                 # imports KleanImp.Rewrite
KleanImp/Prelude.lean         # pinned upstream hook prelude
KleanImp/Sorts.lean
KleanImp/Inj.lean
KleanImp/Func.lean
KleanImp/Rewrite.lean
lakefile.toml
lean-toolchain
```

The core does not add a manifest file to `files`; its manifest is an in-memory
value. It records K/Lean pins, package/library names, selected rule labels and
UIDs, emitted sorts/symbols/equations/rewrites, axiomatic functions, and the
semantic mode. It does **not yet** hash the input definition or claim that
every omitted construct was made harmless—read diagnostics before trusting an
output.

## Writing a project and CLI

The Node-only writer is explicit:

```ts
import { writeKleanProject } from "@kframework-ts/klean/fs";

const destination = await writeKleanProject(project, "out");
// out/klean-imp, with klean-manifest.json by default
```

It preflights the destination, stages every file, and renames it into place;
an existing `out/klean-imp` produces `KleanOutputExistsError` and is never
overwritten. Pass `{ manifest: false }` to omit `klean-manifest.json`.

The packaged command is a thin shell around the same pure plan:

```text
klean DEFN_DIR PKG_NAME [options]

  -o, --output DIR
  -l, --library NAME
  -r, --rule LABEL              repeat for exact labels
      --derive-beq
      --derive-decidableeq
      --no-manifest
```

`DEFN_DIR` must contain `definition.kore`. The command never runs `kompile` or
Lean; it refuses to write when generation has error diagnostics. Its default
output is `./PKG_NAME`; exit status `115` means that directory already exists.

The same command also carries the drift check described below:

```sh
klean check-k v7.1.337
```

`check-k` is the only reserved first argument; a definition directory named
exactly `check-k` is still generatable as `./check-k`.

## Semantic contract and current limits

This package follows upstream KLean's intentionally narrow model:

- K functions are represented as `Option Result`. A function that cannot be
  emitted from retained equations is an explicit axiom, listed in the manifest.
- `Rewrites` is **priority-agnostic** and therefore over-approximates K's
  rewrite relation. A Lean build is not evidence of priority-correct semantics.
- The generated prelude contains hook axioms and selected hook definitions.
  It is an extension point, not a proof that every K hook is implemented.
- The implemented lowering subset includes variables; Bool, Int, Bytes, Id,
  String, and StringBuffer domain values; applications; monomorphic
  injections; structures/cells; recognized collection shapes; and Bool
  `\and`, `\or`, and `\equals` where generation needs them. Unsupported
  KORE patterns, parametric sort _applications_, aliases that cannot be
  eliminated, and unresolved symbols become typed diagnostics rather than
  fabricated Lean.
- Exact `--rule`/`ruleLabels` selection retains the selected rewrites plus
  their transitive configuration, function, and collection closure. Unknown or
  duplicate labels are errors; selection order is deterministic.

Lean terms in the renderer are opaque leaves by design. This package has a
typed declaration/printer model; it is not a general Lean parser.

## Function-rule lowering

A K function rule's left-hand side is a matching-logic pattern; Lean's `match`
is a structural one. Three shapes have no structural counterpart and are
compiled into guards that run before the rule body — upstream's `Matcher`
hierarchy, ported in `src/matchers.ts`:

| K left-hand side                           | generated Lean                                    |
| ------------------------------------------ | ------------------------------------------------- |
| `f(X, X)` (repeated variable)              | rename + `match X == _Uniq0 with \| true =>`      |
| `f(inj{Sub,Super}(P))`, `Sub` has subsorts | `match (@retr Sub Super) _Pat0 with \| some P =>` |
| `f(ListItem(H) L)` / `f(.List)`            | `(ListHook E).split _Pat0.coll 1 0` / `.size`     |
| `f(SetItem(E) S)` / `f(.Set)`              | `(SetHook E).split _Pat0.coll [E]` / `.size`      |
| `f(K \|-> V M)` / `f(.Map)`                | `(MapHook K V).split _Pat0.coll [K]` / `.size`    |

Matchers are ordered into dependency generations, so a matcher that reads a
variable another one binds is emitted as a nested `match`. Nested Option-valued
calls in `requires`/`rhs` are hoisted into an `Option`-monad `do` block, which
is how a partial K function calls another. `Func.lean` is laid out in
dependency-first SCC order over functions _and_ their equations; a component
with more than one member becomes a Lean `mutual` block, and anything that
transitively reaches an `axiom` is marked `noncomputable`.

`fixtures/matchers.k` is a small K definition that exercises every one of these
shapes; the acceptance gate below kompiles it and makes Lean elaborate the
result.

Two departures from upstream are worth knowing, both because the upstream
output does not elaborate:

- upstream binds the leftover of a collection `split` at the hook's raw type
  (`List (K × V)`) while the KORE variable has the collection sort, so a rule
  such as `f((K |-> V) M) => M` is rejected by Lean. This package maps the
  collection's structure constructor over the `Option` before matching.
- upstream emits a rule whose right-hand side reads a variable no pattern
  binds. This package reports that as an `axiomatic-function-equation`
  diagnostic and axiomatizes the containing function instead, so a missing
  matcher shape is auditable rather than a broken build.

On the committed IMP fixture there are **no equation-lowering fallbacks**:
`#lookup(_,_)_IMP_KItem_Id_Map`, `_/=Int_`, and `isKResult` are generated
definitions. The
remaining axioms in the IMP manifest are the collection hooks the Prelude
deliberately leaves open (`Map:lookup`, `_|->_`, `SetItem`, …), which are part
of upstream KLean's shallow embedding rather than unfinished lowering. See
[ROADMAP.md](ROADMAP.md) for the remaining manifest, extension-policy, and KEVM
acceptance work.

## Development and acceptance

From the monorepo root, the normal package gate is hermetic and does not require
Lean:

```sh
bun run --cwd packages/klean check
```

The opt-in acceptance gate materializes and builds both the full IMP theory and
the selected `IMP-SYNTAX._%_1-cool` theory using the generated project's pinned
Lean toolchain:

```sh
KLEAN_RUN_LAKE=1 bun test packages/klean/test/imp-conformance.test.ts
```

The matcher gate additionally needs `kompile` on `PATH`: it compiles
`fixtures/matchers.k`, generates a project from the result, asserts that no
function degraded to an axiom, and builds it.

```sh
KLEAN_RUN_LAKE=1 bun test packages/klean/test/matcher-conformance.test.ts
```

## Upstream compatibility and provenance

The stock `Prelude.lean` asset is byte-for-byte the upstream template at the
recorded K release. The Lake file, root import, toolchain policy, generator
logic, CLI contract, and KORE projection model are tracked in
`TRANSCRIBED_FROM` along with SHA-256 hashes.

```ts
import { K_RELEASE, LEAN_TOOLCHAIN, checkKleanSources } from "@kframework-ts/klean";

console.log(K_RELEASE, LEAN_TOOLCHAIN); // v7.1.337, leanprover/lean4:v4.30.0
```

`checkKleanSources` accepts an injected fetcher, making drift checks pure and
offline-testable. The same three-outcome check is exposed as a command:

```sh
klean check-k v7.1.337
```

It exits `0` when every source is unchanged, `1` when one changed, `3` when K
moved a source path, and `2` if it could not run. A moved path is explicitly
not a compatibility verdict. Those codes do not collide with the generator's
`115`: `check-k` writes nothing, and generation fetches nothing.

This package is dual-licensed under MIT or Apache-2.0. The
K/pyk BSD-3-Clause notice for the transcription and copied Prelude is in
`THIRD-PARTY-NOTICES.md`.
