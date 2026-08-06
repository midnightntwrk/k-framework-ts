/**
 * Async symbolic execution over {@link CTerm}, composed from konvert and an
 * injected kore-rpc client.  This module never starts a server: construction
 * takes a narrow client seam so callers choose transport, lifetime, and policy
 * for timeout/aborted outcomes themselves.
 *
 * Transcribed from pyk's `cterm/symbolic.py` (K v7.1.337).  Two things beyond
 * the method bodies come from that file and are easy to miss:
 *
 * 1. **The instance carries request defaults.** pyk's `CTermSymbolic.__init__`
 *    (`cterm/symbolic.py:96-122`) holds `log_succ_rewrites` (**default
 *    `True`**), `log_fail_rewrites`, `booster_only_simplify`, and
 *    `haskell_log_entries`, and stamps them onto every request it makes.  The
 *    adapter is where rewrite-log *policy* lives; the client below it only
 *    serializes what it is handed.  See {@link CTermSymbolicOptions}.
 * 2. **An SMT failure is a domain error, not a wire error.** pyk catches the
 *    client's `SmtSolverError` in every method and re-raises
 *    {@link CTermSMTError} carrying the offending pattern *pretty-printed
 *    against the definition* (`cterm/symbolic.py:376-379`), because the wire
 *    error's message is escaped KORE that nobody can read.
 */

import {
  eq,
  isSpuriousConstraint,
  kapply,
  klabel,
  krewrite,
  ktoken,
  kvariable,
  match as matchKast,
  PrettyPrinter,
  sortAcCollections,
  Subst,
  type KDefinition,
  type KFlatModule,
  type KInner,
} from "@kframework-ts/kast";
import { GENERATED_TOP_CELL, K_ITEM } from "@kframework-ts/kast/prelude/k";
import { mlAnd, mlExists, mlImplies, mlTop } from "@kframework-ts/kast/prelude/ml";
import { kastToKore, kflatmoduleToKore, koreToKast } from "@kframework-ts/konvert";
import { type KoreJson, type Pattern, koreText } from "@kframework-ts/kore";
import {
  type AddModuleOptions,
  type ExecuteOptions,
  type ExecuteResult,
  type ExecuteState,
  type GetModelOptions,
  type GetModelResult,
  type ImpliesOptions,
  type ImpliesResult,
  type SimplifyOptions,
  type SimplifyResult,
  koreJson,
  SmtSolverError,
  stateKore,
} from "@kframework-ts/kore-rpc";

import { CSubst } from "./csubst.js";
import { CTerm } from "./cterm.js";

/**
 * The five payload methods the symbolic adapter needs from `KoreClient`.
 *
 * `addModule` takes the module as *text*, exactly as the wire does: the
 * KAST → KORE step happens here, the KORE → text step is the client's payload,
 * and neither belongs to the seam.
 */
export interface CTermSymbolicClient {
  execute(state: KoreJson, options?: ExecuteOptions): Promise<ExecuteResult>;
  simplify(state: KoreJson, options?: SimplifyOptions): Promise<SimplifyResult>;
  getModel(state: KoreJson, options?: GetModelOptions): Promise<GetModelResult>;
  implies(antecedent: KoreJson, consequent: KoreJson, options?: ImpliesOptions): Promise<ImpliesResult>;
  addModule(moduleText: string, options?: AddModuleOptions): Promise<string>;
  interrupt(): void;
}

/** The definition-aware KAST/KORE conversion seam, independently fakeable in tests. */
export interface CTermSymbolicCodec {
  kastToKore(definition: KDefinition, term: KInner): Pattern;
  koreToKast(definition: KDefinition, pattern: Pattern): KInner;
}

const DEFAULT_CODEC: CTermSymbolicCodec = {
  kastToKore: (definition, term) => kastToKore(definition, term, { sort: GENERATED_TOP_CELL }),
  koreToKast,
};

/** One decoded successor, retaining the backend's state and branch predicate. */
export interface CTermNextState {
  readonly cterm: CTerm;
  readonly rulePredicate?: KInner;
  readonly ruleSubstitution?: KInner;
  readonly ruleId?: string;
  readonly raw: ExecuteState;
}

/** A decoded execute response without discarding any protocol information. */
export interface CTermExecuteResult {
  readonly state: CTerm;
  readonly nextStates: readonly CTermNextState[];
  readonly reason: ExecuteResult["reason"];
  readonly depth: ExecuteResult["depth"];
  readonly logs?: NonNullable<ExecuteResult["logs"]>;
  readonly haskellLogEntries?: NonNullable<ExecuteResult["haskellLogEntries"]>;
  /** Decoded only for an `aborted` response that supplied the predicate. */
  readonly unknownPredicate?: KInner;
  readonly raw: ExecuteResult;
}

