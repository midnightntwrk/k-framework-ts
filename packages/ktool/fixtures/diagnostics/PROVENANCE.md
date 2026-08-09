# Frontend diagnostic fixtures

These are verbatim stderr bytes generated in the repository root with K
v7.1.337 (build date `Thu Aug 06 05:58:35 JST 2026`). They are opaque fixture
input: unit tests parse the stored bytes and never invoke K.

The source definition is `ambiguity.k` (sha256
`a482be452aff1b1cee9b82cfaf244529870488eedac552f94d138d9795e47ed0`).
It was compiled in a fresh temporary directory with:

```sh
kompile packages/ktool/fixtures/diagnostics/ambiguity.k \
  --main-module AMBIGUITY --syntax-module AMBIGUITY --backend llvm \
  --output-definition "$TMP/ambiguity-kompiled"
```

Then, from the same repository-root CWD, the following commands were run and
their stderr was captured exactly (the commands exit 113):

```sh
kast --definition "$TMP/ambiguity-kompiled" --input program --output kore \
  packages/ktool/fixtures/diagnostics/ambiguity.pgm
kast --definition "$TMP/ambiguity-kompiled" --input program --output kore \
  packages/ktool/fixtures/diagnostics/scanner.pgm
```

| file | sha256 |
| --- | --- |
| `ambiguity.pgm` | `52873f6e27cf1f82afca5bb6d4b3a7d8443661ccbe246b92c642945c6a9395d7` |
| `ambiguity.stderr` | `998572f99e0598854afbd016b438e7abc80e2843fb85092684cf1821d5444540` |
| `scanner.pgm` | `ecf5de1a2ecc66a1876a832804c64f6b5125784e94c82285d9720621c613ab46` |
| `scanner.stderr` | `29e7557d6ef106b27642e52d6aa136844e88b75afc410144ab8619e16a853854` |
| `taxonomy.out` | `9f20b5a6a50be8751fe9c62afb12ba9ea780172ba316bfdb5032961e27b1cd17` |
| `non-lr-grammar.stderr` | `71db0b37881ca4d4acd10c3dda415323b614e326d61440a67a6f2033d9a66e69` |

Absolute source paths are part of K's output and therefore intentionally remain
in the golden bytes. Regeneration in a different checkout location requires an
intentional fixture update with new hashes.

## Promoted non-LR grammar diagnostic

`non-lr-grammar.stderr` was captured on 2026-08-09 from the live definition
`test/fixtures/live-k/generated-bison-not-lr1.k` (sha256
`b6078c7ed7994329324e9d5ffa8de316ddf0008300998550f5aa78ec61ff05f4`).
The selected Bison was GNU Bison 3.8.2 at `/usr/bin/bison`. From the repository
root, the effective K command was:

```sh
kompile packages/ktool/test/fixtures/live-k/generated-bison-not-lr1.k \
  --main-module GENERATED-BISON-NOT-LR1 \
  --syntax-module GENERATED-BISON-NOT-LR1-SYNTAX \
  --emit-json --gen-bison-parser --backend haskell --no-haskell-binary \
  --output-definition "$TMP/output" --temp-dir "$TMP" \
  --type-inference-mode checked --warnings all --warnings-to-errors --debug \
  -Wno unused-symbol
```

It exits 113. `--debug` intentionally exposes the `KEMException` prefix and
stack; every byte is retained in the fixture. The diagnostic originates from
`KSyntax2Bison.java:156-163` as `ExceptionType.NON_LR_GRAMMAR`. The unit test
proves the shared parser recognizes that promoted envelope and classifies it as
`inner-parser/non-lr-grammar`.

## Source-backed taxonomy corpus

`taxonomy.out` is a checked-in byte fixture consumed by
`test/search-diagnostics.test.ts`; it does not execute K in CI. The first four
records are protocol-shaped counterparts of the live ambiguity/scanner runs.
The remaining difficult-to-reach records are exact message templates transcribed
from the K v7.1.337 source checkout at
`../inspirations/runtimeverification/k` (commit
`4a46d1231473b599c699160132fd6e76a5c46406`), on 2026-08-07, Linux. Each is
enveloped exactly as `KException.toString()`/`KExceptionManager` print it.
They are source-backed rather than claimed live-reachable: the classifier test
uses every byte and every exported tag, so a source or wording change is a
named fixture failure, not an untested documentation claim.

The exact source extraction/verification session was run from the repository
root (`/home/sebdev20/Documents/git/workspaces/starstream-fv/k-framework-ts`)
on 2026-08-07. `k_src` names the adjacent K checkout and `fixture` names the
checked-in result:

```sh
k_src=../inspirations/runtimeverification/k
fixture=packages/ktool/fixtures/diagnostics/taxonomy.out
git -C "$k_src" show v7.1.337:k-frontend/src/main/java/org/kframework/parser/inner/kernel/EarleyParser.java \
  | rg -n 'Parse error:|Invalid applyPriority'
git -C "$k_src" show v7.1.337:k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/PriorityVisitor.java \
  | rg -n 'immediate child|Priority filter|Associativity filter'
git -C "$k_src" show v7.1.337:k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/inference/SortInferenceError.java \
  | rg -n 'Unexpected sort|Sort inferred|Sort of|monomorphization'
git -C "$k_src" show v7.1.337:k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/TypeInferencer.java \
  | rg -n 'Unexpected sort|Sort of variable'
sha256sum "$fixture"
# 9f20b5a6a50be8751fe9c62afb12ba9ea780172ba316bfdb5032961e27b1cd17  taxonomy.out
bun test packages/ktool/test/search-diagnostics.test.ts
```

The first four `git show`/`rg` commands are the deterministic extraction
commands for the source templates; the remaining raise-site families are
listed in the table below. CI **consumes and byte-checks** `taxonomy.out` via
the fixture test and its recorded sha256; it never regenerates it, because
several source templates require runtime terms and locations to become complete
diagnostic bytes.

The extraction CWD was the repository root; source identities and hashes are
`TRANSCRIBED_FROM` entries in `src/version.ts`. Raise-site families are:

| class records | raise-site authority (v7.1.337) |
| --- | --- |
| parse/scanner | `parser/inner/kernel/EarleyParser.java`, `Scanner.java:494-498` |
| ambiguity | `disambiguation/AmbFilterError.java:49-64` (live fixture also retained) |
| priority/scope | `disambiguation/PriorityVisitor.java` |
| Z3/simple-sub sort inference | `TypeInferenceVisitor.java:193-212`, `TypeInferencer.java:264-326`, `inference/SortInferenceError.java:25-81` |
| overload/record/production | `AddEmptyLists.java:139-154`, `ResolveOverloadedTerminators.java:40`, `CollapseRecordProdsVisitor.java:61,70`, `KAppToTermConsVisitor.java:78` |
| start symbol | `ParseInModule.java:383-386` |
| outer/compiler/envelope | `KException.java`, `KEMException.java`, `KExceptionManager.java`, `FrontEnd.java` |
| native scanner/parser | `Scanner.java:180-185`, `KSyntax2Bison.java:217,275-281` |
| wrapper | `k-distribution/src/main/scripts/lib/k-util.sh:24-29,71-79` |

The taxonomy corpus deliberately includes 25 program-input Inner Parser tags,
four Outer Parser tags, the compiler aggregate, all four wrapper tools, both
native protocols, all six JVM groups, a warning, source/location/snippet fields,
and an unknown future message. The separate live-backed fixture adds the
compiler-generation `non-lr-grammar` tag. This is a classification corpus, not
a promise that every source path is conveniently triggerable by one program
input.
