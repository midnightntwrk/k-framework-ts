/**
 * Identity of this transcription: which upstream files, at which release, with
 * which hashes — the same contract every other package in this monorepo
 * carries, asked about pyk's tool-orchestration layer.
 *
 * What is peculiar to *this* package is that its subject matter has **two**
 * specifications and they are not the same document. pyk's `ktool` decides
 * which flags to emit and in what order; the Java frontend's `KompileOptions`
 * decides which flags exist. A port has to track both, and a divergence between
 * them is a real finding rather than a formatting change — pyk emitting a flag
 * K no longer accepts is exactly the failure this manifest is meant to catch.
 * Hence the two tiers below.
 *
 * And a third peculiarity, added at milestone 5: three modules here —
 * `kserver.ts`, `kparse.ts` and the `/dev/stdin` finding in `stdio.ts` — have
 * **no pyk counterpart at all**. pyk never manages a kserver and never execs a
 * generated Bison parser (`grep -r 'kserver\|nailgun\|parser_' pyk/src/`
 * confirms both). Their specification is the K distribution's own shell
 * scripts, so those scripts are in the **format** tier: a change to
 * `bin/kparse`'s lookup rule invalidates this transcription exactly as a change
 * to a pyk function would. The tier is "what our behaviour is transcribed
 * from", not "what is written in Python".
 */

/** The K release every source below was read at. */
export const K_RELEASE = "v7.1.337" as const;

/** The commit {@link K_RELEASE} names, for the benefit of anyone diffing by hand. */
export const K_COMMIT = "4a46d1231473b599c699160132fd6e76a5c46406" as const;

/** The repository a transcription source lives in. */
export type KtoolSourceRepo = "runtimeverification/k";

/**
 * The two drift tiers, hashed separately because they mean different things:
 *
 * - `format` — the sources this package's *behaviour* is transcribed from: the
 *   pyk argv builders, the process runner, the path predicates, the binary
 *   discovery and the version parser — **plus** the four K distribution scripts
 *   (`bin/kparse`, `bin/{spawn,stop,reset}-kserver`, `lib/checkJava`) that are
 *   the only specification the kserver and native-parser modules have. A change
 *   here means the transcription itself must be re-verified, and it is the tier
 *   that gates trust.
 * - `content` — the Java declaration of what `kompile` actually accepts. A diff
 *   here is **advisory**: a flag may have been added (nothing breaks), renamed
 *   (every argv built for it is now wrong), or removed. A human has to look.
 */
export type KtoolSourceTier = "format" | "content";

export interface KtoolTranscribedSource {
  readonly repo: KtoolSourceRepo;
  /** Path within that repository's tree. */
  readonly path: string;
  /** Lowercase hex sha256 of the file at {@link K_RELEASE}. */
  readonly sha256: string;
  /** Line count at that same release — a human-scale cross-check. */
  readonly lines: number;
  readonly tier: KtoolSourceTier;
  /** Why this file is in the manifest. */
  readonly why: string;
}

/**
 * Every upstream file this package is derived from, at milestone 3.
 *
 * The manifest grows with the package. A file is listed only once code here is
 * derived from it — a manifest that declares files nothing reads cannot be
 * checked against anything. `kprove.py` sits in the format tier rather than the
 * content tier, because src/parse-modules.ts transcribes its argv builder: a
 * rename there makes our argv wrong.
 */
