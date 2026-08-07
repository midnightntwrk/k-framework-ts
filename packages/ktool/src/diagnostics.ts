/** Pure parsers for K frontend diagnostics measured at K v7.1.337. */

/** JVM exit statuses.  They describe frontend machinery, not backend failures. */
export const K_FRONTEND_EXIT_CODES = Object.freeze({
  success: 0,
  failure: 1,
  kemException: 113,
  timeout: 124,
} as const);

/** Generated Bison statuses; `1` does not distinguish scanner from parser failure. */
export const K_NATIVE_PARSER_EXIT_CODES = Object.freeze({ failure: 1, stackExhaustion: 2 } as const);

export type KDiagnosticSeverity = "error" | "warning";
export type KDiagnosticGroup =
  | "Compiler"
  | "Outer Parser"
  | "Inner Parser"
  | "Internal"
  | "Critical"
  | "Prover"
  | "wrapper"
  | "native-scanner"
  | "native-parser";

export interface KDiagnostic {
  readonly severity: KDiagnosticSeverity;
  readonly group: KDiagnosticGroup;
  readonly message: string;
  readonly source: string | null;
  readonly location: string | null;
  readonly snippet: string | null;
  /** Shell wrapper tool for wrapper-attributed failures; `null` otherwise. */
  readonly wrapperTool: "krun" | "kparse" | "kparse-gen" | "kore-print" | null;
  /** Original, unreassembled bytes for forward-compatible reporting. */
  readonly raw: string;
  /** Original physical lines, including K's optional 80-column wrapping. */
  readonly rawLines: readonly string[];
}

/**
 * Complete program-input `Inner Parser` message inventory for K v7.1.337.
 *
 * These tags are deliberately raise-site shaped, rather than consumer-shaped:
 * the latter can collapse them to lexical/syntactic/post-parse if desired,
 * without losing the distinction K actually made.  `duplicate-record-key`
 * covers both branches in `CollapseRecordProdsVisitor`, which have exactly
 * the same externally observable message grammar.  See the source entries in
 * `version.ts` for the pinned Java files.
 */
export type KInnerParserMessageTag =
  | "parse-unexpected-eof"
  | "parse-unexpected-token"
  | "scanner-unexpected-character"
  | "parsing-ambiguity"
  | "invalid-apply-priority"
  | "rewrite-immediate-child"
  | "ksequence-immediate-child"
  | "let-immediate-child"
  | "cast-immediate-child"
  | "priority-filter"
  | "left-associativity-filter"
  | "right-associativity-filter"
  | "z3-constant-sort"
  | "z3-production-sort"
  | "z3-localized-variable-sort"
  | "simplesub-lattice-term"
  | "simplesub-lattice-anonymous-variable"
  | "simplesub-lattice-named-variable"
  | "simplesub-constraint"
  | "simplesub-monomorphization"
  | "overloaded-terminator-no-least-sort"
  | "overloaded-empty-list-terminator-no-least-sort"
  | "duplicate-record-key"
  | "no-suitable-production"
  | "unknown-start-symbol";

export type KMessageClass =
  | { readonly family: "inner-parser"; readonly tag: KInnerParserMessageTag }
  | { readonly family: "native"; readonly tag: "scanner" | "parser" }
  | {
      readonly family: "outer-parser";
      readonly tag:
        | "circular-lexical-identifiers"
        | "unrecognized-lexical-identifiers"
        | "named-lexical-line-anchor"
        | "syntax";
    }
  | { readonly family: "compiler"; readonly tag: "had-parsing-errors" }
  | { readonly family: "wrapper"; readonly tag: "krun" | "kparse" | "kparse-gen" | "kore-print" }
  | { readonly kind: "unknown"; readonly raw: string };

export interface KAmbiguityAlternative {
  readonly index: number;
  readonly production: string;
  readonly term: string | null;
}

const JVM = /^\[(Error|Warning)\] (Compiler|Outer Parser|Inner Parser|Internal|Critical|Prover):\s?(.*)$/u;
const WRAPPER = /^\[Error\] (krun|kparse|kparse-gen|kore-print):\s?(.*)$/u;
const SCANNER = /^(\d+):(\d+):(\d+):(\d+):syntax error:\s*(.*)$/u;
const PARSER = /^(.*):(\d+):(\d+):(\d+):(\d+):(syntax error,.*)$/u;
const JVM_GROUPS = ["Compiler", "Outer Parser", "Inner Parser", "Internal", "Critical", "Prover"] as const;
const WRAPPER_TOOLS = ["krun", "kparse", "kparse-gen", "kore-print"] as const;