/** A decoded simplify response, with all response logs retained in `raw`. */
export interface CTermSimplifyResult {
  readonly cterm: CTerm;
  readonly logs?: NonNullable<SimplifyResult["logs"]>;
  readonly haskellLogEntries?: NonNullable<SimplifyResult["haskellLogEntries"]>;
  readonly raw: SimplifyResult;
}

/** {@link CTermSimplifyResult} for a bare term: no CTerm split of the answer. */
export interface CTermKastSimplifyResult {
  readonly kast: KInner;
  readonly logs?: NonNullable<SimplifyResult["logs"]>;
  readonly haskellLogEntries?: NonNullable<SimplifyResult["haskellLogEntries"]>;
  readonly raw: SimplifyResult;
}

/** `Sat` with a model decoded as a KAST substitution. */
export interface CTermSatModelResult {
  readonly satisfiable: "Sat";
  readonly model: Subst;
  readonly haskellLogEntries?: NonNullable<GetModelResult["haskellLogEntries"]>;
  readonly raw: Extract<GetModelResult, { readonly satisfiable: "Sat" }>;
}

/** `Unsat` or `Unknown`; the raw result keeps backend log entries. */
export interface CTermNoModelResult {
  readonly satisfiable: "Unsat" | "Unknown";
  readonly haskellLogEntries?: NonNullable<GetModelResult["haskellLogEntries"]>;
  readonly raw: Exclude<GetModelResult, { readonly satisfiable: "Sat" }>;
}

export type CTermGetModelResult = CTermSatModelResult | CTermNoModelResult;

/**
 * A decoded implication verdict, preserving the RPC's three-valued status —
 * pyk's `CTermImplies` (`cterm/symbolic.py:76-80`).
 */
export interface CTermImpliesResult {
  readonly status: ImpliesResult["status"];
  /** The backend's returned implication, decoded with this adapter's codec. */
  readonly implication: KInner;
  /**
   * The implication's witness — present **exactly when** `status === "valid"`.
   *
   * A `valid` verdict whose `condition` the backend omitted yields the trivial
   * `CSubst()` rather than nothing, so `csubst !== undefined` is a sound test
   * for validity; see {@link CTermSymbolic.implies}.
   */
  readonly csubst?: CSubst;
  /**
   * `failing_cells` (`cterm/symbolic.py:78`) — `[cellName, lhs => rhs]` pairs
   * explaining a rejected implication cell by cell.
   *
   * Always present, always empty unless {@link CTermImpliesOptions.failureReason}
   * asked for the extra round trip *and* the configurations alone already fail
   * to match.
   */
  readonly failingCells: readonly (readonly [cell: string, rewrite: KInner])[];
  /**
   * `remaining_implication` (`cterm/symbolic.py:79`) — the constraint-level
   * obligation left once the configurations *did* match. Mutually exclusive
   * with a non-empty {@link CTermImpliesResult.failingCells}.
   */
  readonly remainingImplication?: KInner;
  readonly logs?: NonNullable<ImpliesResult["logs"]>;
  readonly haskellLogEntries?: NonNullable<ImpliesResult["haskellLogEntries"]>;
  readonly raw: ImpliesResult;
}

/** Extra implication policy over the kore-rpc options. */
export interface CTermImpliesOptions extends ImpliesOptions {
  /** Bind RHS-only variables before conversion; pyk's default is existential. */
  readonly bindRhs?: "exists" | "forall" | "none";
  /**
   * `failure_reason` (`cterm/symbolic.py:290`) — on a non-valid verdict, spend
   * one more `implies` round trip working out *why*.
   *
   * Off by default, exactly as upstream: it doubles the request count for a
   * result only a failure report reads.
   */
  readonly failureReason?: boolean;
}

/** Shared empty tuple, so a result that has nothing to explain allocates nothing. */
const EMPTY_FAILING_CELLS: readonly (readonly [cell: string, rewrite: KInner])[] = Object.freeze([]);

/** What the failure-reason walk produces; both halves default to "nothing to say". */
interface CTermImpliesFailure {
  readonly failingCells: readonly (readonly [cell: string, rewrite: KInner])[];
  readonly remainingImplication?: KInner;
}

/** `unique` (`utils.py`) over KAST terms, which have no value identity in JS. */
function uniqueTerms(terms: readonly KInner[]): KInner[] {
  const result: KInner[] = [];
  for (const term of terms) if (!result.some((seen) => eq(seen, term))) result.push(term);
  return result;
}

