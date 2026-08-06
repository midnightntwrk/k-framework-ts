/**
 * Opt-in real-world corpus soak: outer-parse the maintained RV
 * semantics repos in place.  Off by default — `bun test` promises no reads
 * outside the repository — and enabled by pointing
 * `KFRAMEWORK_TS_RV_CHECKOUTS` at a directory containing checkouts of
 * `wasm-semantics`, `mir-semantics`, `evm-semantics`, `pl-tutorial` and
 * `kontrol` (the workspace's `inspirations/runtimeverification/`).
 *
 *     KFRAMEWORK_TS_RV_CHECKOUTS=…/runtimeverification bun test corpus-soak
 *
 * The assertion is the plan's: every file outer-parses without error, except
 * a named allowlist of known pyk-parity divergences.  Nothing here is
 * vendored — these files stay in their repos, under their own licenses.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { selectCodeBlocks } from "../src/markdown.ts";
import { OuterParser } from "../src/parser.ts";

const ROOT = process.env["KFRAMEWORK_TS_RV_CHECKOUTS"];
const soak = ROOT === undefined ? describe.skip : describe;

/**
 * Files expected to fail, with the reason.  Keys are `<corpus>:<relative
 * path>`; every entry is a *pyk*-faithful rejection this port reproduces on
 * purpose (`fixtures/PROVENANCE.md` records each).
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  // `#staticArrayLenBits(/* placeholder */)` — a comment-only argument list;
  // Java accepts, pyk rejects (a `parser.ts` documented divergence).
  // Fails under both mir selectors.
  ["mir:ty.md", "f(/* comment */) — pyk-faithful rejection, Java accepts"],
  // Anonymous tuple productions, `syntax KItem ::= (Map,K,…)` — pre-7.x K
  // syntax (pl-tutorial pins K 7.1.267-era conventions); pyk rejects at the
  // same line:col with the same message, verified 2026-08-06.
  ["pl-tutorial:2_languages/1_simple/1_untyped/simple-untyped.md", "anonymous tuple production — pyk rejects too"],
  [
    "pl-tutorial:2_languages/1_simple/2_typed/2_dynamic/simple-typed-dynamic.md",
    "anonymous tuple production — pyk rejects too",
  ],
  ["pl-tutorial:2_languages/2_kool/1_untyped/kool-untyped.md", "anonymous tuple production — pyk rejects too"],
]);

function walk(dir: string, suffix: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(suffix))
    .toSorted();
}

interface Corpus {
  readonly name: string;
  readonly dir: string;
  /** `[suffix, selectors]` — `.md` files go through every listed selector. */
  readonly suffixes: readonly (readonly [string, readonly (string | null)[]])[];
  readonly minFiles: number;
  /** `.md` files with no K fence at all (pl-tutorial lesson prose) are skipped. */
  readonly literateOnly?: boolean;
}

function corpora(root: string): Corpus[] {
  return [
    {
      name: "wasm",
      dir: join(root, "wasm-semantics", "pykwasm", "src", "pykwasm", "kdist", "wasm-semantics"),
      suffixes: [
        [".md", ["k"]],
        [".k", [null]],
      ],
      minFiles: 12,
    },
    {
      name: "mir",
      dir: join(root, "mir-semantics", "kmir", "src", "kmir", "kdist", "mir-semantics"),
      suffixes: [[".md", ["k & ! symbolic", "k & ! concrete"]]],
      minFiles: 18,
    },
    {
      name: "evm",
      dir: join(root, "evm-semantics", "kevm-pyk", "src", "kevm_pyk", "kproj", "evm-semantics"),
      suffixes: [[".md", ["k"]]],
      minFiles: 19,
    },
    {
      name: "pl-tutorial",
      dir: join(root, "pl-tutorial"),
      suffixes: [
        [".md", ["k"]],
        [".k", [null]],
      ],
      minFiles: 50,
      literateOnly: true,
    },
    {
      name: "kontrol",
      dir: join(root, "kontrol", "src", "kontrol", "kdist"),
      suffixes: [[".md", ["k"]]],
      minFiles: 1,
    },
  ];
}

/** One file under one selector; pushes onto `failures`, returns 1 if a parse was attempted. */
function soakOne(
  corpus: Corpus,
  rel: string,
  raw: string,
  suffix: string,
  selector: string | null,
  failures: string[],
): number {
  let text = raw;
  if (suffix === ".md") {
    try {
      text = selectCodeBlocks(raw, selector);
    } catch (error) {
      // pyk cannot select this file either (`parse_tags` runs on every
      // fence).  For lesson prose that merely *contains* a K fence, that
      // makes it a non-definition, not a failure.
      if (corpus.literateOnly !== true) {
        failures.push(`${rel} (selection, ${String(selector)}): ${String(error)}`);
      }
      return 0;
    }
  }
  try {
    new OuterParser(text, rel).definition();
  } catch (error) {
    if (!ALLOWLIST.has(`${corpus.name}:${rel}`)) {
      failures.push(`${rel} (selector ${String(selector)}): ${String(error)}`);
    }
  }
  return 1;
}

soak("real-world corpus soak", () => {
  for (const corpus of corpora(ROOT ?? "")) {
    test(corpus.name, () => {
      if (!existsSync(corpus.dir)) throw new Error(`corpus checkout missing: ${corpus.dir}`);

      const failures: string[] = [];
      let attempted = 0;
      for (const [suffix, selectors] of corpus.suffixes) {
        for (const rel of walk(corpus.dir, suffix)) {
          const raw = readFileSync(join(corpus.dir, rel), "utf8");
          if (suffix === ".md" && corpus.literateOnly === true && !raw.includes("```k") && !raw.includes("```{.k")) {
            continue;
          }
          for (const selector of selectors) {
            attempted += soakOne(corpus, rel, raw, suffix, selector, failures);
          }
        }
      }

      expect(failures).toEqual([]);
      expect(attempted).toBeGreaterThanOrEqual(corpus.minFiles);
    });
  }
});