/**
 * Read the JVM envelope, K shell-wrapper failure line, and generated-parser
 * scanner/parser lines. Unknown text is intentionally ignored rather than
 * manufactured into a diagnostic.
 */
export function parseKDiagnostics(text: string): readonly KDiagnostic[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const result: KDiagnostic[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const jvm = JVM.exec(line);
    if (jvm !== null) {
      const group = diagnosticGroup(jvm[2] ?? "");
      if (group === undefined) continue;
      const body: string[] = [jvm[3] ?? ""];
      let source: string | null = null;
      let location: string | null = null;
      let snippet: string | null = null;
      let end = i;
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? "";
        if (JVM.test(next) || WRAPPER.test(next) || SCANNER.test(next) || PARSER.test(next)) break;
        end = j;
        if (next.startsWith("\tSource(")) source = next.slice("\tSource(".length, -1);
        else if (next.startsWith("\tLocation(")) location = next.slice("\tLocation(".length, -1);
        else if (next.startsWith("\t")) snippet = snippet === null ? next.slice(1) : `${snippet}\n${next.slice(1)}`;
        else if (next !== "") body.push(next);
      }
      const rawLines = lines.slice(i, end + 1);
      const raw = rawLines.join("\n");
      result.push({
        severity: jvm[1] === "Warning" ? "warning" : "error",
        group,
        message: reassemble(body),
        source,
        location,
        snippet,
        wrapperTool: null,
        raw,
        rawLines,
      });
      i = end;
      continue;
    }
    const wrapper = WRAPPER.exec(line);
    if (wrapper !== null) {
      const wrapperTool = wrapperDiagnosticTool(wrapper[1] ?? "");
      if (wrapperTool === undefined) continue;
      result.push({
        severity: "error",
        group: "wrapper",
        message: wrapper[2] ?? "",
        source: null,
        location: null,
        snippet: null,
        wrapperTool,
        raw: line,
        rawLines: [line],
      });
      continue;
    }
    const scanner = SCANNER.exec(line);
    if (scanner !== null) {
      result.push({
        severity: "error",
        group: "native-scanner",
        message: scanner[5] ?? "",
        source: null,
        location: `${scanner[1]}:${scanner[2]}:${scanner[3]}:${scanner[4]}`,
        snippet: null,
        wrapperTool: null,
        raw: line,
        rawLines: [line],
      });
      continue;
    }
    const parser = PARSER.exec(line);
    if (parser !== null) {
      result.push({
        severity: "error",
        group: "native-parser",
        message: parser[6] ?? "",
        source: parser[1] ?? null,
        location: `${parser[2]}:${parser[3]}:${parser[4]}:${parser[5]}`,
        snippet: null,
        wrapperTool: null,
        raw: line,
        rawLines: [line],
      });
    }
  }
  return result;
}

/** Classify conservatively; a new K message remains raw-preserving `unknown`. */
export function classifyKDiagnostic(diagnostic: KDiagnostic): KMessageClass {
  const { message } = diagnostic;
  if (diagnostic.group === "native-scanner") return { family: "native", tag: "scanner" };
  if (diagnostic.group === "native-parser") return { family: "native", tag: "parser" };
  if (diagnostic.group === "wrapper" && diagnostic.wrapperTool !== null)
    return { family: "wrapper", tag: diagnostic.wrapperTool };
  if (diagnostic.group === "Outer Parser") {
    if (message.startsWith("Circular dependency between lexical identifiers:"))
      return { family: "outer-parser", tag: "circular-lexical-identifiers" };
    if (message.startsWith("Unrecognized lexical identifiers in regular expression:"))
      return { family: "outer-parser", tag: "unrecognized-lexical-identifiers" };
    if (message === "Named lexical syntax cannot contain line anchors.")
      return { family: "outer-parser", tag: "named-lexical-line-anchor" };
    if (message.startsWith("Encountered ")) return { family: "outer-parser", tag: "syntax" };
    return { kind: "unknown", raw: diagnostic.raw };
  }
  if (diagnostic.group === "Compiler" && /^Had \d+ parsing errors\.$/u.test(message))
    return { family: "compiler", tag: "had-parsing-errors" };
  if (diagnostic.group === "Inner Parser") return classifyInnerParser(message, diagnostic.raw);
  return { kind: "unknown", raw: diagnostic.raw };
}

