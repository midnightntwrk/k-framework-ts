# Pinned pyk KCFG generator

`generate-pinned-pyk-kcfg.py` builds the compact KCFG dictionary used by this
package's fixture test. It deliberately uses `pyk`'s `KCFG`, `CTerm`, and
successor constructors rather than spelling a dictionary by hand. The five
successor kinds live in disconnected components because pyk permits one
successor object per source node.

Run it from any directory with the virtual environment in the pinned K source
checkout:

```sh
/path/to/k/pyk/.venv/bin/python packages/kcfg/fixtures/generators/generate-pinned-pyk-kcfg.py
```

At the recorded revision this rewrites `../pinned-pyk-kcfg.json` deterministically.
The generator also makes pyk deserialize and serialize the document before it
writes it, so a successful run checks pyk's own structural round trip.

See `../PROVENANCE.md` for the required K revision, source hashes, the exact
generation command, and the committed fixture digest.
