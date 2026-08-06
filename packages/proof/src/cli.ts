/**
 * The `kproof` command: `prove`, `show`, `status`, and the house `check-k`
 * drift check.
 *
 * The rule this file follows is the one `@kframework-ts/ktool`'s CLI states:
 * **no logic here that is not in the library**. `prove` parses flags into the
 * {@link ProveClaimsOptions} object `facade.ts` already defines and calls
 * {@link proveClaims}; `status` calls `readProofData` and prints the summary the
 * proof already knows how to render. The flag parsers ({@link parseProveArgs},
 * {@link parseStatusArgs}) are pure and exported, which is what makes the whole
 * mapping testable with no K installed.
 *
 * `prove` is modelled on pyk's `exec_prove` (`pyk/__main__.py:248-290`),
 * including its exit-code contract — **the number of proofs that did not
 * pass** — and its output order, which sorts proofs by id and prints each
 * summary, optionally followed by the failure report.
 *
 * `show` is pyk's `exec_show` (`__main__.py:293-296`) with its one accident
 * removed. Upstream reaches showing by *re-running the prover* with
 * `max_iterations = 0` and `show_kcfg = True`, which needs a kompiled
 * definition, a spec file and a `kore-rpc` server just to re-print a proof
 * that is already on disk. Here `show` loads the stored proof and renders it:
 * same output block (`'\\n'.join(show.show(proof, minimize=False))` under a
 * `full_printer=True`, `minimize=False` `CTermShow`), no backend.
 */

import { CTermShow } from "@kframework-ts/cterm";
import type { KAst } from "@kframework-ts/kast";
import type { NodeIdLike } from "@kframework-ts/kcfg";
import { KPrint } from "@kframework-ts/ktool";

import { APRProof } from "./apr.js";
import { APRFailureInfo } from "./failure.js";
import { APRProofNodePrinter, APRProofShow } from "./show.js";
import { proveClaims, type ProveClaimsOptions, type ProofVerdict } from "./facade.js";
import {
  checkProofSources,
  type ProofSourceFetcher,
  type ProofSourcesReport,
  type ProofSourcesVerdict,
} from "./ksources.js";
import { readProofData } from "./store.js";
import { K_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com/runtimeverification/k";

export const USAGE = `kproof <command>

  kproof prove <definition-dir> <spec-file> [flags]
      Prove every claim a spec file resolves to and print each proof's summary.
      Resumes from --proof-dir by default; --reinit starts over.

      claims   --spec-module M   --labels A,B   --exclude A,B   --no-depends
               -I DIR   --md-selector S   --builtin-dir DIR   --kprove CMD
      proving  --max-depth N   --max-iterations N   --bmc-depth N
               --cut-point-rule R   --terminal-rule R   --assume-defined
               --fail-fast   --counterexample-info   --optimize-kcfg
               --initialize   --maintenance-rate N   --step-timeout SECONDS
      run      --proof-dir DIR   --reinit   --no-digest   --workers N
               --failure-info   --port N   --kore-rpc-command CMD
               --llvm-definition DIR   --quiet

      --step-timeout budgets one step; a step that overruns is interrupted,
      the execution depth is halved, and the step retried, until there is
      nothing left to halve. It forces the run sequential, as upstream does.

      Resume is gated on <proof-dir>/digest: a claim whose text (or whose
      dependencies' text) changed is re-initialised rather than resumed.
      --no-digest turns the gate off, which is what a proof directory written
      by pyk or Kontrol needs.

      This command proves with the trivial semantics — nothing terminal,
      nothing a loop — exactly as pyk's own prove command does. A language
      whose proofs close on is_terminal needs the library, not the CLI: pass a
      KCFGSemantics through proveClaims' explore options.

  kproof show <definition-dir> <proof-dir> <id> [flags]
      Render a stored APR proof: the KCFG as text, then the SUMMARY module.
      Loads from disk and prints; it never proves and never starts a server.

          --minimize        minimize each printed configuration
          --no-full-printer print only node headers, not their terms
          --no-module       omit the trailing SUMMARY-<ID> module
          --omit-cell C,D   print these cell labels as ...
          --node N          also print node N's whole term (repeatable)
          --node-delta A,B  also print the rewrite from node A to node B
          --show-rules      name the rules each edge fired (beyond pyk)
          --dot             print the DOT graph instead of the text one

  kproof status <proof-dir> <id>
      Print a stored proof's summary. Exit 0 when it passed, 1 otherwise.

  kproof check-k <k-release>
      Check whether the pyk proof sources this package was transcribed from are
      unchanged at a given K release, e.g. kproof check-k ${K_RELEASE}.

Exit codes: prove exits with the **number of proofs that did not pass**, which
is pyk's own contract (\`__main__.py:290\`) and means 0 is success; 2 is a usage
error and 1 a run that could not start. status exits 0 passed, 1 otherwise;
show exits 0 when it rendered, 2 on a usage error and 1 when it could not load.
For check-k: 0 unchanged, 1 changed, 3 could not locate, 2 could not run.`;

interface ResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Fetch a declared source from GitHub; only a clean 404 means it moved. */
export const fetchFromGitHub: ProofSourceFetcher = async (path, release) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { fetch } = globalThis as unknown as { fetch: (url: string) => Promise<ResponseLike> };
  const response = await fetch(`${RAW}/${encodeURIComponent(release)}/${path}`);
  if (!response.ok && response.status !== 404) {
    throw new Error(`GET ${path} at ${release}: HTTP ${response.status} ${response.statusText}`);
  }
  return response.status === 404 ? undefined : new Uint8Array(await response.arrayBuffer());
};

