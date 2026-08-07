/**
 * Strictness and generated heat/cool labels, transcribed from K's
 * `ResolveStrict`, `ResolveContexts`, and `ResolveHeatCoolAttribute` passes.
 *
 * This is predictive rather than an observational join against compiled
 * rules. It intentionally does not synthesize rule bodies or context-alias
 * bodies: `context alias` remains an opaque outer-parser bubble. A generated
 * label identifies a strict position, not necessarily one unique rule; an
 * alias name can resolve to more than one alias body in K.
 */

import {
  Atts,
  productionNonTerminals,
  type KBubble,
  type KContext,
  type KDefinition,
  type KProduction,
  type KSentence,
} from "@kframework-ts/kast";

/** One ordered strictness group parsed from `strict` or `seqstrict`. */
export interface StrictnessGroup {
  /** The referenced context-alias label, absent for K's implicit default alias. */
  readonly alias?: string;
  /** One-based nonterminal positions, in the order K uses for `seqstrict`. */
  readonly positions: readonly number[];
  /** Whether this group originated in `seqstrict` rather than `strict`. */
  readonly sequential: boolean;
}

/** Labels K will put on one generated heat/cool pair. */
export interface HeatCoolLabelPair {
  readonly heat?: string;
  readonly cool?: string;
  /** Present for strictness-generated pairs; omitted for an explicit context. */
  readonly position?: number;
}

/** The sequential `is<Result>(K<n>)` residue on one generated heat pair. */
export interface StrictnessResidue {
  readonly position: number;
  readonly sequential: boolean;
  readonly resultSort: string;
  /** Earlier listed positions K requires to be results; empty for `strict`. */
  readonly requiresPositions: readonly number[];
}

/** A definition-local sentence and the labels predicted from it. */
export interface GeneratedRuleLabels {
  readonly moduleName: string;
  readonly sentence: KSentence;
  readonly labels: readonly HeatCoolLabelPair[];
}

/**
 * Parse the ordered strictness groups K derives from `strict` and `seqstrict`.
 *
 * Invalid strings throw with the same boundary K enforces: positions must be
 * one-based nonterminal indices. Empty attributes select every nonterminal;
 * an arity-zero production therefore has no positions.
 */
export function strictPositions(production: KProduction): readonly StrictnessGroup[] {
  const arity = productionNonTerminals(production).length;
  const groups: StrictnessGroup[] = [];
  addGroups(groups, production.att.get(Atts.STRICT), false, arity);
  addGroups(groups, production.att.get(Atts.SEQSTRICT), true, arity);
  return Object.freeze(groups);
}

/** Number of heat/cool rule pairs K derives, ignoring unresolved alias-body multiplicity. */
export function heatCoolPairs(sentence: KSentence): number {
  if (sentence.node === "KProduction") {
    return strictPositions(sentence).reduce((count, group) => count + group.positions.length, 0);
  }
  return isExplicitContext(sentence) ? 1 : 0;
}

/**
 * Predict the strictness-side condition before ResolveHeatCoolAttribute adds
 * `notBool is<Result>(HOLE)`.  For `seqstrict`, order is attribute order, not
 * sorted nonterminal position; `result(S)` changes `isKResult` to `isS`.
 */
export function heatCoolResidue(production: KProduction): readonly StrictnessResidue[] {
  const residues: StrictnessResidue[] = [];
  const resultSort = resultSortOf(production);
  const priorSequential: number[] = [];
  for (const group of strictPositions(production)) {
    const prior = group.sequential ? priorSequential : [];
    for (let index = 0; index < group.positions.length; index++) {
      const position = group.positions[index];
      if (position === undefined) continue;
      residues.push(
        Object.freeze({
          position,
          sequential: group.sequential,
          resultSort,
          requiresPositions: Object.freeze(group.sequential ? [...prior, ...group.positions.slice(0, index)] : []),
        }),
      );
    }
    if (group.sequential) priorSequential.push(...group.positions);
  }
  return Object.freeze(residues);
}

/**
 * Predict labels for one source sentence in its declaring module.
 *
 * Explicit contexts without a `label` still produce a pair, but no label.
 * Strictness labels remove backticks and all whitespace exactly as K does.
 */
