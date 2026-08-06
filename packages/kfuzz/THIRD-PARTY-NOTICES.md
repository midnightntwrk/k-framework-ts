# Third-party notices

## K Framework (including pyk)

This package is a **hand-transcription** of pyk's property-fuzzing module, read
from the K Framework source tree at tag `v7.1.337` (commit
`4a46d1231473b599c699160132fd6e76a5c46406`):

- `pyk/src/pyk/ktool/kfuzz.py`
  (sha256 `14d10b85335db51612b0c480bbcc8942bcc935b3d9644bed574f48c68cde75f5`, 206 lines)
- `pyk/src/pyk/kore/manip.py`
  (sha256 `db5bf72505aed8e315056fe11549253a9d0d1f34f05665e75f9f339beb4f9e58`, 95 lines) —
  only `substitute_vars` (`:60-74`), which is `fuzz`'s default substitution
  function and is reimplemented here as `src/subst.ts`

One further file at the same tag is a **behavioural reference**, not a
transcription — this package is checked against it rather than derived from it,
but since `kfuzz.py` has no unit test anywhere, it is the only specification the
module has, so it travels in the same manifest:

- `pyk/src/tests/integration/ktool/test_fuzz.py`
  (sha256 `a5a93f4323801fab2d72f0e8d4afbde3dc711d9c82d229661c2a66211f50a7be`, 207 lines)

Nothing from `test_fuzz.py` is copied. `test/live-k.test.ts` reproduces its
three _scenarios_ against a semantics written in this workspace
(`fixtures/live-k/fuzz-test.k`, first-party — see `fixtures/PROVENANCE.md`), not
against upstream's `imp.k`, and no upstream K source is vendored in this package
at all.

The same hashes are recorded machine-readably in `src/version.ts`.

Two pyk modules this package's behaviour depends on are **not** listed here,
because they are transcribed in sibling packages that carry their own notices:
`pyk/src/pyk/ktool/krun.py` (`llvm_interpret_raw`) in `@kframework-ts/ktool`,
and `pyk/src/pyk/kore/{prelude,parser}.py` in `@kframework-ts/kore`.

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

No file from the `llvm-backend` submodule is copied or transcribed here. One of
its facts is **cited** as an authority and is load-bearing for this package:
`runtime/util/finish_rewriting.cpp`'s
`auto exit_code = error ? 113 : get_exit_code(subject);` is why `checkExitCode`
mode works at all, and it is the reason `fixtures/live-k/fuzz-test.k` carries a
cell with the `exit=""` attribute. `113` is the status a partial-function
evaluation error produces, which is worth knowing before reading an exit code as
a verdict.

The `llvm-backend` is BSD 3-Clause under the same notices as above, with Runtime
Verification's copyright line.

## fast-check

`fast-check` is a runtime dependency, resolved from npm rather than vendored:
no `fast-check` source is copied or transcribed into this package. It is
distributed under the MIT License, © Nicolas DUBIEN and contributors, and npm
ships its `LICENSE` inside its own package where a consumer's tooling can find
it. This package's own dual `MIT OR Apache-2.0` licence is unaffected.

## Fixtures are first-party, and are not distributed

`fixtures/live-k/fuzz-test.k` was written in this workspace and is not derived
from any third-party source; `fixtures/PROVENANCE.md` records that in full. It
is not in the published tarball either way — `package.json`'s `files` field
ships `dist`, the two licences, `README.md` and this file.