/** Render a source-drift result for both the terminal and CI logs. */
export function render(report: ProofSourcesReport): string {
  const files = report.files.map((file) => {
    const mark = file.status === "unchanged" ? "ok  " : file.status === "changed" ? "DIFF" : "GONE";
    const detail =
      file.status === "unchanged"
        ? `unchanged since ${report.recordedAt}`
        : file.status === "changed"
          ? `expected ${file.expected.slice(0, 12)}…, got ${(file.actual ?? "").slice(0, 12)}…`
          : `no such path at ${report.release}`;
    return `  ${mark}  ${file.path}\n        ${detail}`;
  });
  const summary =
    report.verdict === "unchanged"
      ? `This package's transcription is current for K ${report.release}.`
      : report.verdict === "changed"
        ? `A source this package transcribes changed between ${report.recordedAt} and ${report.release}.\n` +
          `Diff it before trusting this package at that release.`
        : `K moved a source path, so this check cannot answer for ${report.release}. That is\n` +
          `not a verdict about compatibility — the manifest needs re-establishing.`;
  return `${files.join("\n")}\n\n${summary}\n`;
}

/** Map the repository-wide `check-k` verdict contract to process exit codes. */
export function exitCodeFor(verdict: ProofSourcesVerdict): number {
  return verdict === "unchanged" ? 0 : verdict === "changed" ? 1 : 3;
}

//////////////////////////////
// Shared parsing helpers   //
//////////////////////////////

/** A positive integer, or the reason it is not one. */
function positiveInt(flag: string, value: string): number | string {
  return /^[1-9][0-9]*$/u.test(value) ? Number(value) : `${flag} takes a positive integer, got ${value}`;
}

/** A non-negative integer, or the reason it is not one. */
function nonNegativeInt(flag: string, value: string): number | string {
  return /^[0-9]+$/u.test(value) ? Number(value) : `${flag} takes a non-negative integer, got ${value}`;
}

/**
 * `--labels a,b --labels c` → `['a', 'b', 'c']`.
 *
 * Repeatable *and* comma-separated, matching `ktool claims` — and `kprove`'s
 * own argv, which comma-joins `--claims`.
 */
function pushCommaSeparated(into: string[], value: string): void {
  for (const part of value.split(",")) if (part !== "") into.push(part);
}

//////////////////////////////
// prove                    //
//////////////////////////////

/** What `kproof prove` turns its flags into: the library's own options object, plus output switches. */
export interface ProveInvocation {
  readonly options: ProveClaimsOptions;
  /** `--failure-info`: print `APRFailureInfo.print()` under a failing proof's summary. */
  readonly failureInfo: boolean;
  /** `--quiet`: suppress the per-proof progress lines on stderr. */
  readonly quiet: boolean;
}

