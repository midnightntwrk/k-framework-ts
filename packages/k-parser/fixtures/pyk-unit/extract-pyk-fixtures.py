#!/usr/bin/env python3
"""Dump pyk's inline outer-parser test tables to JSON, once, so TS can be table-driven over them.

Upstream pins its outer lexer, parser, markdown selection and
`outer_syntax -> KAst` bridge with ~330 `@pytest.mark.parametrize` cases
written as module-level `Final` tuples.  Hand-translating those to TypeScript
would be ~330 opportunities to introduce a difference that looks like a passing
test.  So they are not hand-translated: this script imports the test modules and
serialises the tables verbatim, and `test/` reads the JSON.  That also keeps the
tables re-syncable — at the next K release, re-run this and read the diff.

Run against a *source checkout* of `runtimeverification/k` at the tag this
package transcribes, not against an installed `pyk` (the two are usually
different versions):

    PYTHONPATH=<k-checkout>/pyk/src python3 extract-pyk-fixtures.py

The checkout root is derived from `pyk.__file__`; pass `--k <path>` to override.
The script refuses to run unless all six transcribed sources hash to what
`src/version.ts` records, which is the house precedent (see
`packages/kast/fixtures/kast-text/generate-expected.py`): a generator that
silently accepts a different upstream produces goldens that pin nothing.

`pytest` must be importable, because the test modules import it at module level
to build their decorators.  Nothing here *runs* pytest — the tables are plain
tuples, read straight off the imported modules.

## Importing the test modules at all

`k/pyk/src/tests/` has no `__init__.py`, so it is only a namespace package, and
a regular `tests` package anywhere else on `sys.path` (a very common thing to
have installed) wins the import outright — `import tests.unit.kast.test_markdown`
then fails with `ModuleNotFoundError` even with PYTHONPATH set correctly.  So
the package hierarchy is built by hand under a private name (`_pyktests`) whose
`__path__` points at the checkout.  The submodules' own relative imports
(`from ..utils import TEST_DATA_DIR`) resolve through that, unchanged.

## Encoding

Values are encoded structurally, so a TypeScript test can compare against what
it builds without knowing Python:

- `Token` (a `NamedTuple`)  -> `{"text": ..., "type": "KW_RULE", "loc": [line, col]}`
- other dataclasses         -> `{"node": "ClassName", <every declared field>}`
- `Enum`                    -> its member *name* (`Assoc.NON_ASSOC` -> `"NON_ASSOC"`)
- tuples / lists            -> arrays
- `set`                     -> a **sorted** array (Python set order is not a fact)
- `Path`                    -> its string form
- `KAst` (the expected side of `test_ast_to_kast`) -> `.to_dict()`, KAST v4 JSON

`outer_syntax.AST` gives every node two keyword-only fields, `source` and
`location`.  They are emitted **only when not `None`**, because they are `None`
almost everywhere and their absence is unambiguous.  Everything else is emitted
always, defaults included.

Each output file is one table:

    {"table": "BUBBLE_TEST_DATA", "source": "<upstream path>", "note": "...",
     "fields": [...], "cases": [{...}, ...]}
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import importlib
import importlib.util
import json
import sys
from enum import Enum
from pathlib import Path
from typing import Any

# Kept in lockstep with `src/version.ts`'s TRANSCRIBED_FROM and with
# `../PROVENANCE.md`.  Paths are relative to the K checkout root.
K_RELEASE = 'v7.1.337'
TRANSCRIBED_FROM = {
    'pyk/src/pyk/kast/outer_lexer.py': 'c9ff7eb091d4cdd7e25e62bc10ea651b637ed623cf3f8ebe517216e1897238ac',
    'pyk/src/pyk/kast/outer_parser.py': 'd63011402f9f8fb8dbafd461b0ec0833fb9c9283ab56b9923d6672bb2e3cd128',
    'pyk/src/pyk/kast/outer_syntax.py': '5e31852d1bb775a070d91429a7720dce5d6c8a5cd7cb738e2d825cd88da03920',
    'pyk/src/pyk/kast/markdown.py': '2dd7db70eb542f8371abc1a5d4faa52ba8f02e30c135d5f60a8c8f6d7f03548a',
    'pyk/src/pyk/kast/_ast_to_kast.py': '52260d4de7be648562325b06703258fee66503497452c9ea4edc83d07bf07a2b',
    'pyk/src/pyk/kast/utils.py': 'f6bf742332ece60d2f2fe21335eb84c8ff1f8b179f364031911e98041c661896',
}

TESTS_PKG = '_pyktests'


# --------------------------------------------------------------------------
# Guard
# --------------------------------------------------------------------------


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _check_version(k_root: Path) -> None:
    problems: list[str] = []
    for rel, expected in TRANSCRIBED_FROM.items():
        path = k_root / rel
        if not path.is_file():
            problems.append(f'  missing: {rel}')
            continue
        actual = _sha256(path)
        if actual != expected:
            problems.append(f'  changed: {rel}\n    expected {expected}\n    actual   {actual}')
    if problems:
        sys.exit(
            f'refusing to extract: the checkout at {k_root} is not K {K_RELEASE}\n'
            + '\n'.join(problems)
            + '\n\nRe-point --k at a checkout of the recorded tag, or update this script,\n'
            '`src/version.ts` and `../PROVENANCE.md` together after reviewing the diff.'
        )


# --------------------------------------------------------------------------
# Importing pyk's test modules (see the module docstring)
# --------------------------------------------------------------------------


def _register_package(name: str, path: Path) -> None:
    spec = importlib.machinery.ModuleSpec(name, None, is_package=True)
    module = importlib.util.module_from_spec(spec)
    module.__path__ = [str(path)]  # type: ignore[attr-defined]
    sys.modules[name] = module


def _load_test_modules(k_root: Path) -> dict[str, Any]:
    tests_root = k_root / 'pyk' / 'src' / 'tests'
    _register_package(TESTS_PKG, tests_root)
    _register_package(f'{TESTS_PKG}.unit', tests_root / 'unit')
    _register_package(f'{TESTS_PKG}.unit.kast', tests_root / 'unit' / 'kast')
    return {
        name: importlib.import_module(f'{TESTS_PKG}.unit.kast.{name}')
        for name in ('test_outer_lexer', 'test_outer_parser', 'test_markdown', 'test_ast_to_kast')
    }


# --------------------------------------------------------------------------
# Encoding
# --------------------------------------------------------------------------


def encode(value: Any) -> Any:
    from pyk.kast.outer_lexer import Loc, Token

    if value is None or isinstance(value, (bool, int, float, str)):
        return value

    if isinstance(value, Token):
        return {'text': value.text, 'type': value.type.name, 'loc': [value.loc.line, value.loc.col]}

    if isinstance(value, Loc):
        return [value.line, value.col]

    if isinstance(value, Enum):
        return value.name

    if isinstance(value, Path):
        return str(value)

    if isinstance(value, (set, frozenset)):
        return sorted(encode(item) for item in value)

    if isinstance(value, (list, tuple)):
        return [encode(item) for item in value]

    if isinstance(value, dict):
        return {str(key): encode(item) for key, item in value.items()}

    # `KAst` — the expected side of `test_ast_to_kast`.  Its own serialiser is
    # the authority on its shape, and it is exactly what `@kframework-ts/kast`
    # reads, so use it rather than re-deriving the fields here.
    to_dict = getattr(value, 'to_dict', None)
    if callable(to_dict):
        return to_dict()

    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        out: dict[str, Any] = {'node': type(value).__name__}
        for f in dataclasses.fields(value):
            item = getattr(value, f.name)
            # `source` and `location` are `AST`'s two keyword-only fields; they
            # are `None` almost everywhere, so silence means `None`.
            if f.name in ('source', 'location') and item is None:
                continue
            out[f.name] = encode(item)
        return out

    raise TypeError(f'cannot encode {type(value).__name__}: {value!r}')


def write_table(
    out_dir: Path,
    filename: str,
    *,
    table: str,
    source: str,
    fields: list[str],
    rows: Any,
    note: str | None = None,
) -> int:
    cases = [dict(zip(fields, (encode(v) for v in row), strict=True)) for row in rows]
    doc: dict[str, Any] = {'table': table, 'source': source, 'fields': fields}
    if note is not None:
        doc['note'] = note
    doc['cases'] = cases
    (out_dir / filename).write_text(json.dumps(doc, indent=2) + '\n')
    return len(cases)


# --------------------------------------------------------------------------
# The tables
# --------------------------------------------------------------------------

LEXER_SRC = 'pyk/src/tests/unit/kast/test_outer_lexer.py'
PARSER_SRC = 'pyk/src/tests/unit/kast/test_outer_parser.py'
MARKDOWN_SRC = 'pyk/src/tests/unit/kast/test_markdown.py'
AST_SRC = 'pyk/src/tests/unit/kast/test_ast_to_kast.py'

TOKEN_FIELDS = ['text', 'expectedToken', 'expectedRemaining']
TOKENS_FIELDS = ['text', 'expectedTokens', 'expectedRemaining']
KTEXT_FIELDS = ['kText', 'expected']


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--k', type=Path, default=None, help='K checkout root (default: derived from pyk.__file__)')
    args = parser.parse_args()

    try:
        import pyk
    except ImportError:
        sys.exit('pyk is not importable; run with PYTHONPATH=<k-checkout>/pyk/src')

    # .../k/pyk/src/pyk/__init__.py -> .../k
    k_root: Path = args.k.resolve() if args.k else Path(pyk.__file__).resolve().parents[3]
    _check_version(k_root)

    mods = _load_test_modules(k_root)
    lexer, outer, md, ast = (
        mods['test_outer_lexer'],
        mods['test_outer_parser'],
        mods['test_markdown'],
        mods['test_ast_to_kast'],
    )

    out_dir = Path(__file__).parent
    counts: dict[str, int] = {}

    # --- test_outer_lexer.py --------------------------------------------
    counts['outer-lexer-comment.json'] = write_table(
        out_dir,
        'outer-lexer-comment.json',
        table='COMMENT_TEST_DATA',
        source=LEXER_SRC,
        fields=['text', 'expectedSuccess', 'expectedConsumedText', 'expectedRemaining'],
        rows=lexer.COMMENT_TEST_DATA,
        note='`_maybe_comment(la, it)`; `expectedConsumedText` is the joined `consumed` list.',
    )
    counts['outer-lexer-bubble.json'] = write_table(
        out_dir,
        'outer-lexer-bubble.json',
        table='BUBBLE_TEST_DATA',
        source=LEXER_SRC,
        fields=TOKENS_FIELDS,
        rows=lexer.BUBBLE_TEST_DATA,
        note='`_bubble_or_context(la, it, context=False)`.',
    )
    counts['outer-lexer-context.json'] = write_table(
        out_dir,
        'outer-lexer-context.json',
        table='CONTEXT_TEST_DATA',
        source=LEXER_SRC,
        fields=TOKENS_FIELDS,
        rows=lexer.CONTEXT_TEST_DATA,
        note='`_bubble_or_context(la, it, context=True)` — the state where `alias` terminates a bubble.',
    )
    counts['outer-lexer-default.json'] = write_table(
        out_dir,
        'outer-lexer-default.json',
        table='DEFAULT_TEST_DATA',
        source=LEXER_SRC,
        fields=TOKEN_FIELDS,
        rows=lexer.DEFAULT_TEST_DATA,
        note='`_default(la, it)`.',
    )
    counts['outer-lexer-modname.json'] = write_table(
        out_dir,
        'outer-lexer-modname.json',
        table='MODNAME_TEST_DATA',
        source=LEXER_SRC,
        fields=TOKEN_FIELDS,
        rows=lexer.MODNAME_TEST_DATA,
        note='`_modname(la, it)`.',
    )
    counts['outer-lexer-klabel.json'] = write_table(
        out_dir,
        'outer-lexer-klabel.json',
        table='KLABEL_TEST_DATA',
        source=LEXER_SRC,
        fields=TOKEN_FIELDS,
        rows=lexer.KLABEL_TEST_DATA,
        note='`_klabel(la, it)`.',
    )
    counts['outer-lexer-attr.json'] = write_table(
        out_dir,
        'outer-lexer-attr.json',
        table='ATTR_TEST_DATA',
        source=LEXER_SRC,
        fields=TOKENS_FIELDS,
        rows=lexer.ATTR_TEST_DATA,
        note='`_attr(la, it)`, driven to `StopIteration`; the generator returns the lookahead.',
    )

    # --- test_outer_parser.py -------------------------------------------
    counts['outer-parser-sentence.json'] = write_table(
        out_dir,
        'outer-parser-sentence.json',
        table='SENTENCE_TEST_DATA',
        source=PARSER_SRC,
        fields=KTEXT_FIELDS,
        rows=outer.SENTENCE_TEST_DATA,
        note='`OuterParser(kText).sentence()`.',
    )
    counts['outer-parser-import.json'] = write_table(
        out_dir,
        'outer-parser-import.json',
        table='IMPORT_TEST_DATA',
        source=PARSER_SRC,
        fields=KTEXT_FIELDS,
        rows=outer.IMPORT_TEST_DATA,
        note='`OuterParser(kText).importt()`.',
    )
    counts['outer-parser-module.json'] = write_table(
        out_dir,
        'outer-parser-module.json',
        table='MODULE_TEST_DATA',
        source=PARSER_SRC,
        fields=KTEXT_FIELDS,
        rows=outer.MODULE_TEST_DATA,
        note='`OuterParser(kText).module()`; every case carries a 4-tuple `location`.',
    )
    counts['outer-parser-definition.json'] = write_table(
        out_dir,
        'outer-parser-definition.json',
        table='DEFINITION_TEST_DATA',
        source=PARSER_SRC,
        fields=KTEXT_FIELDS,
        rows=outer.DEFINITION_TEST_DATA,
        note='`OuterParser(kText).definition()`.',
    )
    # `test_require` is a plain function upstream, not a parametrized table, so
    # its one case is reconstructed here from the same imports rather than
    # hand-copied into TypeScript.  Keeping it in the same shape as the tables
    # means the TS side needs no special case.
    counts['outer-parser-require.json'] = write_table(
        out_dir,
        'outer-parser-require.json',
        table='test_require',
        source=PARSER_SRC,
        fields=KTEXT_FIELDS,
        rows=[('requires "foo.k"', outer.Require('foo.k'))],
        note='NOT a table upstream: `test_require()` is a plain function, reconstructed here in table shape.',
    )

    # --- test_markdown.py -----------------------------------------------
    counts['markdown-selector-parse.json'] = write_table(
        out_dir,
        'markdown-selector-parse.json',
        table='PARSER_TEST_DATA',
        source=MARKDOWN_SRC,
        fields=KTEXT_FIELDS,
        rows=md.PARSER_TEST_DATA,
        note='`SelectorParser(text).parse()`; nodes are Atom/Not/And/Or.',
    )
    counts['markdown-selector-eval.json'] = write_table(
        out_dir,
        'markdown-selector-eval.json',
        table='EVAL_TEST_DATA',
        source=MARKDOWN_SRC,
        fields=['text', 'atoms', 'expected'],
        rows=md.EVAL_TEST_DATA,
        note='`SelectorParser(text).parse().eval(atoms)`.',
    )
    counts['markdown-parse-tags.json'] = write_table(
        out_dir,
        'markdown-parse-tags.json',
        table='PARSE_TAGS_TEST_DATA',
        source=MARKDOWN_SRC,
        fields=['text', 'expected'],
        rows=md.PARSE_TAGS_TEST_DATA,
        note='`parse_tags(text)`; the expected set is emitted sorted.',
    )

    # --- test_ast_to_kast.py --------------------------------------------
    # The two upstream tables differ only in whether `_ast_to_kast` is called
    # with keyword arguments, so they are merged into one 7-case table with an
    # always-present `kwargs`.
    ast_rows = [(a, e, {}) for a, e in ast.AST_TO_KAST_TEST_DATA] + list(ast.AST_TO_KAST_ARGS_TEST_DATA)
    counts['ast-to-kast.json'] = write_table(
        out_dir,
        'ast-to-kast.json',
        table='AST_TO_KAST_TEST_DATA + AST_TO_KAST_ARGS_TEST_DATA',
        source=AST_SRC,
        fields=['ast', 'expected', 'kwargs'],
        rows=ast_rows,
        note='`_ast_to_kast(ast, **kwargs)`; `expected` is KAST v4 JSON via `KAst.to_dict()`.',
    )

    total = sum(counts.values())
    for name in sorted(counts):
        print(f'{counts[name]:4d}  {name}')
    print(f'{total:4d}  total cases across {len(counts)} files')


if __name__ == '__main__':
    main()