export function heatCoolLabels(sentence: KSentence, moduleName: string): readonly HeatCoolLabelPair[] {
  if (sentence.node === "KProduction") {
    const klabel = strictnessKLabel(sentence);
    if (klabel === undefined) {
      if (heatCoolPairs(sentence) !== 0) {
        throw new TypeError("Only productions with a KLabel can be strict");
      }
      return Object.freeze([]);
    }
    const base = `${moduleName}.${sanitizeKLabel(klabel)}`;
    const pairs: HeatCoolLabelPair[] = [];
    for (const group of strictPositions(sentence)) {
      for (const position of group.positions) {
        pairs.push(Object.freeze({ heat: `${base}${position}-heat`, cool: `${base}${position}-cool`, position }));
      }
    }
    return Object.freeze(pairs);
  }
  if (isExplicitContext(sentence)) return contextLabels(sentence);
  return Object.freeze([]);
}

/** Walk every declared module locally, preserving the declaring-module qualifier. */
export function generatedRuleLabels(definition: KDefinition): readonly GeneratedRuleLabels[] {
  const generated: GeneratedRuleLabels[] = [];
  for (const module of definition.allModules) {
    for (const sentence of module.sentences) {
      const labels = heatCoolLabels(sentence, module.name);
      if (heatCoolPairs(sentence) !== 0) generated.push(Object.freeze({ moduleName: module.name, sentence, labels }));
    }
  }
  return Object.freeze(generated);
}

function addGroups(groups: StrictnessGroup[], raw: unknown, sequential: boolean, arity: number): void {
  if (raw === undefined) return;
  if (typeof raw !== "string") throw new TypeError(`${sequential ? "seqstrict" : "strict"} must have a string value`);
  const all = (): readonly number[] => Object.freeze(Array.from({ length: arity }, (_, index) => index + 1));
  if (raw === "") {
    groups.push(Object.freeze({ positions: all(), sequential }));
    return;
  }
  const components = raw.split(";");
  if (components.length === 1) {
    const component = components[0]?.trim() ?? "";
    if (startsWithDigit(component))
      groups.push(Object.freeze({ positions: parsePositions(component, arity), sequential }));
    else groups.push(Object.freeze({ alias: component, positions: all(), sequential }));
    return;
  }
  if (components.length % 2 !== 0) throw new TypeError("Invalid strict attribute containing multiple semicolons");
  for (let index = 0; index < components.length; index += 2) {
    const alias = components[index]?.trim() ?? "";
    const positions = components[index + 1]?.trim() ?? "";
    groups.push(Object.freeze({ alias, positions: parsePositions(positions, arity), sequential }));
  }
}

function startsWithDigit(value: string): boolean {
  return /^\d/u.test(value);
}

function parsePositions(value: string, arity: number): readonly number[] {
  const positions: number[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!/^[+-]?\d+$/u.test(trimmed)) throw invalidPosition(arity, trimmed);
    const position = Number(trimmed);
    if (!Number.isSafeInteger(position) || position < 1 || position > arity) throw invalidPosition(arity, trimmed);
    positions.push(position);
  }
  return Object.freeze(positions);
}

function invalidPosition(arity: number, value: string): TypeError {
  return arity === 0
    ? new TypeError("Cannot put a strict attribute on a production with no nonterminals")
    : new TypeError(`Expecting a number between 1 and ${arity}, but found ${value} as a strict position`);
}

function sanitizeKLabel(label: string): string {
  return label.replaceAll("`", "").replaceAll(/\s/gu, "");
}

/** A parsed `context` is a bubble; a compiled one is a `KContext`. Both carry the generated-rule label. */
function isExplicitContext(sentence: KSentence): sentence is KContext | KBubble {
  return sentence.node === "KContext" || (sentence.node === "KBubble" && sentence.sentenceType === "context");
}

/** Read a context label verbatim: source spelling has already decided qualification. */
function contextLabels(context: KContext | KBubble): readonly HeatCoolLabelPair[] {
  const label = context.att.get(Atts.LABEL);
  if (typeof label !== "string" || label === "") return Object.freeze([Object.freeze({})]);
  return Object.freeze([Object.freeze({ heat: `${label}-heat`, cool: `${label}-cool` })]);
}

function resultSortOf(production: KProduction): string {
  for (const entry of production.att) {
    if (entry.key.name === "result" && typeof entry.value === "string" && entry.value !== "") return entry.value;
  }
  return "KResult";
}

/** K's strictness label lookup prefers a deprecated klabel attribute. */
function strictnessKLabel(production: KProduction): string | undefined {
  for (const entry of production.att) {
    if (entry.key.name === "klabel" && typeof entry.value === "string" && entry.value !== "") return entry.value;
  }
  return production.klabel?.name;
}