/**
 * `CTerm._ml_impl` (`cterm/cterm.py:180-188`).
 *
 * Upstream this is a private static on `CTerm`, used by `cterm_build_rule` and
 * by the failure-reason walk below. `@kframework-ts/kast`'s `buildRule` covers
 * the first consumer with its own implementation, so the transcription lives
 * here, next to its only caller, rather than on {@link CTerm}.
 *
 * Consequents that already appear among the antecedents are dropped, and an
 * `#Top` on either side collapses the implication to the consequent.
 */
function mlImpl(antecedents: readonly KInner[], consequents: readonly KInner[]): KInner {
  const antecedent = mlAnd(uniqueTerms(antecedents), GENERATED_TOP_CELL);
  const consequent = mlAnd(
    uniqueTerms(consequents.filter((term) => !antecedents.some((given) => eq(given, term)))),
    GENERATED_TOP_CELL,
  );
  // `mlTop(GENERATED_TOP_CELL) in {antecedent, consequent}` — structural
  // equality against that exact sorted `#Top`, not the weaker `is_top`.
  const top = mlTop(GENERATED_TOP_CELL);
  if (eq(antecedent, top) || eq(consequent, top)) return consequent;
  return mlImplies(antecedent, consequent, GENERATED_TOP_CELL);
}

/**
 * `CTermSMTError` (`cterm/symbolic.py:83-88`) — an SMT-solver failure the
 * caller can catch and *read*.
 *
 * The wire error (`@kframework-ts/kore-rpc`'s `SmtSolverError`, backend code
 * 5) renders the offending pattern as textual KORE, which for a real
 * configuration is thousands of characters of escaped `Lbl'Unds'…` and is
 * useless in a failure report.  This carries the same pattern pretty-printed
 * against the adapter's definition, exactly as upstream's `_smt_solver_error`
 * does — pyk's message *is* the pretty-printed pattern and nothing else, and
 * so is {@link CTermSMTError.pretty}.
 *
 * **Deviations, both additive.** pyk's exception carries only `message`; this
 * one also keeps {@link CTermSMTError.cause} (the wire error, so a caller can
 * still reach the raw pattern and the JSON-RPC `data`) and prefixes the
 * message with `SMT solver error:` plus the backend's own one-line reason, so
 * a log line that shows only `error.message` still says what failed.
 * {@link CTermSMTError.pretty} is the unprefixed pyk-equivalent string.
 */
export class CTermSMTError extends Error {
  override readonly name = "CTermSMTError";
  /** The pretty-printed offending pattern — pyk's whole message. */
  readonly pretty: string;
  /** The wire error this was raised from, with its `term` and JSON-RPC `data`. */
  override readonly cause: SmtSolverError;

  constructor(pretty: string, cause: SmtSolverError) {
    super(`SMT solver error: ${cause.error} Pattern: ${pretty}`, { cause });
    this.pretty = pretty;
    this.cause = cause;
  }
}

/**
 * `HASKELL_LOGGING_ENTRIES` (`cterm/symbolic.py:48-60`) — the canonical set of
 * `haskell-logging` capture groups to request when context logging is on.
 *
 * Spans both engines: `DebugAttemptEquation`/`DebugApplyEquation`/`DebugTerm`
 * are kore's, the rest are booster context tags.  The backend silently skips a
 * name it does not know, which is why this can be a fixed list.
 *
 * Note this is *which* entries, not *whether*: see
 * {@link CTermSymbolicOptions.haskellLogging}.
 */
export const HASKELL_LOGGING_ENTRIES: readonly string[] = Object.freeze([
  "DebugAttemptEquation",
  "DebugApplyEquation",
  "DebugTerm",
  "Proxy",
  "Detail",
  "Abort",
  "Simplify",
  "Rewrite",
]);

/**
 * Options for {@link CTermSymbolic}; use a codec fake for fully offline tests.
 *
 * Everything but `codec` is a **per-instance request default**, transcribed
 * from pyk's constructor (`cterm/symbolic.py:96-122`).  A per-call option of
 * the same name always wins, so these set the policy an instance executes
 * under rather than constraining any single request.
 */
