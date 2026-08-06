# Third-party notices

## K Framework

This package is a **hand-transcription** of pyk's outer parser — the six files
in the K Framework source tree that turn `.k` and literate `.md` definition text
into K's frontend AST — read at tag `v7.1.337`
(`4a46d1231473b599c699160132fd6e76a5c46406`):

- `pyk/src/pyk/kast/outer_lexer.py`
  (sha256 `c9ff7eb091d4cdd7e25e62bc10ea651b637ed623cf3f8ebe517216e1897238ac`, 959 lines)
- `pyk/src/pyk/kast/outer_parser.py`
  (sha256 `d63011402f9f8fb8dbafd461b0ec0833fb9c9283ab56b9923d6672bb2e3cd128`, 418 lines)
- `pyk/src/pyk/kast/outer_syntax.py`
  (sha256 `5e31852d1bb775a070d91429a7720dce5d6c8a5cd7cb738e2d825cd88da03920`, 295 lines)
- `pyk/src/pyk/kast/markdown.py`
  (sha256 `2dd7db70eb542f8371abc1a5d4faa52ba8f02e30c135d5f60a8c8f6d7f03548a`, 226 lines)
- `pyk/src/pyk/kast/_ast_to_kast.py`
  (sha256 `52260d4de7be648562325b06703258fee66503497452c9ea4edc83d07bf07a2b`, 60 lines)
- `pyk/src/pyk/kast/utils.py`
  (sha256 `f6bf742332ece60d2f2fe21335eb84c8ff1f8b179f364031911e98041c661896`, 87 lines)

The same list is `src/version.ts`'s `TRANSCRIBED_FROM` — the machine-readable
copy, which `k-parser check-k <release>` uses to answer whether those files
still hold at any later K release.

The `.k` language has no published grammar specification. Those files, together
with the Java frontend's `Outer.jj` they shadow, _are_ the specification of what
K accepts, so reading the format at all means reading them, and the lexer
states, bubble-termination rules, surface-AST shapes, attribute lexing, markdown
fence selection and `require` resolution implemented here are taken directly
from them. No K source code is copied verbatim into this package, but a
transcription this close is fairly regarded as a derivative work, so K's notices
travel with it.

The K Framework is distributed under the BSD 3-Clause License. Its repository
`LICENSE.md` carries the first copyright notice below; the headers of the
individual source files carry the second. **Both are reproduced, as required by
clauses 1 and 2.**

### Copyright notices

> Copyright (c) 2010-2024, University of Illinois Board of Trustees and
> individual contributors. All rights reserved. The K Framework originated in
> the Formal Systems Laboratory led by Prof. Grigore Rosu at the University of
> Illinois at Urbana-Champaign.

> Copyright (c) Runtime Verification, Inc. All Rights Reserved.

### License text

```
BSD 3-Clause License

Copyright (c) 2010-2024, University of Illinois Board of Trustees and individual contributors. All rights reserved. The K Framework originated in the Formal Systems Laboratory led by Prof. Grigore Rosu at the University of Illinois at Urbana-Champaign.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

Clause 3 is worth stating plainly: neither the University of Illinois Board of
Trustees nor Runtime Verification, Inc. endorses this package, and nothing here
should be read as suggesting they do.

## Fixtures

Unlike this package's siblings, whose fixtures are output from running K, the
124 vendored files under `fixtures/` are **K's own source and test data, copied
byte-for-byte** from the same repository at the same tag — so the BSD-3-Clause
notice above covers them directly, as a redistribution in source form:

| what                                                          | from                                         |
| ------------------------------------------------------------- | -------------------------------------------- |
| 37 lexer goldens, 16 markdown goldens, 15 `parse-outer` files | `pyk/src/tests/unit/test-data/`              |
| 45 targeted `.k`/`.md` cases and their `.out` files           | `pyk/regression-new/`                        |
| the 9-file builtin prelude                                    | `k-distribution/include/kframework/builtin/` |
| `imp.json` (Java's outer-parsed IMP) and its `imp.k`          | `pyk/regression-new/`                        |

Three kinds of file under `fixtures/` are **not** copied from K: the two
checked-in generator scripts (`pyk-unit/extract-pyk-fixtures.py`,
`builtin/dump-outer.py`), the JSON they produce from pyk's inline test tables,
and the `.outer.json` surface-AST goldens. Those are this package's own work
product, derived by running pyk — see `fixtures/PROVENANCE.md`, which records
exactly how each one was made and how to reproduce it.

Nothing under `fixtures/` is published: the `files` field of `package.json`
ships `dist` and the documents beside it, and no fixture reaches the tarball.

`fixtures/PROVENANCE.md` also records what is **deliberately not** vendored, and
one item there is a licensing decision rather than a size one: the
`imp-semantics` repository has no LICENSE file and no `license` field in its
`pyproject.toml`, so no fixture is taken from it at all. The IMP source used
here is `pyk/regression-new/imp-llvm/imp.k`, which is BSD-3-Clause like the rest
of the K repository.

## This package's own license

`MIT OR Apache-2.0`, at the user's option — see `LICENSE-MIT` and
`LICENSE-APACHE`. The notices above are obligations this package carries
_regardless_ of which of the two licenses a consumer takes it under.
