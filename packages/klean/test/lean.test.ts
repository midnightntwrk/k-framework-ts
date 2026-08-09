import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  indentLean,
  leanIdentifier,
  leanModuleSchema,
  renderLeanCommand,
  renderLeanDeclaration,
  renderLeanModule,
} from "../src/lean.ts";

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

  test("round-trips the complete Lean module fixture through the public schema", () => {
    const fixture = JSON.parse(readFileSync(new URL("../fixtures/lean-module.json", import.meta.url), "utf8"));
    const module = leanModuleSchema.parse(fixture);

    expect(JSON.parse(JSON.stringify(module))).toEqual(fixture);
    expect(renderLeanModule(module)).toBe(
      "import Demo.Prelude\n\n@[local simp] noncomputable def lookup {α : Type} (xs : List α) : Option α\n  | [] => none\n  | x :: _ => some x\n\nmutual\n  inductive Even where\n    | zero\n\n  inductive Odd where\n    | one\nend\n\nstructure Pair (α : Type) extends Prod α α where\n  mk ::\n  left : α\n  right : α\n",
    );
  });

  test("rejects malformed nested Lean output-model nodes", () => {
    const fixture = JSON.parse(readFileSync(new URL("../fixtures/lean-module.json", import.meta.url), "utf8"));
    fixture.commands[0].value.alternatives[1].patterns[0] = 42;
    fixture.commands[1].commands[0].constructors[0].identifier = null;

    expect(leanModuleSchema.safeParse(fixture).success).toBeFalse();
  });
});