export interface CTermSymbolicOptions {
  readonly codec?: CTermSymbolicCodec;
  /**
   * `log_succ_rewrites` (`cterm/symbolic.py:103`) — request a `rewrite`/
   * `success` log entry per rewrite step.  **Defaults to `true`**, as upstream.
   *
   * This is what makes an edge's rule provenance exist at all: with it off the
   * response has no `logs` array, `@kframework-ts/kcfg`'s `KCFGExplore` has no
   * rule ids to resolve, and `@kframework-ts/cterm/trace` has nothing to
   * assemble.  Turn it off only for the cost (kontrol's
   * `--optimize-performance` does).
   *
   * What a v0.1.155 server actually puts in such an entry is **the rule id and
   * nothing else** — see the emission note on `@kframework-ts/cterm/trace`.
   */
  readonly logSuccessfulRewrites?: boolean;
  /**
   * `log_fail_rewrites` (`cterm/symbolic.py:104`) — also log rewrite steps
   * that were *attempted* and failed.  Defaults to `false`.
   *
   * Upstream sends `log_succ_rewrites and log_fail_rewrites`
   * (`cterm/symbolic.py:180`), so this is subordinate: with
   * {@link logSuccessfulRewrites} off, failure logging is off too however this
   * is set.  That conjunction is transcribed rather than repaired.
   */
  readonly logFailedRewrites?: boolean;
  /**
   * `booster_only_simplify` (`cterm/symbolic.py:105`) — the `booster-only`
   * request flag, which suppresses the proxy's escalation to kore.
   *
   * Applied to `execute`, `simplify`/`kastSimplify`, and `implies`, exactly
   * the three pyk applies it to; `getModel` and `addModule` never carry it
   * upstream and do not carry it here.
   */
  readonly boosterOnly?: boolean;
  /**
   * `haskell_log_entries` (`cterm/symbolic.py:106`) — *which* context-log
   * groups to request when {@link haskellLogging} is on.  Defaults to
   * {@link HASKELL_LOGGING_ENTRIES}.
   */
  readonly haskellLogEntries?: readonly string[];
  /**
   * Whether to request {@link haskellLogEntries} on every request that accepts
   * it.  Defaults to `false`.
   *
   * **Deviation.** pyk has no such boolean: it derives the switch from
   * `haskell_log_dir` (`cterm/symbolic.py:132-142`) because the adapter itself
   * writes the captured bundle to `<dir>/<request-id>.jsonl`
   * (`:144-160`).  This adapter writes no files — a response's
   * `haskellLogEntries` is returned to its caller on `raw`, and where it lands
   * is the caller's decision, which is the same stance the rest of the package
   * takes on backend output.  So the derived switch becomes an explicit one.
   *
   * A per-call `haskellLogging` array overrides this outright, in either
   * direction.
   */
  readonly haskellLogging?: boolean;
}

/**
 * Definition-aware, asynchronous symbolic operations over constrained terms.
 *
 * All backend result variants resolve normally. In particular, `timeout`,
 * `aborted`, and `indeterminate` remain data for the caller to handle; no
 * policy converts them to exceptions or booleans here.
 */
export class CTermSymbolic {
  readonly client: CTermSymbolicClient;
  readonly definition: KDefinition;
  readonly codec: CTermSymbolicCodec;
  /** `_log_succ_rewrites` (`cterm/symbolic.py:89`); `true` unless overridden. */
  readonly logSuccessfulRewrites: boolean;
  /** `_log_fail_rewrites` (`cterm/symbolic.py:90`). */
  readonly logFailedRewrites: boolean;
  /** `_booster_only_simplify` (`cterm/symbolic.py:91`). */
  readonly boosterOnly: boolean;
  /** `_haskell_log_entries` (`cterm/symbolic.py:92`). */
  readonly haskellLogEntries: readonly string[];
  /** Whether {@link haskellLogEntries} is requested by default; see the option. */
  readonly haskellLogging: boolean;
  // Written after `Object.freeze(this)`, which is legal — a private field is an
  // internal slot, not a property.  pyk builds a throwaway `PrettyPrinter` per
  // SMT failure (`cterm/symbolic.py:378`); one per adapter is the same output
  // and does not pay definition indexing costs on a failure path.
  #prettyPrinter: PrettyPrinter | undefined;

  constructor(client: CTermSymbolicClient, definition: KDefinition, options: CTermSymbolicOptions = {}) {
    this.client = client;
    this.definition = definition;
    this.codec = options.codec ?? DEFAULT_CODEC;
    this.logSuccessfulRewrites = options.logSuccessfulRewrites ?? true;
    this.logFailedRewrites = options.logFailedRewrites ?? false;
    this.boosterOnly = options.boosterOnly ?? false;
    this.haskellLogEntries = Object.freeze([...(options.haskellLogEntries ?? HASKELL_LOGGING_ENTRIES)]);
    this.haskellLogging = options.haskellLogging ?? false;
    Object.freeze(this);
  }