export const TRANSCRIBED_FROM: readonly KtoolTranscribedSource[] = [
  // --- format tier: the pyk behaviour this package reimplements ------------
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/ktool/kompile.py",
    sha256: "fda90f2c679be32c64e4720d823975732d31adfb75f42f43c5fa64d5f9e66e7e",
    lines: 668,
    tier: "format",
    why: "the whole of src/kompile.ts — KompileArgs.args() (:589-637), the per-backend args(), Kompile.__call__'s suffix flags (:301-333), from_dict (:241-266), _booster_kompile (:109-198), _default_output_dir (:356)",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/ktool/_ktool.py",
    sha256: "2a3fc71c67917a6cf5e04eef45888660e5ba16574c352ad32e0fc702caa9eb41",
    lines: 8,
    tier: "format",
    why: "TypeInferenceMode — the four --type-inference-mode values",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/ktool/utils.py",
    sha256: "edec26c181b28320ad3b1aa13ce40d08dbf933fc7e8feaa2c16c0b363ddc4689",
    lines: 47,
    tier: "format",
    why: "KDistribution — the install-prefix-is-the-grandparent rule and include/kframework/builtin (:25-34), which src/distribution.ts keeps while replacing the `which` subprocess",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/utils.py",
    sha256: "a773154b7832bb5f1a9a8334bc5807fd8ecdc65f94f943118e477dbf52755312",
    lines: 743,
    tier: "format",
    why: "run_process_2 (:488-529) and _subprocess_run/_subprocess_communicate (:532-641) — src/proc.ts; plus single() (:287-300), check_dir_path/check_file_path/abs_or_rel_to (:654-693), and unique() (:277-284), FrozenDict (:52-86), hash_str (:373-376) — src/claim-index.ts and src/claim-loader.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kbuild/utils.py",
    sha256: "3f9cb09ad363e1402f6c95c4b9c883082532775fa914c2c62a1b8e189f0571ff",
    lines: 108,
    tier: "format",
    why: "KVersion's pattern and k_version's first-line slice (:18-79) — src/distribution.ts's parseKVersion/kVersion",
  },

  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/ktool/kprint.py",
    sha256: "cf0d3518e2457fe5b5da4b435d976b031221f3715b92f077ec1afe77d7b574c2",
    lines: 353,
    tier: "format",
    why: "src/kast-cli.ts (KAstInput/KAstOutput, _kast, gen_glr_parser, _build_arg_list :136-168, the 128 KiB _expression_kast :314-353, _temp_file :206-216) and src/kprint.ts (KPrint :171-312)",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/ktool/krun.py",
    sha256: "ae45a5156bbb4004a50ae51bf53c476fb21f847787b4bc8f4935881d106c9a76",
    lines: 478,
    tier: "format",
    why: "src/krun.ts (KRunOutput, _build_arg_list :371-424 — the golden table — _krun's validations :328-338, KRun :45-301) and src/interpreter.ts (llvm_interpret/llvm_interpret_raw :427-478)",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore/tools.py",
    sha256: "775bdae924b48def2563391f8e23f3da1edf982bf40ca88785b3acc88ab1c636",
    lines: 78,
    tier: "format",
    why: "src/kore-print.ts — PrintOutput and kore_print, including the --output kore short circuit (:36-37) and the --output_file typo this package does not reproduce (:68)",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/ktool/claim_index.py",
    sha256: "bbfddb80a3a549b7339be4b2f00ecde474bf19b7a1167359fc0abd81a6911ff4",
    lines: 188,
    tier: "format",
    why: "the whole of src/claim-index.ts — _resolve_depends (:51-87), _resolve_claim_label (:89-103), _validate (:41-49), labels/_close_dependencies/_sort_topologically (:124-188)",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/ktool/claim_loader.py",
    sha256: "62825323fe81f414755eac34dcf4520cbc0774ec51b1a9fbf646cb5e3db0db3c",
    lines: 121,
    tier: "format",
    why: "the whole of src/claim-loader.ts — load_claims' cache decision (:57-91), _digest (:93-103, digest scheme deliberately diverges), _ClaimModuleList's wire shape (:106-121)",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/ktool/kprove.py",
    sha256: "f08d09941c272a791542cfede1b80826184e3e9223f9696650389c8b715ea339",
    lines: 389,
    tier: "format",
    why: "src/parse-modules.ts — parse_modules (:255-278) and the _kprove/_build_arg_list argv builder it calls (:88-155), including `if depth:` at :149; ClaimIndex.fromModuleList and ClaimLoader.loadClaims provide get_claims/get_claim_index semantics",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/tests/unit/ktool/test_krun.py",
    sha256: "ae1fb9ddfbd8a8b25e89e15e3a3c5eb8874388fcb3a40555eb7a0f850e012ba3",
    lines: 74,
    tier: "format",
    why: "the only unit test in all of pyk's ktool — its seventeen-key argv table is ported verbatim into test/krun.test.ts, so a change to it is a change to our goldens",
  },

  // --- format tier, K distribution scripts: the specification for the three
  //     modules pyk has no counterpart for -----------------------------------
  {
    repo: "runtimeverification/k",
    path: "k-distribution/src/main/scripts/bin/kparse",
    sha256: "5c7554cf27bff36ac3599ff11078239bdea82f94de55c70e962f4206fc97fcc6",
    lines: 209,
    tier: "format",
    why: "the whole of src/kparse.ts — the syntaxDefinition.kore gate (:164-167), the module/sort defaults (:179-190), the parser_<Sort>_<Module> `[ -x ]` lookup (:194-196), the `--input kore` cat (:202-203) and the kast fallback (:198,207). pyk has no equivalent: it never execs a generated parser",
  },
  {
    repo: "runtimeverification/k",
    path: "k-distribution/src/main/scripts/lib/checkJava",
    sha256: "217f1d06de60efcebf21908a038befaeb3a718209e8c11c9a3c2ec2c5f37efed",
    lines: 66,
    tier: "format",
    why: "src/kserver.ts's address arithmetic and probe — KSERVER_SOCKET defaulting to $HOME/.kserver (:25), the socket being <dir>/socket (:26), NG at lib/kframework/bin/ng (:24) and the JavaVersion dispatch probe (:27-31). Sourced by every K wrapper, which is why setting the variable is the whole integration",
  },
  {
    repo: "runtimeverification/k",
    path: "k-distribution/src/main/scripts/bin/spawn-kserver",
    sha256: "35d2522f1b2bf21c1901fcb88e33af9d2ecf0c8d20b6626f507321c5702f1de5",
    lines: 4,
    tier: "format",
    why: 'spawnKserver — `kserver --socket "$KSERVER_SOCKET" >> "$1" 2>&1 &` (:4)',
  },
  {
    repo: "runtimeverification/k",
    path: "k-distribution/src/main/scripts/bin/stop-kserver",
    sha256: "f3220a7f92efb1aeec81e811044324a675ff1deb3a3598afe0e6ce1de8d9d8b4",
    lines: 3,
    tier: "format",
    why: "stopKserver — `$KSERVER_INSTANCE org.kframework.kserver.KServerFrontEnd shutdown` (:3), whose exit status is 227 on success and is therefore ignored",
  },
  {
    repo: "runtimeverification/k",
    path: "k-distribution/src/main/scripts/bin/reset-kserver",
    sha256: "da140c1d24e60dd5ebfc38a6928b9308f850cb634ff310337c285d35469a7297",
    lines: 3,
    tier: "format",
    why: "resetKserver — `$KSERVER_INSTANCE … reset` (:3), which clears the injector and definition caches without killing the JVM",
  },

  // --- content tier: what the K binaries actually accept --------------------
  {
    repo: "runtimeverification/k",
    path: "k-distribution/include/kframework/cparser/main.c",
    sha256: "27b4e784542a732a7cb3699f6b78f1e25500ec38a8eae22bc1c05faa83a27201",
    lines: 322,
    tier: "content",
    why: 'the C runtime every generated parser links against — the `<file> [<filename>]` argv (:302-316), the `fopen(input_file)` that makes /dev/stdin unusable from a socketpair-stdio spawn (:264), and the trailing `printf("\\n")` (:318) src/kparse.ts trims',
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/kompile/KompileOptions.java",
    sha256: "c4e1768934d10b677e0bfe1cc0ae8c4dd64a3260a6bcecc84fa8d33d8b4e6590",
    lines: 254,
    tier: "content",
    why: "the flag inventory every argv this package builds is checked against — including --emit-json defaulting to false here and true in pyk (:159-161)",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/kast/KastOptions.java",
    sha256: "fb4af35d462b18577c47d2fd082fe094c159fd27ebccaf897bb0ddd5b82312fd",
    lines: 199,
    tier: "content",
    why: "the declaration of what `kast` accepts — --expression/-e, --sort, --module, --input, --gen-glr-parser — which src/kast-cli.ts's argv is built against",
  },
  {
    repo: "runtimeverification/k",
    path: "k-distribution/src/main/scripts/bin/kore-print",
    sha256: "9ecc25d61d1d4773a4a582d5eb34cb54630ea615649a7404732ed8a1510b55a2",
    lines: 234,
    tier: "content",
    why: "kore-print is a shell script, and its option table is the evidence for two findings in src/kore-print.ts: --output-file is hyphenated (pyk emits --output_file) and --output rejects `latex` even though PrintOutput carries it",
  },
  {
    repo: "runtimeverification/k",
    path: "k-distribution/src/main/scripts/bin/krun",
    sha256: "3133034f2427b8438fc52575ffd7a2b0cde43ba7a6a2da597f9279fbaee80b0e",
    lines: 720,
    tier: "content",
    why: "the option table src/krun.ts's argv is built against — --depth, --parser, --term, --search-final, --no-pattern, --proof-hint, --debugger and the rest",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/tests/integration/test_kprint.py",
    sha256: "05825177a9024af4d46efba7d42704016652b1db4d0be97786da5c3128d1c1f5",
    lines: 438,
    tier: "content",
    why: "TestImpDefn's empty/init-config and pretty-print goldens are copied into test/kprint.test.ts, where they are asserted against the checked-in imp-*-kompiled fixtures",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/tests/integration/test_krun.py",
    sha256: "9a71fb194f1b8523a795dea471f438c8f8305406968e8639984a2d2e672cba1a",
    lines: 142,
    tier: "content",
    why: "the only end-to-end coverage KRun and llvm_interpret have upstream — the reference for the gated integration tests milestone 2 leaves as future work",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/tests/integration/kprove/test_get_claims.py",
    sha256: "284bbe29592ea01252abe34749be41106bd7fbc168c2c7c1b5d3fcaa39a6568d",
    lines: 105,
    tier: "content",
    why: "GET_CLAIMS_SPEC_DATA (:20-65) is ported row-for-row into test/claim-index.test.ts, including the skipped simple-dep-in-submodule-2 row (:17,81-82) kept as a documented divergence",
  },
];
