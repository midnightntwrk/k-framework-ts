# Nondeterministic search fixtures

Generated from the repository root on 2026-08-07, on
`Linux 6.18.33.2-microsoft-standard-WSL2 x86_64`, with K v7.1.337 (build
date Thu Aug 06 05:58:35 JST 2026). Every command below returned rc 0; each
stored output is its byte-for-byte stdout (including the absence of a final
newline where K emitted none).

```sh
kompile packages/ktool/fixtures/search/nondet.k \
  --backend llvm --enable-search --output-definition /tmp/nondet-kompiled

for count in 0 1 2 3 5; do
  bound=5; test "$count" = 0 && bound=0
  for output in json kore; do
    krun packages/ktool/fixtures/search/"$count".pgm \
      --definition /tmp/nondet-kompiled --search --bound "$bound" --output "$output"
    krun packages/ktool/fixtures/search/"$count".pgm \
      --definition /tmp/nondet-kompiled --search --bound "$bound" --output "$output" --no-pattern
  done
done

krun packages/ktool/fixtures/search/pairs.pgm \
  --definition /tmp/nondet-kompiled --search --bound 5 --output json \
  --pattern '<k> pair(B:KItem, C:KItem) </k>'
krun packages/ktool/fixtures/search/duplicate.pgm \
  --definition /tmp/nondet-kompiled --search --bound 5 --output json
```

`--bound 0` is the official zero-solution route: without it, the unreduced
`zero` configuration is itself a final state. The custom pattern records two
real results with multi-variable `#And` bindings; the duplicate program has
two rule paths to the same final configuration and records one backend-deduped
solution.

The LLVM unsupported-search command (same repository-root CWD and compiled
definition) was:

```sh
krun packages/ktool/fixtures/search/1.pgm --definition /tmp/nondet-kompiled --search-all
```

It returned rc 1. Its exact stderr bytes, shown with the newline escaped so
the literal preceding space remains visible, are
`[Error] krun: Backend llvm does not support --search-all, \n--search-one-or-more-steps, or --search-one-step yet.`.

Search routes force the LLVM interpreter's I/O mode off; this is a backend
invocation fact, not a decoder transformation.

| file | sha256 |
| --- | --- |
| `nondet.k` | `84f7c07a16b0b912ede998e1ecffa59af2fd1698fadc1bd977fc706c7a221d76` |
| `0.pgm` | `ff9fb51036a15c5c92c8b80d3dac03262bfb9d081b1490f719ab4127e6069fce` |
| `1.pgm` | `2c8b08da5ce60398e1f19af0e5dccc744df274b826abe585eaba68c525434806` |
| `2.pgm` | `27dd8ed44a83ff94d557f9fd0412ed5a8cbca69ea04922d88c01184a07300a5a` |
| `3.pgm` | `f6936912184481f5edd4c304ce27c5a1a827804fc7f329f43d273b8621870776` |
| `5.pgm` | `ac169f9fb7cb48d431466d7b3bf2dc3e1d2e7ad6630f6b767a1ac1801c496b35` |
| `pairs.pgm` | `4cc7f2e0e2222655a7b966ba213310fbb063a6c44c5dc835c5988bb45b020c87` |
| `duplicate.pgm` | `3f84cce967052e85c3cf2d671c2433dc4899226bb99a67d6bfe4aeb9e938b7cc` |
| `custom-pattern.json` | `533cc0a657afec1537f61a29415025b90331671891553f1b41382e519e5cad59` |
| `dedup.json` | `94919997a991f4997ecad0980ffab024d462ed7bf57e94c4fe4f9c0c00d039da` |
| `matrix/0.json.default`, `matrix/0.json.no-pattern` | `389ed1d7246538da64f187e2dec80d022b55dbd111bc3f847dad17bae03d52ff` |
| `matrix/0.kore.default`, `matrix/0.kore.no-pattern` | `c87c16a01890095d35b2b42a4f25887fe4e910523e409324fd79ba8cc2d79f57` |
| `matrix/1.json.default` | `94919997a991f4997ecad0980ffab024d462ed7bf57e94c4fe4f9c0c00d039da` |
| `matrix/1.json.no-pattern` | `045996c7b6667b338ad950ba844e359304a6d0f6cf630be1bb0c6ca09eec82b2` |
| `matrix/1.kore.default` | `7fb7113f4533febf3fa8850cc7ee905bfe0287db95a6001ebd07d52604a48ed8` |
| `matrix/1.kore.no-pattern` | `047a7e122d3758e7a7cc14b6e17c7e96d870dbdefaae8e8e6fca057ff67133c5` |
| `matrix/2.json.default` | `7ece43453c492ed807184fce355ec1eaea88c2c15dabab7912cc6696f46e6235` |
| `matrix/2.json.no-pattern` | `6b7b45668613b61d0c6aab2c4a773a7aa52403727a5541695a36eba64fc41242` |
| `matrix/2.kore.default` | `86675bb2c61d7a473422f4c38688a12d673b93fa34957cc6722993ce848e40c9` |
| `matrix/2.kore.no-pattern` | `415657c821e025e6e29668df46856add466ae661b021259f1138973073bdff6a` |
| `matrix/3.json.default` | `efff5deabf7692828d003223d82c6c933b7432513150f4a8c25c9ffbaa4266fd` |
| `matrix/3.json.no-pattern` | `51a16e6ffd97e701f0f5ef4098116682155ca08b241897fd4c49489b1efb936c` |
| `matrix/3.kore.default` | `0c7f6bfefe0b4d224148a569092fa299323495744c764dd962bb67149b8e9c51` |
| `matrix/3.kore.no-pattern` | `fedf01ab59f2a93b808bdd33112908fc48844845e98cb5f2b03a4900b2adf56b` |
| `matrix/5.json.default` | `92de4285ffe8338696ff0da3bcdc273e9f0b6d47dda3c087f616fade651b0a0b` |
| `matrix/5.json.no-pattern` | `289fdde3eec6372fd82fc3ca8f39626cd912620b43416bd3a54d3af5ec6894d2` |
| `matrix/5.kore.default` | `a3d4de89bde0f45b08972a426d76d22bfb55db790c34259e0de484d78e4598f6` |
| `matrix/5.kore.no-pattern` | `92caf6ec856bbd063da791ba384d2d9ed56670cb08eb1dcdff247b5df27e3963` |
