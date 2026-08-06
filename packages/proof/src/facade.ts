/**
 * `proveClaims` — spec file in, verdicts out.
 *
 * This is the composition every real pyk consumer writes for itself. Upstream
 * has two halves of it and ships neither as API:
 *
 * - `ProveRpc.prove_rpc` / `_prove_claim_rpc` (`proof/prove_rpc.py:36-124`)
 *   owns the *claim* logic — functional-claim detection, `EqualityProof` versus
 *   `APRProof`, resume-if-on-disk, prover selection — and has **zero downstream
 *   users**, which is why this package does not port the class.
 * - `kevm_pyk.utils.run_prover` (`utils.py:101-188`) owns the *run* logic —
 *   the `create_prover` factory, sequential versus parallel selection, the
 *   progress callback, and catching any exception into `proof.error_info`
 *   rather than aborting — and is the de-facto public façade every consumer
 *   copies.
 *
 * {@link proveClaims} is those two, joined, over this monorepo's own
 * claim-loading (`@kframework-ts/ktool`) and backend session
 * ({@link withExplore}). The contract that matters, and the reason a batch
 * function exists at all: **one claim crashing does not abort the batch.** Its
 * verdict carries the error, `APRProof.errorInfo` carries it too, and the run
 * continues — `run_prover`'s behaviour exactly.
 */

import { extractLhs, sentenceLabel, type KClaim, type KDefinition, type KFlatModule } from "@kframework-ts/kast";
import { isBottom, isTop } from "@kframework-ts/kast/prelude/ml";
import type { CTerm } from "@kframework-ts/cterm";
import type { KCFGExplore } from "@kframework-ts/kcfg/explore";
import { ClaimLoader, KproveModuleParser, type TypeInferenceMode } from "@kframework-ts/ktool";

import { APRProof } from "./apr.js";
import { APRProver, type APRProverOptions } from "./apr-prover.js";
import { claimDigests, claimUpToDate, digestFilePath, updateClaimDigest } from "./digest.js";
import { EqualityProof } from "./implies.js";
import { ImpliesProver } from "./implies-prover.js";
import { concurrentAdvanceProof } from "./parallel.js";
import { ProofError, type Proof } from "./proof.js";
import { advanceProof, type StepTimeoutEvent } from "./prover.js";
import { aprProofStepKey } from "./step.js";
import { proofDataExists, readProofData, writeProofData } from "./store.js";
import { ProofStatus } from "./status.js";
import { withExplore, type ExploreHandle, type ExploreSession, type ExploreSessionOptions } from "./explore.js";

//////////////////////////////
// initializeAprProof       //
//////////////////////////////

/** The two `CTermSymbolic` methods {@link initializeAprProof} needs. */
export interface InitializeSymbolic {
  assumeDefined(cterm: CTerm, options?: { readonly boosterOnly?: boolean }): Promise<CTerm>;
  simplify(cterm: CTerm, options?: { readonly boosterOnly?: boolean }): Promise<{ readonly cterm: CTerm }>;
}

/**
 * `initialize_apr_proof` (`kevm_pyk/utils.py:329-348`).
 *
 * Both big consumers do this before the first step and pyk does not: the
 * initial node gains its definedness constraint, then both the initial and the
 * target node are simplified and written back with `letNode`. Skipping it
 * costs a proof nothing but leaves `#Ceil` conditions to be rediscovered at
 * every subsumption check.
 *
 * **`boosterOnly: false` is pinned, deliberately.** Upstream pins
 * `booster_only_simplify=False` here regardless of the run-wide setting
 * (`utils.py:334-336`): the `#Ceil` definedness constraint has to be
 * discharged by Kore, and Booster-only mode skips exactly that. A run
 * configured Booster-only everywhere else still takes this one request the long
 * way round.
 *
 * The two guards are upstream's, including the second one's message, which says
 * `#Bottom` while testing for `#Top` (`utils.py:344-347`).
 */