  /**
   * Execute a CTerm, preserving its reason, raw response, and branch predicates.
   *
   * The instance's rewrite-log policy is stamped on the request here
   * (`cterm/symbolic.py:177-186`); anything the caller names in `options` wins.
   */
  async execute(cterm: CTerm, options: ExecuteOptions = {}): Promise<CTermExecuteResult> {
    const raw = await this.request(() => this.client.execute(this.toKore(cterm.kast), this.executeOptions(options)));
    const unknownPredicate =
      raw.reason === "aborted" && raw.unknownPredicate !== undefined ? this.fromKore(raw.unknownPredicate) : undefined;
    return Object.freeze({
      state: this.fromState(raw.state),
      nextStates: Object.freeze(
        raw.reason === "branching" || raw.reason === "cut-point-rule"
          ? raw.nextStates.map((state) => this.nextState(state))
          : [],
      ),
      reason: raw.reason,
      depth: raw.depth,
      ...(raw.logs === undefined ? {} : { logs: raw.logs }),
      ...(raw.haskellLogEntries === undefined ? {} : { haskellLogEntries: raw.haskellLogEntries }),
      ...(unknownPredicate === undefined ? {} : { unknownPredicate }),
      raw,
    });
  }

  /**
   * Simplify a CTerm and retain the entire response, including log bundles —
   * pyk `CTermSymbolic.simplify` (`cterm/symbolic.py:217-231`), which is
   * {@link kastSimplify} plus a `CTerm.fromKast`, layered exactly as here.
   */
  async simplify(cterm: CTerm, options: SimplifyOptions = {}): Promise<CTermSimplifyResult> {
    const simplified = await this.kastSimplify(cterm.kast, options);
    return Object.freeze({
      cterm: CTerm.fromKast(simplified.kast),
      ...(simplified.logs === undefined ? {} : { logs: simplified.logs }),
      ...(simplified.haskellLogEntries === undefined ? {} : { haskellLogEntries: simplified.haskellLogEntries }),
      raw: simplified.raw,
    });
  }

  /**
   * Simplify a bare `KInner` — pyk `CTermSymbolic.kast_simplify`
   * (`cterm/symbolic.py:233-256`).
   *
   * The term is neither required to be a constrained configuration on the way
   * out nor split into one on the way back, which is what makes this the right
   * entry point for a predicate (an implication's remaining obligation, a
   * `#Ceil`) rather than a state.
   */
  async kastSimplify(kast: KInner, options: SimplifyOptions = {}): Promise<CTermKastSimplifyResult> {
    const raw = await this.request(() => this.client.simplify(this.toKore(kast), this.simplifyOptions(options)));
    return Object.freeze({
      kast: this.fromKore(raw.state),
      ...(raw.logs === undefined ? {} : { logs: raw.logs }),
      ...(raw.haskellLogEntries === undefined ? {} : { haskellLogEntries: raw.haskellLogEntries }),
      raw,
    });
  }

  /** Query a model, distinguishing satisfiable, unsatisfiable, and unknown results. */
  async getModel(cterm: CTerm, options: GetModelOptions = {}): Promise<CTermGetModelResult> {
    // No instance defaults: pyk's `get_model` forwards `module_name` alone
    // (`cterm/symbolic.py:258-262`), so neither `booster-only` nor the context
    // logging bundle is stamped on this request upstream or here.
    const raw = await this.request(() => this.client.getModel(this.toKore(cterm.kast), options));
    if (raw.satisfiable !== "Sat") {
      return Object.freeze({
        satisfiable: raw.satisfiable,
        ...(raw.haskellLogEntries === undefined ? {} : { haskellLogEntries: raw.haskellLogEntries }),
        raw,
      });
    }

    const model = raw.substitution === undefined ? new Subst() : Subst.fromPred(this.fromKore(raw.substitution));
    return Object.freeze({
      satisfiable: "Sat",
      model,
      ...(raw.haskellLogEntries === undefined ? {} : { haskellLogEntries: raw.haskellLogEntries }),
      raw,
    });
  }

