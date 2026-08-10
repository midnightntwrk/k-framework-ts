# Bison LR(1) fixture provenance

The `.y` files in this directory are hand-written minimal witnesses for the
strict LR(1) analysis API. Their `.xml` and `.output` companions were generated
with GNU Bison 3.8.2 from this directory using:

```text
bison -Werror=conflicts-sr -Werror=conflicts-rr --report=all --report-file=<fixture>.output --xml=<fixture>.xml -o <temporary-c-path> <fixture>.y
```

Using a basename for the input deliberately keeps host paths out of the checked
in XML. The live tests exercise the public runner's exact normative argv, its
absolute read-only owned input snapshot, and its
`--file-prefix-map=<owned-directory>=/kframework-ts-bison-input` mapping. That mapping
and the cwd-relative `parser.y` input spelling make the public runner's raw
reports deterministic before hashing; Bison 3.8.2 does not apply the mapping to
XML's `<filename>` itself. The generated reports are evidence
fixtures, not trusted verdicts: tests decode and cross-check their semantic
contents, fully partition the supported Bison 3.8.2 text-report sections, and
reject appended nonempty report drift.
Regenerate them only with GNU Bison 3.8.2 and review semantic changes rather
than accepting byte drift blindly.

- `lr1.y`: a one-production IELR grammar.
- `shift-reduce.y`: an ambiguous expression grammar.
- `reduce-reduce.y`: two reductions for the same token.
- `expected-conflict.y`: the shift/reduce grammar with `%expect 1`, showing
  that raw Bison can exit successfully while policy/XML still expose conflict.
- `precedence.y`: the expression grammar with `%left`, showing a successful
  raw Bison run whose XML records a solved conflict.
- `unambiguous-non-lr1.y`: the two strings `acdd` and `acde` have distinct
  derivations, but deciding the reduction after `ac` requires two tokens of
  lookahead, so the grammar is unambiguous and not LR(1).
- `syntax-error.y`: intentionally malformed after its valid declaration header;
  it has no generated report companions and checks missing-artifact evidence.
- `rule-expected-zero.y`: a conflict-free grammar carrying a rule-level
  `%expect 0`. Raw Bison accepts it, proving the source-policy scanner must find
  rule-level expected-conflict directives even when XML has no conflict trace.
- `panopticon-lr1.output` and `panopticon-lr1.xml`: the reports reproduced from
  Panopticon's `syntax/lr1` witness with the pinned tools on 2026-08-09. They
  retain the ordinary two-digit rule/item lines that exposed the Bison
  right-aligned number field. Only the XML `<filename>` temporary path was
  normalized to `panopticon-lr1.y`; the text report is byte-for-byte output.
  Their SHA-256 digests are respectively
  `0015bb77f0f7ceb165429dd74e536f32bff2685bf732679b86517b08f916c0c7`
  and
  `27456d1c629c635044bb5c905715fb418d35b5ca0c84ac2c48d5c8402fad65c9`.