export async function initializeAprProof(symbolic: InitializeSymbolic, proof: APRProof): Promise<void> {
  const initCterm = proof.kcfg.node(proof.init).cterm;
  const targetCterm = proof.kcfg.node(proof.target).cterm;

  const defined = await symbolic.assumeDefined(initCterm, { boosterOnly: false });
  const simplifiedInit = (await symbolic.simplify(defined)).cterm;
  const simplifiedTarget = (await symbolic.simplify(targetCterm)).cterm;

  if (isBottom(simplifiedInit.kast, { weak: true })) {
    throw new ProofError("Simplifying initial node led to #Bottom, are you sure your LHS is defined?");
  }
  if (isTop(simplifiedTarget.kast, { weak: true })) {
    throw new ProofError("Simplifying target node led to #Bottom, are you sure your RHS is defined?");
  }

  proof.kcfg.letNode(proof.init, { cterm: simplifiedInit });
  proof.kcfg.letNode(proof.target, { cterm: simplifiedTarget });
}

//////////////////////////////
// proveClaims              //
//////////////////////////////

/** How one claim came out. */
export interface ProofVerdict {
  /** The proof id, which is the claim's label. */
  readonly id: string;
  readonly status: ProofStatus;
  readonly passed: boolean;
  /**
   * The proof object, advanced as far as it got, or `undefined` when the claim
   * could not be turned into one at all — see {@link ProofVerdict.error}.
   */
  readonly proof: Proof | undefined;
  /**
   * The exception this claim crashed with, if it did.
   *
   * `run_prover` stores it on `APRProof.error_info` and returns `False`
   * (`utils.py:181-187`); this field is the same fact, reported rather than
   * hidden on one of the two proof kinds.
   */
  readonly error: unknown;
  /** True when the proof was already `PASSED` on disk and nothing was run. */
  readonly resumed: boolean;
}

/** What {@link proveClaims} reports as it goes. */
export type ProveProgressEvent =
  | { readonly kind: "claims-loaded"; readonly labels: readonly string[] }
  | { readonly kind: "proof-started"; readonly id: string; readonly index: number; readonly total: number }
  | { readonly kind: "proof-progress"; readonly id: string; readonly summary: string }
  | { readonly kind: "proof-finished"; readonly verdict: ProofVerdict }
  /**
   * Something upstream would have written to the log and this package has no
   * logger for: a `maxWorkers` overridden by `stepTimeout`, a step that
   * exhausted its budget, a claim reinitialised because its digest moved.
   */
  | { readonly kind: "notice"; readonly id: string; readonly message: string };

/** Prover knobs common to both proof kinds (`utils.py:103-131`). */
export interface ProveClaimsProverOptions {
  /** `execute_depth` — the backend's `max-depth`. */
  readonly maxDepth?: number;
  readonly maxIterations?: number;
  readonly cutPointRules?: readonly string[];
  readonly terminalRules?: readonly string[];
  readonly failFast?: boolean;
  readonly counterexampleInfo?: boolean;
  readonly fastCheckSubsumption?: boolean;
  readonly directSubproofRules?: boolean;
  readonly assumeDefined?: boolean;
  readonly extraModule?: KFlatModule;
  readonly optimizeKcfg?: boolean;
  readonly maintenanceRate?: number;
  /** `max_frontier_parallel`: above 1 selects {@link concurrentAdvanceProof}. */
  readonly maxWorkers?: number;
  /** `bmc_depth` on every `APRProof` this call constructs. */
  readonly bmcDepth?: number;
  /**
   * `step_timeout` — a per-step wall-clock budget in whole seconds.
   *
   * **Setting it forces the run sequential.** `run_prover` does the same
   * (`utils.py:145-153`): the budget is enforced by `advance_proof` and
   * `parallel_advance_proof` does not wrap steps in one, so a timeout plus
   * `maxWorkers > 1` would silently be no timeout at all. A `maxWorkers` that
   * is being ignored is reported as a `notice` progress event, standing in for
   * upstream's `_LOGGER.warning`.
   */
  readonly stepTimeout?: number;
}

