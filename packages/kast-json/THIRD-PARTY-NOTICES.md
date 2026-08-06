# Third-party notices

## K Framework

This package's decoders are a **hand-transcription** of files from the
K Framework source tree, at two revisions — the KAST v3 revision read at tag
`v7.1.191` and the KAST v4 revision read at tag `v7.1.337`:

- `k-frontend/src/main/java/org/kframework/unparser/ToJson.java`
  (v3: sha256 `8756c9d8bb1fd9dab3d1e0b6ff7bd9ba019596afb1e04b4c09ad11bf7c1e2c7b`;
  v4: sha256 `1003e8c003abad22cdbdcd14dc64471246e7a5fa39760471297613de7def1c65`)
- `k-frontend/src/main/java/org/kframework/parser/json/JsonParser.java`
  (v3: sha256 `288e39a57fc0bba901d37738ff5d067c94181ae289c2f2868ff223f2a3d1d1fd`;
  v4: sha256 `ee7152871ff838531bc8fb670c95071f5295bcf9c918a1d7aaffe183ef8ee416`)
- `k-frontend/src/main/scala/org/kframework/kore/ADT.scala`
  (sha256 `369b9cd8591d02ff2f07db4fdbec0fd26c18a505b041d4f0519e962c944b5ec2`,
  byte-identical at both tags) — its `Sort.toString` is the specification of
  the flat sort spelling that `flattenSort` reproduces.

KAST JSON has no published schema. Those files _are_ its specification, so
reading the format at all means reading them, and the node names, field names,
optionality rules, ordering and version semantics implemented here are taken
directly from them. No K source code is copied verbatim into this package, but a
transcription this close is fairly regarded as a derivative work, so K's notices
travel with it.

The K Framework is distributed under the BSD 3-Clause License. Its repository
`LICENSE.md` carries the first copyright notice below; the headers of the two
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

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

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

Clause 3 is worth stating plainly: neither the University of Illinois Board of
Trustees nor Runtime Verification, Inc. endorses this package, and nothing here
should be read as suggesting they do.

## Fixtures

Everything under `fixtures/` was produced by running K (`kompile`, `krun` — at
v7.1.191 for the v3 fixtures and v7.1.337 for the `v4/` ones) over a K
definition written for formal-verification research, or copied byte-for-byte
from the K repository's own checked-in test data. The fixtures are
machine-generated output; see `fixtures/PROVENANCE.md` for exactly how each
one was made.

## This package's own license

`MIT OR Apache-2.0`, at the user's option — see `LICENSE-MIT` and
`LICENSE-APACHE`. The notices above are obligations this package carries
_regardless_ of which of the two licenses a consumer takes it under.
