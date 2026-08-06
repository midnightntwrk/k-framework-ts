/**
 * `src/slurp.ts` — `requires` resolution over a filesystem.
 *
 * Two halves, deliberately:
 *
 * - the **fixture** half runs against `fixtures/parse-outer/` on the real disk,
 *   because directory-relative resolution and include-dir search are half of
 *   what is being tested and a fake filesystem would test the fake;
 * - the **seam** half passes an in-memory {@link FileSystem} so the ordering and
 *   dedup rules can be stated as small graphs — including a diamond and a
 *   symlink-style alias — without checking in files that exist only to be
 *   walked.
 *
 * The DFS order is the one contract here that is genuinely load-bearing
 * downstream: `parseOuter` concatenates modules in visit order, so it decides
 * `KDefinition.allModules`, which `d.k.expected.json` pins byte for byte.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  NODE_FILE_SYSTEM,
  RequireNotFoundError,
  parseOuter,
  resolveRequire,
  slurpDefinitions,
  type FileSystem,
} from "../src/slurp.ts";
import { PARSE_OUTER } from "./fixtures.ts";

//////////////////////////////
// The in-memory seam       //
//////////////////////////////

/**
 * A {@link FileSystem} over a plain map, with POSIX-ish path handling.
 *
 * `resolve` collapses `.` and `..` and applies {@link aliases}, which is how a
 * symlink is modelled: two spellings that resolve to one canonical path must
 * dedup, and that is the property `Path.resolve()` gives pyk.
 */
function memoryFs(files: Readonly<Record<string, string>>, aliases: Readonly<Record<string, string>> = {}): FileSystem {
  const canonical = (path: string): string => {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === ".." && parts.length > 0) parts.pop();
      else parts.push(part);
    }
    const joined = `/${parts.join("/")}`;
    return aliases[joined] ?? joined;
  };
  return {
    readFile(path: string): string {
      const text = files[canonical(path)];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    isFile(path: string): boolean {
      return files[canonical(path)] !== undefined;
    },
    resolve: canonical,
  };
}

/** `module X endmodule` for each name, preceded by the given requires. */
function file(requires: readonly string[], modules: readonly string[]): string {
  return [...requires.map((path) => `requires "${path}"`), ...modules.map((name) => `module ${name}\nendmodule`)].join(
    "\n",
  );
}

//////////////////////////////
// DFS order and dedup      //
//////////////////////////////

describe("slurpDefinitions", () => {
  test("DFS, first require first — the d.k fixture order", () => {
    const files = slurpDefinitions(join(PARSE_OUTER, "d.k"));
    const names = [...files.keys()].map((path) => path.split("/").at(-1));
    expect(names).toEqual(["d.k", "b.k", "a.k", "c.k"]);
  });

  test("and that is the module order parseOuter produces", () => {
    const definition = parseOuter(join(PARSE_OUTER, "d.k"), "D", { includeSource: false });
    expect(definition.allModules.map((mod) => mod.name)).toEqual([
      "D-SYNTAX",
      "D",
      "B-SYNTAX",
      "B",
      "A-SYNTAX",
      "A",
      "C-SYNTAX",
      "C",
    ]);
  });

  test("a diamond is visited once", () => {
    const fs = memoryFs({
      "/d.k": file(["b.k", "c.k"], ["D"]),
      "/b.k": file(["a.k"], ["B"]),
      "/c.k": file(["a.k"], ["C"]),
      "/a.k": file([], ["A"]),
    });
    const files = slurpDefinitions("/d.k", { fs });
    expect([...files.keys()]).toEqual(["/d.k", "/b.k", "/a.k", "/c.k"]);
  });

  test("two spellings of one file collapse, because the key is the resolved path", () => {
    // `/link.k` is an alias for `/real.k` — pyk's dedup key is `Path.resolve()`,
    // which resolves symlinks, and this is the behaviour that depends on it.
    const fs = memoryFs(
      { "/main.k": file(["real.k", "sub/../link.k"], ["MAIN"]), "/real.k": file([], ["REAL"]) },
      { "/link.k": "/real.k" },
    );
    const files = slurpDefinitions("/main.k", { fs });
    expect([...files.keys()]).toEqual(["/main.k", "/real.k"]);
  });

  test("a require cycle terminates", () => {
    const fs = memoryFs({ "/a.k": file(["b.k"], ["A"]), "/b.k": file(["a.k"], ["B"]) });
    expect([...slurpDefinitions("/a.k", { fs }).keys()]).toEqual(["/a.k", "/b.k"]);
  });

  test("deeper nesting still goes depth-first", () => {
    const fs = memoryFs({
      "/a.k": file(["b.k", "e.k"], ["A"]),
      "/b.k": file(["c.k", "d.k"], ["B"]),
      "/c.k": file([], ["C"]),
      "/d.k": file([], ["D"]),
      "/e.k": file([], ["E"]),
    });
    expect([...slurpDefinitions("/a.k", { fs }).keys()]).toEqual(["/a.k", "/b.k", "/c.k", "/d.k", "/e.k"]);
  });
});