/** Everything {@link proveClaims} takes. */
export interface ProveClaimsOptions extends ProveClaimsProverOptions {
  /** The `*-kompiled/` directory; also what the spec file is parsed against. */
  readonly definitionDir: string;
  readonly specFile: string;
  readonly specModuleName?: string;
  readonly claimLabels?: readonly string[];
  readonly excludeClaimLabels?: readonly string[];
  /** Close the selection over `depends(...)`. Defaults to `true`, as `ClaimLoader` does. */
  readonly includeDependencies?: boolean;
  readonly includeDirs?: readonly string[];
  /** K's `include/kframework/builtin`; `ClaimLoader` folds it into the cache digest. */
  readonly builtinDir?: string;
  readonly mdSelector?: string;
  readonly typeInferenceMode?: TypeInferenceMode;
  /** The `kprove` command the spec is parsed with; defaults to `['kprove']` on `PATH`. */
  readonly kproveCommand?: readonly string[];
  /** Where proofs are read from and written to. Without it nothing is persisted. */
  readonly proofDir?: string;
  /** Start from scratch even when the proof is on disk — kimp/kevm/kontrol's `--reinit`. */
  readonly reinit?: boolean;
  /**
   * Gate resume on `<proofDir>/digest`, so a claim whose text changed is
   * re-initialised instead of resumed. Defaults to `true`, as kevm-pyk does
   * (`__main__.py:290-307`); needs a `proofDir` to have anywhere to record it.
   *
   * Turn it **off** to resume a proof directory written by another tool: pyk,
   * kevm-pyk and Kontrol all key their digests off their own claim
   * serialisation, and a directory with no digest file at all reads as "out of
   * date" and is re-proved from scratch. See `digest.ts` for what the value is.
   */
  readonly digest?: boolean;
  /** Run {@link initializeAprProof} on every fresh `APRProof`. Defaults to `false`, as `ProveRpc` does. */
  readonly initializeProofs?: boolean;
  /**
   * Backend session settings; `definitionDir` comes from this object.
   *
   * **This is where the `KCFGSemantics` goes**, and forgetting it is the
   * expensive mistake: the default calls nothing terminal and no state a loop,
   * so a language whose proofs close on `is_terminal` will explore past its own
   * end. Every real consumer passes one (`downstream`'s `semantics(definition)`
   * fixture is the pyk equivalent).
   */
  readonly explore?: Omit<ExploreSessionOptions, "definitionDir">;
  /** An already-open session, so a caller can prove several batches on one server. */
  readonly session?: ExploreSession;
  readonly progress?: (event: ProveProgressEvent) => void;
}

/**
 * Load a spec file's claims, prove each, and report a verdict for every one.
 *
 * Per claim, in `_prove_claim_rpc`'s order (`prove_rpc.py:96-124`), with
 * kevm-pyk's digest gate around the resume decision (`__main__.py:290-307`):
 *
 * 1. **Functional-claim detection**: the LHS head symbol being one of the
 *    definition's function productions selects `EqualityProof` over `APRProof`
 *    (`prove_rpc.py:105-106`).
 * 2. **Resume by default, if the claim has not changed**: with a `proofDir`, an
 *    existing proof directory is read back instead of the freshly constructed
 *    proof — unless `reinit`, or unless `<proofDir>/digest` says this claim (or
 *    something it depends on) is not the one that proof was built from.
 * 3. **Nothing to do**: a proof that already passed, or `maxIterations: 0`,
 *    takes no steps and touches no backend.
 * 4. **Advance**: `ImpliesProver` for the implies family, `APRProver`
 *    otherwise — serially, or through {@link concurrentAdvanceProof} when
 *    `maxWorkers > 1` and the proof is an `APRProof`.
 * 5. **Never abort the batch**: an exception becomes the verdict's `error` and,
 *    for an `APRProof`, its `errorInfo`.
 *
 * The backend is one session for the whole batch — one server, one client per
 * prover. `ProveRpc` opens a *fresh* context per claim (`prove_rpc.py:112`);
 * that is a cost, not a contract, and module injection is per-proof-named so
 * sharing a session is safe.
 */
export async function proveClaims(options: ProveClaimsOptions): Promise<readonly ProofVerdict[]> {
  const claims = await loadProveClaims(options);
  options.progress?.({ kind: "claims-loaded", labels: claims.map((claim) => sentenceLabel(claim)) });

  // `init_claim_jobs(spec_module_name, all_claims)` — once for the batch, so a
  // dependency's digest is computed once however many claims name it
  // (`__main__.py:286`).
  const proofDir = options.proofDir;
  const gate: DigestGate | undefined =
    proofDir === undefined || options.digest === false
      ? undefined
      : { file: digestFilePath(proofDir), digests: claimDigests(claims, specModuleName(options)) };

  const run = async (session: ExploreSession): Promise<readonly ProofVerdict[]> => {
    const verdicts: ProofVerdict[] = [];
    let index = 0;
    for (const claim of claims) {
      index += 1;
      verdicts.push(await proveOneClaim(claim, session, options, index, claims.length, gate));
    }
    return verdicts;
  };

  if (options.session !== undefined) return run(options.session);
  return withExplore(
    {
      ...options.explore,
      definitionDir: options.definitionDir,
      // A server that must answer several provers at once needs the threads to
      // do it — see the kore-rpc README on `haskellThreads`.
      ...(options.explore?.haskellThreads === undefined && (options.maxWorkers ?? 1) > 1
        ? { haskellThreads: options.maxWorkers }
        : {}),
    },
    run,
  );
}

