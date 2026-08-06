# Third-party notices

## K Framework (including pyk)

This package is a **hand-transcription** of pyk's rule-coverage tooling — hit
counting, Cobertura rendering, cross-build translation, and the legacy
haskell-log analyzer — read from the K Framework source tree at tag `v7.1.337`
(commit `4a46d1231473b599c699160132fd6e76a5c46406`):

- `pyk/src/pyk/kcovr.py`
  (sha256 `a981ca48967e5de4550d5a916fbc892a13227892ea350e74ddbc359cfaa755c3`, 264 lines)
- `pyk/src/pyk/coverage.py`
  (sha256 `b3acd449b58d0e9cbb24785608a4920934db37583a44779eabeedee5404ca182`, 133 lines)
- `pyk/src/pyk/kore_exec_covr/kore_exec_covr.py`
  (sha256 `c4cf9587e91d7627be41fc611dc7c973654efa336756bf792e70a0cd76cce607`, 107 lines)
- `pyk/src/pyk/kore_exec_covr/__main__.py`
  (sha256 `4c0f104ae4da529515da6fd269aadd12dca104ce7cf19653ade1ca6fd0ac4f2f`, 101 lines)

Two further files at the same tag are **behavioural references**, not
transcriptions — this package is checked against them rather than derived from
them, but a change to either invalidates its answers, so they travel in the same
manifest:

- `pyk/src/tests/unit/test_kore_exec_covr.py`
  (sha256 `776d9cc14c402f796446a1710d8a588c14285a5681e6b9d29e555bcf565844e0`, 100 lines)
- `k-frontend/src/main/java/org/kframework/compile/GenerateCoverage.java`
  (sha256 `478a41ff74b523afaab7d9c72f56007e8fe9a2625e7f7218e3b2016fbf751751`, 80 lines)

`test_kore_exec_covr.py` is the exception to "not transcribed": its 7
parametrized cases **are** copied, into
`fixtures/pyk-unit/kore-exec-covr-cases.json`, because they are the only
specification the legacy oneline log format has. That file is fixture material
and is not distributed in the published npm package.

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

### Fixtures vendored from `k`

Under the same BSD-3-Clause notices above:

- `fixtures/generators/coverage-test.k`,
  `fixtures/generators/bytes-coverage-test.k`,
  `fixtures/generators/issue-1388-test.k` — byte-for-byte from
  `pyk/regression-new/{coverage,bytes-coverage,issue-1388}/test.k` at
  `v7.1.337`. They carry Runtime Verification's copyright header in their first
  line, unmodified.
- `fixtures/generators/imp.k` — byte-for-byte from `pyk/regression-new/imp-llvm/imp.k`
  at `v7.1.337` (sha256 `fe5ca3d0a7ac3f9424622a57496e1dc027bf7cf7065fe6d8057d1801672f42ec`),
  carrying Runtime Verification's copyright header in its first line,
  unmodified. **This is the IMP inside the `k` repository, which is BSD-3
  licensed — not the separate `imp-semantics` repository, which has no license
  and is excluded below.**
- `fixtures/imp-build/` — `kompile --coverage` and `krun` output for that
  `imp.k`. `allRules.txt` and the hit log are machine-generated by K from
  BSD-3 material, so they travel under the same notices; `loops.imp` is this
  workspace's own IMP program, first-party like `cov-build/`. Only absolute
  paths were substituted (`fixtures/PROVENANCE.md`, "Path sanitization").
- `fixtures/pyk-unit/kore-exec-covr-cases.json` — the test table described
  above.
- `fixtures/synthetic/golden.cobertura.xml` — the output of running pyk's own
  `render_coverage_xml` at `v7.1.337`. Generated output rather than copied
  source, but it is pyk's rendering of pyk's templates, so it travels under the
  same notices.

## llvm-backend

No file from the `llvm-backend` submodule is copied or transcribed here.
`runtime/io/io.cpp` (sha256
`977b8238f8303163191a90512139974d4ccb5d4793b1db3ee6049379f22617c9`, 786 lines at
the revision `k` `v7.1.337` pins) is cited as the authority for the hit-log
filename grammar and its append/`atexit` semantics, and its identity is recorded
in `src/version.ts` as `IO_CPP_IDENTITY`. It is BSD 3-Clause under the same
notices as above, with Runtime Verification's copyright line.

## panopticon — this workspace's own output

`fixtures/cov-build/` and `fixtures/compiled/` are derived from a
`kompile --coverage` build of the `panopticon` semantics, made in this
workspace. That is first-party material, not third-party: no external grant is
needed, and the sanitization applied to it is documented in
`fixtures/PROVENANCE.md`.

The **instrumentation inside** those artifacts is machine-generated by K's
`GenerateCoverage` pass and is therefore K-derived in the same sense any
`kompile` output is; the BSD-3-Clause notices above cover it.

## wasm-semantics (KWasm) — NCSA — not applicable

`docs/coverage-plan.md` §9 anticipated that a KWasm coverage build might be
vendored here, which would have made this package a redistributor of
NCSA-licensed derived artifacts.

**It is not.** The build does not succeed: `kompile --coverage` fails on KWasm
with `Could not find productions for KApply with label sideEffect:#SortParam{Q0}`,
a defect still present in `GenerateCoverage.java` at `v7.1.337`.
`fixtures/PROVENANCE.md` records the attempt in full under "KWasm generation
attempt". Nothing from `wasm-semantics` is vendored in this package, so no NCSA
notice is required — the section is kept, empty, so that a future phase that
succeeds at the build knows a notice is owed. The template for it is
`packages/kompiled/THIRD-PARTY-NOTICES.md`, which does redistribute KWasm
`kompile` output and carries the full NCSA text.

`fixtures/generators/build-corpus.sh` _builds_ KWasm and other semantics on
demand, but its output is never checked in and never published — the same
posture `packages/k-parser` takes toward its soak corpus.

## mir-semantics (KMIR) — BSD-3-Clause — not applicable

Same story, same defect, recorded for the same reason. `kompile --coverage` of
the KMIR LLVM target fails with the identical
`sideEffect:#SortParam{Q0}` error, on two `simplification` rules in
`mir-semantics/rt/data.md`. Nothing from `mir-semantics` is vendored here, so
no notice is owed; `fixtures/PROVENANCE.md`, "KMIR generation attempt", has the
probe in full. KMIR is BSD-3-Clause, the same license as `k`, so if a future
phase does vendor from it the notices above already cover the text.

## Exclusions, recorded so they are not re-litigated

- **`imp-semantics` has no license file of any kind.** No grant, so nothing from
  it appears here or in any sibling package's fixtures.
- **`bin/kcovr`'s output** (`k-distribution/src/main/scripts/bin/kcovr`) was run
  once as a differential check. Its output is **not** vendored; only prose notes
  about where it diverges from pyk are recorded, in `fixtures/PROVENANCE.md`.

## Fixtures are not distributed

`package.json`'s `files` field ships `dist`, the two licenses, `README.md` and
this file. `fixtures/` is not in the published tarball.