//////////////////////////////
// Resolution               //
//////////////////////////////

describe("resolveRequire", () => {
  test("the requiring file's own directory comes first", () => {
    const resolved = resolveRequire("a.k", join(PARSE_OUTER, "b.k"));
    expect(resolved).toBe(NODE_FILE_SYSTEM.resolve(join(PARSE_OUTER, "a.k")));
  });

  test("then the include directories, in order (include.k → include/e.k)", () => {
    const files = slurpDefinitions(join(PARSE_OUTER, "include.k"), {
      includeDirs: [join(PARSE_OUTER, "include")],
    });
    expect([...files.keys()].map((path) => path.split("/").slice(-2).join("/"))).toEqual([
      "parse-outer/include.k",
      "include/e.k",
    ]);
  });

  test("include directories are searched in the order given", () => {
    const fs = memoryFs({ "/main.k": file(["x.k"], ["MAIN"]), "/one/x.k": "module ONE\nendmodule", "/two/x.k": "" });
    expect([...slurpDefinitions("/main.k", { fs, includeDirs: ["/one", "/two"] }).keys()]).toEqual([
      "/main.k",
      "/one/x.k",
    ]);
    expect([...slurpDefinitions("/main.k", { fs, includeDirs: ["/two", "/one"] }).keys()]).toEqual([
      "/main.k",
      "/two/x.k",
    ]);
  });

  test("a missing require names every path it searched (utils.py:87)", () => {
    let thrown: unknown;
    try {
      slurpDefinitions(join(PARSE_OUTER, "include.k"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RequireNotFoundError);
    if (!(thrown instanceof RequireNotFoundError)) throw new TypeError("unreachable");
    const error = thrown;
    expect(error.name).toBe("RequireNotFoundError");
    expect(error.path).toBe("e.k");
    expect(error.searchedPaths).toEqual([PARSE_OUTER]);
    expect(error.message).toBe(`e.k not found. Searched paths: ['${PARSE_OUTER}']`);
  });

  test("the message lists include directories after the file's own", () => {
    const fs = memoryFs({ "/main.k": file(["missing.k"], ["MAIN"]) });
    expect(() => slurpDefinitions("/main.k", { fs, includeDirs: ["/inc"] })).toThrow(
      "missing.k not found. Searched paths: ['/', '/inc']",
    );
  });

  test("an absolute require path bypasses the search", () => {
    const fs = memoryFs({ "/main.k": file(["/elsewhere/x.k"], ["MAIN"]), "/elsewhere/x.k": "module X\nendmodule" });
    expect([...slurpDefinitions("/main.k", { fs }).keys()]).toEqual(["/main.k", "/elsewhere/x.k"]);
  });
});

//////////////////////////////
// Markdown gating          //
//////////////////////////////

describe("markdown selection", () => {
  test("is gated purely on the .md suffix (utils.py:74)", () => {
    const md = "text\n\n```k\nmodule YES\nendmodule\n```\n\n```other\nmodule NO\nendmodule\n```\n";
    const fs = memoryFs({ "/a.md": md, "/a.k": md });
    expect([...(slurpDefinitions("/a.md", { fs }).get("/a.md")?.modules ?? [])].map((m) => m.name)).toEqual(["YES"]);
    // The same bytes in a `.k` file are not a literate definition; the fences
    // are just text the outer lexer has to choke on.
    expect(() => slurpDefinitions("/a.k", { fs })).toThrow();
  });

  test("the default selector is 'k', not selectCodeBlocks' own default", () => {
    const md = "```k\nmodule A\nendmodule\n```\n```foo\nmodule B\nendmodule\n```\n";
    const fs = memoryFs({ "/a.md": md });
    expect([...(slurpDefinitions("/a.md", { fs }).get("/a.md")?.modules ?? [])].map((m) => m.name)).toEqual(["A"]);
    expect(
      [...(slurpDefinitions("/a.md", { fs, mdSelector: "foo" }).get("/a.md")?.modules ?? [])].map((m) => m.name),
    ).toEqual(["B"]);
    expect(
      [...(slurpDefinitions("/a.md", { fs, mdSelector: "k | foo" }).get("/a.md")?.modules ?? [])].map((m) => m.name),
    ).toEqual(["A", "B"]);
  });

  test("markdown.md's golden is reached through this path", () => {
    const definition = parseOuter(join(PARSE_OUTER, "markdown.md"), "MARKDOWN", { includeSource: false });
    expect(definition.allModules.map((mod) => mod.name)).toEqual(["MARKDOWN"]);
  });
});

//////////////////////////////
// includeSource            //
//////////////////////////////

describe("includeSource", () => {
  test("off, nothing records a path — which is how the goldens were made", () => {
    const fs = memoryFs({ "/a.k": "module A\n  rule x => y\nendmodule" });
    const parsed = slurpDefinitions("/a.k", { fs, includeSource: false }).get("/a.k");
    expect(parsed?.modules[0]?.source).toBeUndefined();
    expect(parsed?.modules[0]?.sentences[0]?.location).toBeUndefined();
  });

  test("on (the default), the resolved path is what is recorded", () => {
    const fs = memoryFs({ "/a.k": "module A\n  rule x => y\nendmodule" });
    const parsed = slurpDefinitions("/a.k", { fs }).get("/a.k");
    expect(parsed?.modules[0]?.source).toBe("/a.k");
    expect(parsed?.modules[0]?.sentences[0]?.location).toEqual([2, 8, 2, 8]);
  });
});

//////////////////////////////
// parseOuter               //
//////////////////////////////

describe("parseOuter", () => {
  test("threads options through to the conversion", () => {
    const fs = memoryFs({ "/a.k": "module A [haskell]\nendmodule" });
    expect(parseOuter("/a.k", "A", { fs }).mainModule.att.toDict()).toEqual({
      node: "KAtt",
      att: {
        haskell: "",
        "org.kframework.attributes.Location": [1, 1, 2, 10],
        "org.kframework.attributes.Source": "/a.k",
      },
    });
    // `strictAtts` is pyk's `KAtt.parse`, which cannot read `[haskell]`.
    expect(() => parseOuter("/a.k", "A", { fs, strictAtts: true })).toThrow();
  });

  test("a main module that is not there fails at construction", () => {
    const fs = memoryFs({ "/a.k": "module A\nendmodule" });
    expect(() => parseOuter("/a.k", "NOPE", { fs })).toThrow("Module not found: NOPE");
  });

  test("the default filesystem is the node one", () => {
    expect(NODE_FILE_SYSTEM.isFile(join(PARSE_OUTER, "a.k"))).toBe(true);
    expect(NODE_FILE_SYSTEM.isFile(PARSE_OUTER)).toBe(false);
    expect(NODE_FILE_SYSTEM.isFile(join(PARSE_OUTER, "nope.k"))).toBe(false);
  });
});