/** What the digest gate needs: where it is recorded, and what each claim hashes to. */
interface DigestGate {
  readonly file: string;
  readonly digests: ReadonlyMap<string, string>;
}

/**
 * The spec module name dependency labels are qualified with
 * (`kevm_pyk/__main__.py:283-285`): the given one, else the spec file's base
 * name upper-cased.
 */
function specModuleName(options: ProveClaimsOptions): string {
  if (options.specModuleName !== undefined) return options.specModuleName;
  const base = options.specFile.split(/[/\\]/u).at(-1) ?? options.specFile;
  const dot = base.lastIndexOf(".");
  return (dot <= 0 ? base : base.slice(0, dot)).toUpperCase();
}

/** `ProveRpc.prove_rpc`'s claim loading (`prove_rpc.py:36-58`), through ktool's `ClaimLoader`. */
export async function loadProveClaims(options: ProveClaimsOptions): Promise<readonly KClaim[]> {
  const loader = new ClaimLoader(
    new KproveModuleParser({
      definitionDir: options.definitionDir,
      ...(options.kproveCommand === undefined ? {} : { command: options.kproveCommand }),
    }),
  );
  const claims = await loader.loadClaims(options.specFile, {
    ...(options.specModuleName === undefined ? {} : { specModuleName: options.specModuleName }),
    ...(options.claimLabels === undefined ? {} : { claimLabels: options.claimLabels }),
    ...(options.excludeClaimLabels === undefined ? {} : { excludeClaimLabels: options.excludeClaimLabels }),
    ...(options.includeDependencies === undefined ? {} : { includeDependencies: options.includeDependencies }),
    ...(options.includeDirs === undefined ? {} : { includeDirs: options.includeDirs }),
    ...(options.builtinDir === undefined ? {} : { builtinDir: options.builtinDir }),
    ...(options.mdSelector === undefined ? {} : { mdSelector: options.mdSelector }),
    ...(options.typeInferenceMode === undefined ? {} : { typeInferenceMode: options.typeInferenceMode }),
  });
  if (claims.length === 0) throw new ProofError(`No claims found in file: ${options.specFile}`);
  return claims;
}

/**
 * `is_functional_claim` (`prove_rpc.py:105-106`).
 *
 * The claim's LHS head symbol, looked up in the definition's symbol table and
 * tested for membership in its function productions. Identity comparison, as
 * upstream's `in` is: `symbols` keeps the first production declared for a name
 * and `functions` collects every function production, so the object a symbol
 * resolves to is the one in that list when it is a function at all.
 */
export function isFunctionalClaim(definition: KDefinition, claim: KClaim): boolean {
  const lhs = extractLhs(claim.body);
  if (lhs.node !== "KApply") return false;
  const production = definition.symbols.get(lhs.label.name);
  return production !== undefined && definition.functions.includes(production);
}

/**
 * One claim, from label to verdict.
 *
 * **Divergence, and the reason the batch exists.** `run_prover` wraps only the
 * proving phase, because by the time kevm calls it the proof object already
 * exists (`utils.py:112-187`); `ProveRpc` wraps nothing, so a claim it cannot
 * turn into a proof aborts the whole run (`prove_rpc.py:96-124`). Here the
 * *whole* per-claim body is wrapped: a claim whose LHS is a bare token routes
 * to `APRProof.fromClaim` — upstream's own routing rule — and that raises
 * before any prover exists. Reporting it as one failed verdict and carrying on
 * is the only reading of "a batch" that survives contact with a real spec file.
 */
