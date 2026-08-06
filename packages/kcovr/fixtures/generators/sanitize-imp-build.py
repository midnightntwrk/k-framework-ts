#!/usr/bin/env python3
"""Rebuild `fixtures/imp-build/` from a real `kompile --coverage` build of the
upstream IMP semantics, run against `loops.imp`.

Why a second build directory exists at all: `cov-build/`'s largest hit log is
362 lines, and `../PROVENANCE.md` records that **nothing in the K ecosystem has
a large one** — upstream's six `--coverage` regression directories contain no
program, so `krun` never runs there and no hit log is ever produced.  A
large-scale log had to be made, and IMP is the smallest real semantics that can
make one: 101 instrumented rules, a `while` loop, and a 6.6-second `kompile`.

The sanitization is the same total prefix substitution `sanitize-cov-build.py`
applies, with `/fix/imp/` added for the IMP source and `/fix/k/` reused
verbatim for the prelude, so the two fixture trees name the K prelude by the
same fake path.  Rule hashes, counts and **line order** are copied byte for
byte: the log is a chronological record of rule applications and reordering it
would destroy the only thing it has to say.

**Both real prefixes are read out of the build, never hardcoded.**  The prelude
root is whichever directory `allRules.txt` names ending in
`include/kframework/`, so it follows the K install that actually made the build
instead of a store path pinned in this file that goes stale on the next
upgrade; the IMP root is the directory of the remaining sources.  Run this
script and `sanitize-cov-build.py` against builds made by the *same* K install
and the prelude row is identical in both, which is what lets
`/fix/k/include/kframework/builtin/domains.md` mean one file across the corpus.

Usage:

    ./sanitize-imp-build.py <build-dir> <program.imp> <fixtures-dir>

where `<build-dir>` is the `kompile --coverage --backend llvm imp.k` output
directory *after* a `krun` (so exactly one `*_coverage.txt` exists in it), and
`<fixtures-dir>` is `packages/kcovr/fixtures`.

See `../PROVENANCE.md`, section "The large hit log — `imp-build/`", for the
build this was run against and what came out.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

# --- discovering the real prefixes ----------------------------------------
#
# Two prefixes, which is the complete census for this build: `allRules.txt`
# names exactly two source files (37 entries in `imp.k`, 64 in the prelude) and
# no other artifact vendored here contains a path at all.  Both are read out of
# the build rather than written down here — see the module docstring.

# `Kompile.java` emits `<id> <file>:<line>:<col>`; the source is everything
# between the single space and the trailing `:line:col`.
_SOURCE = re.compile(r"^[0-9a-f]{64} (?P<source>.*):\d+:\d+$")

# Every K install lays its prelude out under `<root>/include/kframework/`,
# whether `<root>` is a nix store path, a `/usr/local` tree or an unpacked
# release tarball.  That tail is the stable part, so it is what is matched on.
_PRELUDE_TAIL = "/include/kframework/"


def sources(all_rules: str) -> set[str]:
    """The distinct source files `allRules.txt` names."""
    out: set[str] = set()
    for line in all_rules.split("\n"):
        if not line:
            continue
        match = _SOURCE.match(line)
        if match is None:
            raise SystemExit(f"allRules.txt entry does not parse: {line!r}")
        out.add(match.group("source"))
    return out


def one_directory(paths: set[str], what: str) -> str:
    """The single directory holding `paths`, with a trailing slash."""
    dirs = {path[: path.rindex("/") + 1] for path in paths}
    if len(dirs) != 1:
        raise SystemExit(f"expected exactly one {what} directory, found {sorted(dirs)}")
    return dirs.pop()


def path_map(all_rules: str) -> list[tuple[str, str]]:
    """The prefix substitution for this build, longest real prefix first."""
    found = sources(all_rules)
    prelude = {s for s in found if _PRELUDE_TAIL in s}
    if not prelude:
        raise SystemExit("no source under an `include/kframework/` root; is this a K build?")
    roots = {s[: s.index(_PRELUDE_TAIL) + len(_PRELUDE_TAIL)] for s in prelude}
    if len(roots) != 1:
        raise SystemExit(f"expected one K prelude root, found {sorted(roots)}")
    mapping = [
        # The K prelude.  The *same* real prefix and the *same* fake prefix as
        # `sanitize-cov-build.py` produces, provided both builds were made by
        # the same K install — which is what lets
        # `/fix/k/include/kframework/builtin/domains.md` mean one file across
        # the whole fixture corpus.
        (roots.pop(), "/fix/k/include/kframework/"),
        # The IMP semantics, kompiled out of a scratch directory.  `/fix/imp/`
        # is a fresh root rather than `cov-build`'s `/fix/sem/`, so a test that
        # loads both fixture trees can still tell which build a path came from.
        (one_directory(found - prelude, "IMP source"), "/fix/imp/"),
    ]
    return sorted(mapping, key=lambda entry: len(entry[0]), reverse=True)


# The hit log is renamed: a pid is noise.  `pid-large_coverage.txt` matches
# `cov-build/`'s naming, and the two files never share a directory.
HIT_LOG_NAME = "pid-large_coverage.txt"


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        raise SystemExit(__doc__)
    build, program, fixtures = Path(argv[1]), Path(argv[2]), Path(argv[3])
    out = fixtures / "imp-build"
    out.mkdir(parents=True, exist_ok=True)

    raw_rules = (build / "allRules.txt").read_text()
    mapping = path_map(raw_rules)
    print("\n".join(f"{real}\n  -> {fake}" for real, fake in mapping))

    def sanitize(text: str) -> str:
        for real, fake in mapping:
            text = text.replace(real, fake)
        return text

    logs = sorted(build.glob("*_coverage.txt"))
    if len(logs) != 1:
        # More than one means the directory was `krun` twice without the
        # `rm -f *_coverage.txt` that `io.cpp`'s append mode makes mandatory,
        # and a fixture assembled from an unknown number of runs is not a
        # record of anything.
        raise SystemExit(f"expected exactly one *_coverage.txt in {build}, found {len(logs)}")

    (out / "allRules.txt").write_text(sanitize(raw_rules))
    # Bare 64-hex lines, no paths; run through `sanitize` anyway so that "every
    # vendored byte went through the mapping" holds without exception.
    (out / HIT_LOG_NAME).write_text(sanitize(logs[0].read_text()))
    # Copied, not written empty: IMP declares no macro, and that this really
    # does leave a zero-byte file behind is worth asserting rather than
    # trusting.
    if (build / "coverage.txt").read_bytes():
        raise SystemExit("coverage.txt is not empty; the fixture documents the empty case")
    shutil.copyfile(build / "coverage.txt", out / "coverage.txt")
    shutil.copyfile(program, out / program.name)

    # `imp.k` itself is vendored beside the program as the other input a reader
    # needs to re-run this; it is upstream BSD-3 material like the three
    # `test.k` files in `generators/`.  It is expected to sit next to the
    # program, which is where `kompile` was invoked.
    shutil.copyfile(program.parent / "imp.k", fixtures / "generators" / "imp.k")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
