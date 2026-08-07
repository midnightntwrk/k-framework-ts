/**
 * Identity of this transcription: which upstream files, at which release, with
 * which hashes — the same contract `packages/kore/src/version.ts` and
 * `packages/kast-json/src/version.ts` carry, and the fourth package in this
 * monorepo to need it.
 *
 * A `*-kompiled/` directory has no specification.  It is the output of three
 * separate toolchains (the Java frontend, the LLVM backend, the Haskell
 * backend), and the closest thing to a written contract is the `README.md`
 * that `kompile` copies into every such directory — which ends by saying the
 * layout is "subject to change without warning".  That is why the tiers below
 * are drawn where they are.
 */

/** The K release every source below was read at. */
export const K_RELEASE = "v7.1.337";

/**
 * The KAST-JSON format version this package accepts, and only this one.
 *
 * `ToJson.java:56` emits `4` at {@link K_RELEASE}; the K release that first did
 * so is {@link KAST_VERSION_4_SINCE}.  Every reader upstream compares with
 * strict equality (`JsonParser.java:96-112`, pyk `kast/kast.py:53-54`), and so
 * does `packages/kast`, so a v3 `compiled.json` is rejected rather than lifted.
 * The whole v3→v4 delta is commit `79fae65c1e` — `KSort` gained `params` — and
 * a lifter belongs in `@kframework-ts/kast-json`, which reads both, not here.
 */
export const KAST_VERSION = 4;

/** The K release that started emitting {@link KAST_VERSION}. */
export const KAST_VERSION_4_SINCE = "v7.1.320";

/** The repository a transcription source lives in. */
export type KompiledSourceRepo = "runtimeverification/k";

/**
 * The two drift tiers, hashed separately because they mean different things:
 *
 * - `format` — the pyk sources this package's *behaviour* is transcribed from:
 *   `DefinitionInfo`, `KPrint`, `KompiledKore`, and the KAST formatter.  A
 *   change here means the transcription itself must be re-verified.
 * - `content` — the Java producers, plus the `README.md` `kompile` copies into
 *   every kompiled directory.  These decide what lands on disk.  There is no
 *   single file declaring the layout, so a diff here is **advisory**: a new
 *   artifact may have appeared, or an existing one changed shape, and a human
 *   has to look: a mismatch is a warning, not an exit code.
 */
export type KompiledSourceTier = "format" | "content";

export interface KompiledTranscribedSource {
  readonly repo: KompiledSourceRepo;
  /** Path within that repository's tree. */
  readonly path: string;
  /** Lowercase hex sha256 of the file at {@link K_RELEASE}. */
  readonly sha256: string;
  readonly tier: KompiledSourceTier;
  /** Why this file is in the manifest. */
  readonly why: string;
}

/**
 * Every upstream file this package is derived from.
 *
 * `llvm-backend`'s `LLVMBackend.java` lives in the k repo's `llvm-backend/`
 * directory (not in the `llvm-backend` submodule), so one repo covers the whole
 * manifest — unlike `packages/kore`, which spans two.
 */
export const TRANSCRIBED_FROM: readonly KompiledTranscribedSource[] = [
  // --- format tier: the pyk behaviour this package reimplements ------------
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/ktool/kompile.py",
    sha256: "fda90f2c679be32c64e4720d823975732d31adfb75f42f43c5fa64d5f9e66e7e",
    tier: "format",
    why: "DefinitionInfo (:643-668) — the marker files and the timestamp mtime; Kompile.default_directory (:228) — findKompiledDir",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/ktool/kprint.py",
    sha256: "cf0d3518e2457fe5b5da4b435d976b031221f3715b92f077ec1afe77d7b574c2",
    tier: "format",
    why: "KPrint — definition (:218-220), all_rules (:222-236), definition_hash (:238-240)",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore/kompiled.py",
    sha256: "5bf57e9ed02f15d1594cb609eee180bbe6198c1c5a3f7d7a7b26e24acacffe4e",
    tier: "format",
    why: "KompiledKore — what reading definition.kore is for; its tables live in @kframework-ts/kore",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kast/formatter.py",
    sha256: "3e8555adce63c0b25d33a3518854d8ccf23d8c00f272191204ff79ac94caf429",
    tier: "format",
    why: "Route A pretty printing; transcribed in @kframework-ts/kast's formatter.ts and reached through prettyPrint",
  },

  // --- content tier: the Java producers, and the only prose spec -----------
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/resources/org/kframework/utils/file/README.md",
    sha256: "7202c455a322f60276c475075cc7f76c08065b6ef12b4312181038a9f8cb2120",
    tier: "content",
    why: "the README kompile copies into every kompiled directory — the only prose description of the layout, and therefore its manifest",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/kompile/Kompile.java",
    sha256: "a63e1a3cd3947af73da253a6808d5e09a6475f1ed55aec36faf06c77465c0c31",
    tier: "content",
    why: "writes allRules.txt (:229, :363-381), compiled.json and parsed.json (:234-236), and Bison parser names/aliases (:255-331)",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/kompile/KompileFrontEnd.java",
    sha256: "cea3d4674c74feb18f6572516c4ff8af38399167f73285ef92c4db5f4e324c84",
    tier: "content",
    why: "writes mainModule.txt (:98), mainSyntaxModule.txt (:99), README.md (:101-107), backend.txt (:110), timestamp (:116)",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/kompile/CompiledDefinition.java",
    sha256: "12dc97a71c9fc572a6d95718cfd6c7bd6e4ce084d1378e3e2ffda382dc181e19",
    tier: "content",
    why: "writes configVars.sh (:81-139) — the three forms deriveConfigVars reproduces",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/backend/kore/KoreBackend.java",
    sha256: "783b207fab1bd77ff430088b3023357bf2e1b3a9645206dbf6138506fdf93a87",
    tier: "content",
    why: "writes syntaxDefinition.kore (:98) and macros.kore (:99); excludes `symbolic` modules (:458-460)",
  },
  {
    repo: "runtimeverification/k",
    path: "llvm-backend/src/main/java/org/kframework/backend/llvm/LLVMBackend.java",
    sha256: "fca315a9173a57ddce872cc0aca0258c1445ed8097ba131d534de08eecd570fd",
    tier: "content",
    why: "writes definition.kore (:62) for the llvm backend",
  },
];

