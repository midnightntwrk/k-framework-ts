/**
 * The KAST envelope: `{format: "KAST", version: 3 | 4, term: ...}`.
 *
 * Both flavours of KAST JSON — the *term* flavour from `krun --output json`
 * and the *definition* flavour from `kompile --emit-json` — share this
 * envelope and differ only in what `term` holds.  Every read in this package
 * goes through `openEnvelope` first, so no decoder can ever be handed bytes
 * whose provenance was not checked.
 *
 * Transcribed from `JsonParser.parseJson` (v3 `JsonParser.java:387-404`, v4
 * `JsonParser.java:393-410`) and `JsonParser.parseJsonDef`
 * (`JsonParser.java:95-118`), which perform the identical three checks in the
 * identical order.  Where K's parser accepts exactly its own version, this
 * package accepts the versions it transcribes — each strictly under its own
 * rules — and *reports which one it read*, because the two spell `KSort`
 * incompatibly and a caller may need to know.
 */

import { KAST_FORMAT, KAST_VERSIONS, type KastVersion } from "./version.js";

/** Anything that is a JSON object (and specifically not an array or null). */
export function isRecord(u: unknown): u is Record<string, unknown> {
  return typeof u === "object" && u !== null && !Array.isArray(u);
}

/**
 * Why an envelope was refused.  Each arm is a distinct, actionable situation,
 * because "this is not KAST" and "this is KAST from a newer K" call for very
 * different responses from a caller.
 */
export type EnvelopeProblem =
  /** The bytes were not JSON at all. */
  | { readonly kind: "not-json"; readonly message: string }
  /** Valid JSON, but not a JSON object at the top level. */
  | { readonly kind: "not-an-object"; readonly message: string }
  /** One or more of `format` / `version` / `term` is missing. */
  | {
      readonly kind: "missing-fields";
      readonly message: string;
      readonly missing: readonly string[];
    }
  /** `format` is present but is not `"KAST"`. */
  | { readonly kind: "wrong-format"; readonly message: string; readonly format: unknown }
  /**
   * `format` is `"KAST"` but `version` is not one the caller accepts.
   * `version` is reported verbatim so a caller can distinguish "v5, i.e. a K
   * newer than this package" from garbage, and `accepted` records what would
   * have been taken, which matters once callers can narrow the default.
   */
  | {
      readonly kind: "wrong-version";
      readonly message: string;
      readonly version: unknown;
      readonly accepted: readonly KastVersion[];
    };

export type Envelope =
  | { readonly ok: true; readonly version: KastVersion; readonly term: unknown }
  | { readonly ok: false; readonly problem: EnvelopeProblem };

/**
 * Render an observed value for an error message.
 *
 * Deliberately never calls `String(u)`: an object would stringify to
 * `[object Object]`, which tells a reader nothing about what was actually
 * found.  `JSON.stringify` returns `undefined` for a value it cannot
 * represent (a function, a symbol), so that case is named explicitly.
 */
function show(u: unknown): string {
  if (typeof u === "string") return JSON.stringify(u);
  if (u === undefined) return "undefined";
  return JSON.stringify(u) ?? `a value of type ${typeof u}`;
}

/**
 * Check an already-parsed JSON value's envelope and hand back its `term`,
 * with the version it declared.
 *
 * `accept` narrows which versions may be read; it defaults to everything this
 * package speaks.  Passing `[3]` restores the strict single-version behaviour
 * this package had before v4 support: a v4 document then fails with one clear
 * message instead of being read.
 *
 * Note that `version` is compared strictly, by identity, against the members
 * of `accept`: a document carrying the *string* `"3"` is refused.  K writes
 * it with `JsonObjectBuilder.add(String, int)` (`ToJson.java:73`), so a
 * string here means some other producer, and being lenient would be guessing.
 */
export function openEnvelope(doc: unknown, accept: readonly KastVersion[] = KAST_VERSIONS): Envelope {
  if (!isRecord(doc)) {
    return {
      ok: false,
      problem: {
        kind: "not-an-object",
        message: `Expected a KAST JSON object at the top level, found ${Array.isArray(doc) ? "an array" : typeof doc}.`,
      },
    };
  }

  // JsonParser.java:388 checks all three keys are present before reading any.
  const missing = (["format", "version", "term"] as const).filter((k) => !(k in doc));
  if (missing.length > 0) {
    return {
      ok: false,
      problem: {
        kind: "missing-fields",
        message: `A KAST JSON document must have \`format\`, \`version\` and \`term\` fields; missing: ${missing.join(
          ", ",
        )}.`,
        missing,
      },
    };
  }

  const format = doc["format"];
  if (format !== KAST_FORMAT) {
    return {
      ok: false,
      problem: {
        kind: "wrong-format",
        message: `Only KAST format JSON can be read. Found format ${show(format)}.`,
        format,
      },
    };
  }

  const version = doc["version"];
  // Identity comparison against each accepted version — never coercion, so
  // "3" (a string) and 3.5 fail even though Number("3") === 3.
  const matched = accept.find((v) => v === version);
  if (matched === undefined) {
    return {
      ok: false,
      problem: {
        kind: "wrong-version",
        message:
          `Only KAST version${accept.length === 1 ? "" : "s"} ${accept.join(", ")} can be read here. ` +
          `Found version ${show(version)}. KAST v3 (K <= v7.1.319) and v4 (K >= v7.1.320) spell KSort ` +
          `incompatibly, so no version is ever read as another.`,
        version,
        accepted: accept,
      },
    };
  }

  return { ok: true, version: matched, term: doc["term"] };
}

/** `openEnvelope` over raw text, folding a JSON syntax error into the result. */
export function openEnvelopeText(text: string, accept: readonly KastVersion[] = KAST_VERSIONS): Envelope {
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false,
      problem: {
        kind: "not-json",
        message: `Input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  return openEnvelope(doc, accept);
}
