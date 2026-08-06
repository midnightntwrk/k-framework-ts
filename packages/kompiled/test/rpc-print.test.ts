/**
 * The `pyk-rpc-print/` corpus — eight JSON-RPC messages and their
 * `.pretty.golden` outputs, vendored from
 * `pyk/src/tests/integration/test-data/`.
 *
 * # What this corpus is, and what it needs
 *
 * `pyk rpc-print` (`pyk/src/pyk/__main__.py:136-210`) walks a JSON-RPC envelope,
 * prints its scalar fields, and then — for every `state` it finds —
 * `printer.kore_to_kast(...)` followed by `printer.pretty_print(..., sort_collections=True)`.
 * The goldens therefore have **two halves**: header lines derived from the JSON
 * with no term algebra at all, and a `State:` block that requires a full
 * KORE `Pattern` → KAST `KInner` conversion.
 *
 * That conversion is `konvert`, which this package deliberately does not depend
 * on *at runtime*: it is a *sibling*, reached through the injected
 * `KompiledDefinitionOptions.koreToKast` (`kompiled.ts:114-126`).  A test is
 * the one place the sibling may be named, so `@kframework-ts/konvert` is a
 * **devDependency** here and `koreToKast(definition, pattern)`
 * (`konvert/src/convert.ts:403`) is what gets injected — the production edge
 * stays a function, and the corpus stops being half-checked.  So:
 *
 * - the **header halves are asserted** against the JSON, byte for byte, which
 *   is what keeps the pairing between each `.json` and its `.pretty.golden`
 *   honest and stops the corpus rotting;
 * - every `state` is asserted to be **valid KORE-JSON** that
 *   `@kframework-ts/kore` parses — so the input half of the pipeline is real;
 * - the injected-converter **plumbing** is exercised with a stub;
 * - `exec_rpc_print` is **transcribed** ({@link rpcPrint}) and run over the
 *   `imp-haskell-kompiled` fixture — the same `kompile imp.k --backend haskell`
 *   `TestRpcPrint` itself uses (`test_pyk.py:101-103`) — and the result is
 *   compared to the whole golden, `State:` blocks included.
 *
 * # The two comparisons, and why there are two
 *
 * Upstream's oracle is a **set of stripped lines** (`test_pyk.py:129-131`):
 *
 * ```python
 * expected_lines = {line.strip() for line in expected_file.read_text().splitlines()}
 * actual_lines = {line.strip() for line in actual_file.read_text().splitlines()}
 * assert actual_lines == expected_lines
 * ```
 *
 * It is that weak for one reason: `pretty_print_request` iterates
 * `set(request_params.keys()).difference(['state'])` (`__main__.py:145-147`), a
 * Python `set`, so the parameter lines of the two *request* files come out in
 * an order pyk does not control — `imp-execute-request.pretty.golden` commits
 * `terminal-rules`, `cut-point-rules`, `max-depth`, and this transcription (JSON
 * key order) produces `max-depth`, `cut-point-rules`, `terminal-rules`.  The set
 * also swallows the goldens' trailing-newline disagreement: `rpc-print` writes
 * `'\n'.join(output_buffer)` with no terminator (`__main__.py:211-214`), and
 * three of the eight goldens were committed with one anyway
 * ({@link GOLDENS_WITH_TRAILING_NEWLINE}).
 *
 * So both are asserted.  Upstream's set oracle for all eight, transcribed
 * exactly — `splitlines()`, not `split('\n')`, which is what drops that trailing
 * newline rather than turning it into an empty line.  Then, on top, the strictly
 * stronger claim upstream's own oracle cannot make: the six **response** files
 * are byte-for-byte identical to their goldens (bar that terminator, stripped
 * by {@link goldenBody} and pinned by its own test), and for the two
 * **request** files everything from `State:` onward is byte-for-byte identical
 * while only the parameter block is compared as a set.  Nothing about the
 * `State:` blocks is ordering-dependent, so nothing is bought by asserting them
 * loosely — and a set comparison is blind to *duplicates*, which this corpus
 * has in quantity: `imp-execute-branching-response` prints the same
 * configuration three times (state plus two next states), and upstream's oracle
 * would not notice one of them going missing.
 *
 * # `PrettyPrinter`, not `prettyPrint`
 *
 * The goldens are `KPrint.pretty_print` output, and `KPrint.pretty_print`
 * delegates to `PrettyPrinter` (`pretty.py:44-101`) — the symbol-table printer
 * that reads neither `format` nor `bracket`.  `KompiledDefinition.prettyPrint`
 * deliberately delegates to `Formatter` instead (`kompiled.ts:425-459`), which
 * *does* read them, and on this very corpus the difference is not cosmetic:
 * IMP's `<generatedTop>` production carries `format: "%2"`, so `Formatter`
 * correctly prints the `<T>` cell **alone** while the golden shows the
 * `<generatedTop>`/`<generatedCounter>` wrapper; and `PrettyPrinter`'s
 * space-joined terminals give `int k , sum , .Ids ;` where `Formatter` gives
 * `int k, sum, .Ids;` on its own line.  Both printers are right about different
 * questions.  This file asks pyk's, so it uses `@kframework-ts/kast`'s
 * `PrettyPrinter` with the two pre-passes `rpc-print` asks for: `unalias`
 * (pyk's default) and `sort_collections=True` (`__main__.py:149,163,168,195`).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { kvariable, PrettyPrinter } from "@kframework-ts/kast";
import { koreToKast } from "@kframework-ts/konvert";
import { decodeKoreJson, type Pattern } from "@kframework-ts/kore";

import { loadKompiledDefinition } from "../src/fs.ts";
import { KompiledDefinition } from "../src/kompiled.ts";
import { parseKompiledLayout } from "../src/layout.ts";
import { IMP_HASKELL, UPSTREAM } from "./fixtures.ts";

const CORPUS = join(UPSTREAM, "pyk-rpc-print");

const STEMS = [
  "imp-execute-request",
  "imp-execute-depth-bound-response",
  "imp-execute-terminal-rule-response",
  "imp-execute-cut-point-rule-response",
  "imp-execute-branching-response",
  "imp-execute-stuck-response",
  "imp-simplify-request",
  "imp-simplify-response",
] as const;

/**
 * The split upstream's file names already encode, and which the tests below
 * branch on: a `-request` carries `method` and prints its parameters from an
 * unordered `set`, a `-response` does not.  `the naming is the shape` asserts
 * the two agree, so this stays a fact about the corpus rather than a guess.
 */
