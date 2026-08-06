#!/usr/bin/env python3
"""Dump pyk's `outer_syntax` surface AST for each vendored builtin file, as a JSON golden.

The nine files beside this script are K's own prelude — the highest
feature-density-per-byte K source that exists, and all of it BSD-3-Clause. They
are here as a parse-clean corpus, but "it parsed" is a weak assertion: this
script records *what pyk parsed them into*, so a `.outer.json` diff catches a
surface-AST regression before the KAST layer is even reached.

Run against a *source checkout* of `runtimeverification/k` at the tag this
package transcribes, not against an installed `pyk`:

    PYTHONPATH=<k-checkout>/pyk/src python3 dump-outer.py

The checkout root is derived from `pyk.__file__`; pass `--k <path>` to override.
As in `../pyk-unit/extract-pyk-fixtures.py`, the script refuses to run unless
all six transcribed sources hash to what `src/version.ts` records.

Two deliberate choices about reproducibility:

- `source=None` is passed to `OuterParser`, so no absolute path from this
  machine can reach the goldens.  (pyk's own `_parse_file` passes the real path
  when `include_source`; that is `utils.py`'s business, not a fixture's.)
- `.md` files are selected with the `'k'` selector, which is what `parse_outer`,
  `slurp_definitions` and the CLI all default to.  Selection is gated purely on
  the `.md` suffix, exactly as `utils.py:74` does it — `unification.k` is parsed
  as-is.

Encoding, matching `../pyk-unit/extract-pyk-fixtures.py`: dataclasses become
`{"node": "ClassName", <every declared field>}`, enums their member name, tuples
arrays, and `source`/`location` are emitted only when not `None`.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import sys
from enum import Enum
from pathlib import Path
from typing import Any

# Kept in lockstep with `src/version.ts`'s TRANSCRIBED_FROM and `../PROVENANCE.md`.
K_RELEASE = 'v7.1.337'
TRANSCRIBED_FROM = {
    'pyk/src/pyk/kast/outer_lexer.py': 'c9ff7eb091d4cdd7e25e62bc10ea651b637ed623cf3f8ebe517216e1897238ac',
    'pyk/src/pyk/kast/outer_parser.py': 'd63011402f9f8fb8dbafd461b0ec0833fb9c9283ab56b9923d6672bb2e3cd128',
    'pyk/src/pyk/kast/outer_syntax.py': '5e31852d1bb775a070d91429a7720dce5d6c8a5cd7cb738e2d825cd88da03920',
    'pyk/src/pyk/kast/markdown.py': '2dd7db70eb542f8371abc1a5d4faa52ba8f02e30c135d5f60a8c8f6d7f03548a',
    'pyk/src/pyk/kast/_ast_to_kast.py': '52260d4de7be648562325b06703258fee66503497452c9ea4edc83d07bf07a2b',
    'pyk/src/pyk/kast/utils.py': 'f6bf742332ece60d2f2fe21335eb84c8ff1f8b179f364031911e98041c661896',
}

MD_SELECTOR = 'k'


def _check_version(k_root: Path) -> None:
    problems = []
    for rel, expected in TRANSCRIBED_FROM.items():
        path = k_root / rel
        if not path.is_file():
            problems.append(f'  missing: {rel}')
        elif (actual := hashlib.sha256(path.read_bytes()).hexdigest()) != expected:
            problems.append(f'  changed: {rel}\n    expected {expected}\n    actual   {actual}')
    if problems:
        sys.exit(
            f'refusing to dump: the checkout at {k_root} is not K {K_RELEASE}\n'
            + '\n'.join(problems)
            + '\n\nRe-point --k at a checkout of the recorded tag, or update this script,\n'
            '`src/version.ts` and `../PROVENANCE.md` together after reviewing the diff.'
        )


def encode(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Enum):
        return value.name
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [encode(item) for item in value]
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        out: dict[str, Any] = {'node': type(value).__name__}
        for f in dataclasses.fields(value):
            item = getattr(value, f.name)
            if f.name in ('source', 'location') and item is None:
                continue
            out[f.name] = encode(item)
        return out
    raise TypeError(f'cannot encode {type(value).__name__}: {value!r}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--k', type=Path, default=None, help='K checkout root (default: derived from pyk.__file__)')
    args = parser.parse_args()

    try:
        import pyk
    except ImportError:
        sys.exit('pyk is not importable; run with PYTHONPATH=<k-checkout>/pyk/src')

    k_root: Path = args.k.resolve() if args.k else Path(pyk.__file__).resolve().parents[3]
    _check_version(k_root)

    from pyk.kast.markdown import select_code_blocks
    from pyk.kast.outer_parser import OuterParser

    here = Path(__file__).parent
    inputs = sorted(p for p in here.iterdir() if p.suffix in ('.k', '.md'))
    if not inputs:
        sys.exit(f'no .k or .md files beside {__file__}')

    failures = 0
    for path in inputs:
        text = path.read_text()
        if path.suffix == '.md':
            text = select_code_blocks(text, MD_SELECTOR)
        try:
            definition = OuterParser(text, source=None).definition()
        except Exception as err:  # noqa: BLE001 — a failure is a finding, not a crash
            failures += 1
            print(f'FAIL  {path.name}: {type(err).__name__}: {err}')
            continue
        out = path.with_suffix(path.suffix + '.outer.json')
        out.write_text(json.dumps(encode(definition), indent=2) + '\n')
        modules = len(definition.modules)
        sentences = sum(len(module.sentences) for module in definition.modules)
        print(f'ok    {path.name} -> {out.name}  ({modules} modules, {sentences} sentences)')

    if failures:
        sys.exit(f'{failures} of {len(inputs)} files failed to parse')


if __name__ == '__main__':
    main()
