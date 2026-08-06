import assert from "node:assert/strict";
import {
  KLEAN_PRELUDE,
  K_RELEASE,
  LEAN_TOOLCHAIN,
  generateKleanProject,
  leanSymbolIdentifier,
  renderDomainValue,
  renderLeanModule,
  sourceFromKoreText,
} from "@kframework-ts/klean";

assert.equal(K_RELEASE, "v7.1.337");
assert.equal(LEAN_TOOLCHAIN, "leanprover/lean4:v4.30.0");
assert.equal(leanSymbolIdentifier("Lbl'UndsPlus'Int'Unds'"), "«_+Int_»");
assert.equal(renderDomainValue("SortInt", "-1"), "(-1)");
assert.equal(
  renderLeanModule({ commands: [{ tag: "axiom", identifier: { text: "a" }, signature: { type: "Prop" } }] }),
  "axiom a : Prop\n",
);
assert.ok(KLEAN_PRELUDE.includes("class Inj (From To : Type)"));

const project = generateKleanProject(sourceFromKoreText("[] module M sort SortGeneratedTopCell{} [] endmodule []"), {
  packageName: "smoke",
  libraryName: "Smoke",
});
assert.equal(project.diagnostics.length, 0);
assert.equal(project.files.get("Smoke.lean"), "import Smoke.Rewrite\n");
assert.ok(project.files.get("lakefile.toml")?.includes('defaultTargets = ["Smoke"]'));

console.log(`@kframework-ts/klean: packed tarball imports and runs under Node ${process.version}`);
