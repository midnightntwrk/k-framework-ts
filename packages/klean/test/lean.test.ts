import { describe, expect, test } from "bun:test";

import { indentLean, leanIdentifier, renderLeanCommand, renderLeanDeclaration, renderLeanModule } from "../src/lean.ts";

describe("Lean renderer", () => {
  test("renders imports, declarations, and exactly one final newline", () => {
    expect(
      renderLeanModule({
        imports: ["Demo.Prelude", "Demo.Sorts"],
        commands: [
          {
            tag: "axiom",
            identifier: leanIdentifier("answer"),
            signature: { type: "SortInt" },
          },
          {
            tag: "definition",
            identifier: leanIdentifier("id"),
            signature: { binders: [{ tag: "explicit", identifiers: ["x"], type: "α" }], type: "α" },
            value: { tag: "simple", term: "x" },
          },
        ],
      }),
    ).toBe("import Demo.Prelude\nimport Demo.Sorts\n\naxiom answer : SortInt\n\ndef id (x : α) : α := x\n");
    expect(renderLeanModule({})).toBe("");
  });

  test("renders structure values, alternatives, modifiers, and mutual blocks", () => {
    expect(
      renderLeanDeclaration({
        tag: "definition",
        identifier: leanIdentifier("lookup"),
        modifiers: { attributes: [{ text: "simp", kind: "local" }], noncomputable: true },
        value: {
          tag: "alternatives",
          alternatives: [
            { patterns: ["[]"], rhs: "none" },
            { patterns: ["x :: _"], rhs: "some x" },
          ],
        },
      }),
    ).toBe("@[local simp] noncomputable def lookup\n  | [] => none\n  | x :: _ => some x");
    expect(
      renderLeanCommand({
        tag: "mutual",
        commands: [
          { tag: "inductive", identifier: leanIdentifier("Even"), constructors: [{ identifier: "zero" }] },
          { tag: "inductive", identifier: leanIdentifier("Odd"), constructors: [{ identifier: "one" }] },
        ],
      }),
    ).toBe("mutual\n  inductive Even where\n    | zero\n\n  inductive Odd where\n    | one\nend");
  });

  test("preserves blank lines while indenting", () => {
    expect(indentLean("first\n\nsecond", 2)).toBe("  first\n\n  second");
  });
});
