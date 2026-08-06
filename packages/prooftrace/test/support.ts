/**
 * Test support: the checked-in fixtures, and a re-implementation of
 * `kore-proof-trace`'s printer.
 *
 * The printer is here and not in `src/` on purpose.  It exists for exactly one
 * job — rendering this package's parse in the *byte-exact* form the backend's
 * own tool produces, so `reference.test.ts` can diff the two — and nothing a
 * consumer wants is expressed in it.  `@kframework-ts/kore`'s `koreText` is the
 * printer for every other purpose; it differs from kllvm's in one respect
 * (`", "` between a composite pattern's arguments where kllvm writes `","`),
 * which is enough to make a diff useless and not enough to make either wrong.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Pattern, Sort } from "@kframework-ts/kore";

import { stripInjections } from "../src/binary.ts";
import type { ProofTraceBinding, ProofTraceEvent } from "../src/events.ts";
import { parseProofTrace } from "../src/events.ts";
import { KoreHeader } from "../src/header.ts";
import type { OrdinalRuleIndex } from "../src/ordinals.ts";
import { referenceLocation } from "../src/ordinals.ts";

export const FIXTURES = join(import.meta.dir, "..", "fixtures");

/** Raw bytes of a file under `fixtures/`. */
export function fixtureBytes(...parts: readonly string[]): Uint8Array {
  return readFileSync(join(FIXTURES, ...parts));
}

/** UTF-8 text of a file under `fixtures/`. */
export function fixtureText(...parts: readonly string[]): string {
  return readFileSync(join(FIXTURES, ...parts), "utf8");
}

/** The three traced runs the fixtures carry, and what each is for. */
export const RUNS = Object.freeze({
  /** `state(s(s(z())), z())` on the llvm-backend doc's own example semantics. */
  addRewrite: Object.freeze({
    header: "add-rewrite.header",
    hints: "add-rewrite.hints",
    trace: "add-rewrite.trace.txt",
    definition: "add-rewrite.definition.kore",
  }),
  /** `halve(s(s(s(z()))))` — takes the `depth(N) >Int 1` side of the guard first. */
  guardedBig: Object.freeze({
    header: "guarded.header",
    hints: "guarded-big.hints",
    trace: "guarded-big.trace.txt",
    definition: "guarded.definition.kore",
  }),
  /** `halve(s(z()))` — takes the `depth(N) <=Int 1` side immediately. */
  guardedSmall: Object.freeze({
    header: "guarded.header",
    hints: "guarded-small.hints",
    trace: "guarded-small.trace.txt",
    definition: "guarded.definition.kore",
  }),
} as const);

export type RunName = keyof typeof RUNS;

/** Load one run's header. */
export function runHeader(run: RunName): KoreHeader {
  return KoreHeader.parse(fixtureBytes("hints", RUNS[run].header));
}

/** Load one run's hint stream. */
export function runHints(run: RunName): Uint8Array {
  return fixtureBytes("hints", RUNS[run].hints);
}

/** Load one run's `kore-proof-trace --expand-terms --verbose` output. */
export function runReference(run: RunName): string {
  return fixtureText("hints", RUNS[run].trace);
}

/** Load one run's `definition.kore` text. */
export function runDefinition(run: RunName): string {
  return fixtureText("hints", RUNS[run].definition);
}

//////////////////////////////
// The kllvm printer        //
//////////////////////////////

/**
 * `kore_pattern::print` (`llvm-backend lib/ast/AST.cpp:1379-1459`).
 *
 * Three separators, all different and all deliberate:
 * - a composite **sort**'s arguments: `","` (`:1385`);
 * - a **symbol**'s formal sort arguments: `", "` (`:1403`);
 * - a composite **pattern**'s arguments: `","` (`:1432`).
 */
// oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the
// `default` below is the point: a hint stream contains only the three arms
// listed, and anything else must be a loud failure rather than a silent one.
export function kllvmText(pattern: Pattern): string {
  switch (pattern.tag) {
    case "String":
      return `"${escapeString(pattern.value)}"`;
    case "DV":
      // A `\dv` is a composite pattern whose constructor is `\dv{Sort{}}` and
      // whose one argument is the string; `binary.ts` folds it into a `DV`.
      return `${symbolText("\\dv", [pattern.sort])}(${kllvmText(pattern.value)})`;
    case "App":
      return `${symbolText(pattern.symbol, pattern.sorts)}(${pattern.args.map(kllvmText).join(",")})`;
    default:
      throw new Error(`kllvmText does not print ${pattern.tag} — no hint stream contains one`);
  }
}

