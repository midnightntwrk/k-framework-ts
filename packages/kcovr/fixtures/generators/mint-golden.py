#!/usr/bin/env python3
"""Mint `fixtures/synthetic/golden.cobertura.xml` from pyk itself.

No Cobertura golden exists anywhere upstream — `kcovr.py` has no test of any
kind — so this package mints one, from pyk's own renderer, over this package's
own sanitized fixtures.  `cobertura.ts` is then a transcription with a
differential check against the thing it was transcribed from.

Run it against a **source checkout** of `k` at the pinned tag, not an installed
`pyk` (usually a different version):

    cd <k-checkout>/pyk
    uv run python <this-script> \\
        <fixtures>/cov-build ++ \\
        /fix/k/include/kframework/builtin/domains.md \\
        /fix/sem/panopticon-semantics.md \\
        /fix/sem/panopticon-syntax.md \\
        > <fixtures>/synthetic/golden.cobertura.xml

Two things are done to pyk's output, and nothing else.  Both are recorded in
`../PROVENANCE.md`; both are also **requirements on `cobertura.ts`**, which must
reproduce the normalized form.

1.  **`timestamp` is pinned to `0`.**  `kcovr.py:92` calls `time.time()`.  The
    plan makes the timestamp an injected parameter for exactly this reason
    (`docs/coverage-plan.md` §4, "Timestamp injected").

2.  **`<line>` elements are sorted by line number within each `<class>`.**
    This is not cosmetic.  `create_rule_map` accumulates `allRules.txt` into a
    Python `set[str]` (`kcovr.py:179-186`), so the emission order of
    `<line>` elements follows string-hash iteration order and **changes with
    `PYTHONHASHSEED`** — pyk's XML is not reproducible run to run.  Measured on
    this fixture set: four unseeded runs gave four distinct sha256s; four runs
    at fixed seeds 0/1/2/7 gave three distinct sha256s.  After the sort, all
    four seeds agree byte-for-byte.  Sorting is lossless and total — there is
    exactly one `<line>` per line number in a class (`kcovr.py:231-240` keys the
    map by line) — and every rate in the document is computed from set
    cardinalities, so no number depends on the order.

`<class>` order needs no normalization: `render_classes` iterates the
source-file arguments in the order given (`kcovr.py:115`).  Pass them sorted,
as the invocation above does.

## Why this calls `render_coverage_xml` instead of the `pyk-covr` binary

`pyk-covr`'s `main()` is three lines: `parse_args()`, `render_coverage_xml()`,
`print` (`kcovr.py:52-55`).  `parse_args` validates that every source file
exists on disk and `.resolve()`s it (`:70-71`); `render_coverage_xml` never
opens a source file — it uses only `str(path)` and `path.relative_to(...)`, and
line *counts* come from the rule map, not from the files.  The fixture paths are
sanitized to `/fix/...` roots that by construction cannot exist on any machine,
so the existence check is the one thing that must be bypassed.

That bypass was verified, not assumed: run over the **unsanitized** build, where
the sources do exist, this script's output is byte-identical to `pyk-covr`'s own
(timestamp normalized).  See `../PROVENANCE.md`.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from pyk.kcovr import render_coverage_xml

# A `<line>` element ends either at its own `/>` (the no-branch template, whose
# attributes contain no `>`) or at `</line>` (the branch template).  The two
# alternatives must be spelled separately: a single non-greedy `.*?(?:/>|</line>)`
# stops at the *self-closing `<condition …/>` inside* a branch line, truncating
# the block and dropping its `</conditions></line>` tail.  The first minted
# golden had exactly that defect — 21 `<conditions>` against 1 `</conditions>`,
# not well-formed XML.  See ../PROVENANCE.md, "A minting defect, found and fixed".
_LINE_BLOCK = re.compile(r'\n<line number="(\d+)"(?:[^>]*/>|.*?</line>)\n', re.S)


def canonicalize(xml: str) -> str:
    """Sort `<line>` blocks by line number inside each `<class>`."""
    out = []
    for chunk in re.split(r"(?=\n<class )", xml):
        matches = list(_LINE_BLOCK.finditer(chunk))
        if not matches:
            out.append(chunk)
            continue
        start, end = matches[0].start(), matches[-1].end()
        body = "".join(
            text for _, text in sorted((int(m.group(1)), m.group(0)) for m in matches)
        )
        out.append(chunk[:start] + body + chunk[end:])
    return "".join(out)


def main(argv: list[str]) -> int:
    if "++" not in argv:
        raise SystemExit(__doc__)
    sep = argv.index("++")
    xml = render_coverage_xml(
        [Path(d) for d in argv[1:sep]], [Path(s) for s in argv[sep + 1 :]]
    )
    sys.stdout.write(canonicalize(re.sub(r'timestamp="\d+"', 'timestamp="0"', xml)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
