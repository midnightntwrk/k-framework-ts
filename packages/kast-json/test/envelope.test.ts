import { describe, expect, test } from "bun:test";
import {
  KAST_FORMAT,
  KAST_VERSIONS,
  K_RELEASE,
  openEnvelope,
  openEnvelopeText,
  TRANSCRIBED_FROM,
} from "../src/index.ts";

const wrap = (term: unknown, version: unknown = 3): string => JSON.stringify({ format: "KAST", version, term });

describe("the versions this package supports", () => {
  test("are exactly KAST v3 and v4, newest transcription at K v7.1.337", () => {
    expect(KAST_FORMAT).toBe("KAST");
    expect([...KAST_VERSIONS]).toEqual([3, 4]);
    expect(K_RELEASE).toBe("v7.1.337");
  });

  test("the manifest records one revision per byte-distinct source pair, oldest first", () => {
    expect(TRANSCRIBED_FROM.map((r) => r.kastVersion)).toEqual([3, 3, 4]);
    expect(TRANSCRIBED_FROM.map((r) => r.recordedAt)).toEqual(["v7.1.191", "v7.1.296", "v7.1.337"]);
    // The revisions must differ pairwise in at least one hash, or `check-k`
    // could report two matches at once.
    const pairs = TRANSCRIBED_FROM.map((r) => `${r.toJson.sha256}:${r.jsonParser.sha256}`);
    expect(new Set(pairs).size).toBe(TRANSCRIBED_FROM.length);
    // v4 first shipped in v7.1.320 — not v7.1.337, which is merely where the
    // hashes were recorded.
    expect(TRANSCRIBED_FROM[2].firstRelease).toBe("v7.1.320");
  });
});

describe("openEnvelope", () => {
  test("accepts a well-formed v3 envelope and yields its term, reporting the version", () => {
    const result = openEnvelope({ format: "KAST", version: 3, term: { node: "KToken" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe(3);
      expect(result.term).toEqual({ node: "KToken" });
    }
  });

  test("accepts a well-formed v4 envelope and reports version 4", () => {
    const result = openEnvelope({ format: "KAST", version: 4, term: { node: "KToken" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.version).toBe(4);
  });

  test("accepts a null term — presence is checked, contents are not", () => {
    const result = openEnvelope({ format: "KAST", version: 3, term: null });
    expect(result.ok).toBe(true);
  });

  test("ignores unknown envelope keys", () => {
    const result = openEnvelope({ format: "KAST", version: 3, term: 1, extra: "ignored" });
    expect(result.ok).toBe(true);
  });

  test("rejects a non-object top level", () => {
    for (const bad of [42, "KAST", null, [1, 2, 3]]) {
      const result = openEnvelope(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.kind).toBe("not-an-object");
    }
  });

  test("names every missing required field", () => {
    const result = openEnvelope({ format: "KAST" });
    expect(result.ok).toBe(false);
    if (!result.ok && result.problem.kind === "missing-fields") {
      expect(result.problem.missing).toEqual(["version", "term"]);
      expect(result.problem.message).toContain("version, term");
    } else {
      throw new Error("expected missing-fields");
    }
  });

  test("rejects a non-KAST format, reporting what it found", () => {
    const result = openEnvelope({ format: "KORE", version: 3, term: {} });
    expect(result.ok).toBe(false);
    if (!result.ok && result.problem.kind === "wrong-format") {
      expect(result.problem.format).toBe("KORE");
      expect(result.problem.message).toContain("KORE");
    } else {
      throw new Error("expected wrong-format");
    }
  });

  test("an accept list of [3] restores the strict v3-only behaviour", () => {
    // The pre-0.2.0 contract, now an opt-in: a v4 document is refused loudly
    // rather than read, because a lenient read would silently misinterpret
    // every parametric sort.
    const result = openEnvelope({ format: "KAST", version: 4, term: {} }, [3]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.problem.kind === "wrong-version") {
      expect(result.problem.version).toBe(4);
      expect(result.problem.accepted).toEqual([3]);
      expect(result.problem.message).toContain("3");
    } else {
      throw new Error("expected wrong-version");
    }
  });

  test("an accept list of [4] refuses a v3 document the same way", () => {
    const result = openEnvelope({ format: "KAST", version: 3, term: {} }, [4]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("wrong-version");
  });

  test("rejects versions this package does not speak, including non-numbers", () => {
    for (const version of [1, 2, 5, "3", "4", null, 3.5]) {
      const result = openEnvelope({ format: "KAST", version, term: {} });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.kind).toBe("wrong-version");
    }
  });

  test("checks format before version, so a non-KAST v5 blames the format", () => {
    const result = openEnvelope({ format: "NOTKAST", version: 5, term: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("wrong-format");
  });
});

describe("openEnvelopeText", () => {
  test("reports invalid JSON as not-json rather than throwing", () => {
    const result = openEnvelopeText("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("not-json");
  });

  test("reports empty input as not-json", () => {
    expect(openEnvelopeText("").ok).toBe(false);
  });

  test("round-trips a wrapped term at either version", () => {
    expect(openEnvelopeText(wrap({ node: "KSequence", arity: 0, items: [] })).ok).toBe(true);
    expect(openEnvelopeText(wrap({ node: "KSequence", arity: 0, items: [] }, 4)).ok).toBe(true);
  });

  test("passes its accept list through", () => {
    expect(openEnvelopeText(wrap({}, 4), [3]).ok).toBe(false);
  });
});
