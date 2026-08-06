import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { KCFG } from "../src/index.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "pinned-pyk-kcfg.json");
const FIXTURE_SHA256 = "7353446368d1c16ca67631afdf57f4749e207d103b92e1e8257ff2cc51d11daa";

function fixtureText(): string {
  return readFileSync(FIXTURE, "utf8");
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(text: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error("Expected a JSON object");
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isJsonObject(value))
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  const primitive = JSON.stringify(value);
  if (primitive === undefined) throw new Error("Expected a JSON value");
  return primitive;
}

describe("pinned pyk KCFG fixture", () => {
  test("is the recorded pyk-generated document", () => {
    expect(createHash("sha256").update(fixtureText()).digest("hex")).toBe(FIXTURE_SHA256);
  });

  test("reads and structurally round-trips every pyk successor kind", () => {
    const document = jsonObject(fixtureText());
    const graph = KCFG.fromJson(fixtureText());

    expect(canonicalJson(graph.toDict())).toBe(canonicalJson(document));
    expect(canonicalJson(jsonObject(graph.toJson()))).toBe(canonicalJson(document));
    expect(graph.nodes).toHaveLength(12);
    expect(graph.next).toBe(13);
    expect(graph.node("@edge-root").id).toBe(1);
    expect(graph.node("@cover-general").id).toBe(6);
    expect(graph.node("@split-root").id).toBe(7);
    expect(graph.node(2).hasAttr("vacuous")).toBeTrue();
    expect(graph.node(5).hasAttr("stuck")).toBeTrue();
    expect(graph.node(12).hasAttr("fixture-terminal")).toBeTrue();

    const edge = graph.successor(1);
    expect(edge?.kind).toBe("edge");
    if (edge?.kind !== "edge") throw new Error("fixture edge is missing");
    expect(edge.depth).toBe(3);
    expect(edge.rules).toEqual(["EDGE-A", "EDGE-B"]);

    const merged = graph.successor(3);
    expect(merged?.kind).toBe("merged-edge");
    if (merged?.kind !== "merged-edge") throw new Error("fixture merged edge is missing");
    expect(merged.edges.map((member) => member.depth)).toEqual([5, 7]);
    expect(merged.edges.flatMap((member) => member.rules)).toEqual(["MERGED-FIRST", "MERGED-SECOND", "MERGED-THIRD"]);

    const cover = graph.successor(5);
    expect(cover?.kind).toBe("cover");
    if (cover?.kind !== "cover") throw new Error("fixture cover is missing");
    expect(cover.csubst.subst.get("COVER_VALUE")?.node).toBe("KToken");
    expect(cover.csubst.constraints).toHaveLength(1);

    const split = graph.successor(7);
    expect(split?.kind).toBe("split");
    if (split?.kind !== "split") throw new Error("fixture split is missing");
    expect(split.targets.map((branch) => branch.node.id)).toEqual([8, 9]);
    expect(split.targets.map((branch) => branch.csubst.constraints)).toSatisfy((constraints) =>
      constraints.every((branch) => branch.length === 1),
    );

    const ndbranch = graph.successor(10);
    expect(ndbranch?.kind).toBe("ndbranch");
    if (ndbranch?.kind !== "ndbranch") throw new Error("fixture ndbranch is missing");
    expect(ndbranch.targetIds).toEqual([11, 12]);
    expect(ndbranch.rules).toEqual(["ND-ONE", "ND-TWO"]);
  });
});
