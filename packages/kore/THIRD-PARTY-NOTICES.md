# Third-party notices

## K Framework (including pyk)

This package's KORE reader/writer is a **hand-transcription** of pyk's KORE
implementation, read from the K Framework source tree at tag `v7.1.337`
(commit `4a46d1231473b599c699160132fd6e76a5c46406`):

- `pyk/src/pyk/kore/syntax.py`
  (sha256 `ec20a72cfd637d2a66ba06e47507c2ea898167a68c62d2e2e4ee560385bf3aca`)
- `pyk/src/pyk/kore/parser.py`
  (sha256 `dbf27b98593ccecfb347fd4801b7c128b00bff971b5b983dde48ffc9aeed95a8`)
- `pyk/src/pyk/kore/lexer.py`
  (sha256 `d7404acc45c88f962245424193eeab54797b08b0b45430abb736ac99d8abd419`)
- `pyk/src/pyk/dequote.py`
  (sha256 `448bbe752349628a3e6b65f7885f0866f1850d52ba354d7e27d0301aac77dabc`)
- `pyk/src/pyk/kore/prelude.py`
  (sha256 `9fca0129c308c308e6dd008f24c994de38a8267eb618137fd7c4dbecb42ab367`)
- `pyk/src/pyk/kore/match.py`
  (sha256 `3cbecbbf2f5e1a3e13751dd59fca8fab89a3f503f7962fd3f0638bc40a0b5527`)
- `pyk/src/pyk/kore/manip.py`
  (sha256 `db5bf72505aed8e315056fe11549253a9d0d1f34f05665e75f9f339beb4f9e58`)
- `pyk/src/pyk/kore/kompiled.py`
  (sha256 `5bf57e9ed02f15d1594cb609eee180bbe6198c1c5a3f7d7a7b26e24acacffe4e`)

The symbol-name mangling tables and encoder are transcribed from
`k-frontend/src/main/java/org/kframework/utils/StringUtil.java`
(sha256 `2071fb1d3324df4227a42560b769e0b515eeefdcef4f1fde7af2cde3d1df200b`)
and `k-frontend/src/main/java/org/kframework/backend/kore/ModuleToKORE.java`
(sha256 `88e961adb3620b4a51a8b1e3adb8b56961123ace89c67e04637aa7cd8334c3e4`)
at the same tag.

The frontend GLR ambiguity projection is measured against
`k-distribution/include/kframework/builtin/kast.md`
(sha256 `42c815ea80ed522dde962e231bdacc3d0d7e643016f8d649eab8d4be1d570040`)
and `k-distribution/include/kframework/cparser/main.c`
(sha256 `27b4e784542a732a7cb3699f6b78f1e25500ec38a8eae22bc1c05faa83a27201`)
at the same tag. A narrow verbatim KORE excerpt from the LLVM backend test
definition is vendored under `fixtures/ambiguity/`; see its provenance record.

No K source code is copied verbatim into this package, but a transcription
this close is fairly regarded as a derivative work, so K's notices travel with
it. The K Framework is distributed under the BSD 3-Clause License. Its
repository `LICENSE.md` carries the first copyright notice below; the headers
of the individual source files carry the second. **Both are reproduced, as
required by clauses 1 and 2.**

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

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

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

## haskell-backend (kore, kore-rpc-types)

The KORE-JSON codec is a hand-transcription of the reference Haskell codec,
and the textual grammar follows the normative documents, read from
`runtimeverification/haskell-backend` at tag `v0.1.155`
(commit `38afc81fc9414f1e11e609b01a43a436b613bd2d` — the submodule commit
that K tag `v7.1.337` pins):

- `kore-rpc-types/src/Kore/Syntax/Json/Types.hs`
  (sha256 `9a6bd2cc1231ec3d9ffb5e1936945247a9449a61d63b3b3d3054f21edd2794b9`)
- `docs/kore-syntax.md`
  (sha256 `4a73aa604e2bef4727aeb0c82fb800df8122e5975b875fcc31b3875071e6fafd`)
- `kore/src/Kore/Parser/CString.hs`
  (sha256 `27a5b4cfc02b2783b21ae3c1f000abee4e36df1290cef8a43c18fe82f794f6f2`)
- `kore/src/Kore/Parser/Lexer.x`
  (sha256 `4a0306d4bf0732e0d2081a4ee4c9ba31f33f40dfb7b97c978bb10ff19f3c0e9f`)
- `kore/src/Kore/Parser/Parser.y`
  (sha256 `a25435f1d0cf318e56ac977d9710638380c74ad6e40677cf5d00d0ab80a59280`)
- `kore/src/Kore/Unparser.hs`
  (sha256 `9baa46934f6e27dba2470ddea7de82f02939baaed196448afea3ff8addb61403`)
- `src/main/json/kore-schema.json`
  (sha256 `615b55b21da64a06730e7d12e6883d94421b28012957d6ef128d367995e93230`;
  also vendored unmodified under `fixtures/`)

The haskell-backend is distributed under the BSD 3-Clause License; its
`LICENSE` file carries this notice, reproduced as required:

> Copyright (c) 2018-2021, Runtime Verification, Inc. All rights reserved.

The license text is identical to the BSD 3-Clause text reproduced above, with
that copyright line.

Test fixtures under `fixtures/` are copied byte-for-byte from these two
repositories (see `fixtures/PROVENANCE.md`); they are not distributed in the
published npm package.
