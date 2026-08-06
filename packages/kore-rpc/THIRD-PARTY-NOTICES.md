# Third-party notices

## haskell-backend (kore-rpc-types)

This package's wire types, error taxonomy, log types and key-order emitter are
a **hand-transcription** of the normative Haskell definitions, read from
`runtimeverification/haskell-backend` at tag `v0.1.155`
(commit `38afc81fc9414f1e11e609b01a43a436b613bd2d` — the submodule commit that
K tag `v7.1.337` pins at `haskell-backend/src/main/native/`):

- `kore-rpc-types/src/Kore/JsonRpc/Types.hs`
  (sha256 `0e643d204fca92b35b22f03537358b66dc3539142457e6f99af1f3ffa6fa9c59`)
- `kore-rpc-types/src/Kore/JsonRpc/Error.hs`
  (sha256 `5547f92bb008ffe7d9772a1d7b408ebd644f3baba886a93afa87ce1b92719f8a`)
- `kore-rpc-types/src/Kore/JsonRpc/Server.hs`
  (sha256 `31b5d8a47674b439e5404074f5cf76fadffe4415c7ea2ed3b0ec621206baf12f`)
- `kore-rpc-types/src/Kore/JsonRpc/Types/Depth.hs`
  (sha256 `3f2a8a298fd0690617aebb545ed1b8379ec32e8067266aa6533d9c792f0b8b45`)
- `kore-rpc-types/src/Kore/JsonRpc/Types/Log.hs`
  (sha256 `246155cf12c1c360178dfd9bddb9d54e31986583bd9f130d73371d0c72da5acf`)
- `kore-rpc-types/src/Kore/JsonRpc/Types/ContextLog.hs`
  (sha256 `fcbfd49eacfe164233c61e9c8f7a87610844e50045111b82633cfae9ffa1da2a`)
- `kore-rpc-types/kore-rpc-types.cabal`
  (sha256 `028021852897a9fe8e951f42f0b4672267e0c6eb43faf81e2aab44b0704688f2`;
  read to pin which aeson/deriving-aeson the derivations above are interpreted by)

A further eight files from the same tree were **read but not transcribed** —
they document what the two server binaries _do_ rather than what the wire _is_,
and every behavioural note in `README.md` and `src/types.ts` (which halt
reasons each server produces, what the proxy rewrites, which CLI flags exist)
comes from them. They are recorded here, and in `src/version.ts`'s `content`
tier, so that a drift check can tell a reader when that documentation needs
re-reading:

- `booster/library/Booster/JsonRpc.hs`
  (sha256 `a327e3550ce35e4255a30e8f96937f731630df58401284451bfb9830977d5ec1`)
- `booster/library/Booster/Pattern/Implies.hs`
  (sha256 `eeaf6d3c9fef1645b9a9e1b656447ebae3eeefa4d8af711ae5cf873dce85e977`)
- `kore/src/Kore/JsonRpc.hs`
  (sha256 `bee4b4f6f03b37bcd71148423b5b00ac50575e87984f3300f3c3ec2391d9c531`)
- `booster/tools/booster/Proxy.hs`
  (sha256 `437fdc8dd0f88c48ebad9a7435da4f75276d42a97655eb21894ec7640e4b53c0`)
- `booster/tools/booster/Server.hs`
  (sha256 `f39864ca4319bd8aa920151433dc6925245f7168314f63df389e4fbcd6439a53`)
- `booster/library/Booster/CLOptions.hs`
  (sha256 `131a311972120e9f4f738a697ad681941f42c439e542338ad55717c641f96d50`)
- `booster/tools/rpc-client/RpcClient.hs`
  (sha256 `b980eccb18c2670de6bff6c7575c7a6ac96d4963738c53f7b0196819b9887c10`;
  `run-tarball`, the only consumer of the bug-report archive `src/bugreport.ts`
  writes, and therefore the authority on its layout)
- `docs/2022-07-18-JSON-RPC-Server-API.md`
  (sha256 `0a29514090e5012a2a8eccb404b094831b03e064cb51054802df31faa8ad08c4`;
  the prose specification, which is stale — see `src/index.ts`)

The haskell-backend is distributed under the BSD 3-Clause License; its
`LICENSE` file carries this notice, reproduced as required by clauses 1 and 2:

> Copyright (c) 2018-2021, Runtime Verification, Inc. All rights reserved.

The license text is identical to the BSD 3-Clause text reproduced below, with
that copyright line.

## K Framework (including pyk)

The client-facing shape of this package — the per-halt-reason result classes,
the typed error hierarchy and its message strings, and the request-parameter
spellings — is a hand-transcription of pyk's kore-rpc client, and the codec
test suite transcribes pyk's own unit-test data tables row for row. Both were
read from the K Framework source tree at tag `v7.1.337`
(commit `4a46d1231473b599c699160132fd6e76a5c46406`):

- `pyk/src/pyk/kore/rpc.py`
  (sha256 `f81b434c81c1386ad3424817b5e7da9a37cf305d81693e79221dc9aedb6a5450`)
- `pyk/src/tests/unit/kore/test_client.py`
  (sha256 `a78496ac6471886aae94d9d2805704888eae7e93c7a2e190de61d81d7e680492`)
- `pyk/src/pyk/utils.py`
  (sha256 `a773154b7832bb5f1a9a8334bc5807fd8ecdc65f94f943118e477dbf52755312`;
  its `BugReport` class is the archive layout `src/bugreport.ts` reproduces)
- `pyk/src/pyk/__main__.py`
  (sha256 `9b8d8cd0c464b0eab41a64ad271e85a2f785fd8c9f55e1a05cc3cda0ea927279`;
  `exec_rpc_print` / `exec_rpc_kast`, transcribed as `src/inspect.ts`)
- `pyk/src/pyk/cli/pyk.py`
  (sha256 `d18762713cb76c812427d61988f27442398e20e10a91d0e16029fbb6f58b760c`;
  read for those two commands' argument surface only)

No K or haskell-backend source code is copied verbatim into this package, but
a transcription this close is fairly regarded as a derivative work, so the
upstream notices travel with it. The K Framework is distributed under the BSD
3-Clause License. Its repository `LICENSE.md` carries the first copyright
notice below; the headers of the individual source files carry the second.
**Both are reproduced, as required by clauses 1 and 2.**

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

## Fixtures

Test fixtures under `fixtures/` are copied byte-for-byte from these same two
repositories and carry their own provenance record, `fixtures/PROVENANCE.md`,
which lists every vendored file with its upstream path and hash. They are not
distributed in the published npm package.

## Machine-readable copy

The hashes above are also recorded, with the same values, in
`src/version.ts` (`TRANSCRIBED_FROM`), which a drift check can read directly.