async function proveOneClaim(
  claim: KClaim,
  session: ExploreSession,
  options: ProveClaimsOptions,
  index: number,
  total: number,
  gate: DigestGate | undefined,
): Promise<ProofVerdict> {
  const label = sentenceLabel(claim);
  let proof: Proof | undefined;
  let resumed = false;
  let error: unknown;

  try {
    const definition = session.definition;
    const functional = isFunctionalClaim(definition, claim);
    const proofDir = options.proofDir;

    // `up_to_date = claim_job.up_to_date(digest_file)` then, unconditionally,
    // `claim_job.update_digest(digest_file)` (`__main__.py:293-298`): the file
    // records what *this* run proved, whatever the run then decides to do.
    const digest = gate?.digests.get(label);
    let upToDate = true;
    if (gate !== undefined && digest !== undefined) {
      upToDate = await claimUpToDate(gate.file, label, digest);
      await updateClaimDigest(gate.file, label, digest);
      if (!upToDate) {
        options.progress?.({
          kind: "notice",
          id: label,
          message: `Claim reinitialized because it is out of date: ${label}`,
        });
      }
    }
    /** No stored proof may be resumed: `--reinit`, or the claim moved. */
    const mayResume = options.reinit !== true && upToDate;

    proof = functional
      ? EqualityProof.fromClaim(claim, definition, proofDir === undefined ? {} : { proofDir })
      : APRProof.fromClaim(definition, claim, new Map(), {
          ...(proofDir === undefined ? {} : { proofDir }),
          ...(options.bmcDepth === undefined ? {} : { bmcDepth: options.bmcDepth }),
        });

    let fromDisk = false;
    if (proofDir !== undefined && mayResume && (await proofDataExists(proofDir, proof.id))) {
      proof = await readProofData(proofDir, proof.id);
      fromDisk = true;
      resumed = true;
    }
    options.progress?.({ kind: "proof-started", id: proof.id, index, total });

    const maxIterations = options.maxIterations;
    const nothingToDo = proof.passed || (maxIterations !== undefined && maxIterations <= 0);
    resumed = resumed && nothingToDo;
    if (!nothingToDo) await advanceOneProof(proof, session, options, !fromDisk);
  } catch (caught) {
    error = caught;
    // `run_prover` records the crash on the proof itself and keeps going
    // (`utils.py:181-187`); only `APRProof` carries the field upstream.
    if (proof instanceof APRProof) proof.errorInfo = caught instanceof Error ? caught : new Error(String(caught));
  }

  const verdict: ProofVerdict = {
    id: proof?.id ?? label,
    // A claim that never became a proof has no status to derive; it plainly did
    // not pass, which is what the CLI's exit code counts.
    status: proof?.status ?? ProofStatus.FAILED,
    passed: proof?.passed ?? false,
    proof,
    error,
    resumed,
  };
  options.progress?.({ kind: "proof-finished", verdict });
  return verdict;
}

/**
 * Prover construction and driver selection — `run_prover`'s body
 * (`utils.py:112-175`), plus the two decisions kevm-pyk makes just outside it.
 *
 * `fresh` gates the proof initialisation hook: it runs on a proof that is
 * starting, never on one that is resuming — its `letNode` writes would
 * overwrite a graph that has already moved past them. Upstream then writes the
 * proof data before the first step (`__main__.py:363`), so a run killed during
 * initialisation still leaves the simplified init and target on disk.
 *
 * **Deviation, small and deliberate.** Upstream spells the condition
 * `reinit or not up_to_date` (`__main__.py:359`), which is a *proxy* for "the
 * proof was constructed rather than read": it misses the corner where the
 * digest matches but no proof directory exists, and it would miss every fresh
 * proof outright when the digest gate is switched off. The condition here is
 * the thing itself — no stored proof was read — which agrees with upstream
 * wherever upstream is right.
 */
