/** KORE-to-Lean names and the KLean-supported domain-value literal subset. */

import { bytesEncode, demangleName } from "@kframework-ts/kore";

/** pyk.klean's two deliberate escapes from Lean keywords/builtins. */
export const LEAN_SYMBOL_OVERRIDES: Readonly<Record<string, string>> = {
  Lblite: "kite",
  Lblabs: "kabs",
};

const VALID_LEAN_IDENTIFIER = /^_[A-Za-z0-9_?!']+$|^[A-Za-z][A-Za-z0-9_?!']*$/u;

/**
 * Decode a KORE mangled identifier (the `Lbl`/`Sort`/`Var` prefix is retained).
 *
 * This delegates the nontrivial apostrophe encoding to `@kframework-ts/kore`;
 * callers that turn labels or variables into Lean names normally want one of
 * the prefix-aware helpers below.
 */
export function unmungeKoreIdentifier(identifier: string): string {
  return demangleName(identifier);
}

/** Render arbitrary known KORE text as a Lean identifier, quoting when needed. */
export function quoteLeanIdentifier(identifier: string): string {
  if (VALID_LEAN_IDENTIFIER.test(identifier)) return identifier;
  if (identifier.includes("»")) throw new TypeError(`KLean cannot quote a Lean identifier containing »: ${identifier}`);
  return `«${identifier}»`;
}

/** Render a compiled KORE symbol name as its Lean counterpart. */
export function leanSymbolIdentifier(symbol: string): string {
  const override = LEAN_SYMBOL_OVERRIDES[symbol];
  if (override !== undefined) return override;
  const bare = symbol.startsWith("Lbl") ? symbol.slice("Lbl".length) : symbol;
  return quoteLeanIdentifier(unmungeKoreIdentifier(bare));
}

/** Render a compiled KORE variable name (`VarX`) as the Lean variable `X`. */
export function leanVariableIdentifier(variable: string): string {
  const bare = variable.startsWith("Var") ? variable.slice("Var".length) : variable;
  return quoteLeanIdentifier(unmungeKoreIdentifier(bare));
}

/** Render a KORE sort name. Sort identifiers are not label-mangled by KLean. */
export function leanSortIdentifier(sort: string): string {
  return quoteLeanIdentifier(sort);
}

/**
 * Render a rewrite constructor name, preserving upstream's readable label
 * convention and deterministic anonymous UID fallback.
 */
export function leanRuleIdentifier(label: string | undefined, uid: string): string {
  if (label === undefined || label.length === 0) return `_${uid.slice(0, 7)}`;
  return quoteLeanIdentifier(label.replaceAll("-", "_").replaceAll(".", "_"));
}

export type KleanDomainValueSort = "SortBool" | "SortInt" | "SortBytes" | "SortId" | "SortString" | "SortStringBuffer";

/** Detailed result available to consumers that want literal diagnostics. */
export type DomainValueRenderResult =
  | { readonly ok: true; readonly term: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Lower the exact DV subset supported by upstream KLean.
 *
 * `undefined` is intentionally reserved for unsupported/invalid values so
 * the lowering pass can report a typed Klean diagnostic rather than fabricate
 * a Lean literal.
 */
export function renderDomainValue(sort: string, value: string): string | undefined {
  const result = tryRenderDomainValue(sort, value);
  return result.ok ? result.term : undefined;
}

export function tryRenderDomainValue(sort: string, value: string): DomainValueRenderResult {
  switch (sort) {
    case "SortBool":
      return value === "true" || value === "false"
        ? { ok: true, term: value }
        : { ok: false, reason: `SortBool domain value must be true or false, got ${JSON.stringify(value)}` };
    case "SortInt":
      return renderIntDomainValue(value);
    case "SortBytes":
      return renderBytesDomainValue(value);
    case "SortId":
    case "SortString":
    case "SortStringBuffer":
      return renderStringDomainValue(value);
    default:
      return { ok: false, reason: `unsupported KLean domain-value sort: ${sort}` };
  }
}

function renderIntDomainValue(value: string): DomainValueRenderResult {
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value))
    return { ok: false, reason: `invalid SortInt domain value: ${JSON.stringify(value)}` };
  const normalized = BigInt(value).toString();
  return { ok: true, term: normalized.startsWith("-") ? `(${normalized})` : normalized };
}

function renderBytesDomainValue(value: string): DomainValueRenderResult {
  let bytes: Uint8Array;
  try {
    bytes = bytesEncode(value);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "SortBytes cannot be latin-1 encoded" };
  }
  const body = Array.from(bytes, (byte) => `0x${byte.toString(16).padStart(2, "0").toUpperCase()}`).join(", ");
  return { ok: true, term: `⟨#[${body}]⟩` };
}

function renderStringDomainValue(value: string): DomainValueRenderResult {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return { ok: false, reason: "missing Unicode code point" };
    if (codePoint === 13) escaped += "\\r";
    else if (codePoint === 10) escaped += "\\n";
    else if (codePoint === 9) escaped += "\\t";
    else if (codePoint === 92) escaped += "\\\\";
    else if (codePoint === 34) escaped += '\\"';
    else if (codePoint === 39) escaped += "\\'";
    else if (codePoint >= 32 && codePoint < 127) escaped += character;
    else if (codePoint <= 0xff) escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    else if (codePoint <= 0xffff) escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    else return { ok: false, reason: `unsupported Unicode character: ${JSON.stringify(character)} (${codePoint})` };
  }
  return { ok: true, term: `"${escaped}"` };
}
