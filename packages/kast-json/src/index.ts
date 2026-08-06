/**
 * `@kframework-ts/kast-json` — a reader for K Framework's KAST JSON,
 * versions 3 and 4.
 *
 * KAST JSON is the serialisation K emits from `krun --output json` and
 * `kompile --emit-json`.  It has no published schema: its only specification
 * is two Java files in the K source tree, `ToJson.java` (the writer) and
 * `JsonParser.java` (the reader).  This package is a hand-transcription of
 * those two files at every revision recorded in `TRANSCRIBED_FROM` — the v3
 * revision at tag `v7.1.191` and the v4 revision at `v7.1.337` — and its
 * conformance fixtures — real output from a real `kompile`/`krun`, plus K's
 * own checked-in test documents at both versions — are what make the
 * transcription trustworthy.
 *
 * See `README.md` for the guarantees, and `THIRD-PARTY-NOTICES.md` for the
 * BSD-3-Clause notices that travel with a port of K's sources.
 */

export {
  KAST_FORMAT,
  KAST_VERSIONS,
  type KastRevision,
  type KastVersion,
  K_RELEASE,
  SORT_SPELLING_SOURCE,
  TRANSCRIBED_FROM,
  type TranscribedSource,
} from "./version.js";

export {
  checkKRevisions,
  checkKSources,
  type KObservedFile,
  type KRevisionsReport,
  type KSourceFetcher,
  type KSourceFile,
  type KSourceOutcome,
  type KSourcesReport,
  type KSourcesVerdict,
  type KSourceStatus,
  sha256Hex,
} from "./ksources.js";

export { type Envelope, type EnvelopeProblem, isRecord, openEnvelope, openEnvelopeText } from "./envelope.js";

export {
  canonicalKey,
  cell,
  type CellRead,
  children,
  decodeTerm,
  find,
  findAll,
  firstArg,
  flattenSort,
  head,
  type KLabel,
  type KTerm,
  parseTermDocument,
  type SortShape,
  type StructuredSort,
  type TermDocument,
  token,
  unflattenSort,
} from "./term.js";

export {
  builtinListElements,
  type KMap,
  type KMapEntry,
  type KSet,
  mapEntries,
  setElements,
  userListElements,
} from "./collections.js";

export {
  type AttValue,
  AttValueSchema,
  attLocation,
  attSource,
  attString,
  type DefinitionDocument,
  type DefinitionTermJson,
  DefinitionTermSchema,
  type KAttJson,
  KAttSchema,
  type KDefinitionJson,
  KDefinitionSchema,
  type KFlatModuleJson,
  KFlatModuleListSchema,
  type KFlatModuleListJson,
  KFlatModuleSchema,
  KImportSchema,
  type KLabelJson,
  KLabelSchema,
  type KLocation,
  KNonTerminalSchema,
  type KProductionJson,
  KProductionSchema,
  KRegexTerminalSchema,
  type KSortJson,
  KSortSchema,
  KTerminalSchema,
  LOCATION_KEY,
  modulesOf,
  parseDefinitionDocument,
  PRODUCTION_KEY,
  type ProductionItemJson,
  ProductionItemSchema,
  productions,
  rules,
  type SentenceJson,
  SentenceSchema,
  SOURCE_KEY,
} from "./definition.js";