function symbolText(name: string, sorts: readonly Sort[]): string {
  return `${name}{${sorts.map(sortText).join(", ")}}`;
}

function sortText(sort: Sort): string {
  return sort.tag === "SortVar" ? sort.name : `${sort.name}{${sort.sorts.map(sortText).join(",")}}`;
}

/** `escape_string` (`AST.cpp:1440-1454`): `"`, `\` and every non-printable byte become `\xNN`. */
function escapeString(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === '"' || character === "\\" || code < 0x20 || code > 0x7e) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += character;
    }
  }
  return out;
}

//////////////////////////////
// The trace renderer       //
//////////////////////////////

const INDENT = "  ";

/**
 * Render a parsed trace exactly as `kore-proof-trace <header> <hints>
 * <definition.kore> --expand-terms --verbose` prints it
 * (`ProofTraceParser.cpp:34-138`, `:188-196`).
 *
 * Pass `rules: undefined` to reproduce the two-argument invocation, where
 * `print_debug_info()` is false and a rule event prints without its brackets.
 */
export function renderReference(bytes: Uint8Array, header: KoreHeader, rules: OrdinalRuleIndex | undefined): string {
  const trace = parseProofTrace(bytes, header);
  const lines: string[] = [`version: ${String(trace.version)}`];
  const emit = (event: ProofTraceEvent): void => {
    lines.push(...renderEvent(event, rules));
  };
  trace.preTrace.forEach(emit);
  if (trace.initialConfig !== undefined) emit(trace.initialConfig);
  trace.trace.forEach(emit);
  return lines.join("\n") + "\n";
}

function renderEvent(event: ProofTraceEvent, rules: OrdinalRuleIndex | undefined): string[] {
  switch (event.tag) {
    case "config":
      return [`config: kore[${term(event.term)}]`];
    case "rule":
      return [ruleHeading(event.ordinal, event.substitution.length, rules), ...substitution(event.substitution)];
    case "side-condition-enter":
      return [
        `side condition entry: ${String(event.ordinal)} ${String(event.substitution.length)}`,
        ...substitution(event.substitution),
      ];
    case "side-condition-exit":
      return [`side condition exit: ${String(event.ordinal)} ${event.result ? "true" : "false"}`];
    case "function-exit":
      return [`function exit: ${String(event.ordinal)} ${event.isTail ? "tail" : "notail"}`];
    case "pattern-matching-failure":
      return [`pattern matching failure: ${event.functionName}`];
    case "function":
      return [
        `function: ${event.name} (${event.relativePosition})`,
        ...event.args.map((arg) => `${INDENT}arg: kore[${term(arg.term)}]`),
      ];
    case "hook":
      return [
        `hook: ${event.name} ${event.symbolName} (${event.relativePosition})`,
        ...event.args.map((arg) => `${INDENT}arg: kore[${term(arg.term)}]`),
        `hook result: kore[${term(event.result)}]`,
      ];
    default:
      // Unreachable while `ProofTraceEvent` has eight arms and all eight are
      // above; present so the lint can see a total function, and so a ninth
      // arm added upstream fails loudly here rather than rendering nothing.
      throw new Error(`unrendered event`);
  }
}

/** `llvm_rule_event::print` (`ProofTraceParser.cpp:47-60`). */
function ruleHeading(ordinal: number, size: number, rules: OrdinalRuleIndex | undefined): string {
  const head = `rule: ${String(ordinal)} ${String(size)}`;
  if (rules === undefined) return head;
  const identity = rules[ordinal];
  // A definition was supplied, so the reference prints the brackets whether or
  // not the axiom filled them; an unresolved ordinal cannot happen against the
  // definition the trace came from and would be a test failure, not a blank.
  if (identity === undefined) throw new Error(`no axiom at ordinal ${String(ordinal)}`);
  return `${head} [${identity.declaredLabel ?? ""}] [${referenceLocation(identity)}]`;
}

/** `print_substitution` (`ProofTraceParser.cpp:33-45`) — `std::map`, so name-sorted. */
function substitution(bindings: readonly ProofTraceBinding[]): string[] {
  return bindings
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((binding) => `${INDENT}${binding.name} = kore[${term(binding.term)}]`);
}

/** Every term the tool prints goes through `strip_injections()` first. */
function term(pattern: Pattern): string {
  return kllvmText(stripInjections(pattern));
}
