# @kframework-ts/kcfg

Persistent symbolic-execution graphs for K Framework constrained terms. This
is an unofficial TypeScript transcription of pyk's KCFG artifact layer at K
**v7.1.337**.

> **Unofficial.** This package is not affiliated with, endorsed by, or
> supported by Runtime Verification, Inc. or the K Framework maintainers.

The browser-safe main entry point models a mutable graph container around
immutable `CTerm` nodes and successor values. It reads and writes pyk's
structural KCFG dictionaries; KCFG JSON carries no format/header version, so a
document cannot identify its producing K runtime. Compatibility is instead
tracked through the source manifest and conformance tests.

```ts
import { CTerm } from "@kframework-ts/cterm";
import { KCFG } from "@kframework-ts/kcfg";

const graph = new KCFG();
const start = graph.createNode(CTerm.top());
const next = graph.createNode(CTerm.top());
graph.createEdge(start.id, next.id, 1, ["rule-id"]);

console.log(graph.toDict());
```

## Current scope

The current core implements pyk-shaped nodes, aliases, the five successor
kinds (`Edge`, `MergedEdge`, `Cover`, `Split`, and `NDBranch`), strict
dictionary decoding, graph mutation, reachability, path queries, and
zero-depth-cycle rejection. `KCFG`, `KCFGNode`, and `NodeAttr` are named public
classes; successor objects are immutable discriminated values.

The Node-only `@kframework-ts/kcfg/store` entry point reads and writes pyk's
split layout:

```text
<kcfg-dir>/
  kcfg.json
  nodes/<id>.json
```

```ts
import { readKcfgStore, writeKcfgStore } from "@kframework-ts/kcfg/store";

await writeKcfgStore("proof/kcfg", graph);
const restored = await readKcfgStore("proof/kcfg");
```

As in pyk, the split-store index's `vacuous` and `stuck` arrays are
authoritative. Arbitrary attributes stored in individual node files are not
preserved by that format. Writes stage replacement files and install the index
last, so an installed index does not name a node file that has not yet been
installed.

The pure minimizer is published separately so applications opt into graph
rewrites explicitly:

```ts
import { KCFGMinimizer } from "@kframework-ts/kcfg/minimize";

new KCFGMinimizer(graph).minimize();
```

It lifts edge chains, lifts and fuses compatible splits, preserves accumulated
constraints, and can optionally merge branches through `ctermsAntiUnify` and
an injected mergeability policy.

The asynchronous exploration adapter is available from
`@kframework-ts/kcfg/explore`. It accepts a narrow interface implemented by
`CTermSymbolic`; the caller owns the kore-rpc client and server lifetime.

```ts
import { KCFGExplore, KCFGExploration, type KCFGSymbolic } from "@kframework-ts/kcfg/explore";

const exploration = new KCFGExploration(graph);
const explorer = new KCFGExplore(symbolic as KCFGSymbolic);
await explorer.extendNode(exploration, start.id, { executeDepth: 100 });
```

Classification and mutation are separate operations, so recorded responses
and fakes can exercise every backend halt reason without a K installation.
Timeout and aborted results remain explicit instead of being collapsed into
stuck nodes. Exploration, semantics policy, and terminal-node helpers are
exported together through the `./explore` subpath. Neither minimization nor
exploration is re-exported by the browser-safe main entry point.

An edge's `rules` are **resolved rule labels**, not raw backend hashes:
`_extract_rule_labels` (`explore.py:66-77`) looks each `rewrite`/`success` log
entry's rule id up in the adapter's `KDefinition.sentenceByUniqueId` and
records `LABEL:source:(line, col, line, col)`. An id the definition does not
know — including the literal `UNKNOWN` a backend substitutes when it has none —
becomes `<id>:UNKNOWN`, as upstream. An adapter carrying no definition (the
seam allows one) falls back to the raw ids. Rule ids only reach the response at
all when the adapter requests rewrite logging, which `CTermSymbolic` does by
default; for the fully attributed projection of the same entries — source
location, module, per-rule fire counts, JSONL — see
`@kframework-ts/cterm/trace`.