const REQUEST_STEMS = STEMS.filter((stem) => stem.endsWith("-request"));
const RESPONSE_STEMS = STEMS.filter((stem) => stem.endsWith("-response"));

interface Envelope {
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
}

const readJson = (stem: string): Envelope => {
  // `JSON.parse` returns `any`; widening to `unknown` first keeps the
  // assertion a *widening* one, and the shape is upstream's own committed
  // fixture, checked by the assertions below.
  const parsed = JSON.parse(readFileSync(join(CORPUS, `${stem}.json`), "utf8")) as unknown;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return parsed as Envelope;
};
const readGolden = (stem: string): string => readFileSync(join(CORPUS, `${stem}.pretty.golden`), "utf8");

/**
 * The three goldens upstream committed with a trailing newline.
 *
 * `exec_rpc_print` writes `'\n'.join(output_buffer)` and nothing after it
 * (`__main__.py:211-214`), so **no** golden should end in one; these three do,
 * and the other five do not.  It is a property of the committed bytes, not of
 * the command, and there is no pattern to it — two requests and one response.
 * Recorded as data and pinned by its own test so that the byte comparison can
 * strip exactly this much and no more: a golden that quietly grew or lost a
 * terminator would fail that test rather than be normalised away.
 */
const GOLDENS_WITH_TRAILING_NEWLINE: ReadonlySet<(typeof STEMS)[number]> = new Set([
  "imp-execute-request",
  "imp-simplify-request",
  "imp-simplify-response",
]);

/** A golden as `rpc-print` wrote it — see {@link GOLDENS_WITH_TRAILING_NEWLINE}. */
const goldenBody = (stem: string): string => {
  const text = readGolden(stem);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
};

/**
 * The KORE-JSON document inside an RPC `state`, whichever of the two shapes it
 * came in.
 *
 * `simplify` and the requests carry the envelope directly — pyk calls
 * `kore_term(...)` on it (`__main__.py:147,193`).  An `execute` response's
 * `state` is one level deeper: it deserialises to a `State` whose `.kore` is
 * the envelope (`__main__.py:161`), which on the wire is `{"term": {...}}`.
 */
