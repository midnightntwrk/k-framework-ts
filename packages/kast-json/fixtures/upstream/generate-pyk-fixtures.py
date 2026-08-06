#!/usr/bin/env python3
"""Regenerate the generated pyk fixtures in this directory (and in v4/).

Usage:

    PYK_SRC=<k-checkout-at-v7.1.191>/pyk/src python3 generate-pyk-fixtures.py
    PYK_SRC=<k-checkout-at-v7.1.337>/pyk/src python3 generate-pyk-fixtures.py

The KAST version the checkout's pyk emits decides what is written:

- a KAST v3 pyk (tag v7.1.191) writes `pyk-term-kas.json`,
  `pyk-spec-kflatmodulelist.json` and `pyk-term-nested-sorts.json` beside this
  script;
- a KAST v4 pyk (tag v7.1.320 or later; recorded at v7.1.337) writes the same
  three documents, in their v4 spelling, into `v4/`.

Any other version is refused.  Regenerating with the matching checkout
reproduces the committed files byte-for-byte.

Every *term* byte in the output is pyk's own `to_dict()` serialization. The
`{"format": "KAST", "version": N, "term": ...}` envelope is spelled here
because pyk has no envelope writer — its own callers build the dict by hand
the same way (`pyk/ktool/kprove.py`, `tests/integration/test_bytes.py`).
JSON text is written compact (no spaces), matching K's canonical form.

`KSyntaxLexical` is deliberately absent: pyk `v7.1.191` (and HEAD, `v7.1.337`)
emits the misspelled node name `KSyntaxLexcial` (`pyk/kast/outer.py:464`),
which neither K's Java `JsonParser` nor pyk's own `from_dict` accepts, so a
valid pyk-produced `KSyntaxLexical` fixture cannot exist.  See
`test/upstream.test.ts`, which pins that divergence.
"""

import importlib.metadata as _md
import json
import os
import sys

# pyk's package __init__ resolves its own version from installed metadata;
# running from a source checkout has none, so answer for it.  The value never
# reaches the serialized output.
_orig_version = _md.version
_md.version = lambda name: "7.1.191" if name == "kframework" else _orig_version(name)

pyk_src = os.environ.get("PYK_SRC")
if not pyk_src:
    sys.exit("set PYK_SRC to <k-checkout>/pyk/src (at tag v7.1.191 for v3, v7.1.337 for v4)")
sys.path.insert(0, pyk_src)

from pyk.kast.inner import KApply, KAs, KLabel, KSequence, KSort, KToken, KVariable
from pyk.kast.kast import KAst
from pyk.kast.outer import KClaim, KFlatModule, KFlatModuleList, KImport, KSortSynonym

VERSION = KAst.version()
if VERSION not in (3, 4):
    sys.exit(f"need pyk at KAST v3 (tag v7.1.191) or v4 (tag v7.1.337); this checkout emits v{VERSION}")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = HERE if VERSION == 3 else os.path.join(HERE, "v4")


def write(name: str, term_dict: dict) -> None:
    doc = {"format": "KAST", "version": VERSION, "term": term_dict}
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(doc, f, separators=(",", ":"))


def sort(name: str, *params: KSort) -> KSort:
    """A sort, spelled the only way the checkout's pyk can spell it.

    pyk v3's KSort dataclass holds a single flat `name`, so parameters are
    inlined here exactly as `ADT.Sort.toString` inlines them (bare commas, no
    spaces) -- the parameters passed in have already been flattened by the same
    rule, so the recursion is the one that file defines.  pyk v4's KSort holds
    a real `params` tuple, so the tree is built as a tree.
    """
    if VERSION == 4:
        return KSort(name, params)
    if not params:
        return KSort(name)
    return KSort(f"{name}{{{','.join(p.name for p in params)}}}")


# A term document exercising KAs, plus pyk's emission quirks: every KApply
# carries "variable": false, every KSequence carries "arity".  Under v4 the
# KSorts additionally carry "params": [] — same terms, other spelling.
term = KSequence(
    [
        KAs(
            KApply(KLabel("foo", (KSort("Int"),)), [KToken("1", KSort("Int"))]),
            KVariable("P"),
        ),
        KApply("bar", [KVariable("X", sort=KSort("Int"))]),
    ]
)
write("pyk-term-kas.json", term.to_dict())

# A spec-module document: KFlatModuleList wrapping a module that carries a
# KClaim and a KSortSynonym — the shape `kprove --emit-json-spec` writes.
claim = KClaim(
    body=KApply("run", [KVariable("N", sort=KSort("Int"))]),
    requires=KToken("true", KSort("Bool")),
    ensures=KToken("true", KSort("Bool")),
)
module = KFlatModule(
    "SPEC",
    sentences=[claim, KSortSynonym(KSort("MyInt"), KSort("Int"))],
    imports=[KImport("BASIC", True)],
)
write("pyk-spec-kflatmodulelist.json", KFlatModuleList("SPEC", [module]).to_dict())

# A term document carrying sorts nested two levels deep, Outer{Inner{Int},Int},
# on each of the three node kinds that can hold a sort: a KToken's sort, a
# KVariable's sort, and a KLabel's sort parameters.  No Java-frontend document
# can cover this: K refuses to compile a user-defined parametric sort at all
# ("User-defined parametric sorts are currently unsupported",
# k-distribution/tests/regression-new/checks/checkParametricSort.k), so the
# deepest sort that frontend emits is an instantiated MInt{64}.  pyk, the
# format's other real producer, has no such restriction.
inner = sort("Inner", sort("Int"))
outer = sort("Outer", inner, sort("Int"))
nested = KSequence(
    [
        KToken("nested", outer),
        KVariable("N", sort=outer),
        KApply(KLabel("wrap", (outer, inner)), [KVariable("X", sort=inner)]),
    ]
)
write("pyk-term-nested-sorts.json", nested.to_dict())
print(f"ok (KAST v{VERSION} -> {os.path.relpath(OUT, HERE) or '.'})")
