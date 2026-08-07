# Third-party notices

## K Framework (pyk)

This package is a **hand-transcription** of pyk's `kast` module — the K
Framework's Python term-algebra library — read at tag `v7.1.337` of the
`runtimeverification/k` repository. The exact files, with their sha256 at that
tag, are declared in `src/version.ts` (`TRANSCRIBED_FROM`); the class shapes,
matching semantics, JSON correspondence, traversal behaviour and test tables
implemented here are taken directly from them. No Python source is copied
verbatim into this package, but a transcription this close — including
transcribed test-case tables, which copy expression and not just interface —
is fairly regarded as a derivative work, so pyk's notices travel with it.

The package also derives its source-level user-list recognizer from the Java
frontend's `definition/UserList.java`, and records Java frontend sources plus
K's builtin `domains.md`, `kast.md`, and `substitution.md` as content
authorities for production attribution and sort facts. Those files are from the
same K repository and release, so are covered by the same notices and BSD
3-Clause terms.

The repository is also the source of the 19 test-data files vendored
byte-for-byte under `fixtures/kast-text/` (from
`k-distribution/tests/regression-new/`, same tag, catalogued in
`fixtures/PROVENANCE.md`), which are covered by the same license and notices.

pyk is distributed under the BSD 3-Clause License. Its source files carry no
per-file copyright headers; the authority is `pyk/LICENSE.md` in the K
repository, which carries the second copyright notice below. The repository
root `LICENSE.md` carries the first. **Both are reproduced, as required by
clauses 1 and 2.**

### Copyright notices

> Copyright (c) 2010-2024, University of Illinois Board of Trustees and
> individual contributors. All rights reserved. The K Framework originated in
> the Formal Systems Laboratory led by Prof. Grigore Rosu at the University of
> Illinois at Urbana-Champaign.

> Copyright (c) 2022, Runtime Verification, Inc. All rights reserved.

### License text

```
BSD 3-Clause License

Copyright (c) 2022, Runtime Verification, Inc.
All rights reserved.

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
Trustees nor Runtime Verification, Inc. endorses this package, and nothing
here should be read as suggesting they do.

A handful of escape-codec test cases are additionally transcribed from the
Java frontend's `StringUtilTest.java` at the same tag — same repository, same
BSD 3-Clause terms, covered by the notices above.

## KWasm (wasm-semantics)

Seven `bytesToken` formatting test cases are transcribed from
`wasm-semantics/pykwasm/src/tests/unit/test_kwasm_ast.py`
(`runtimeverification/wasm-semantics`), which is distributed under the
**University of Illinois/NCSA Open Source License**. Its notice:

> Copyright (c) 2009-2019 University of Illinois at Urbana-Champaign.
> All rights reserved.
>
> Developed by: K Team (http://kframework.org) with members from the
> University of Illinois at Urbana-Champaign (http://fsl.cs.illinois.edu/) and
> Runtime Verification, Inc (https://www.runtimeverification.com).

The NCSA license requires redistributions of source to retain that notice and
its conditions; see the `LICENSE` file in the `wasm-semantics` repository for
the full text. Neither the K Team, the University of Illinois, nor Runtime
Verification, Inc. endorses this package.

## This package's own license

`MIT OR Apache-2.0`, at the user's option — see `LICENSE-MIT` and
`LICENSE-APACHE`. The notices above are obligations this package carries
_regardless_ of which of the two licenses a consumer takes it under.