function koreEnvelopeOf(state: unknown): unknown {
  if (typeof state !== "object" || state === null) return state;
  // The narrowing above establishes it is an object; TypeScript has no way to
  // say "an object, indexed by string" without an assertion.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const record = state as Record<string, unknown>;
  return record["format"] === "KORE" ? record : record["term"];
}

/**
 * An RPC field as pyk's f-string would render it — Python `str()`, which for
 * everything but a `str` is `repr()`.
 *
 * `exec_rpc_print` interpolates JSON-decoded values straight into f-strings
 * (`__main__.py:147,154-156,165`), so `'IMP'` prints as `IMP` but
 * `['IMP.stop']` prints as `['IMP.stop']`, quotes and all.  The corpus carries
 * strings, ints and lists of strings and nothing else; anything outside that is
 * thrown on rather than guessed at, because a silently plausible-but-wrong
 * rendering is exactly what a golden test exists to catch.
 */
function asText(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}

/** Python `repr()`, over the JSON value space this corpus uses. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  // Only ASCII without quotes or backslashes appears here, so `'...'` is the
  // whole of CPython's string repr for it.
  if (typeof value === "string") return `'${value}'`;
  if (Array.isArray(value)) return `[${value.map((item) => pyRepr(item)).join(", ")}]`;
  throw new TypeError(`No Python repr transcribed for ${JSON.stringify(value)}`);
}

/**
 * Python `str.splitlines()` — the function upstream's oracle splits with
 * (`test_pyk.py:129-130`).
 *
 * The difference from `split('\n')` is the whole reason it is spelled out: a
 * trailing newline yields **no** final empty line, which is what lets a golden
 * that ends in `\n` compare equal to `'\n'.join(...)` output that does not.
 * The corpus contains no other line terminator, so no other is handled.
 */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Upstream's oracle: `{line.strip() for line in text.splitlines()}`. */
function strippedLineSet(text: string): Set<string> {
  return new Set(splitLines(text).map((line) => line.trim()));
}

/**
 * A **request**'s three fixed lines, its floating parameter block, and
 * everything from `State:` on.
 *
 * `JSON RPC request` / `id:` / `Method:` are positional
 * (`__main__.py:152-154`); the parameter lines after them come out of a Python
 * `set` and only their *contents* are defined; `State:` and the term below it
 * are positional again.  Splitting on the literal `State:` line is safe because
 * the printer indents every line of the term it emits, so no line of a cell can
 * collide with it.
 */
function splitAtState(lines: readonly string[]): {
  preamble: readonly string[];
  params: readonly string[];
  state: readonly string[];
} {
  const at = lines.indexOf("State:");
  return { preamble: lines.slice(0, 3), params: lines.slice(3, at), state: lines.slice(at) };
}

/** Every `state` a message carries, in the order `exec_rpc_print` reaches them. */
function statesOf(envelope: Envelope): readonly unknown[] {
  const states: unknown[] = [];
  const state = envelope.params?.["state"] ?? envelope.result?.["state"];
  if (state !== undefined) states.push(koreEnvelopeOf(state));
  const next = envelope.result?.["next-states"];
  if (Array.isArray(next)) for (const s of next) states.push(koreEnvelopeOf(s));
  return states;
}

describe("the corpus is intact", () => {
  test("16 files — 8 messages, 8 goldens — exactly as upstream commits them", () => {
    const files = readdirSync(CORPUS).toSorted();
    expect(files.length).toBe(16);
    expect(files.filter((f) => f.endsWith(".json")).length).toBe(8);
    expect(files.filter((f) => f.endsWith(".pretty.golden")).length).toBe(8);
    expect(new Set(STEMS).size).toBe(8);
  });
});