  /**
   * Check implication without collapsing the backend's tri-state status —
   * pyk `CTermSymbolic.implies` (`cterm/symbolic.py:285-378`).
   *
   * RHS-only variables are quantified before conversion to avoid the backend's
   * free-variable rejection; existential is the pyk-compatible default.
   *
   * With {@link CTermImpliesOptions.failureReason} set, a non-valid verdict is
   * followed by the diagnosis walk pyk performs
   * (`cterm/symbolic.py:330-359`); see {@link CTermSymbolic.impliesFailure}.
   *
   * **Invariant, and the divergence it repairs:** `csubst` is present exactly
   * when `status === "valid"`.  Every consumer in this monorepo — kcfg's
   * `implicationFailureReason`, proof's `APRProver` — reads
   * `csubst !== undefined` as "the implication held", because that is the only
   * shape pyk's `CTermImplies` offers (`cterm/symbolic.py:76`, `csubst: CSubst
   * | None`). An omitted `condition` denotes the trivial witness, so a `valid`
   * response decodes to that witness rather than an absent `csubst`; see
   * {@link CTermSymbolic.csubstFromCondition}'s caller below.
   */
  async implies(antecedent: CTerm, consequent: CTerm, options: CTermImpliesOptions = {}): Promise<CTermImpliesResult> {
    const { bindRhs = "exists", failureReason = false, ...rpcOptions } = options;
    const boundConsequent = this.bindRhsOnlyVariables(antecedent, consequent, bindRhs);
    const raw = await this.request(() =>
      this.client.implies(this.toKore(antecedent.kast), this.toKore(boundConsequent), this.impliesOptions(rpcOptions)),
    );

    // `if not result.valid` (`cterm/symbolic.py:324`). pyk collapses the
    // tri-state to `valid: bool`, so `indeterminate` takes this branch there
    // too; the status itself is still reported to the caller unflattened.
    if (raw.status !== "valid") {
      const failure: CTermImpliesFailure = failureReason
        ? await this.impliesFailure(antecedent, consequent, options)
        : { failingCells: EMPTY_FAILING_CELLS };
      return Object.freeze({
        status: raw.status,
        implication: this.fromKore(raw.implication),
        failingCells: failure.failingCells,
        ...(failure.remainingImplication === undefined ? {} : { remainingImplication: failure.remainingImplication }),
        ...(raw.logs === undefined ? {} : { logs: raw.logs }),
        ...(raw.haskellLogEntries === undefined ? {} : { haskellLogEntries: raw.haskellLogEntries }),
        raw,
      });
    }

    // Upstream raises `ValueError` when a valid implication arrives without a
    // condition (`cterm/symbolic.py:370-373`).  This adapter's contract is that
    // no backend response is an exception — but "no witness" is *not* the right
    // reading of the absence either: `Condition` (`Types.hs:158-165`) is
    // optional on a result whose `status` already says the implication holds,
    // and an omitted one means the substitution and predicate are both trivial.
    // So it decodes to `CSubst()` — the identity substitution with no extra
    // constraints, which is exactly `⊤` — keeping `csubst` present iff valid.
    // Reporting it as absent instead is what made a valid implication read as
    // a matching failure downstream; see this method's doc comment.
    const csubst =
      raw.condition === undefined
        ? new CSubst()
        : this.csubstFromCondition(raw.condition.substitution, raw.condition.predicate);
    return Object.freeze({
      status: raw.status,
      implication: this.fromKore(raw.implication),
      csubst,
      failingCells: EMPTY_FAILING_CELLS,
      ...(raw.logs === undefined ? {} : { logs: raw.logs }),
      ...(raw.haskellLogEntries === undefined ? {} : { haskellLogEntries: raw.haskellLogEntries }),
      raw,
    });
  }