## Summary modules

`Edge.to_rule`, `KCFG.to_rules` and `KCFG.to_module` (`kcfg.py:218-246`,
`288-289`, `713-735`) turn an explored graph back into K sentences — the
summary→lemma direction, where a proved basic block becomes a rule the next
proof may assume. They need no printer and no definition, so they are on the
browser-safe main entry point:

```ts
import { kcfgToModule } from "@kframework-ts/kcfg";

const summary = kcfgToModule(graph, { moduleName: "SUMMARY-ADD", id: "ADD", priority: 40 });
// module SUMMARY-ADD  rule ADD-1-TO-2 …  rule ADD-2-TO-3 …  endmodule
```

Upstream's defaults are kept: label prefix `BASIC-BLOCK`, priority `20`, module
name `KCFG`. `#Ceil` side conditions are dropped from both ends, each
configuration is inlined-and-sorted first, source constraints become `requires`
and target constraints `ensures`. Only edges and merged edges convert — a
cover is subsumption pointing backwards, a split is case analysis rather than a
transition, and an ndbranch has several targets — so a graph of splits alone
produces an empty module, exactly as pyk's `to_rules` does. As upstream,
`defuncWith` reaches ordinary edges but not merged ones.

Four differences from upstream:

- **Free functions, not methods.** Successors here are immutable data values,
  so `edgeToRule(edge, label, …)` replaces `edge.to_rule(label, …)`.
- **`edgeToRule` accepts any `{ source, target }` pair**, pyk's `EdgeLike`
  shape. `to_rule` reads only the two `CTerm`s, and this package's `edge()`
  rejects the depth-0 edge upstream fabricates in `APRProof.as_rule`.
- **`edgeToClaim` is the `claim=True` branch**, split out so the result type is
  known at the call site. It takes neither `priority` nor `defuncWith`,
  because `cterm_build_claim` accepts neither.
- **`inlineCellMaps` and `minimizeRuleLike` are forwarded, not re-implemented**:
  both are `kast/manip.py` functions and are implemented in
  `@kframework-ts/kast`. They stay visible from here because `edgeToRule`'s
  `minimize` and `KCFGShow.toModule`'s `parseableOutput` are what a consumer of
  this package reaches them through.

## Display

`@kframework-ts/kcfg/show` is pyk's `kcfg/show.py`: `NodePrinter`, `KCFGShow`,
and — re-exported for convenience — the summary-module functions above, which
`KCFGShow.toModule` wraps with cell hiding and per-rule minimization.

```ts
import { KCFGShow } from "@kframework-ts/kcfg/show";

const show = new KCFGShow({ definition }); // or { prettyPrint }
console.log(show.pretty(graph).join("\n"));
console.log(show.show(graph, { toModule: true, moduleName: "SUMMARY" }).join("\n"));
```

`prettySegments` returns pyk's addressable regions — `{ id, lines }` with the
ids `node_7`, `edge_3_7`, `split_3_7`, `ndbranch_3_7`, `cover_3_7`,
`merged_edge_3_7`, `unknown`, and the `_0`/`_1` disambiguating suffix — so a
consumer can map printed text back to a node or successor. The text itself is
pyk's, box-drawing characters and all.

Three deliberate differences from upstream:

- **`showRules` is beyond pyk.** Upstream prints `(N steps)` for an edge and
  never names the rules that fired, though `KCFG.Edge` has carried `rules` all
  along. Pass `{ showRules: true }` to `pretty`, `prettySegments` or `show` and
  every successor that carries rule ids — `Edge`, `MergedEdge` and `NDBranch`;
  a `Cover` and a `Split` have none — grows a `rules:` block under its label,
  in the same `_multi_line_print` shape `constraint:` and `subst:` use. The
  ids are whatever the edge holds: resolved `LABEL:file:line` triples when the
  graph was explored against a `KDefinition`, the backend's raw ids from a
  pyk-written `kcfg.json`, and `unknown` when there are none. It defaults to
  `false`, so the transcribed output and the frozen goldens are unchanged;
  turn it on when a proof failed and the question is which rule fired where.

  ```text
  │
  │  (2 steps)
  │  rules:
  │      IMP.assignment:imp.k:142
  │      IMP.sequence:imp.k:151
  ├─ 2
  ```

