# Third-party notices

## K Framework (including pyk)

This package is a **hand-transcription** of pyk's kompiled-directory reader —
`DefinitionInfo`, `KPrint`'s definition/`allRules.txt`/hash surface, and the
job `KompiledKore` does — read from the K Framework source tree at tag
`v7.1.337` (commit `4a46d1231473b599c699160132fd6e76a5c46406`):

- `pyk/src/pyk/ktool/kompile.py`
  (sha256 `fda90f2c679be32c64e4720d823975732d31adfb75f42f43c5fa64d5f9e66e7e`)
- `pyk/src/pyk/ktool/kprint.py`
  (sha256 `cf0d3518e2457fe5b5da4b435d976b031221f3715b92f077ec1afe77d7b574c2`)
- `pyk/src/pyk/kore/kompiled.py`
  (sha256 `5bf57e9ed02f15d1594cb609eee180bbe6198c1c5a3f7d7a7b26e24acacffe4e`)
- `pyk/src/pyk/kast/formatter.py`
  (sha256 `3e8555adce63c0b25d33a3518854d8ccf23d8c00f272191204ff79ac94caf429`;
  transcribed in `@kframework-ts/kast` and reached here through `prettyPrint`)

The _layout_ — which files `kompile` writes, in what shape — was read from the
Java frontend and the LLVM backend at the same tag. These are described, not
transcribed; the derivative-work question is weaker for them, and they are
listed because the package's behaviour is checked against them:

- `k-frontend/src/main/resources/org/kframework/utils/file/README.md`
  (sha256 `7202c455a322f60276c475075cc7f76c08065b6ef12b4312181038a9f8cb2120`)
- `k-frontend/src/main/java/org/kframework/kompile/Kompile.java`
  (sha256 `a63e1a3cd3947af73da253a6808d5e09a6475f1ed55aec36faf06c77465c0c31`)
- `k-frontend/src/main/java/org/kframework/kompile/KompileFrontEnd.java`
  (sha256 `cea3d4674c74feb18f6572516c4ff8af38399167f73285ef92c4db5f4e324c84`)
- `k-frontend/src/main/java/org/kframework/kompile/CompiledDefinition.java`
  (sha256 `12dc97a71c9fc572a6d95718cfd6c7bd6e4ce084d1378e3e2ffda382dc181e19`)
- `k-frontend/src/main/java/org/kframework/backend/kore/KoreBackend.java`
  (sha256 `783b207fab1bd77ff430088b3023357bf2e1b3a9645206dbf6138506fdf93a87`)
- `llvm-backend/src/main/java/org/kframework/backend/llvm/LLVMBackend.java`
  (sha256 `fca315a9173a57ddce872cc0aca0258c1445ed8097ba131d534de08eecd570fd`)

That `README.md` **is** copied verbatim, but only into `fixtures/`, where it
arrived the way `kompile` puts it into every `*-kompiled/` directory. It is not
distributed in the published npm package.

The same hashes are recorded machine-readably in `src/version.ts` and, for the
fixtures, in `fixtures/PROVENANCE.md`.

No K source code is copied verbatim into `src/`, but a transcription this close
is fairly regarded as a derivative work, so K's notices travel with it. The K
Framework is distributed under the BSD 3-Clause License. Its repository
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

## llvm-backend

`fixtures/upstream/unparse/ml/` is copied byte-for-byte from the `llvm-backend`
submodule at `v0.1.140` (commit `f02284f09858cd2b9f310ad0142b3e04054295ec`),
which K tag `v7.1.337` pins. It is BSD 3-Clause under the same notices as
above, with Runtime Verification's copyright line.

## Fixtures

Everything under `fixtures/upstream/` is copied byte-for-byte from
`runtimeverification/k` at `v7.1.337` and from the `llvm-backend` submodule
above; everything under `fixtures/generated/` is the output of running that same
K release's `kompile` and `krun` on inputs vendored from it, from `k` itself. So
**every fixture byte in this package is BSD-3-Clause under the notices above**.
See `fixtures/PROVENANCE.md`, which also records the reproducibility caveat:
those bytes embed absolute paths and reproduce only from the same K install and
working directory.

The KWasm fixture is owned by the private `packages/wasm-fixtures` package;
its NCSA notice is in
[`packages/wasm-fixtures/THIRD-PARTY-NOTICES.md`](../wasm-fixtures/THIRD-PARTY-NOTICES.md).
This package reads that fixture through the package API as a dev dependency;
nothing NCSA-derived is redistributed from here.

One exclusion found while assembling the fixtures is recorded so it is not
re-litigated: **`imp-semantics` has no license file of any kind**, which is why
`fixtures/src/imp.k` is `k`'s own IMP.

Fixtures are not distributed in the published npm package.
