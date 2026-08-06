/**
 * Identity of this transcription: which upstream files, at which releases,
 * with which hashes.
 *
 * Same two-repository shape as `@kframework-ts/kore`'s `version.ts`, for the
 * same reason: kore-rpc's authority is split between the haskell-backend (the
 * normative wire types) and the K repo (pyk, the reference client and the
 * source of the unit-test oracle), pinned to each other by the k repo itself —
 * the `haskell-backend` release below is the submodule commit that k tag
 * `v7.1.337` records at `haskell-backend/src/main/native/`.
 */

/** The K release this package's pyk-derived sources were read at. */
export const K_RELEASE = "v7.1.337";

/**
 * The haskell-backend release the wire types were read at — the submodule
 * commit `38afc81fc9414f1e11e609b01a43a436b613bd2d` that {@link K_RELEASE}
 * pins.
 */
export const HASKELL_BACKEND_RELEASE = "v0.1.155";

/** The repository a transcription source lives in. */
export type KoreRpcSourceRepo = "runtimeverification/k" | "runtimeverification/haskell-backend";

/**
 * The two drift tiers, hashed separately because they drift at very different
 * rates:
 *
 * - `format` — the files that define what the *wire* is: the request/response
 *   records, the error taxonomy, the two log families, and the framing. A
 *   change here means the transcription itself must be re-verified before this
 *   package can be trusted against the new backend.
 * - `content` — the reference client and its tests, the package manifest, and
 *   the two servers' own *semantics*: which reason they halt with, which
 *   errors they raise, what the proxy rewrites, which CLI flags exist. These
 *   change routinely without the wire changing (pyk gains ergonomics, the
 *   cabal file gains a dependency, the proxy gains a fallback case); a diff is
 *   worth reading but is not, on its own, a translation finding. It is,
 *   however, where every behavioural note in this package's README and in
 *   `types.ts` came from, so "worth reading" is not a euphemism.
 *
 * Note the asymmetry with `@kframework-ts/kore`: there the format tier spanned
 * both repos. Here the format tier is *entirely* haskell-backend — pyk has no
 * say in what the wire is, only in what a client does with it.
 */
export type KoreRpcSourceTier = "format" | "content";

export interface KoreRpcTranscribedSource {
  readonly repo: KoreRpcSourceRepo;
  /** Path within that repository's tree. */
  readonly path: string;
  /** Lowercase hex sha256 of the file at the release recorded above. */
  readonly sha256: string;
  readonly tier: KoreRpcSourceTier;
}

/**
 * Every upstream file this package is derived from, or was written by reading.
 * The same paths and hashes are listed in `THIRD-PARTY-NOTICES.md` (the
 * licensing record, which additionally says which of them were *transcribed*
 * and which only read); `fixtures/PROVENANCE.md` is the parallel record for
 * the vendored corpus. This constant is the machine-readable copy, and
 * `ksources.ts` is what asks whether it still holds.
 */
