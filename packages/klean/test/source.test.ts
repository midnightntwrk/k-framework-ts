import { describe, expect, test } from "bun:test";
import { parseDefinition, type Axiom } from "@kframework-ts/kore";
import { sourceFromDefinition, sourceFromKompiled, sourceFromKoreText } from "../src/source.ts";

const impDefinition = new URL(
  "../../kompiled/fixtures/generated/imp-haskell-kompiled/definition.kore",
  import.meta.url,
);

describe("Klean sources", () => {
  test("KORE text is lazy by default and forces one axiom through its original text", async () => {
    const source = sourceFromKoreText(await Bun.file(impDefinition).text());
    const [first] = source.index.axioms;
    if (first?.tag !== "LazyAxiom") throw new Error("Expected the default KLean source to retain a lazy axiom");
    expect(source.forceAxiom(first).tag).toBe("Axiom");
    // Forcing is memoized, which matters for a repeated dependency closure.
    expect(source.forceAxiom(first)).toBe(source.forceAxiom(first));
  });

  test("eager text and a structural KompiledDefinition adapter both preserve the source contract", async () => {
    const text = await Bun.file(impDefinition).text();
    const eager = sourceFromKoreText(text, { lazyAxioms: false });
    expect(eager.index.axioms[0]?.tag).toBe("Axiom");

    let calls = 0;
    const adapted = sourceFromKompiled({
      koreDefinition: eager.index,
      forceKoreAxiom(axiom): Axiom {
        calls += 1;
        if (axiom.tag !== "Axiom") throw new Error("The eager source must contain eager axioms");
        return axiom;
      },
    });
    const [axiom] = eager.index.axioms;
    expect(adapted.forceAxiom(axiom!).tag).toBe("Axiom");
    expect(calls).toBe(0);
    expect(sourceFromDefinition(parseDefinition(text)).index.axioms).toHaveLength(eager.index.axioms.length);
  });
});