/**
 * The artifacts observed in a real `kompile --emit-json` directory at
 * {@link K_RELEASE}, and whether this package reads them.
 *
 * The layout is recorded as a fixture so drift is *visible*; this is that
 * fixture, in code rather than on disk so
 * `ksources.ts` can compare against it without I/O.  A directory that has more
 * or fewer of these is not an error — `-o` renames the directory, backends
 * differ, and `--emit-json` is off by default.
 */
export interface KompiledArtifactInfo {
  readonly file: string;
  /** `"read"` — this package parses it.  `"refused"` — see `kompiled.ts`'s `KompiledArtifact`. */
  readonly status: "read" | "refused" | "ignored";
  readonly note: string;
}

export const OBSERVED_LAYOUT: readonly KompiledArtifactInfo[] = [
  {
    file: "mainModule.txt",
    status: "read",
    note: "bare name, no trailing newline",
  },
  {
    file: "mainSyntaxModule.txt",
    status: "read",
    note: "bare name, no trailing newline",
  },
  {
    file: "backend.txt",
    status: "read",
    note: "llvm | haskell, no trailing newline",
  },
  {
    file: "timestamp",
    status: "read",
    note: "mtime only — 7 bytes of Java serialization, never parsed",
  },
  {
    file: "allRules.txt",
    status: "read",
    note: "<UNIQUE_ID> <file>:<line>:<col>, space-separated",
  },
  {
    file: "configVars.sh",
    status: "read",
    note: "bash; parsed by regex, never executed",
  },
  {
    file: "compiled.json",
    status: "read",
    note: "KAST-JSON v4 KDefinition; --emit-json only",
  },
  {
    file: "definition.kore",
    status: "read",
    note: "textual KORE; read with lazy axiom bodies",
  },
  {
    file: "syntaxDefinition.kore",
    status: "read",
    note: "textual KORE, syntax slice + printing attributes",
  },
  {
    file: "macros.kore",
    status: "read",
    note: "textual KORE; literally `// macros\\n` when empty",
  },
  {
    file: "README.md",
    status: "read",
    note: "the layout's only prose spec; hashed by check-k",
  },
  {
    file: "parsed.json",
    status: "read",
    note: "optional pre-compilation KDefinition; --emit-json only, distinct from compiled.json",
  },
  {
    file: "parsed.txt",
    status: "ignored",
    note: "Definition.toString() debug dump, no grammar guarantee",
  },
  {
    file: "compiled.txt",
    status: "ignored",
    note: "Definition.toString() debug dump",
  },
  {
    file: "post-processed.txt",
    status: "ignored",
    note: "Definition.toString() debug dump; --post-process only",
  },
  {
    file: "compiled.bin",
    status: "refused",
    note: "Java ObjectOutputStream; everything in it is in compiled.json",
  },
  {
    file: "cache.bin",
    status: "refused",
    note: "Java ObjectOutputStream of HashMap<String,ParseCache>",
  },
  {
    file: "haskellDefinition.bin",
    status: "refused",
    note: "GHC COMPACT heap image, GHC-ABI-locked",
  },
  { file: "interpreter", status: "refused", note: "native ELF/Mach-O" },
  { file: "scanner", status: "refused", note: "native tokenizer binary" },
  {
    file: "dt",
    status: "refused",
    note: "LLVM decision-tree YAML; even pyk only existence-checks it",
  },
];
