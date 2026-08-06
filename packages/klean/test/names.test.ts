import { describe, expect, test } from "bun:test";

import {
  leanRuleIdentifier,
  leanSymbolIdentifier,
  leanVariableIdentifier,
  renderDomainValue,
  tryRenderDomainValue,
} from "../src/names.ts";

describe("KORE names", () => {
  test("unmunges and quotes symbols, with upstream overrides", () => {
    expect(leanSymbolIdentifier("Lbl'UndsPlus'Int'Unds'")).toBe("«_+Int_»");
    expect(leanSymbolIdentifier("Lblite")).toBe("kite");
    expect(leanSymbolIdentifier("Lblabs")).toBe("kabs");
    expect(leanVariableIdentifier("Var'Unds'X")).toBe("_X");
    expect(leanRuleIdentifier("step-1.foo", "abcdef0123")).toBe("step_1_foo");
    expect(leanRuleIdentifier(undefined, "abcdef0123")).toBe("_abcdef0");
  });
});

describe("KORE domain values", () => {
  test("renders all supported literals deterministically", () => {
    expect(renderDomainValue("SortBool", "true")).toBe("true");
    expect(renderDomainValue("SortInt", "42")).toBe("42");
    expect(renderDomainValue("SortInt", "-42")).toBe("(-42)");
    expect(renderDomainValue("SortBytes", "\u0000ÿ")).toBe("⟨#[0x00, 0xFF]⟩");
    expect(renderDomainValue("SortString", 'a\n"é')).toBe('"a\\n\\"\\xe9"');
  });

  test("does not invent unsupported literals", () => {
    expect(renderDomainValue("SortFloat", "1.0")).toBeUndefined();
    expect(tryRenderDomainValue("SortString", "😀")).toEqual({
      ok: false,
      reason: 'unsupported Unicode character: "😀" (128512)',
    });
  });
});
