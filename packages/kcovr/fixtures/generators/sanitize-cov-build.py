#!/usr/bin/env python3
"""Rebuild `fixtures/cov-build/` and `fixtures/compiled/` from a real
`kompile --coverage` build directory.

Every artifact a `--coverage` build produces embeds absolute paths — the
semantics' source files, the K prelude in the nix store, and the absolute path
of `coverage.txt` baked into each instrumented rule.  Those are machine
specific, and `renderCoverageXml`'s `commonprefix` behaviour depends on the
*shape* of the paths, so a fixture that carried them would be neither portable
nor a stable golden.  This script maps them onto fixed fake roots.

The mapping is a prefix substitution over three real directories, applied
identically everywhere a path can appear (see `path_map`).  It is deliberately
total and order-independent: the same real path always becomes the same fake
path, so cross-references between `allRules.txt`, the hit logs and
`compiled.json` survive.

**All three real prefixes are read out of the build, never written down here.**
The K prelude root is whichever directory `allRules.txt` names ending in
`include/kframework/`; the semantics root is the directory of the remaining
sources; the build root is the directory of the `coverage.txt` path that
`GenerateCoverage` baked into every instrumented rule, so it is the directory
the build was *made* in rather than wherever it happens to sit now.  A store
path pinned in this file would name one K install forever and go stale on the
next upgrade,
and the prelude prefix has to agree with `sanitize-imp-build.py`'s for
`/fix/k/include/kframework/builtin/domains.md` to mean one file across the
corpus — which it does whenever both builds were made by the same K install.

Nothing else is touched.  Rule hashes, line numbers, column numbers, attribute
values and term structure are copied verbatim.

Usage:

    ./sanitize-cov-build.py <build-dir> <fixtures-dir>

where `<build-dir>` is a `kompile --coverage` output directory that has been
run against a corpus (so `*_coverage.txt` files exist), and `<fixtures-dir>` is
`packages/kcovr/fixtures`.

See `../PROVENANCE.md` for the build this was run against and what came out.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

# --- discovering the real prefixes ----------------------------------------
#
# Three prefixes, which `PROVENANCE.md`'s census shows to be the complete set:
# no fourth absolute path occurs anywhere in the vendored artifacts.  All three
# are derived from the build — see the module docstring for why none of them is
# written down here.

# `Kompile.java` emits `<id> <file>:<line>:<col>`; the source is everything
# between the single space and the trailing `:line:col`.
_SOURCE = re.compile(r"^[0-9a-f]{64} (?P<source>.*):\d+:\d+$")

# Every K install lays its prelude out under `<root>/include/kframework/`,
# whether `<root>` is a nix store path, a `/usr/local` tree or an unpacked
# release tarball.  That tail is the stable part, so it is what is matched on.
_PRELUDE_TAIL = "/include/kframework/"

# Which per-run hit logs to vendor, and what to call them.  Real names are
# `<pid>_coverage.txt`; a pid is noise, so they are renamed to describe what
# each one is for.  `pick_hit_logs` chooses them by size rather than by name,
# because a pid is not stable across regenerations either — see
# `../PROVENANCE.md` for the selection rationale these sizes implement.
HIT_LOG_NAMES = ("pid-small_coverage.txt", "pid-mid_coverage.txt", "pid-large_coverage.txt")


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


def macro_log_root(compiled: dict) -> str:
    """The build directory, read out of the instrumentation itself.

    `GenerateCoverage.java:72-74` bakes the absolute path of `coverage.txt` into
    every instrumented rule, as a K `String` literal — quotes included — so the
    one directory `compiled.json` names is discoverable without being told where
    the build sits.  Taking it from the artifact rather than from `argv` means a
    build directory that has since been copied or moved still sanitizes to the
    root it was actually made in.
    """
    found: set[str] = set()

    def walk(value: object) -> None:
        if isinstance(value, str):
            if value.endswith('/coverage.txt"'):
                found.add(value[1:-1])
        elif isinstance(value, dict):
            for key, item in value.items():
                walk(key)
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(compiled)
    if len(found) != 1:
        raise SystemExit(f"expected one baked coverage.txt path, found {sorted(found)}")
    return found.pop().rsplit("/", 1)[0] + "/"


def path_map(compiled: dict, all_rules: str) -> list[tuple[str, str]]:
    """The prefix substitution for this build, longest real prefix first."""
    found = sources(all_rules)
    prelude = {s for s in found if _PRELUDE_TAIL in s}
    if not prelude:
        raise SystemExit("no source under an `include/kframework/` root; is this a K build?")
    roots = {s[: s.index(_PRELUDE_TAIL) + len(_PRELUDE_TAIL)] for s in prelude}
    if len(roots) != 1:
        raise SystemExit(f"expected one K prelude root, found {sorted(roots)}")
    spec = {s[: s.rindex("/") + 1] for s in found - prelude}
    if len(spec) != 1:
        raise SystemExit(f"expected exactly one semantics directory, found {sorted(spec)}")
    root = macro_log_root(compiled)
    mapping = [
        # The build directory itself.  It appears in `compiled.json` — once per
        # instrumented rule — and nowhere else.
        (root, f"/fix/build/{root.rstrip('/').rsplit('/', 1)[-1]}/"),
        # The semantics under test.  `/fix/sem/` keeps the two spec files as
        # siblings, which is what makes their `commonprefix` interesting.
        (spec.pop(), "/fix/sem/"),
        # The K prelude.  The `include/kframework/builtin/` tail is preserved on
        # purpose: a deep prelude path is exactly what makes the common prefix
        # of a real source list short, and flattening it would make the golden
        # easier than reality.  Identical to `sanitize-imp-build.py`'s row
        # whenever both builds came from the same K install.
        (roots.pop(), "/fix/k/include/kframework/"),
    ]
    return sorted(mapping, key=lambda entry: len(entry[0]), reverse=True)


# The middle log's target size.  `docs/coverage-plan.md` asked for a `~4 KB`
# log between the two extremes; the corpus has never actually contained one, so
# the two files bracketing this number are the candidates and the union of
# distinct rules decides between them.  See `pick_hit_logs`.
MIDDLE_TARGET = 4096


def pick_hit_logs(build: Path) -> list[Path]:
    """The three logs to vendor, chosen from the corpus by size and coverage.

    This is `../PROVENANCE.md`'s selection rationale as code, not a list of
    filenames: the names are pids, which change on every regeneration and carry
    no information.  The rule is the extremes plus a middle — the smallest log
    that exists, the largest, and, for the middle, the two logs bracketing
    `MIDDLE_TARGET` with whichever of them raises the **union of distinct rules
    hit** further.  That union is what the golden's covered-line count is made
    of, so it is the quantity worth maximising.  Remaining ties break on name,
    so the choice is deterministic.
    """
    logs = sorted(build.glob("*_coverage.txt"))
    if len(logs) < 3:
        raise SystemExit(f"expected a corpus scan's worth of hit logs in {build}, found {len(logs)}")

    def ids(path: Path) -> set[str]:
        return {line for line in path.read_text().split("\n") if line}

    by_size = sorted(logs, key=lambda p: (p.stat().st_size, p.name))
    small, large = by_size[0], by_size[-1]
    rest = [p for p in by_size if p not in (small, large)]
    if not rest:
        raise SystemExit(f"no log strictly between the extremes in {build}")

    below = [p for p in rest if p.stat().st_size <= MIDDLE_TARGET]
    above = [p for p in rest if p.stat().st_size > MIDDLE_TARGET]
    # `below[-1]`/`above[0]` are the two nearest neighbours of the target; if
    # the corpus happens to have one on only one side, that side is the answer.
    candidates = [side[i] for side, i in ((below, -1), (above, 0)) if side]
    fixed = ids(small) | ids(large)
    middle = max(candidates, key=lambda p: (len(fixed | ids(p)), p.stat().st_size))
    return [small, middle, large]


def rule_ids(all_rules: str) -> set[str]:
    return {line.split(" ", 1)[0] for line in all_rules.split("\n") if line}


def import_path(modules: dict[str, dict], start: str, goal: str) -> list[str]:
    """Shortest path `start` -> `goal` along `imports`, inclusive of both ends."""
    queue: list[list[str]] = [[start]]
    seen = {start}
    while queue:
        path = queue.pop(0)
        if path[-1] == goal:
            return path
        for imp in modules[path[-1]]["imports"]:
            name = imp["name"]
            if name not in seen:
                seen.add(name)
                queue.append([*path, name])
    raise SystemExit(f"{goal} is not reachable from {start} through imports")


def extract_definition(compiled: dict, keep: set[str]) -> dict:
    """Cut `compiled.json` down to the rules `allRules.txt` names.

    The criterion is not a curated list: it is exactly the rules that a
    coverage artifact can ever refer to, since a hit log's ids and
    `allRules.txt`'s ids are the same set.  Everything else — productions,
    syntax sorts, claims, every rule with no `UNIQUE_ID` in `allRules.txt` — is
    dropped.

    **Reachability is preserved deliberately.**  `KDefinition.modules` is not
    the module list: it is the transitive closure of `imports` from the main
    module (`outer.py:1216-1218`, mirrored in `kast`'s `outer.ts:1701`), and
    `getRuleById` scans that closure.  So dropping a module that only *relays*
    imports would make the rules behind it invisible to the very function this
    fixture exists to test, while leaving the file superficially fine.  Every
    module on a shortest import path from the main module to a rule-bearing one
    is therefore retained, emptied of sentences if it has none to contribute.
    """
    term = compiled["term"]
    by_name = {module["name"]: module for module in term["modules"]}
    main = term["mainModule"]

    surviving = {
        module["name"]: [
            sentence
            for sentence in module["localSentences"]
            if sentence["node"] == "KRule"
            and sentence["att"]["att"].get("UNIQUE_ID") in keep
        ]
        for module in term["modules"]
    }
    bearing = sorted(name for name, kept in surviving.items() if kept)
    if main not in bearing:
        raise SystemExit(f"main module {main} has no rule in allRules.txt")

    names: set[str] = set()
    for name in bearing:
        names.update(import_path(by_name, main, name))

    modules = [
        {
            **by_name[name],
            "localSentences": surviving[name],
            "imports": [i for i in by_name[name]["imports"] if i["name"] in names],
        }
        # Emitted in the definition's own module order, not sorted: nothing in
        # KAST gives module order meaning, and preserving it keeps the diff
        # against the source file readable.
        for name in (m["name"] for m in term["modules"])
        if name in names
    ]

    return {**compiled, "term": {**term, "modules": modules}}


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        raise SystemExit(__doc__)
    build, fixtures = Path(argv[1]), Path(argv[2])
    cov_build = fixtures / "cov-build"
    compiled_dir = fixtures / "compiled"
    cov_build.mkdir(parents=True, exist_ok=True)
    compiled_dir.mkdir(parents=True, exist_ok=True)

    raw_rules = (build / "allRules.txt").read_text()
    compiled = json.loads((build / "compiled.json").read_text())
    # No lift.  K emits KAST v4 from v7.1.320 on (`kompiled/src/version.ts`),
    # and `@kframework-ts/kast` reads v4 and only v4, so a build made by any
    # release this repo supports is already readable.  An older build is
    # rejected here rather than rewritten into shape: a fixture this script
    # edited is not toolchain output, and calling it one would be a lie.
    if compiled.get("version") != 4:
        raise SystemExit(
            f"compiled.json is KAST version {compiled.get('version')!r}, not 4; "
            "regenerate the build with a K release that emits v4"
        )

    mapping = path_map(compiled, raw_rules)
    print("\n".join(f"{real}\n  -> {fake}" for real, fake in mapping))

    def sanitize(text: str) -> str:
        for real, fake in mapping:
            text = text.replace(real, fake)
        return text

    def sanitize_tree(value: object) -> object:
        """`sanitize` over every string in a JSON document, keys included."""
        if isinstance(value, str):
            return sanitize(value)
        if isinstance(value, dict):
            return {sanitize_tree(k): sanitize_tree(v) for k, v in value.items()}
        if isinstance(value, list):
            return [sanitize_tree(v) for v in value]
        return value

    all_rules = sanitize(raw_rules)
    (cov_build / "allRules.txt").write_text(all_rules)

    # Copied rather than written empty: the point of this file is that a
    # macro-free semantics really does leave a zero-byte one behind, and
    # asserting that is cheaper than trusting it.
    macro_log = (build / "coverage.txt").read_bytes()
    if macro_log:
        raise SystemExit("coverage.txt is not empty; the fixture documents the empty case")
    shutil.copyfile(build / "coverage.txt", cov_build / "coverage.txt")

    for log, fake in zip(pick_hit_logs(build), HIT_LOG_NAMES, strict=True):
        print(f"{log.name} ({log.stat().st_size} B) -> {fake}")
        # Hit logs are bare 64-hex lines with no paths in them, so this is a
        # copy; it runs through `sanitize` anyway so that the invariant "every
        # vendored byte went through the mapping" holds without exception.
        (cov_build / fake).write_text(sanitize(log.read_text()))

    minimal = sanitize_tree(extract_definition(compiled, rule_ids(all_rules)))
    (compiled_dir / "compiled.json").write_text(
        json.dumps(minimal, separators=(",", ":"), sort_keys=False) + "\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
