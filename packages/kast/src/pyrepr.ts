/**
 * CPython-compatible repr helpers.
 *
 * Three transcribed pyk behaviours interpolate strings with `repr`, so all
 * three must spell it identically: `manip.ts`'s `abstractTermSafely` hashes a
 * term's dataclass repr (`utils.py:373-376`), `att.ts`'s `AnyType.unparse`
 * reprs attribute values, and `lexer.ts`/`parser.ts` quote input fragments in
 * error messages (`lexer.py:88-90`, `parser.py:45-52`).  This module is
 * {@link reprKInner} additionally reproduces the generated dataclass repr of
 * pyk's K inner nodes.  It is exported through `manip.ts`, where it is used
 * for diagnostics, fresh-variable hashing, and CTerm's deterministic
 * constraint ordering.
 *
 * The rules: single quotes, unless the string contains a `'` and no `"`.
 * Below `\x80`: the quote and `\` are backslash-escaped, `\t` `\n` `\r` take
 * their short forms, and anything else under `\x20` — plus `\x7f` — becomes
 * `\xNN`.  At or above `\x80` a *printable* code point is emitted literally
 * and an unprintable one as `\xNN`, `\uXXXX` or `\UXXXXXXXX` by width.
 */

import type { KInner, KLabel, KSort } from "./inner.js";

/** A literal to emit verbatim, or a KAST object still to be rendered. */
type Repr =
  | { readonly lit: string }
  | { readonly term: KInner }
  | { readonly sort: KSort }
  | { readonly label: KLabel };

/** Index into an array whose bounds the caller has already established. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`Index ${i} is out of range (length ${xs.length})`);
  return x;
}

/**
 * The categories `Py_UNICODE_ISPRINTABLE` rejects (CPython `unicodeobject.c`):
 * `Cc`, `Cf`, `Cs`, `Co`, `Cn`, `Zl`, `Zp`, `Zs`.  Space is printable, but this
 * test is only ever reached for a code point above `\x7f`.
 */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

export function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code < 0x7f) out += ch;
    else if (!NON_PRINTABLE.test(ch)) out += ch;
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 0xff_ff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}

/** Emit a Python tuple, retaining the special one-item trailing comma. */
function pushTuple<T>(stack: Repr[], items: readonly T[], wrap: (item: T) => Repr): void {
  stack.push({ lit: ")" });
  if (items.length === 1) stack.push({ lit: "," });
  for (let i = items.length - 1; i >= 0; i--) {
    stack.push(wrap(at(items, i)));
    if (i > 0) stack.push({ lit: ", " });
  }
  stack.push({ lit: "(" });
}

/**
 * The generated frozen-dataclass `repr` of a pyk `KInner` (`inner.py`).
 *
 * This is deliberately iterative: backend terms can be much deeper than the
 * JavaScript call stack.  The spelling is observable in pyk's `hash_str` and
 * is therefore part of the compatibility surface, not display formatting.
 */
export function reprKInner(term: KInner): string {
  const out: string[] = [];
  const stack: Repr[] = [{ term }];

  for (;;) {
    const item = stack.pop();
    if (item === undefined) return out.join("");
    if ("lit" in item) {
      out.push(item.lit);
      continue;
    }
    if ("sort" in item) {
      out.push(`KSort(name=${reprString(item.sort.name)}, params=`);
      stack.push({ lit: ")" });
      pushTuple(stack, item.sort.params, (sort) => ({ sort }));
      continue;
    }
    if ("label" in item) {
      out.push(`KLabel(name=${reprString(item.label.name)}, params=`);
      stack.push({ lit: ")" });
      pushTuple(stack, item.label.params, (sort) => ({ sort }));
      continue;
    }

    const t = item.term;
    switch (t.node) {
      case "KToken":
        out.push(`KToken(token=${reprString(t.token)}, sort=`);
        stack.push({ lit: ")" }, { sort: t.sort });
        break;
      case "KVariable":
        out.push(`KVariable(name=${reprString(t.name)}, sort=`);
        stack.push({ lit: ")" });
        if (t.sort === undefined) stack.push({ lit: "None" });
        else stack.push({ sort: t.sort });
        break;
      case "KApply":
        out.push("KApply(label=");
        stack.push({ lit: ")" });
        pushTuple(stack, t.args, (arg) => ({ term: arg }));
        stack.push({ lit: ", args=" }, { label: t.label });
        break;
      case "KAs":
        out.push("KAs(pattern=");
        stack.push({ lit: ")" }, { term: t.alias }, { lit: ", alias=" }, { term: t.pattern });
        break;
      case "KRewrite":
        out.push("KRewrite(lhs=");
        stack.push({ lit: ")" }, { term: t.rhs }, { lit: ", rhs=" }, { term: t.lhs });
        break;
      case "KSequence":
        out.push("KSequence(items=");
        stack.push({ lit: ")" });
        pushTuple(stack, t.items, (child) => ({ term: child }));
        break;
    }
  }
}
