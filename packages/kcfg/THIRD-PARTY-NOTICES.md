# Third-party notices

## K Framework (pyk)

This package is a hand-transcription of pyk's KCFG graph artifact layer at K
`v7.1.337` (commit `4a46d1231473b599c699160132fd6e76a5c46406`). The exact
implementation and behavioral-oracle files, their hashes, and the reason each
is in scope are machine-readable in `src/version.ts` as `TRANSCRIBED_FROM`.
They include the KCFG graph, minimization/exploration policy, and the upstream
KCFG/minimizer unit tests. The Node split-store layout is derived from
`pyk/src/pyk/kcfg/kcfg.py`; `pyk/src/pyk/kcfg/store.py` is deliberately not
transcribed because it implements Python-specific memory interning.

No upstream Python source is copied verbatim, but this close transcription and
its transcribed behavioral cases are derivative work for notice purposes. The
K Framework is distributed under the BSD 3-Clause License. Its notices are:

> Copyright (c) 2010-2024, University of Illinois Board of Trustees and
> individual contributors. All rights reserved. The K Framework originated in
> the Formal Systems Laboratory led by Prof. Grigore Rosu at the University of
> Illinois at Urbana-Champaign.

> Copyright (c) 2022, Runtime Verification, Inc. All rights reserved.

```
BSD 3-Clause License

Copyright (c) 2022, Runtime Verification, Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
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

Neither the University of Illinois Board of Trustees nor Runtime Verification,
Inc. endorses this package.

## This package's own license

`MIT OR Apache-2.0`, at the user's option. See `LICENSE-MIT` and
`LICENSE-APACHE`.