/** Every `prove` flag that consumes the argument after it. */
const PROVE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--spec-module",
  "--labels",
  "--exclude",
  "-I",
  "--include",
  "--md-selector",
  "--builtin-dir",
  "--kprove",
  "--max-depth",
  "--max-iterations",
  "--bmc-depth",
  "--cut-point-rule",
  "--terminal-rule",
  "--maintenance-rate",
  "--step-timeout",
  "--proof-dir",
  "--workers",
  "--port",
  "--kore-rpc-command",
  "--llvm-definition",
]);

/**
 * `kproof prove`'s flags → a {@link ProveClaimsOptions}. Pure: no filesystem,
 * no process.
 *
 * @returns the invocation, or a one-line reason it could not be built.
 */
export function parseProveArgs(args: readonly string[]): ProveInvocation | string {
  const positional: string[] = [];
  let specModuleName: string | undefined;
  const claimLabels: string[] = [];
  const excludeClaimLabels: string[] = [];
  const includeDirs: string[] = [];
  const cutPointRules: string[] = [];
  const terminalRules: string[] = [];
  let mdSelector: string | undefined;
  let builtinDir: string | undefined;
  let kproveCommand: readonly string[] | undefined;
  let includeDependencies = true;
  let maxDepth: number | undefined;
  let maxIterations: number | undefined;
  let bmcDepth: number | undefined;
  let maintenanceRate: number | undefined;
  let stepTimeout: number | undefined;
  let digest = true;
  let proofDir: string | undefined;
  let maxWorkers: number | undefined;
  let port: number | undefined;
  let koreRpcCommand: readonly string[] | undefined;
  let llvmDefinitionDir: string | undefined;
  let reinit = false;
  let failFast = false;
  let assumeDefined = false;
  let counterexampleInfo = false;
  let optimizeKcfg = false;
  let initializeProofs = false;
  let failureInfo = false;
  let quiet = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (PROVE_VALUE_FLAGS.has(arg)) {
      const raw = args[index + 1];
      if (raw === undefined) return `${arg} takes a value`;
      index += 1;

      switch (arg) {
        case "--spec-module":
          specModuleName = raw;
          break;
        case "--labels":
          pushCommaSeparated(claimLabels, raw);
          break;
        case "--exclude":
          pushCommaSeparated(excludeClaimLabels, raw);
          break;
        case "-I":
        case "--include":
          includeDirs.push(raw);
          break;
        case "--md-selector":
          mdSelector = raw;
          break;
        case "--builtin-dir":
          builtinDir = raw;
          break;
        case "--kprove":
          kproveCommand = raw.split(/\s+/u).filter((part) => part !== "");
          break;
        case "--cut-point-rule":
          pushCommaSeparated(cutPointRules, raw);
          break;
        case "--terminal-rule":
          pushCommaSeparated(terminalRules, raw);
          break;
        case "--proof-dir":
          proofDir = raw;
          break;
        case "--llvm-definition":
          llvmDefinitionDir = raw;
          break;
        case "--kore-rpc-command":
          koreRpcCommand = raw.split(/\s+/u).filter((part) => part !== "");
          break;
        default: {
          // Everything left is numeric. `--max-iterations 0` is a request pyk
          // honours — it loads and reports without stepping — so it is the one
          // that allows zero.
          const parsed = arg === "--max-iterations" ? nonNegativeInt(arg, raw) : positiveInt(arg, raw);
          if (typeof parsed === "string") return parsed;
          if (arg === "--max-depth") maxDepth = parsed;
          else if (arg === "--max-iterations") maxIterations = parsed;
          else if (arg === "--bmc-depth") bmcDepth = parsed;
          else if (arg === "--maintenance-rate") maintenanceRate = parsed;
          else if (arg === "--step-timeout") stepTimeout = parsed;
          else if (arg === "--workers") maxWorkers = parsed;
          else port = parsed;
          break;
        }
      }
      continue;
    }

    switch (arg) {
      case "--no-depends":
        includeDependencies = false;
        continue;
      case "--reinit":
        reinit = true;
        continue;
      case "--no-digest":
        digest = false;
        continue;
      case "--fail-fast":
        failFast = true;
        continue;
      case "--assume-defined":
        assumeDefined = true;
        continue;
      case "--counterexample-info":
        counterexampleInfo = true;
        continue;
      case "--optimize-kcfg":
        optimizeKcfg = true;
        continue;
      case "--initialize":
        initializeProofs = true;
        continue;
      case "--failure-info":
        failureInfo = true;
        continue;
      case "--quiet":
        quiet = true;
        continue;
      default:
        break;
    }

    if (arg.startsWith("-")) return `unknown option: ${arg}`;
    positional.push(arg);
  }

  const [definitionDir, specFile, ...rest] = positional;
  if (definitionDir === undefined || specFile === undefined || rest.length > 0) {
    return "takes exactly a kompiled definition directory and a spec file";
  }

  const explore = {
    ...(port === undefined ? {} : { port }),
    ...(koreRpcCommand === undefined ? {} : { koreRpcCommand }),
    ...(llvmDefinitionDir === undefined ? {} : { llvmDefinitionDir }),
  };

  const options: ProveClaimsOptions = {
    definitionDir,
    specFile,
    includeDependencies,
    reinit,
    digest,
    failFast,
    assumeDefined,
    counterexampleInfo,
    optimizeKcfg,
    initializeProofs,
    ...(specModuleName === undefined ? {} : { specModuleName }),
    ...(claimLabels.length === 0 ? {} : { claimLabels }),
    ...(excludeClaimLabels.length === 0 ? {} : { excludeClaimLabels }),
    ...(includeDirs.length === 0 ? {} : { includeDirs }),
    ...(cutPointRules.length === 0 ? {} : { cutPointRules }),
    ...(terminalRules.length === 0 ? {} : { terminalRules }),
    ...(mdSelector === undefined ? {} : { mdSelector }),
    ...(builtinDir === undefined ? {} : { builtinDir }),
    ...(kproveCommand === undefined ? {} : { kproveCommand }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(bmcDepth === undefined ? {} : { bmcDepth }),
    ...(maintenanceRate === undefined ? {} : { maintenanceRate }),
    ...(stepTimeout === undefined ? {} : { stepTimeout }),
    ...(proofDir === undefined ? {} : { proofDir }),
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    ...(Object.keys(explore).length === 0 ? {} : { explore }),
  };

  return { options, failureInfo, quiet };
}

