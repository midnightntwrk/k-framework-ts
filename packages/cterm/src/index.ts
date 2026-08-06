/** Pure, offline constrained KAST state values. */

export { CTerm, ctermEq, type CTermDict } from "./cterm.js";
export { CSubst, csubstEq, type CSubstDict, type CSubstPredOptions } from "./csubst.js";
export {
  antiUnify,
  ctermAntiUnify,
  ctermsAntiUnify,
  type AntiUnifyOptions,
  type AntiUnifyResult,
  type CTermAntiUnifyResult,
} from "./anti-unify.js";
export {
  ctermBuildClaim,
  ctermBuildRule,
  type CTermBuildClaimOptions,
  type CTermBuildRuleOptions,
} from "./builders.js";
export { CTermShow, type CTermShowOptions, type TermPrinter } from "./show.js";
export { K_COMMIT, K_RELEASE, TRANSCRIBED_FROM, type CtermTranscribedSource } from "./version.js";
export {
  checkCtermSources,
  type CtermSourceFetcher,
  type CtermSourceOutcome,
  type CtermSourcesReport,
  type CtermSourcesVerdict,
  type CtermSourceStatus,
  sha256Hex,
} from "./ksources.js";
