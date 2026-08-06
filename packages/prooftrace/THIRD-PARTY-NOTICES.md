# Third-party notices

## llvm-backend — the normative sources

Unlike every sibling package in this repository, this one is **not** transcribed
from pyk. It is written from the **LLVM backend's own specification and
reference implementation**, read from the `runtimeverification/llvm-backend`
tree at tag `v0.1.140` (commit `f02284f09858cd2b9f310ad0142b3e04054295ec`) — the
submodule commit that K `v7.1.337` pins at
`llvm-backend/src/main/native/llvm-backend`.

### Specification

- `docs/proof-trace.md`
  (sha256 `ce0470cc4372e3e264314bc8048e2da07403804b68b671abb3ddf308286c657d`, 152 lines)
- `docs/binary-kore-2.md`
  (sha256 `c413e317f5edf619f4ac7a37ccb12e66d05b8bb9535e09504a711db1694c830a`, 87 lines)

### Reference implementation

- `include/kllvm/binary/ProofTraceParser.h`
  (sha256 `9f3ba56ebcc8d2cca240b63d746482bcca274d93c9e85b3f4de23f2bbbf97be4`, 784 lines)
- `include/kllvm/binary/deserializer.h`
  (sha256 `0a766ca1cb375ec7e58684f755b4d2c2394b8f32cb3fcef8501340d6702b877d`, 483 lines)
- `lib/binary/deserializer.cpp`
  (sha256 `c705a70f9545507087b09f5ec968563e28d16e76a5f7dfde7b3130bab2dbd8c0`, 163 lines)
- `lib/binary/serializer.cpp`
  (sha256 `f70933e2d63423df740cfb0b4b72962d13da27a1ff473a40ff37cccd9d75772c`, 220 lines)
- `include/runtime/proof_trace_writer.h`
  (sha256 `5af1e2f7eaa094e770dba39018fc8af105e218ad076464b6965168766abf2de6`, 410 lines)
- `lib/ast/definition.cpp`
  (sha256 `948b9f9a66d086af36001ddaa61e836af7c72f06eb4b027e6973d05a739daa09`, 370 lines)
- `lib/binary/ProofTraceParser.cpp`
  (sha256 `067ee0fc36438497625dcff44e8977b0681c4cf2ae1d68cd01ea2cf3ae3c0ec2`, 305 lines) —
  the printer, reproduced in `test/support.ts` for the conformance diff
- `lib/ast/AST.cpp` — `kore_pattern::print` (`:1379-1459`) and
  `strip_injections` (`:1128-1139`), likewise
- `tools/kore-rich-header/main.cpp`
  (sha256 `4c34b7aa22f6448fb7e10e96bcd4273d4e5c1eb60f6408b5b5516fa1ece19595`, 45 lines)
- `tools/kore-proof-trace/main.cpp`
  (sha256 `985395713e2d21a6f8b2184b2ea8b36e2b66ad9624226a44f044c6c000aff1d2`, 86 lines)

No C++ is copied into `src/`. The TypeScript is a hand-transcription — same
control flow, same field order, same failure conditions, different language —
and a transcription this close is fairly regarded as a derivative work, so the
backend's notices travel with it.

### Fixture

`fixtures/live-k/add-rewrite.k` **is copied verbatim** from
`docs/proof-trace.md` §Example (`:109-133`): two modules and five rules, the
semantics the specification uses to illustrate the format. It is unmodified.
`fixtures/PROVENANCE.md` records that in full. It is not in the published
tarball — `package.json`'s `files` field ships `dist`, the two licences,
`README.md` and this file.

## K Framework (including pyk)

Four files from `runtimeverification/k` at tag `v7.1.337` (commit
`4a46d1231473b599c699160132fd6e76a5c46406`) are **behavioural references**, not
transcription sources — this package's public shape and its test scenario were
read from them:

- `pyk/src/pyk/kllvm/hints/prooftrace.py`
  (sha256 `d8bfe602ee0b2570da418f7e457251423ef0ebdef9fcb1f32b5742ba6aaffdde`, 610 lines) —
  wraps the C++ bindings `_kllvm.prooftrace` and implements none of the format;
  what was taken is the API shape
- `pyk/src/pyk/kllvm/compiler.py`
  (sha256 `9ac6662eeef1953a1d112dfb1028f3ec3ead1ef941499ec2a1ea8763ec3000b3`, 130 lines) —
  `generate_hints`'s five-element argv
- `pyk/src/pyk/testing/_kompiler.py`
  (sha256 `7f03ec0e8f4537ecc0099f09da5401b279103184e3ea4e94d5f38299211214c5`, 396 lines) —
  `ProofTraceTest`'s kompile flag and header invocation
- `pyk/src/tests/integration/kllvm/test_prooftrace.py`
  (sha256 `6009f01c5543d0e5d026f88679347e2f5007d4adab66b3c226512fc8c423f4ec`, 1026 lines) —
  the only end-to-end test upstream has; `test/live-k.test.ts` reproduces its
  _scenario_, not its source

Nothing from any of them is copied. The same hashes are recorded
machine-readably in `src/version.ts`.

Three pyk modules this package's behaviour depends on are **not** listed here,
because they are transcribed in sibling packages that carry their own notices:
`pyk/src/pyk/kore/*` in `@kframework-ts/kore`, `pyk/src/pyk/kast/*` in
`@kframework-ts/kast`, `pyk/src/pyk/konvert/*` in `@kframework-ts/konvert`, and
`pyk/src/pyk/ktool/krun.py` (`llvm_interpret_raw`, whose argv `generate.ts`
extends) in `@kframework-ts/ktool`.

## The licence, reproduced

The K Framework and the LLVM backend are both distributed under the BSD 3-Clause
License. K's repository `LICENSE.md` carries the first copyright notice below;
the headers of the individual source files, and the llvm-backend, carry the
second. **Both are reproduced, as required by clauses 1 and 2.**

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

## No runtime dependencies outside this repository

This package has **no third-party runtime dependencies at all**. Binary parsing
needs none: `DataView`, `Uint8Array` and `TextDecoder` are the platform. Its
four `dependencies` are all `@kframework-ts/*` workspace siblings, each with its
own notices. This package's own dual `MIT OR Apache-2.0` licence is unaffected.
