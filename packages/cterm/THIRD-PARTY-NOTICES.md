# Third-party notices

## K Framework (pyk)

This package is a hand-transcription of pyk's constrained-term implementation
at K `v7.1.337` (commit `4a46d1231473b599c699160132fd6e76a5c46406`):

- `pyk/src/pyk/cterm/cterm.py`
  (`a31ddc31151e398f098a42694bb9541f9f8489e0b82b2409c26f22080966e7be`)
- `pyk/src/pyk/cterm/symbolic.py`
  (`2c2a6ec4e845d3db4b94590af16dff176965f39a37c6eefb7b9c2d329e9dcdac`)
- `pyk/src/tests/unit/test_cterm.py`
  (`9eaa7fc78e34af4195a9500d025aa68af67d26759eecc4cc1dcc98a3be84f896`)

The live-K conformance lane also vendors the K source fixture
`pyk/src/tests/integration/test-data/k-files/simple-proofs.k` and the
`KOMPILE_DEFINITION` literal from
`pyk/src/tests/integration/cterm/test_multiple_definitions.py`, both at the
same tag. Their byte-level source and licence provenance is recorded in
`test/fixtures/live-k/PROVENANCE.md`.

No upstream Python source beyond that extracted definition literal is copied
verbatim, but this close transcription and its transcribed test tables are
derivative work for notice purposes. The K Framework is distributed under the
BSD 3-Clause License. Its notices are:

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