/** A crash's message, without asking an arbitrary value for its `toString`. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

/** One proof's stdout block: its summary, then its failure report when asked for. */
export function renderVerdict(verdict: ProofVerdict, failureInfo: boolean): string {
  const proof = verdict.proof;
  const lines = proof === undefined ? [`${verdict.id}: no proof was built`] : [...proof.summary.lines];
  const error = verdict.error;
  if (error !== undefined) {
    lines.push(`Proof crashed: ${describeError(error)}`);
  }
  if (failureInfo && proof?.failed === true) {
    const info = proof.failureInfo;
    if (info instanceof APRFailureInfo) lines.push(...info.print());
  }
  return `${lines.join("\n")}\n`;
}

async function mainProve(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const parsed = parseProveArgs(args);
  if (typeof parsed === "string") {
    err(`prove ${parsed}\n\n${USAGE}\n`);
    return 2;
  }

  let verdicts: readonly ProofVerdict[];
  try {
    verdicts = await proveClaims({
      ...parsed.options,
      ...(parsed.quiet
        ? {}
        : {
            progress: (event) => {
              if (event.kind === "claims-loaded") err(`proving ${event.labels.length} claim(s)\n`);
              if (event.kind === "proof-started") err(`[${event.index}/${event.total}] ${event.id}\n`);
              // The events upstream logs at WARNING: a re-initialised claim, a
              // step over its budget, a `--workers` the timeout overrode.
              if (event.kind === "notice") err(`${event.message}\n`);
            },
          }),
    });
  } catch (error) {
    // Loading claims, kompiled directories and servers all fail before any
    // proof exists, so there is no count to exit with: this is "could not run".
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // `sorted(proofs, key=lambda p: p.id)` (`__main__.py:281`).
  for (const verdict of verdicts.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))) {
    out(renderVerdict(verdict, parsed.failureInfo));
  }
  return verdicts.filter((verdict) => !verdict.passed).length;
}

