#!/usr/bin/env python3
"""Generate `fixtures/synthetic/allrules-{src,dst}.txt`.

`translateCoverage` (`coverage.py:46-105`) remaps a hit list from one build to
another by going src hash -> src `file:line:col` -> **basename**`:line:col` ->
dst hash.  The pair below is the smallest input that exercises every branch of
that: two `allRules.txt` files whose entries have **the same basenames at the
same line:col** and **different directories and different hashes** — i.e. a
pure rename of the containing tree, which is what a recompile after moving a
semantics looks like.

Two entries exist to break parsers rather than to be interesting semantics:

- a path containing **spaces**, which crashes pyk's own `coverage.py:66-67`
  (`line.split(' ')` then indexing `[1]`), and
- a path containing **colons**, which defeats any parser that splits the
  location off from the left rather than the right.

`@kframework-ts/kompiled`'s `parseAllRules` handles both — it takes the first
space and splits the location from the right — and this pair is what pins that
it keeps doing so through `translateCoverage`.

The hashes are not from any build; they are `sha256` of a stable descriptive
string so the file is reproducible and no two entries collide.  A real
`UNIQUE_ID` is `sha256` of a normalised sentence (`NumberSentences.java:26-54`
— note it is SHA3-256 there, not SHA-256; that difference does not matter for a
fixture that only needs 64 distinct lowercase hex characters, and PROVENANCE.md
records that these are synthetic).

Usage: `./make-synthetic.py <fixtures-dir>`
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

SRC_ROOT = "/fix/syn/v1"
DST_ROOT = "/fix/syn/v2"

# (relative path, line, col).  Same tuple list for both sides — that is the
# "rename-only" property.  `nested/alpha.k` deliberately shares a basename with
# `alpha.k` but sits at a different line: basename matching must find both, and
# putting them at the *same* line would create a collision whose winner depends
# on `allRules.txt` iteration order, which is arbitrary (a scala Set,
# `Kompile.java:378`) and therefore untestable.  The collision hazard is real
# and documented in PROVENANCE.md; it is not something a fixture can pin.
ENTRIES: list[tuple[str, int, int]] = [
    ("alpha.k", 10, 5),
    ("path with spaces.k", 20, 3),
    ("path:with:colons.k", 30, 7),
    ("nested/alpha.k", 40, 9),
    ("beta.md", 50, 11),
]


def rule_id(side: str, rel: str) -> str:
    return hashlib.sha256(f"kcovr-synthetic:{side}:{rel}".encode()).hexdigest()


def render(side: str, root: str) -> str:
    return "".join(
        f"{rule_id(side, rel)} {root}/{rel}:{line}:{col}\n" for rel, line, col in ENTRIES
    )


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        raise SystemExit(__doc__)
    out = Path(argv[1]) / "synthetic"
    out.mkdir(parents=True, exist_ok=True)
    (out / "allrules-src.txt").write_text(render("src", SRC_ROOT))
    (out / "allrules-dst.txt").write_text(render("dst", DST_ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