- **The printer is a seam.** pyk's `KCFGShow(defn)` builds its own
  `PrettyPrinter`; here the constructor takes `{ definition }`,
  `{ prettyPrint }`, or both, matching `KCFGExplore`. A stub printer is then
  enough to test every text shape with no kompiled definition in sight.
- **`dot` emits DOT text**, not a `graphviz.Digraph`. The graph is pyk's — one
  node per KCFG node with its short-info label and attribute classes, one edge
  per successor with pyk's exact label strings — but this package will not take
  a rendering dependency, and node ids are formatted as text, which upstream's
  `Digraph` call does not do.

`dump` writes the same directory layout pyk does (`<cfgid>.json`, optional
`.dot`, and `nodes/`, `edges/`, `covers/` text files), including its
append-only rule: a per-artifact file that already exists is never rewritten.

## Boundaries and non-goals

The main entry point has no filesystem, network, process, or K-installation
dependency. Filesystem persistence is isolated in `./store`; `./explore`
makes calls only through its injected client and does not start a kore-rpc
server; `./show` needs a definition or a printer, and only its `dump` touches
the filesystem.

This is not an APR prover. Claim loading, proof scheduling, parallel workers,
refutations, and proof status are outside this package's scope; the
proof-aware node printer that adds `init`/`target`/`pending` to a node's
attributes lives in `@kframework-ts/proof/show`. Pyk's `kcfg/tui.py` is a
`textual` application and is not being ported at all, and Python-style memory
interning has no analogue here.

## Conformance status

The hermetic suite includes a pyk-generated dictionary containing every
successor kind and a byte-identical real Kontrol split store; their origins and
hashes are recorded in `fixtures/PROVENANCE.md`. The opt-in pinned-K lane has
passed against K v7.1.337 for logical `Split` creation, a concrete `Edge`, and
a store write/read round trip.

`NDBranch` is covered by backend-free classification and graph tests. A
deterministic live-K semantic-nondeterminism scenario remains useful follow-up
conformance work; it does not change the shipped API.

**The summary-module tests have no upstream oracle either.** pyk never calls
`to_rule`, `to_rules` or `to_module` from its test suite; `test/rules.test.ts`
asserts sentence ids, priority, `#Ceil` filtering and successor coverage read
directly off `kcfg.py`.

**The `./show` goldens are self-generated.** pyk asserts on none of its show
output — it only logs it — so `fixtures/show/` records this implementation's
rendering of a hand-built graph covering every successor kind, reviewed line by
line against `show.py`. They pin regressions, not upstream agreement, and
`fixtures/PROVENANCE.md` says so.

## Version identity and source drift

```ts
import { K_RELEASE, TRANSCRIBED_FROM, checkKcfgSources } from "@kframework-ts/kcfg";

console.log(K_RELEASE); // "v7.1.337"
```

`TRANSCRIBED_FROM` names the pyk implementations and test oracles used here,
including an exact SHA-256 at the pinned release. `checkKcfgSources` is pure:
give it a fetcher to compare those paths against any K tag without making the
library itself network-dependent. The same three-outcome check is exposed as a
command:

```sh
kcfg check-k v7.1.337
```

It exits `0` when every source is unchanged, `1` when one changed, `3` when K
moved a source path, and `2` if it could not run. A moved path is explicitly
not a compatibility verdict.

The package is ESM-only, supports Node 20+ and Bun 1.3+, and is dual-licensed
under MIT or Apache-2.0. See `THIRD-PARTY-NOTICES.md` for the BSD-3-Clause
notice carried from K/pyk.