  /**
   * Why an implication failed — pyk's `failure_reason` branch
   * (`cterm/symbolic.py:330-359`), reached from {@link CTermSymbolic.implies}.
   *
   * One extra `implies` round trip asks whether the **configurations alone**
   * imply each other, with the caller's binding, module, and definedness
   * options forwarded unchanged and `failureReason` off, so the recursion is
   * exactly one deep.
   *
   * - **Configurations do not match** → walk the antecedent's cells in order.
   *   A cell the consequent lacks becomes `cellValue => .K`; a cell that
   *   cannot be matched — or whose match conflicts with the accumulated one —
   *   becomes `antecedentCell => consequentCell`. Both sides are
   *   `sortAcCollections`-normalised first so set and map literals compare in
   *   a stable order. The accumulated substitution is what makes two cells
   *   that individually match but disagree on a shared variable report the
   *   *second* one as failing.
   * - **Configurations do match** → the failure is in the constraints: apply
   *   the configuration substitution to the consequent's constraints, drop the
   *   spurious ones, and return `antecedentConstraints #Implies` the rest.
   *
   * The two outcomes are mutually exclusive, which is what lets a caller
   * render one block or the other and never both.
   */
  async impliesFailure(
    antecedent: CTerm,
    consequent: CTerm,
    options: CTermImpliesOptions = {},
  ): Promise<CTermImpliesFailure> {
    const configMatch = (
      await this.implies(CTerm.fromKast(antecedent.config), CTerm.fromKast(consequent.config), {
        ...options,
        failureReason: false,
      })
    ).csubst;

    if (configMatch === undefined) {
      const failingCells: (readonly [cell: string, rewrite: KInner])[] = [];
      let currentCellMatch = new Subst();
      for (const cell of antecedent.cells.keys()) {
        const antecedentCell = sortAcCollections(antecedent.cell(cell));
        const consequentRaw = consequent.tryCell(cell);
        if (consequentRaw === undefined) {
          failingCells.push(Object.freeze([cell, krewrite(antecedentCell, ktoken(".K", "KItem"))] as const));
          continue;
        }
        const consequentCell = sortAcCollections(consequentRaw);
        const cellMatch = matchKast(consequentCell, antecedentCell);
        if (cellMatch !== null) {
          const merged = currentCellMatch.union(cellMatch);
          if (merged !== null) {
            currentCellMatch = merged;
            continue;
          }
        }
        failingCells.push(Object.freeze([cell, krewrite(antecedentCell, consequentCell)] as const));
      }
      return Object.freeze({ failingCells: Object.freeze(failingCells) });
    }

    const consequentConstraints = consequent.constraints
      .map((constraint) => configMatch.subst.apply(constraint))
      .filter((constraint) => !isSpuriousConstraint(constraint));
    return Object.freeze({
      failingCells: EMPTY_FAILING_CELLS,
      remainingImplication: mlImpl(antecedent.constraints, consequentConstraints),
    });
  }

  /**
   * Add the configuration's definedness condition to a CTerm — pyk
   * `CTermSymbolic.assume_defined` (`cterm/symbolic.py:380-392`).
   *
   * Two round trips: simplify the CTerm, wrap the simplified **configuration**
   * — constraints deliberately excluded — in
   * `#Ceil{GeneratedTopCell, GeneratedTopCell}`, simplify that, and hang the
   * answer on the **original** cterm.  So the returned term keeps the caller's
   * configuration and constraints verbatim and gains exactly one constraint;
   * the simplified cterm exists only to compute it.
   *
   * pyk gives this method its own `booster_only_simplify: bool = False`
   * positional rather than deferring to the instance default
   * (`cterm/symbolic.py:380-382`) — a genuine upstream inconsistency, since
   * every other method resolves `None` against `self._booster_only_simplify`.
   * Here the two `simplify` calls it delegates to apply the instance default
   * like any other, so an instance constructed with `boosterOnly: true` stays
   * booster-only through `assumeDefined` too; pass `boosterOnly` in `options`
   * to override for this call.  The two responses' logs are dropped, as
   * upstream drops them.
   */
  async assumeDefined(cterm: CTerm, options: SimplifyOptions = {}): Promise<CTerm> {
    const simplified = await this.simplify(cterm, options);
    const ceil = kapply(klabel("#Ceil", [GENERATED_TOP_CELL, GENERATED_TOP_CELL]), [simplified.cterm.config]);
    const definedness = await this.kastSimplify(ceil, options);
    return cterm.addConstraint(definedness.kast);
  }

  /**
   * File a flat module of rules with the backend, returning its module id —
   * pyk `CTermSymbolic.add_module` (`cterm/symbolic.py:394-396`).
   *
   * The KAST module becomes KORE through konvert's `kflatmoduleToKore`
   * (pyk `konvert/_kast_to_kore.py:325-332`) and travels as text, matching
   * pyk's `KoreClient.add_module`, which sends `module.text`
   * (`kore/rpc.py:1200-1215`).  That conversion is pure, so it stays a direct
   * konvert call rather than joining the {@link CTermSymbolicCodec} seam,
   * which exists for the pattern conversions a test may want to stub.
   *
   * The returned id is **session-scoped**: it names the module only on the
   * server that accepted it, and only for that server's lifetime.  A client
   * reconnecting to a fresh server must replay its `addModule` calls before
   * naming the module in a request — see `KoreClient.addModule`.
   */
  async addModule(module: KFlatModule, options: AddModuleOptions = {}): Promise<string> {
    const moduleText = koreText(kflatmoduleToKore(this.definition, module));
    const moduleId = await this.client.addModule(moduleText, options);
    return moduleId;
  }

  /** Abort the client's currently in-flight request, if any. */
  interrupt(): void {
    this.client.interrupt();
  }

