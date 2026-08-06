#!/usr/bin/env python3
"""Regenerate `parse-expected.json` from pyk's own textual-KAST parser.

Run against a *source checkout* of `runtimeverification/k` at the tag this
package transcribes, not against an installed `pyk` (the two are usually
different versions):

    PYTHONPATH=<k-checkout>/pyk/src python3 generate-expected.py

For every vendored fixture the script records what `KAstParser(text).k()`
does with it: either the resulting term as `to_dict()`, or the exact
`ValueError` message pyk raises.  Both halves are oracles — the 6 accepted
files pin our terms, the 13 rejected ones pin the boundary of the format
pyk's parser accepts (see `../PROVENANCE.md`).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from pyk.kast.parser import KAstParser

EXPECTED_KAST_VERSION = 4


def main() -> None:
    from pyk.kast.kast import KAst

    if KAst.version() != EXPECTED_KAST_VERSION:
        sys.exit(f'expected KAST version {EXPECTED_KAST_VERSION}, got {KAst.version()}')

    here = Path(__file__).parent
    result: dict[str, object] = {}
    for path in sorted(here.rglob('*.kast')) + sorted(here.rglob('*.kast.out')):
        key = str(path.relative_to(here))
        text = path.read_text()
        try:
            parser = KAstParser(text)
            term = parser.k()
            if not parser.eof():
                raise ValueError(f'Unexpected token: {parser._la.text!r}')
        except ValueError as err:
            result[key] = {'parses': False, 'error': str(err)}
        else:
            result[key] = {'parses': True, 'term': term.to_dict()}

    out = here / 'parse-expected.json'
    out.write_text(json.dumps(dict(sorted(result.items())), indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