describe("header lines — the half that needs no conversion", () => {
  // `exec_rpc_print` writes these from the JSON directly
  // (`__main__.py:152-210`), so they can be checked without a converter, and
  // checking them is what keeps each golden paired with its message.
  for (const stem of STEMS) {
    test(stem, () => {
      const envelope = readJson(stem);
      const lines = readGolden(stem).split("\n");
      const header = lines.slice(0, lines.indexOf("State:"));

      if (envelope.method !== undefined) {
        expect(header[0]).toBe("JSON RPC request");
        expect(header[1]).toBe(`id: ${asText(envelope.id)}`);
        expect(header[2]).toBe(`Method: ${envelope.method}`);
        // The remaining request lines are `f'{key}: {value!r}'` over a Python
        // dict; the set, not the order, is what upstream compares.
        return;
      }

      const result = envelope.result ?? {};
      expect(header[0]).toBe("JSON RPC Response");
      expect(header[1]).toBe(`id: ${asText(envelope.id)}`);
      if (Object.keys(result).length === 1 && "state" in result) {
        expect(header[2]).toBe("Method: simplify");
        return;
      }
      expect(header[2]).toBe("Method: execute");
      expect(header[3]).toBe(`Depth: ${asText(result["depth"])}`);
      expect(header[4]).toBe(`Stop reason: ${asText(result["reason"])}`);
      const rest = header.slice(5);
      if (result["rule"] !== undefined) {
        expect(rest.shift()).toBe(`Stop rule: ${asText(result["rule"])}`);
      }
      const nextStates = result["next-states"];
      expect(rest.shift()).toBe(`Number of next states: ${Array.isArray(nextStates) ? nextStates.length : 0}`);
    });
  }
});

describe("every state is real KORE-JSON", () => {
  for (const stem of STEMS) {
    test(stem, () => {
      const states = statesOf(readJson(stem));
      expect(states.length).toBeGreaterThan(0);
      for (const state of states) {
        const decoded = decodeKoreJson(state);
        expect(decoded.term.tag).toBe("App");
      }
    });
  }
});

describe("the injected converter is the whole of the konvert edge", () => {
  test("a stub converter receives the parsed Pattern and its result is returned", () => {
    // The shape of the eventual test: parse the state as KORE, hand it to the
    // injected converter, print the result.  Everything but the converter is
    // in place.
    const state = statesOf(readJson("imp-simplify-response"))[0];
    const pattern: Pattern = decodeKoreJson(state).term;

    const seen: Pattern[] = [];
    const kompiled = new KompiledDefinition(
      {
        path: "<memory>",
        layout: parseKompiledLayout({
          mainModule: "IMP",
          mainSyntaxModule: "IMP-SYNTAX",
          backend: "haskell",
          timestampMtimeMs: 0,
        }),
        read: () => undefined,
      },
      {
        koreToKast: (p) => {
          seen.push(p);
          return kvariable("CONVERTED");
        },
      },
    );

    expect(kompiled.koreToKast(pattern)).toEqual(kvariable("CONVERTED"));
    expect(seen).toEqual([pattern]);
  });
});

//////////////////////////////
// `pyk rpc-print`, transcribed
//////////////////////////////

/**
 * The `imp-haskell-kompiled` fixture with `konvert`'s converter injected, and
 * the `PrettyPrinter` the goldens were made with.
 *
 * Built once and memoised: `compiled.json` is IMP's whole KAST definition, and
 * `PrettyPrinter` builds a symbol table over every module in it.  Neither is
 * worth redoing sixteen times.
 *
 * The two-liner is the knot the injection point ties.  `koreToKast` needs the
 * `KDefinition`, which is a *getter on the object being constructed*, so the
 * closure has to reach the binding it is being passed into.  It is only ever
 * called from {@link KompiledDefinition.koreToKast}, long after `await`
 * returns, so the reference is always resolved.
 */
let imp: Promise<{ kompiled: KompiledDefinition; printer: PrettyPrinter }> | undefined;
function impHaskell(): Promise<{ kompiled: KompiledDefinition; printer: PrettyPrinter }> {
  imp ??= (async () => {
    const kompiled: KompiledDefinition = await loadKompiledDefinition(IMP_HASKELL, {
      koreToKast: (pattern) => koreToKast(kompiled.definition, pattern),
    });
    // `unalias` defaults to `true` in both pyk and here, so only the pass
    // `rpc-print` opts into needs naming.
    return { kompiled, printer: new PrettyPrinter(kompiled.definition, { sortCollections: true }) };
  })();
  return imp;
}

/**
 * `exec_rpc_print` (`__main__.py:136-214`), minus the CLI around it.
 *
 * The transcription is line for line, including the two things a reader would
 * otherwise "fix": parameters are emitted in the order the JSON object gives
 * them (pyk's `set` order is not reproducible and not meant to be — see the
 * module docstring), and `Stop rule:` is gated on the *reason*
 * (`__main__.py:157-159`), not on the presence of a `rule` field.
 *
 * The `add-module` request and response branches (`__main__.py:169-173,
 * 197-200`) are absent because the corpus has neither; they need no term
 * algebra and would be untested code.
 */