async function advanceOneProof(
  proof: Proof,
  session: ExploreSession,
  options: ProveClaimsOptions,
  fresh: boolean,
): Promise<void> {
  const report = (advanced: Proof): void => {
    options.progress?.({ kind: "proof-progress", id: advanced.id, summary: advanced.oneLineSummary });
  };
  const driverOptions = {
    ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
    ...(options.failFast === undefined ? {} : { failFast: options.failFast }),
    ...(options.maintenanceRate === undefined ? {} : { maintenanceRate: options.maintenanceRate }),
    callback: report,
    onStepTimeout: ({ budget, shrunk }: StepTimeoutEvent): void => {
      options.progress?.({
        kind: "notice",
        id: proof.id,
        message: shrunk
          ? `Proof ${proof.id}: step exceeded ${budget}s budget; shrinking and retrying.`
          : `Proof ${proof.id}: step exceeded ${budget}s budget and cannot shrink further; stopping.`,
      });
    },
  };

  if (proof instanceof APRProof) {
    if (options.initializeProofs === true && fresh) {
      await initializeAprProof(session.symbolic, proof);
      await writeProofData(proof);
    }
    const maxWorkers = stepTimeoutWorkers(proof, options);
    if (maxWorkers > 1) {
      await concurrentAdvanceProof(proof, {
        ...driverOptions,
        maxWorkers,
        stepKey: aprProofStepKey,
        // One client per prover, labelled with the proof id: the monorepo's
        // answer to pyk's `client_label` ContextVar, which it documents as not
        // propagating into pool threads anyway (`reachability.py:775-778`).
        createProver: async () => {
          const handle = await session.createExplore({ id: proof.id });
          return new SessionAPRProver(handle, options);
        },
      });
      return;
    }
    await advanceProof(makeAprProver(session.explore, options), proof, driverOptions);
    return;
  }
  if (proof instanceof EqualityProof) {
    await advanceProof(
      new ImpliesProver(
        session.symbolic,
        options.assumeDefined === undefined ? {} : { assumeDefined: options.assumeDefined },
      ),
      proof,
      driverOptions,
    );
    return;
  }
  // `run_prover`'s `else: raise ValueError` (`utils.py:178-179`).
  throw new ProofError(`Do not know how to build a prover for proof: ${proof.id} (${proof.proofType})`);
}

/**
 * `run_prover`'s force-sequential rule for `step_timeout` (`utils.py:145-153`).
 *
 * The budget is enforced by {@link advanceProof} and by nothing else, so a run
 * that asked for both a timeout and workers gets the timeout — silently
 * dropping it would leave a run with no ceiling at all, which is the failure
 * the flag exists to prevent. Upstream logs a warning; here the ignored
 * `maxWorkers` is a `notice` event.
 */
function stepTimeoutWorkers(proof: Proof, options: ProveClaimsOptions): number {
  const maxWorkers = options.maxWorkers ?? 1;
  if (options.stepTimeout === undefined || maxWorkers <= 1) return maxWorkers;
  options.progress?.({
    kind: "notice",
    id: proof.id,
    message:
      `Proof ${proof.id}: stepTimeout is only enforced when running sequentially; ` +
      `ignoring maxWorkers=${maxWorkers} and running sequentially.`,
  });
  return 1;
}

/**
 * An `APRProver` that owns its explorer's client, so the pool closing it
 * releases the socket.
 *
 * `APRProver.close()` is a documented no-op here because a client's lifetime
 * belongs to whoever constructed it — and in a concurrent run, that is this
 * factory (`proof.py:432-435` closes every pool prover).
 */
class SessionAPRProver extends APRProver {
  readonly #closeHandle: () => void;

  constructor(handle: ExploreHandle, options: ProveClaimsProverOptions) {
    super(handle.explore, aprProverOptions(options));
    this.#closeHandle = handle.close.bind(handle);
  }

  override close(): void {
    this.#closeHandle();
  }
}

function makeAprProver(explore: KCFGExplore, options: ProveClaimsProverOptions): APRProver {
  return new APRProver(explore, aprProverOptions(options));
}

function aprProverOptions(options: ProveClaimsProverOptions): APRProverOptions {
  return {
    ...(options.maxDepth === undefined ? {} : { executeDepth: options.maxDepth }),
    ...(options.cutPointRules === undefined ? {} : { cutPointRules: options.cutPointRules }),
    ...(options.terminalRules === undefined ? {} : { terminalRules: options.terminalRules }),
    ...(options.counterexampleInfo === undefined ? {} : { counterexampleInfo: options.counterexampleInfo }),
    ...(options.fastCheckSubsumption === undefined ? {} : { fastCheckSubsumption: options.fastCheckSubsumption }),
    ...(options.directSubproofRules === undefined ? {} : { directSubproofRules: options.directSubproofRules }),
    ...(options.assumeDefined === undefined ? {} : { assumeDefined: options.assumeDefined }),
    ...(options.extraModule === undefined ? {} : { extraModule: options.extraModule }),
    ...(options.optimizeKcfg === undefined ? {} : { optimizeKcfg: options.optimizeKcfg }),
    ...(options.stepTimeout === undefined ? {} : { stepTimeout: options.stepTimeout }),
  };
}
