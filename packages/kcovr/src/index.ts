/**
 * `@kframework-ts/kcovr` — K's semantic **rule coverage**, in TypeScript.
 *
 * `kompile --coverage` instruments every rule's right-hand side so that
 * executing the semantics appends the rule's `UNIQUE_ID` to a log on disk
 * (`GenerateCoverage.java:66-78`, `io.cpp:526-572`).  This package is the
 * tooling downstream of that: parsing the artifacts, counting hits, rendering
 * Cobertura reports, and remapping hits across recompiles.  The instrumentation
 * itself stays the K toolchain's job — see `docs/coverage-plan.md` §6.
 *
 * Everything exported from this module is **pure**: functions of strings, maps
 * and `KDefinition`s.  The one filesystem-touching module lives behind the
 * `./fs` subpath, and paths in public signatures are `string`, never node
 * types.
 *
 * ## Status
 *
 * Complete against `docs/coverage-plan.md` §7.  Everything upstream has is
 * here: hit counting (`hits.ts`), the Cobertura renderer (`cobertura.ts`) —
 * which is the whole of `pyk-covr` — rule lookup and de-instrumentation
 * (`rules.ts`), cross-build remapping (`translate.ts`), the legacy haskell
 * one-line log analyzer (`koreExecLog.ts`), and the drift check
 * (`ksources.ts`, `kcovr check-k`).
 *
 * ```ts
 * import { createCoverMap, renderCoverageXml } from "@kframework-ts/kcovr";
 * import { readCoverageDefinitions } from "@kframework-ts/kcovr/fs";
 *
 * const definitions = await readCoverageDefinitions(["./my-kompiled"]);
 * const xml = renderCoverageXml(definitions, ["/abs/path/to/semantics.md"], { timestamp: 0 });
 * ```
 *
 * See `fixtures/PROVENANCE.md` for where the corpus came from, and
 * `THIRD-PARTY-NOTICES.md` for the BSD-3-Clause notices that travel with a port
 * of K's sources.
 */

export {
  type CoverageDefinition,
  type CoverageOptions,
  type CoverageReport,
  coverageSourceRoot,
  createRuleMap,
  formatPythonFloat,
  relativeSourceName,
  renderCoverageReport,
  renderCoverageXml,
  type RuleMap,
} from "./cobertura.js";

export {
  DuplicateRuleIdError,
  KcovrError,
  MissingCoverageFileError,
  RuleNotFoundError,
  UnknownSourceRuleError,
  UnknownTargetLocationError,
} from "./errors.js";

export { type CoverMap, createCoverMap, type RuleId, totalHits } from "./hits.js";

export {
  buildRuleDict,
  HASKELL_LOG_ENTRY_REGEXP,
  HaskellLogEntry,
  type HaskellLogLine,
  type KoreExecReport,
  type KoreExecReportOptions,
  type LocationKey,
  locationKey,
  parseHaskellOnelineLog,
  parseRuleApplications,
  renderKoreExecReport,
  type RuleApplications,
  type RuleDict,
  type RuleDictOptions,
  UNKNOWN_LOCATION,
} from "./koreExecLog.js";

export {
  getRuleById,
  LOG_TO_FILE_LABEL,
  PROJECT_LABEL_PREFIX,
  SIDE_EFFECT_LABEL_PREFIX,
  stripCoverageLogger,
} from "./rules.js";

export {
  type BasenameLocation,
  basenameLocation,
  semanticRuleIds,
  sourceLocationMap,
  targetIdMap,
  translateCoverage,
  translateCoverageFromDefinitions,
} from "./translate.js";

export {
  IO_CPP_IDENTITY,
  K_COMMIT,
  K_RELEASE,
  type KcovrSourceRepo,
  type KcovrSourceTier,
  type KcovrTranscribedSource,
  TRANSCRIBED_FROM,
} from "./version.js";

export {
  checkKcovrSources,
  type KcovrSourceFetcher,
  type KcovrSourceOutcome,
  type KcovrSourcesReport,
  type KcovrSourcesVerdict,
  type KcovrSourceStatus,
  sha256Hex,
} from "./ksources.js";