//////////////////////////////
// status                   //
//////////////////////////////

/** What `kproof status` needs: where the proofs live and which one to report. */
export interface StatusInvocation {
  readonly proofDir: string;
  readonly id: string;
}

/** `kproof status`'s two positionals. Pure. */
export function parseStatusArgs(args: readonly string[]): StatusInvocation | string {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown !== undefined) return `unknown option: ${unknown}`;
  const [proofDir, id, ...rest] = positional;
  if (proofDir === undefined || id === undefined || rest.length > 0) {
    return "takes exactly a proof directory and a proof id";
  }
  return { proofDir, id };
}

async function mainStatus(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const parsed = parseStatusArgs(args);
  if (typeof parsed === "string") {
    err(`status ${parsed}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    const proof = await readProofData(parsed.proofDir, parsed.id);
    out(`${proof.summary.lines.join("\n")}\n`);
    return proof.passed ? 0 : 1;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

//////////////////////////////
// show                     //
//////////////////////////////

/** What `kproof show` turns its arguments into. */
export interface ShowInvocation {
  readonly definitionDir: string;
  readonly proofDir: string;
  readonly id: string;
  /** `--minimize`; pyk's own show passes `minimize=False` (`__main__.py:290`). */
  readonly minimize: boolean;
  /** `--no-full-printer` turns this off; pyk's show sets `full_printer=True`. */
  readonly fullPrinter: boolean;
  /** `--no-module` turns this off. */
  readonly toModule: boolean;
  readonly omitCells: readonly string[];
  readonly nodes: readonly NodeIdLike[];
  readonly nodeDeltas: readonly (readonly [NodeIdLike, NodeIdLike])[];
  /**
   * `--show-rules`: print each successor's rule ids under its label.
   *
   * **Beyond pyk** — `exec_show` has no such flag because `KCFGShow` has no
   * such output. Off by default, so the rendering stays `exec_show`'s.
   */
  readonly showRules: boolean;
  /** `--dot`: print the DOT document instead of the text rendering. */
  readonly dot: boolean;
}

/** Every `show` flag that consumes the argument after it. */
const SHOW_VALUE_FLAGS: ReadonlySet<string> = new Set(["--omit-cell", "--node", "--node-delta"]);

/**
 * A `NodeIdLike`: a positive integer, or an `@alias`.
 *
 * The alias branch is written as a template read rather than a cast so the
 * narrowing is the compiler's, not an assertion's.
 */
function parseNodeId(value: string): NodeIdLike | undefined {
  if (/^[1-9][0-9]*$/u.test(value)) return Number(value);
  if (!value.startsWith("@") || value.length < 2) return undefined;
  const [, ...rest] = value;
  return `@${rest.join("")}`;
}

/** `kproof show`'s three positionals and its rendering flags. Pure. */
export function parseShowArgs(args: readonly string[]): ShowInvocation | string {
  const positional: string[] = [];
  const omitCells: string[] = [];
  const nodes: NodeIdLike[] = [];
  const nodeDeltas: (readonly [NodeIdLike, NodeIdLike])[] = [];
  let minimize = false;
  let fullPrinter = true;
  let toModule = true;
  let showRules = false;
  let dot = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (SHOW_VALUE_FLAGS.has(arg)) {
      const raw = args[index + 1];
      if (raw === undefined) return `${arg} takes a value`;
      index += 1;
      if (arg === "--omit-cell") {
        pushCommaSeparated(omitCells, raw);
      } else if (arg === "--node") {
        const node = parseNodeId(raw);
        if (node === undefined) return `--node takes a positive node id or an @alias, got ${raw}`;
        nodes.push(node);
      } else {
        const parts = raw.split(",");
        const source = parts.length === 2 ? parseNodeId(parts[0] ?? "") : undefined;
        const target = parts.length === 2 ? parseNodeId(parts[1] ?? "") : undefined;
        if (source === undefined || target === undefined) {
          return `--node-delta takes two comma-separated node ids, got ${raw}`;
        }
        nodeDeltas.push([source, target]);
      }
      continue;
    }
    switch (arg) {
      case "--minimize":
        minimize = true;
        continue;
      case "--no-full-printer":
        fullPrinter = false;
        continue;
      case "--no-module":
        toModule = false;
        continue;
      case "--show-rules":
        showRules = true;
        continue;
      case "--dot":
        dot = true;
        continue;
      default:
        break;
    }
    if (arg.startsWith("-")) return `unknown option: ${arg}`;
    positional.push(arg);
  }

  const [definitionDir, proofDir, id, ...rest] = positional;
  if (definitionDir === undefined || proofDir === undefined || id === undefined || rest.length > 0) {
    return "takes exactly a kompiled definition directory, a proof directory and a proof id";
  }
  return {
    definitionDir,
    proofDir,
    id,
    minimize,
    fullPrinter,
    toModule,
    omitCells,
    nodes,
    nodeDeltas,
    showRules,
    dot,
  };
}

async function mainShow(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const parsed = parseShowArgs(args);
  if (typeof parsed === "string") {
    err(`show ${parsed}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    const proof = await readProofData(parsed.proofDir, parsed.id);
    if (!(proof instanceof APRProof)) {
      err(`${parsed.id} is a ${proof.proofType}; only an APRProof can be shown\n`);
      return 1;
    }
    // The composition pyk performs at `__main__.py:287-289`, with `KPrint`
    // standing in for `KProve` because showing needs only the definition.
    const kprint = await KPrint.load(parsed.definitionDir);
    const printer = (kast: KAst): string => kprint.prettyPrint(kast);
    const ctermShow = new CTermShow((term) => printer(term), { minimize: parsed.minimize });
    const show = new APRProofShow({
      definition: kprint.definition,
      prettyPrint: printer,
      nodePrinter: new APRProofNodePrinter(proof, ctermShow, { fullPrinter: parsed.fullPrinter }),
    });
    if (parsed.dot) {
      out(`${show.dot(proof)}\n`);
      return 0;
    }
    out(
      `${show
        .show(proof, {
          minimize: parsed.minimize,
          toModule: parsed.toModule,
          omitCells: parsed.omitCells,
          nodes: parsed.nodes,
          nodeDeltas: parsed.nodeDeltas,
          showRules: parsed.showRules,
        })
        .join("\n")}\n`,
    );
    return 0;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

//////////////////////////////
// check-k                  //
//////////////////////////////

async function mainCheckK(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: ProofSourceFetcher,
): Promise<number> {
  const [release, ...rest] = args;
  if (release === undefined || rest.length > 0) {
    err(`check-k takes exactly one K release tag, e.g. ${K_RELEASE}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    const report = await checkProofSources(release, fetcher);
    out(render(report));
    return exitCodeFor(report.verdict);
  } catch (error) {
    err(`could not check ${release}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

//////////////////////////////
// Entry point              //
//////////////////////////////

/**
 * CLI core, with injected I/O and fetcher so `check-k` can be tested offline.
 *
 * Everything `prove` and `status` touch — K, a server, a proof directory — is
 * real, because a seam for those would be a seam for the one thing those
 * commands exist to do.
 */
export function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: ProofSourceFetcher = fetchFromGitHub,
): Promise<number> {
  const [command, ...args] = argv;

  if (command === undefined) {
    err(`${USAGE}\n`);
    return Promise.resolve(2);
  }
  if (command === "--help" || command === "-h" || command === "help") {
    out(`${USAGE}\n`);
    return Promise.resolve(0);
  }
  if (command === "prove") return mainProve(args, out, err);
  if (command === "show") return mainShow(args, out, err);
  if (command === "status") return mainStatus(args, out, err);
  if (command === "check-k") return mainCheckK(args, out, err, fetcher);

  err(`unknown command: ${command}\n\n${USAGE}\n`);
  return Promise.resolve(2);
}
