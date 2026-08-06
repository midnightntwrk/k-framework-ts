#!/usr/bin/env python3
"""Generate the compact pyk KCFG dictionary fixture for this package.

Run this script with the virtual environment belonging to the pinned K source
checkout.  It intentionally builds the graph only through pyk's public KCFG
constructors, then serializes that graph with ``KCFG.to_dict()``.
"""

from __future__ import annotations

import json
from pathlib import Path

from pyk.cterm import CTerm
from pyk.kast.inner import KApply, KVariable
from pyk.kast.prelude.kint import INT, intToken
from pyk.kast.prelude.ml import mlEquals
from pyk.kcfg import KCFG
from pyk.kcfg.kcfg import KCFGNodeAttr, NodeAttr


FIXTURE = Path(__file__).resolve().parents[1] / "pinned-pyk-kcfg.json"


def cell(value: object) -> KApply:
    """Use the smallest configuration shape accepted by CTerm."""

    return KApply("<top>", [value])


def cterm(value: object, *constraints: object) -> CTerm:
    return CTerm(cell(value), constraints)


def main() -> None:
    graph = KCFG()

    # Separate components make the one-successor-per-source KCFG invariant
    # explicit while keeping each of pyk's five successor encodings present.
    edge_source = graph.create_node(cterm(intToken(1)))
    edge_target = graph.create_node(cterm(intToken(2)))
    graph.create_edge(edge_source.id, edge_target.id, 3, ["EDGE-A", "EDGE-B"])

    merged_source = graph.create_node(cterm(intToken(3)))
    merged_target = graph.create_node(cterm(intToken(4)))
    first_member = KCFG.Edge(merged_source, merged_target, 5, ("MERGED-FIRST",))
    second_member = KCFG.Edge(merged_source, merged_target, 7, ("MERGED-SECOND", "MERGED-THIRD"))
    graph.create_merged_edge(merged_source.id, merged_target.id, [first_member, second_member])

    cover_source = graph.create_node(
        cterm(intToken(5), mlEquals(KVariable("COVER_CONSTRAINT", sort=INT), intToken(5), arg_sort=INT))
    )
    cover_target = graph.create_node(cterm(KVariable("COVER_VALUE", sort=INT)))
    graph.create_cover(cover_source.id, cover_target.id)

    split_source = graph.create_node(cterm(KVariable("SPLIT_VALUE", sort=INT)))
    split_left = graph.create_node(
        cterm(intToken(6), mlEquals(KVariable("LEFT_GUARD", sort=INT), intToken(6), arg_sort=INT))
    )
    split_right = graph.create_node(
        cterm(intToken(7), mlEquals(KVariable("RIGHT_GUARD", sort=INT), intToken(7), arg_sort=INT))
    )
    graph.create_split_by_nodes(split_source.id, [split_left.id, split_right.id])

    nd_source = graph.create_node(cterm(intToken(8)))
    nd_left = graph.create_node(cterm(intToken(9)))
    nd_right = graph.create_node(cterm(intToken(10)))
    graph.create_ndbranch(nd_source.id, [nd_left.id, nd_right.id], ["ND-ONE", "ND-TWO"])

    graph.add_attr(edge_target.id, KCFGNodeAttr.VACUOUS)
    graph.add_attr(cover_source.id, KCFGNodeAttr.STUCK)
    graph.add_attr(nd_right.id, NodeAttr("fixture-terminal"))
    graph.add_alias("edge-root", edge_source.id)
    graph.add_alias("cover-general", cover_target.id)
    graph.add_alias("split-root", split_source.id)

    document = graph.to_dict()
    if KCFG.from_dict(document).to_dict() != document:
        raise AssertionError("pyk failed to round-trip its generated KCFG document")
    required = {"edges", "merged_edges", "covers", "splits", "ndbranches", "aliases"}
    if required.difference(document):
        raise AssertionError(f"fixture is missing required KCFG sections: {sorted(required.difference(document))}")

    FIXTURE.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