  /**
   * `except SmtSolverError as err: raise self._smt_solver_error(err) from err`,
   * which wraps every client call upstream (`cterm/symbolic.py:178`, `:249`,
   * `:265`, `:305`).
   *
   * Only that one error class is translated: everything else — transport
   * failures, `ParseError`, `AbortedError`, an abort a caller wants to retry —
   * propagates untouched, because none of them is improved by being reprinted
   * against the definition.
   */
  private async request<T>(send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (error) {
      if (error instanceof SmtSolverError) throw this.smtSolverError(error);
      throw error;
    }
  }

  /** `_smt_solver_error` (`cterm/symbolic.py:376-379`). */
  private smtSolverError(error: SmtSolverError): CTermSMTError {
    // The wire error carries the pattern only when the backend supplied a
    // decodable one; `SmtSolverError` already says `<unavailable>` in that case
    // and there is nothing to pretty-print.
    if (error.term === undefined) return new CTermSMTError("<unavailable>", error);
    this.#prettyPrinter ??= new PrettyPrinter(this.definition);
    return new CTermSMTError(this.#prettyPrinter.print(this.fromKore(error.term)), error);
  }

  /**
   * `execute`'s instance defaults (`cterm/symbolic.py:181-186`).
   *
   * `log-failed-rewrites` is sent as `log_succ_rewrites and log_fail_rewrites`
   * — upstream's conjunction, transcribed rather than repaired.
   */
  private executeOptions(options: ExecuteOptions): ExecuteOptions {
    return {
      logSuccessfulRewrites: this.logSuccessfulRewrites,
      logFailedRewrites: this.logSuccessfulRewrites && this.logFailedRewrites,
      boosterOnly: this.boosterOnly,
      ...this.haskellLoggingOption(),
      ...options,
    };
  }

  /** `simplify`/`kast_simplify`'s instance defaults (`cterm/symbolic.py:250-254`). */
  private simplifyOptions(options: SimplifyOptions): SimplifyOptions {
    return { boosterOnly: this.boosterOnly, ...this.haskellLoggingOption(), ...options };
  }

  /** `implies`'s instance defaults (`cterm/symbolic.py:306-312`). */
  private impliesOptions(options: ImpliesOptions): ImpliesOptions {
    return { boosterOnly: this.boosterOnly, ...this.haskellLoggingOption(), ...options };
  }

  /**
   * `_haskell_logging_request` (`cterm/symbolic.py:132-142`), with the switch
   * explicit rather than derived from a log directory — see
   * {@link CTermSymbolicOptions.haskellLogging}.
   *
   * An empty entry set omits the field, as upstream's `and self._haskell_log_entries` does.
   */
  private haskellLoggingOption(): { haskellLogging?: readonly string[] } {
    if (!this.haskellLogging || this.haskellLogEntries.length === 0) return {};
    return { haskellLogging: this.haskellLogEntries };
  }

  private toKore(term: KInner): KoreJson {
    return koreJson(this.codec.kastToKore(this.definition, term));
  }

  private fromKore(kore: KoreJson): KInner {
    return this.codec.koreToKast(this.definition, kore.term);
  }

  private fromState(state: ExecuteState): CTerm {
    return CTerm.fromKast(this.codec.koreToKast(this.definition, stateKore(state)));
  }

  private nextState(raw: ExecuteState): CTermNextState {
    return Object.freeze({
      cterm: this.fromState(raw),
      ...(raw.rulePredicate === undefined ? {} : { rulePredicate: this.fromKore(raw.rulePredicate) }),
      ...(raw.ruleSubstitution === undefined ? {} : { ruleSubstitution: this.fromKore(raw.ruleSubstitution) }),
      ...(raw.ruleId === undefined ? {} : { ruleId: raw.ruleId }),
      raw,
    });
  }

  private csubstFromCondition(substitution: KoreJson, predicate: KoreJson): CSubst {
    return CSubst.fromPred(mlAnd([this.fromKore(substitution), this.fromKore(predicate)]));
  }

  private bindRhsOnlyVariables(antecedent: CTerm, consequent: CTerm, binding: "exists" | "forall" | "none"): KInner {
    const antecedentVars = antecedent.freeVars;
    let result = consequent.kast;
    for (const name of consequent.freeVars) {
      if (antecedentVars.has(name)) continue;
      if (binding === "none") continue;
      const variable = kvariable(name);
      result =
        binding === "exists"
          ? mlExists(variable, result, K_ITEM, GENERATED_TOP_CELL)
          : kapply(klabel("#Forall", [K_ITEM, GENERATED_TOP_CELL]), [variable, result]);
    }
    return result;
  }
}
