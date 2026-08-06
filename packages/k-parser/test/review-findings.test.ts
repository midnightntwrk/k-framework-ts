/**
 * Regression tests for the findings of the phase-6 adversarial review (a
 * ~276k-input differential fuzz against pyk at v7.1.337).  Each `describe`
 * names one finding; the review found no divergence in the lexer, parser or
 * markdown cores beyond the documented deviations, so everything here pins a
 * seam, not a transcription.
 */

import { describe, expect, test } from "bun:test";

import { astToKast } from "../src/astToKast.ts";
import { outerLexer } from "../src/lexer.ts";
import { OuterParser } from "../src/parser.ts";
import { slurpDefinitions, type FileSystem } from "../src/slurp.ts";

function memoryFs(files: Record<string, string>): FileSystem {
  return {
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    isFile: (path) => files[path] !== undefined,
    resolve: (path) => path,
  };
}

describe("finding 1: empty mdSelector falls back to 'k' (utils.py:48 truthiness)", () => {
  const doc = ["```k", "module A", "endmodule", "```", "", "```bad", "module ZZZ", "endmodule", "```", ""].join("\n");

  test("mdSelector: '' selects only k blocks, like pyk", () => {
    const defs = slurpDefinitions("/t.md", { mdSelector: "", fs: memoryFs({ "/t.md": doc }) });
    const modules = [...defs.values()].flatMap((d) => d.modules.map((m) => m.name));
    expect(modules).toEqual(["A"]);
  });
});

describe("finding 2: columns count UTF-16 code units consistently, locAdd included", () => {
  test("every token in an astral-bearing line sits at its code-unit offset", () => {
    const text = "module A rule [a\u{1F600}b]: x => y endmodule";
    const tokens = [...outerLexer(text)].filter((t) => t.type !== "EOF");
    for (const token of tokens) {
      // One line of input, so col - 1 is the code-unit offset of the token's
      // first character.  Before the fix the label-derived tokens counted the
      // astral char as width 1 and this failed from `]` onward.
      expect(text.slice(token.loc.col - 1).startsWith(token.text)).toBe(true);
    }
  });
});

describe("finding 3: NAT sort arguments beyond safe-integer range are refused", () => {
  test("a safe NAT converts exactly", () => {
    const definition = new OuterParser("module A syntax Foo = Bar{8} endmodule").definition();
    const synonym = definition.modules[0]?.sentences[0];
    if (synonym?.node !== "SyntaxSynonym") throw new Error("expected a synonym");
    expect(synonym.oldSort.args).toEqual([8]);
  });

  test("an unsafe NAT throws instead of rounding (parser divergence 4)", () => {
    expect(() => new OuterParser("module A syntax Foo = Bar{99999999999999999999} endmodule").definition()).toThrow(
      "NAT '99999999999999999999' exceeds the safe integer range",
    );
  });
});

describe("finding 4: KRegexTerminal keeps the regex verbatim through astToKast", () => {
  test("the regex field survives conversion", () => {
    const definition = new OuterParser('module A syntax Foo ::= r"[a-z]+" "x" endmodule').definition();
    const kdef = astToKast(definition, "A");
    const dumped = JSON.stringify(kdef.toDict());
    expect(dumped).toContain('"node":"KRegexTerminal"');
    expect(dumped).toContain('"regex":"[a-z]+"');
  });
});

describe("finding 5: a file named exactly `.md` has no suffix (Path.suffix semantics)", () => {
  test("`.md` is parsed as raw K; `a.md` is markdown-selected", () => {
    const fs = memoryFs({
      "/dir/.md": "module DOTMD endmodule",
      "/dir/a.md": "```k\nmodule A\nendmodule\n```\n",
    });
    const bare = slurpDefinitions("/dir/.md", { fs });
    expect([...bare.values()][0]?.modules[0]?.name).toBe("DOTMD");
    const literate = slurpDefinitions("/dir/a.md", { fs });
    expect([...literate.values()][0]?.modules[0]?.name).toBe("A");
  });
});
