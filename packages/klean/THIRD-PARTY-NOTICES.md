# Third-party notices

## K Framework (including pyk)

This package is a hand transcription of, and ships the `Prelude.lean` template
verbatim from, the K Framework's pyk `klean` implementation at tag
`v7.1.337` (commit `4a46d1231473b599c699160132fd6e76a5c46406`). Exact paths,
SHA-256 hashes, and roles are exported as `TRANSCRIBED_FROM`.

In particular this covers:

- `pyk/src/pyk/klean/k2lean4.py`
- `pyk/src/pyk/klean/model.py`
- `pyk/src/pyk/klean/generate.py`
- `pyk/src/pyk/klean/__main__.py`
- `pyk/src/pyk/klean/template/{{ cookiecutter.package_name }}/{{ cookiecutter.library_name }}/Prelude.lean`
- `pyk/src/pyk/klean/template/{{ cookiecutter.package_name }}/lakefile.toml`
- `pyk/src/pyk/klean/template/{{ cookiecutter.package_name }}/lean-toolchain`
- `pyk/src/pyk/klean/template/{{ cookiecutter.package_name }}/{{ cookiecutter.library_name }}.lean`
- `pyk/src/pyk/kore/internal.py`

The K Framework is distributed under the BSD 3-Clause License. This closely
related transcription and copied template therefore carry its notices.

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

The old KEVM equivalence repository is an acceptance reference only; no files
from it are copied or distributed by this package.