function classifyInnerParser(message: string, raw: string): KMessageClass {
  if (message.startsWith("Parse error: unexpected end of file")) return inner("parse-unexpected-eof");
  if (message.startsWith("Parse error: unexpected token")) return inner("parse-unexpected-token");
  if (message.startsWith("Scanner error: unexpected character sequence '"))
    return inner("scanner-unexpected-character");
  if (message.startsWith("Parsing ambiguity.")) return inner("parsing-ambiguity");
  if (message.startsWith("Invalid applyPriority attribute value: ")) return inner("invalid-apply-priority");
  if (message.startsWith("Rewrite is not allowed to be an immediate child of "))
    return inner("rewrite-immediate-child");
  if (message.startsWith("~> is not allowed to be an immediate child of ")) return inner("ksequence-immediate-child");
  if (message.startsWith("#let is not allowed to be an immediate child of ")) return inner("let-immediate-child");
  if (/ is not allowed to be an immediate child of cast\./u.test(message)) return inner("cast-immediate-child");
  if (message.startsWith("Priority filter exception. Cannot use ")) return inner("priority-filter");
  if (message.startsWith("Associativity filter exception. Cannot use "))
    return inner(
      message.includes(" immediate left child ") ? "left-associativity-filter" : "right-associativity-filter",
    );
  if (/^Unexpected sort .+ for term .+\. Expected [^:]+\.$/u.test(message))
    return inner(message.includes("parsed as production") ? "z3-production-sort" : "z3-constant-sort");
  if (/^Unexpected sort .+ for variable .+\. Expected: /u.test(message)) return inner("z3-localized-variable-sort");
  if (message.startsWith("Sort of variable inferred as ")) return inner("simplesub-lattice-anonymous-variable");
  if (/^Sort of \S+ inferred as /u.test(message)) return inner("simplesub-lattice-named-variable");
  if (message.startsWith("Sort inferred as ")) return inner("simplesub-lattice-term");
  if (/^Unexpected sort .+ for term parsed as production .+\. Expected: .+$/u.test(message))
    return inner("simplesub-constraint");
  if (message.startsWith("Term is not well-sorted due to monomorphization failure."))
    return inner("simplesub-monomorphization");
  if (message.startsWith("List terminator for overloaded term does not have a least sort."))
    return inner("overloaded-empty-list-terminator-no-least-sort");
  if (message.startsWith("Overloaded term does not have a least sort."))
    return inner("overloaded-terminator-no-least-sort");
  if (message.startsWith("Duplicate record production key: ")) return inner("duplicate-record-key");
  if (message.startsWith("Could not find any suitable productions for label ")) return inner("no-suitable-production");
  if (message.startsWith("Could not find start symbol: ")) return inner("unknown-start-symbol");
  return { kind: "unknown", raw };
}

function inner(tag: KInnerParserMessageTag): KMessageClass {
  return { family: "inner-parser", tag };
}

function diagnosticGroup(value: string): KDiagnosticGroup | undefined {
  return JVM_GROUPS.find((group) => group === value);
}

function wrapperDiagnosticTool(value: string): KDiagnostic["wrapperTool"] | undefined {
  return WRAPPER_TOOLS.find((tool) => tool === value);
}

/** Extract numbered alternatives from a recognised ambiguity diagnostic. */
export function parseAmbiguity(diagnostic: KDiagnostic): readonly KAmbiguityAlternative[] {
  if (!diagnostic.message.startsWith("Parsing ambiguity.")) return [];
  const result: KAmbiguityAlternative[] = [];
  const matches = [...diagnostic.message.matchAll(/(?:^|\n)(\d+):\s*(.*)(?:\n {4}(.*))?/gu)];
  for (const match of matches) {
    result.push({ index: Number(match[1]), production: match[2] ?? "", term: match[3] ?? null });
  }
  return result;
}

function reassemble(lines: readonly string[]): string {
  // K's fixed-width wrapper breaks only at spaces. An ambiguity has its own
  // line grammar, so joining every physical line would corrupt alternatives:
  // `N: syntax` begins a production, four spaces begin its term, and every
  // other body line is the preceding structural line's wrapped continuation.
  // This deliberately keys on grammar, never a guessed 80-column width.
  if (lines[0]?.startsWith("Parsing ambiguity.") === true) {
    const logical: string[] = [];
    for (const physical of lines) {
      const structural =
        logical.length === 0 || /^\d+:\s/u.test(physical) || /^ {4}\S/u.test(physical) || physical === "";
      if (structural) logical.push(physical);
      else {
        const previous = logical.length - 1;
        logical[previous] = `${logical[previous] ?? ""} ${physical.trim()}`.trimEnd();
      }
    }
    return logical.join("\n").trim();
  }
  // Preserve spacing inside a source message: it is observable grammar (for
  // example PriorityVisitor intentionally emits four spaces before its scope
  // advice). Only physical wrapper boundaries are normalised to one space.
  return lines
    .map((line) => line.trim())
    .join(" ")
    .trim();
}
