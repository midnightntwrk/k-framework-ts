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
export type KtoolSourceRepo =
  | "runtimeverification/k"
  | "runtimeverification/llvm-backend"
  | "runtimeverification/haskell-backend";

/** Search rendering authorities live in K submodules, never in K's raw tree. */
export const SEARCH_SOURCE_IDENTITIES = [
  {
    repo: "runtimeverification/llvm-backend",
    gitlinkPath: "llvm-backend/src/main/native/llvm-backend",
    commit: "f02284f09858cd2b9f310ad0142b3e04054295ec",
    path: "runtime/util/ConfigurationPrinter.cpp",
    sha256: "4e20182ea8fbcc5eb82cf79380f1f69a423ef9754597a546a9eabcabcc0da619",
    lines: 323,
    why: "advisory LLVM search disjunction rendering pin",
  },
  {
    repo: "runtimeverification/haskell-backend",
    gitlinkPath: "haskell-backend/src/main/native/haskell-backend",
    commit: "38afc81fc9414f1e11e609b01a43a436b613bd2d",
    path: "kore/src/Kore/Exec.hs",
    sha256: "33781b4634669dbfb720fa86249cab350458f69ee0ea7b35e5d060419e1c07bc",
    lines: 1100,
    why: "advisory Haskell search/disjunction rendering pin",
  },
] as const;

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
  // K v7.1.337's frontend diagnostic surface, consumed as measured text by
  // src/diagnostics.ts. These are content authorities, never a promise that K
  // will retain a particular prose message.
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/utils/errorsystem/KException.java",
    sha256: "b023266464bbb841540828300a6b5346229ca4c94b500ead41517a70e59e3569",
    lines: 332,
    tier: "content",
    why: "JVM diagnostic envelope, groups, source/location and snippets — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/utils/errorsystem/KEMException.java",
    sha256: "a43d6a0517e8924376107bee841b5a07e916b5f978be220781c6053c2e1fc50e",
    lines: 267,
    tier: "content",
    why: "KEMException exit status 113 and frontend message factories — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/utils/errorsystem/KExceptionManager.java",
    sha256: "046aed3031412729e062a9da28428292237532480e698e03a1ac9690fb5a47fa",
    lines: 197,
    tier: "content",
    why: "stderr rendering and diagnostic ordering — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/main/FrontEnd.java",
    sha256: "4d62c28e5fd40f6203ea1857bf1c576391350a1accb7f24303e02cb8ebb060c8",
    lines: 80,
    tier: "content",
    why: "frontend exit-code taxonomy — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/utils/StringUtil.java",
    sha256: "2071fb1d3324df4227a42560b769e0b515eeefdcef4f1fde7af2cde3d1df200b",
    lines: 598,
    tier: "content",
    why: "fixed-width exception wrapping — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/kernel/Scanner.java",
    sha256: "32451e633f48e573813e94726e7e9695dffd455aceb9b4665540cd20508fb142",
    lines: 523,
    tier: "content",
    why: "generated native scanner diagnostic shape — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/kernel/KSyntax2Bison.java",
    sha256: "dbcb208941d6a4c778c10ced5279073b86ee065e82831f21434897280da95e21",
    lines: 637,
    tier: "content",
    why: "generated native parser diagnostic shape — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/kernel/EarleyParser.java",
    sha256: "fc2bf149b323d5914665622318fe11cd1868909ed325cc9096a2f693942ba7a3",
    lines: 1135,
    tier: "content",
    why: "inner-parser message vocabulary — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/PriorityVisitor.java",
    sha256: "c20265569757daea1f430696b642809e9b1c698042e1c59e0f6b4e8f1ace818f",
    lines: 279,
    tier: "content",
    why: "post-parse priority and scope failures — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/AmbFilterError.java",
    sha256: "38e124fad78b63d7ee43a3e79972e1f183fc183be112d9d9d93cf990eca21aeb",
    lines: 68,
    tier: "content",
    why: "ambiguity alternatives — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/ParseInModule.java",
    sha256: "ba956229705c68b563a9aab5bbd535f22792735bd332c4a4aeb0e01bfcccdea5",
    lines: 539,
    tier: "content",
    why: "unknown-start-symbol inner-parser diagnostic — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/TypeInferenceVisitor.java",
    sha256: "8545d7a2df38cb8eb04c62bf2c5bc3a856d526a8bca92b7bef7d763367f2961e",
    lines: 312,
    tier: "content",
    why: "Z3 sort diagnostics — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/AddEmptyLists.java",
    sha256: "444e878306bd7ba3461095a06dfe99ea62240b254a4040fdad46d02cff9adc57",
    lines: 213,
    tier: "content",
    why: "empty-list overload diagnostics — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/CollapseRecordProdsVisitor.java",
    sha256: "87ad56fe9be5ab65388d426027ecd4ec8ddcb049a47929ecc56c59e216be4a39",
    lines: 114,
    tier: "content",
    why: "duplicate-record-key diagnostic — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/ResolveOverloadedTerminators.java",
    sha256: "c415c1fb669efe6b11a1365f0b0fbd264d4f3b6daec00546c51e39a3af7a41a5",
    lines: 49,
    tier: "content",
    why: "overloaded-terminator diagnostic — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/KAppToTermConsVisitor.java",
    sha256: "ea4f93ff5b144478f9c46f5db6559f62563e3ea79f469eba2cfa30c85006c70f",
    lines: 133,
    tier: "content",
    why: "no-suitable-production diagnostic — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/inference/SortInferenceError.java",
    sha256: "7df524db41dac98161520989225624ad8160123b9c4fd5fddc4279b3efa6311f",
    lines: 84,
    tier: "content",
    why: "SimpleSub sort-inference diagnostics — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/TypeInferencer.java",
    sha256: "64ab4933ffeff6790cbadfbaccd31df569e0aaba457475f846dd1665e82042bc",
    lines: 1072,
    tier: "content",
    why: "Z3 localized sort diagnostics — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/unparser/KPrint.java",
    sha256: "48ea5a40e2111c49cd7de2934962f170ab66d4b6da6aefe429b8c3a1edadfd76",
    lines: 427,
    tier: "content",
    why: "advisory KAST search re-binarisation and dedup pin",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/RuleGrammarGenerator.java",
    sha256: "8ff76f1530c16cc660fd4ed4993a3f4bf1655280ce63acdeefe7e04b430402c6",
    lines: 823,
    tier: "content",
    why: "bison-list and parametric parser-generation caveats documented by ktool",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/kompile/Kompile.java",
    sha256: "a63e1a3cd3947af73da253a6808d5e09a6475f1ed55aec36faf06c77465c0c31",
    lines: 872,
    tier: "content",
    why: "official pretty/program compilation output-route authority",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/kast/KastFrontEnd.java",
    sha256: "1eee80a1c242754333f6cad6b83aa1e76f322bbfc3a3d58c627abc81e7621f7c",
    lines: 290,
    tier: "content",
    why: "official kast input/output frontend route authority",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/scala/org/kframework/unparser/KOREToTreeNodes.scala",
    sha256: "1f7ae8fd7e1e7f0f935fd3aef29751662a063df95aad294aef24d4b6deead39f",
    lines: 66,
    tier: "content",
    why: "KORE-to-tree output route boundary documented by ktool",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/scala/org/kframework/definition/outer-to-string.scala",
    sha256: "4d3640d533290ed9201f661132752f2c453568345b7b515fa972c623c3c7c599",
    lines: 116,
    tier: "content",
    why: "Production.toString text used in ambiguity alternatives — src/diagnostics.ts",
  },
  {
    repo: "runtimeverification/k",
    path: "k-distribution/src/main/scripts/lib/k-util.sh",
    sha256: "d657fac9c74fa54d30f4802bc59d00fa56fe4aa68eeb33b32c18a034a54b2761",
    lines: 132,
    tier: "content",
    why: "wrapper-attributed diagnostic envelope and --no-exc-wrap consumption — src/diagnostics.ts",
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