export const TRANSCRIBED_FROM: readonly KoreRpcTranscribedSource[] = [
  // --- haskell-backend: the normative wire (format tier) -------------------
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore-rpc-types/src/Kore/JsonRpc/Types.hs",
    sha256: "0e643d204fca92b35b22f03537358b66dc3539142457e6f99af1f3ffa6fa9c59",
    tier: "format",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore-rpc-types/src/Kore/JsonRpc/Error.hs",
    sha256: "5547f92bb008ffe7d9772a1d7b408ebd644f3baba886a93afa87ce1b92719f8a",
    tier: "format",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore-rpc-types/src/Kore/JsonRpc/Server.hs",
    sha256: "31b5d8a47674b439e5404074f5cf76fadffe4415c7ea2ed3b0ec621206baf12f",
    tier: "format",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore-rpc-types/src/Kore/JsonRpc/Types/Depth.hs",
    sha256: "3f2a8a298fd0690617aebb545ed1b8379ec32e8067266aa6533d9c792f0b8b45",
    tier: "format",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore-rpc-types/src/Kore/JsonRpc/Types/Log.hs",
    sha256: "246155cf12c1c360178dfd9bddb9d54e31986583bd9f130d73371d0c72da5acf",
    tier: "format",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore-rpc-types/src/Kore/JsonRpc/Types/ContextLog.hs",
    sha256: "fcbfd49eacfe164233c61e9c8f7a87610844e50045111b82633cfae9ffa1da2a",
    tier: "format",
  },
  // --- the reference client and its oracle (content tier) ------------------
  //
  // `rpc.py` is where the error hierarchy, the per-reason result classes and
  // the request-parameter spellings come from; `test_client.py`'s six data
  // tables are transcribed row-for-row in `test/codec.test.ts`.
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore/rpc.py",
    sha256: "f81b434c81c1386ad3424817b5e7da9a37cf305d81693e79221dc9aedb6a5450",
    tier: "content",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/tests/unit/kore/test_client.py",
    sha256: "a78496ac6471886aae94d9d2805704888eae7e93c7a2e190de61d81d7e680492",
    tier: "content",
  },
  // `utils.py` is where `BugReport` lives (`:696-743`) — the archive layout
  // `bugreport.ts` reproduces. Only the tar-writing class is read here; the
  // rest of the module's grab-bag belongs to other packages.
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/utils.py",
    sha256: "a773154b7832bb5f1a9a8334bc5807fd8ecdc65f94f943118e477dbf52755312",
    tier: "content",
  },
  // `__main__.py` holds `exec_rpc_print` (`:136-216`) and `exec_rpc_kast`
  // (`:218-236`), which `inspect.ts` transcribes; `cli/pyk.py:409-437` is the
  // argument surface those two are reached through.
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/__main__.py",
    sha256: "9b8d8cd0c464b0eab41a64ad271e85a2f785fd8c9f55e1a05cc3cda0ea927279",
    tier: "content",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/cli/pyk.py",
    sha256: "d18762713cb76c812427d61988f27442398e20e10a91d0e16029fbb6f58b760c",
    tier: "content",
  },
  // The cabal file pins which aeson/deriving-aeson the derivations above are
  // interpreted by — a major bump there could change a field-name modifier
  // without any of the six format files changing a line.
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore-rpc-types/kore-rpc-types.cabal",
    sha256: "028021852897a9fe8e951f42f0b4672267e0c6eb43faf81e2aab44b0704688f2",
    tier: "content",
  },
  // --- the servers' behaviour, as opposed to their wire (content tier) ------
  //
  // The wire types say a `reason` may be `aborted`; only these files say that
  // *booster* produces it and that *kore* turns it into error 6. Every
  // behavioural claim this package documents — the per-server halt reasons,
  // the never-emitted `logs` on implies/simplify, the proxy's reason
  // rewriting, `assume-defined` being a routing switch — was read here, so a
  // diff is the signal to re-read that documentation.
  {
    repo: "runtimeverification/haskell-backend",
    path: "booster/library/Booster/JsonRpc.hs",
    sha256: "a327e3550ce35e4255a30e8f96937f731630df58401284451bfb9830977d5ec1",
    tier: "content",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "booster/library/Booster/Pattern/Implies.hs",
    sha256: "eeaf6d3c9fef1645b9a9e1b656447ebae3eeefa4d8af711ae5cf873dce85e977",
    tier: "content",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore/src/Kore/JsonRpc.hs",
    sha256: "bee4b4f6f03b37bcd71148423b5b00ac50575e87984f3300f3c3ec2391d9c531",
    tier: "content",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "booster/tools/booster/Proxy.hs",
    sha256: "437fdc8dd0f88c48ebad9a7435da4f75276d42a97655eb21894ec7640e4b53c0",
    tier: "content",
  },
  // `Server.hs` and `CLOptions.hs` are the booster's *option parser*, which is
  // what `src/server.ts` assembles a command line against — and the reason
  // pyk's `--not-log-context` is not transcribed: no such option exists in
  // either of them at v0.1.155.
  {
    repo: "runtimeverification/haskell-backend",
    path: "booster/tools/booster/Server.hs",
    sha256: "f39864ca4319bd8aa920151433dc6925245f7168314f63df389e4fbcd6439a53",
    tier: "content",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "booster/library/Booster/CLOptions.hs",
    sha256: "131a311972120e9f4f738a697ad681941f42c439e542338ad55717c641f96d50",
    tier: "content",
  },
  // `RpcClient.hs` is the *reader* of a bug-report tarball (`run-tarball`,
  // `:488-645`) — the only program anywhere that consumes the archive
  // `bugreport.ts` writes, and therefore the authority on three things pyk's
  // writer does not state: that requests must live in a subdirectory, that a
  // `sequence/NNN` file's contents must equal the member name it orders, and
  // that long member names are read through `Tar.decodeLongNames`.
  {
    repo: "runtimeverification/haskell-backend",
    path: "booster/tools/rpc-client/RpcClient.hs",
    sha256: "b980eccb18c2670de6bff6c7575c7a6ac96d4963738c53f7b0196819b9887c10",
    tier: "content",
  },
  // The prose specification. Recorded not because it is authoritative — it is
  // stale, and `index.ts` says so — but because a change to it is the one
  // signal that upstream has decided to describe the protocol again.
  {
    repo: "runtimeverification/haskell-backend",
    path: "docs/2022-07-18-JSON-RPC-Server-API.md",
    sha256: "0a29514090e5012a2a8eccb404b094831b03e064cb51054802df31faa8ad08c4",
    tier: "content",
  },
];
