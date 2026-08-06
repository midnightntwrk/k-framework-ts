# Third-party notices

This package is **private and never published**, and it carries these notices
anyway. Both licences below attach their conditions to redistribution **in
source form** as well as in binary form, and this repository is public: the
bytes in `fixtures/` travel with every clone. A notice belongs where the bytes
are, so it is here rather than in whichever package happens to read them.

## wasm-semantics (KWasm) — NCSA

`fixtures/wasm-haskell-kompiled/` is `kompile` output derived from
`runtimeverification/wasm-semantics` at commit
`194cccdfd8cf002086cead044ad0b90b64060002` (tag `v0.1.156`). That repository is
licensed under the **University of Illinois/NCSA Open Source License** ("The
WebAssembly Semantics in K Release License"), _not_ BSD-3-Clause, and a derived
artifact inherits the terms of what it was derived from. Verified at that commit
on 2026-08-05.

NCSA is an MIT-style grant — use, copy, modify, merge, publish, distribute,
sublicense, sell — under BSD-3-style conditions, and its terms are compatible
with this repository's `MIT OR Apache-2.0`. Those conditions — retention of the
copyright notice, this list of conditions, and the disclaimers, in both source
and binary redistributions, plus no use of the K Team's, Runtime Verification's
or the University of Illinois' names to endorse derived products without
specific prior written permission — are satisfied by this file. **Both are
reproduced below.** Neither the K Team, the University of Illinois, nor Runtime
Verification, Inc. endorses this package.

### Copyright notice

> Copyright (c) 2009-2019 University of Illinois at Urbana-Champaign.
> All rights reserved.
>
> Developed by: K Team (http://kframework.org) with members from the
> University of Illinois at Urbana-Champaign (http://fsl.cs.illinois.edu/) and
> Runtime Verification, Inc (https://www.runtimeverification.com).

### License text

```
University of Illinois/NCSA
Open Source License

Copyright (c) 2009-2019 University of Illinois at Urbana-Champaign.
All rights reserved.

Developed by:

    K Team (http://kframework.org)
    with members from:

      * University of Illinois at Urbana-Champaign (http://fsl.cs.illinois.edu/)
      * Runtime Verification, Inc (https://www.runtimeverification.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal with
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:


    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimers.

    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimers in the
      documentation and/or other materials provided with the distribution.

    * Neither the names of the K Team, Runtime Verification, the University of
      Illinois at Urbana-Champaign, nor the names of its contributors may be
      used to endorse or promote products derived from this Software without
      specific prior written permission.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE
SOFTWARE.
```

## K Framework — BSD 3-Clause

One file in `fixtures/wasm-haskell-kompiled/` is not derived from
`wasm-semantics`: `README.md` is K's own
(`k-frontend/src/main/resources/org/kframework/utils/file/README.md`, sha256
`7202c455a322f60276c475075cc7f76c08065b6ef12b4312181038a9f8cb2120`), which
`kompile` copies verbatim into every `*-kompiled/` directory it writes. It is
byte-identical to the copy in `packages/kompiled`'s IMP fixtures. The K
Framework is distributed under the BSD 3-Clause License; its repository
`LICENSE.md` carries the first copyright notice below and the individual source
files carry the second, and **both are reproduced, as required by clauses 1 and
2**.

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

## Not third-party

`src/` is this workspace's own code. `src/kompile-soak.ts` transcribes the
content-keyed cache idiom from `@kframework-ts/ktool`'s `src/testing.ts` — a
sibling package in this repository under the same `MIT OR Apache-2.0` terms, and
transcribed rather than imported to keep the dependency graph acyclic. That is
noted in the file, not here.

`fixtures/PROVENANCE.md` records the provenance, the pin, and the licence
position at length.
