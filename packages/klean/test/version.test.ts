import { describe, expect, test } from "bun:test";

import { KLEAN_PRELUDE } from "../src/prelude.ts";
import { checkKleanSources, sha256Hex } from "../src/ksources.ts";
import { K_COMMIT, K_RELEASE, LEAN_TOOLCHAIN, TRANSCRIBED_FROM } from "../src/version.ts";

describe("KLean provenance", () => {
  test("pins K and Lean with the upstream prelude/template", () => {
    expect(K_RELEASE).toBe("v7.1.337");
    expect(K_COMMIT).toBe("4a46d1231473b599c699160132fd6e76a5c46406");
    expect(LEAN_TOOLCHAIN).toBe("leanprover/lean4:v4.30.0");
    expect(KLEAN_PRELUDE).toContain("class Inj (From To : Type) : Type where");
    expect(TRANSCRIBED_FROM.some((source) => source.path.endsWith("/lakefile.toml"))).toBe(true);
    expect(TRANSCRIBED_FROM.some((source) => source.path.endsWith("/__main__.py"))).toBe(true);
  });

  test("reports injected source drift without network access", async () => {
    const bytes = new TextEncoder().encode("changed");
    const report = await checkKleanSources("v-test", async () => bytes, TRANSCRIBED_FROM.slice(0, 1));
    expect(report.verdict).toBe("changed");
    expect(report.files[0]?.actual).toBe(await sha256Hex(bytes));
  });
});