function rpcPrint(kompiled: KompiledDefinition, printer: PrettyPrinter, envelope: Envelope): string {
  const out: string[] = [];
  const state = (raw: unknown): string => printer.print(kompiled.koreToKast(decodeKoreJson(koreEnvelopeOf(raw)).term));

  if (envelope.method !== undefined) {
    const params = envelope.params ?? {};
    out.push("JSON RPC request", `id: ${asText(envelope.id)}`, `Method: ${envelope.method}`);
    for (const key of Object.keys(params)) {
      if (key !== "state") out.push(`${key}: ${asText(params[key])}`);
    }
    out.push("State:", state(params["state"]));
    return out.join("\n");
  }

  const result = envelope.result ?? {};
  out.push("JSON RPC Response", `id: ${asText(envelope.id)}`);
  if (Object.keys(result).length === 1 && "state" in result) {
    out.push("Method: simplify", "State:", state(result["state"]));
    return out.join("\n");
  }

  out.push("Method: execute", `Depth: ${asText(result["depth"])}`, `Stop reason: ${asText(result["reason"])}`);
  const reason = result["reason"];
  if (reason === "terminal-rule" || reason === "cut-point-rule") {
    out.push(`Stop rule: ${asText(result["rule"])}`);
  }
  const nextStates = result["next-states"];
  out.push(
    `Number of next states: ${Array.isArray(nextStates) ? nextStates.length : 0}`,
    "State:",
    state(result["state"]),
  );
  if (Array.isArray(nextStates)) {
    for (const [index, next] of nextStates.entries()) out.push(`Next state #${index}:`, state(next));
  }
  return out.join("\n");
}

describe("the State: blocks", () => {
  test("the naming is the shape: `-request` iff the envelope carries a method", () => {
    expect(REQUEST_STEMS.filter((stem) => readJson(stem).method === undefined)).toEqual([]);
    expect(RESPONSE_STEMS.filter((stem) => readJson(stem).method !== undefined)).toEqual([]);
    expect(REQUEST_STEMS.length + RESPONSE_STEMS.length).toBe(STEMS.length);
  });

  describe("upstream's oracle — the set of stripped lines (test_pyk.py:129-131)", () => {
    for (const stem of STEMS) {
      test(stem, async () => {
        const { kompiled, printer } = await impHaskell();
        expect(strippedLineSet(rpcPrint(kompiled, printer, readJson(stem)))).toEqual(strippedLineSet(readGolden(stem)));
      });
    }
  });

  describe("byte for byte — the claim upstream's own oracle cannot make", () => {
    test("exactly three goldens carry a trailing newline `rpc-print` never wrote", () => {
      expect(new Set(STEMS.filter((stem) => readGolden(stem).endsWith("\n")))).toEqual(
        new Set(GOLDENS_WITH_TRAILING_NEWLINE),
      );
    });

    for (const stem of RESPONSE_STEMS) {
      // A response has no unordered anything: every line is positional, so the
      // only allowance is the terminator pinned above.
      test(stem, async () => {
        const { kompiled, printer } = await impHaskell();
        expect(rpcPrint(kompiled, printer, readJson(stem))).toBe(goldenBody(stem));
      });
    }

    for (const stem of REQUEST_STEMS) {
      // A request floats in exactly two ways, and neither touches the term: the
      // parameter block's order, and a trailing newline the goldens have and
      // `rpc-print` does not write.  Everything else — `State:` included — is
      // held to the byte.
      test(`${stem} (parameter block as a set, State: block to the byte)`, async () => {
        const { kompiled, printer } = await impHaskell();
        const actual = splitLines(rpcPrint(kompiled, printer, readJson(stem)));
        const golden = splitLines(readGolden(stem));
        expect(golden.indexOf("State:")).toBeGreaterThan(3);

        const a = splitAtState(actual);
        const g = splitAtState(golden);

        expect(a.preamble).toEqual(g.preamble);
        expect(new Set(a.params)).toEqual(new Set(g.params));
        expect(a.params.length).toBe(g.params.length);
        expect(a.state).toEqual(g.state);
      });
    }
  });
});
