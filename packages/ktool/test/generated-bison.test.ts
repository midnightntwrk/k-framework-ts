import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkKGrammarLr1,
  generateKParserGrammar,
  KGeneratedParserGrammarSchema,
  KParserGrammarCaptureError,
  type GenerateKParserGrammarOptions,
} from "../src/generated-bison.ts";

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ktool-k-parser-capture-"));
  scratchDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface FakeKompile {
  readonly root: string;
  readonly command: string;
  readonly mainFile: string;
}

async function fakeKompile(): Promise<FakeKompile> {
  const root = await scratch();
  const bin = join(root, "bin");
  const command = join(bin, "kompile");
  const mainFile = join(root, "mini.k");
  await mkdir(bin);
  await writeFile(mainFile, "module MINI endmodule\n");
  await writeFile(
    command,
    String.raw`#!/bin/bash
if [[ "$1" == "--version" ]]; then
  version="$KTOOL_CAPTURE_VERSION"
  if [[ -z "$version" ]]; then version="v7.1.337"; fi
  echo "K version:    $version"
  exit 0
fi
output=""
temporary=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-definition) output="$2"; shift 2 ;;
    --temp-dir) temporary="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$KTOOL_CAPTURE_MODE" == "failure" ]]; then
  echo "[Error] Inner Parser: fake generation failure" >&2
  exit 113
fi
if [[ "$KTOOL_CAPTURE_MODE" == "sleep" ]]; then
  /bin/sleep 3
fi
/bin/mkdir -p "$output" "$temporary/.kompile-fake"
if [[ -n "$KTOOL_CAPTURE_RACE_DEST" ]]; then
  /bin/mkdir -p "$KTOOL_CAPTURE_RACE_DEST"
  /usr/bin/printf 'racing sentinel\n' > "$KTOOL_CAPTURE_RACE_DEST/sentinel"
fi
if [[ "$KTOOL_CAPTURE_MODE" == "multiple" ]]; then
  /bin/mkdir -p "$temporary/.kompile-second"
fi
if [[ "$KTOOL_CAPTURE_MODE" != "missing-source" ]]; then
  if [[ "$KTOOL_CAPTURE_MODE" == "raw" ]]; then
    /usr/bin/printf '\377parser\n' > "$temporary/.kompile-fake/parser.y"
  else
    /usr/bin/printf 'parser:%s\n' "$KTOOL_CAPTURE_ID" > "$temporary/.kompile-fake/parser.y"
  fi
fi
/usr/bin/touch "$output/parser_Pgm_MINI-SYNTAX"
/bin/ln -s "parser_Pgm_MINI-SYNTAX" "$output/parser_PGM"
if [[ "$KTOOL_CAPTURE_MODE" == "extra-parser" ]]; then
  /usr/bin/touch "$output/parser_Mode_MINI-MODE"
  /bin/ln -s "parser_Mode_MINI-MODE" "$output/parser_MODE"
fi
exit 0
`,
  );
  await chmod(command, 0o755);
  return { root, command, mainFile };
}

function options(
  fixture: FakeKompile,
  environment: Readonly<Record<string, string>> = {},
): GenerateKParserGrammarOptions {
  return {
    command: [fixture.command],
    temporaryParent: fixture.root,
    env: { PATH: process.env["PATH"] ?? "", ...environment },
  };
}

function spec(mainFile: string) {
  return {
    backend: "haskell" as const,
    mainFile,
    mainModule: "MINI",
    syntaxModule: "MINI-SYNTAX",
    haskellBinary: false,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe("generateKParserGrammar", () => {
  test("composes capture and Bison analysis without collapsing their result boundaries", async () => {
    const fixture = await fakeKompile();
    const checked = await checkKGrammarLr1(spec(fixture.mainFile), {
      capture: options(fixture, { KTOOL_CAPTURE_ID: "composed" }),
      bison: { tool: { command: [join(fixture.root, "missing-bison")] } },
    });

    expect(new TextDecoder().decode(checked.capture.source.bytes)).toBe("parser:composed\n");
    expect(checked.analysis.classification.kind).toBe("tool-failure");
    expect(checked.unprovedBoundaries).toEqual([
      "k-to-bison-grammar-correspondence",
      "scanner-determinism",
      "semantic-action-correctness",
      "generated-parser-runtime-correctness",
    ]);
  });

  test("returns exact bytes and derives the strict deterministic K invocation", async () => {
    const fixture = await fakeKompile();
    const retained = join(fixture.root, "retained");
    const generated = await generateKParserGrammar(spec(fixture.mainFile), {
      ...options(fixture, { KTOOL_CAPTURE_ID: "one" }),
      retainArtifactsTo: retained,
    });

    expect(KGeneratedParserGrammarSchema.safeParse(generated).success).toBe(true);
    expect(new TextDecoder().decode(generated.source.bytes)).toBe("parser:one\n");
    expect(generated.source.sha256).toHaveLength(64);
    expect(generated.target).toEqual({ kind: "pgm" });
    expect(generated.kVersion.text).toBe("v7.1.337");
    expect(generated.retainedArtifactsTo).toBe(retained);
    expect("kompile" in generated).toBe(false);
    expect(await readFile(join(retained, ".kompile-fake", "parser.y"), "utf8")).toBe("parser:one\n");

    const argv = generated.process.args;
    expect(argv).toContain("--gen-bison-parser");
    expect(argv).not.toContain("--gen-glr-bison-parser");
    expect(argv).not.toContain("--bison-parser-library");
    expect(argv).toContain("--debug");
    expect(argv.slice(argv.indexOf("--type-inference-mode"), argv.indexOf("--type-inference-mode") + 2)).toEqual([
      "--type-inference-mode",
      "checked",
    ]);
    expect(argv.slice(argv.indexOf("--warnings"), argv.indexOf("--warnings") + 2)).toEqual(["--warnings", "all"]);
    expect(argv).toContain("--warnings-to-errors");
    expect(argv.slice(argv.indexOf("-Wno"), argv.indexOf("-Wno") + 2)).toEqual(["-Wno", "unused-symbol"]);
    expect(argv).toContain("--output-definition");
    expect(argv).toContain("--temp-dir");
  });

  test("keeps exact non-UTF-8 bytes and cleans its owned workspace", async () => {
    const fixture = await fakeKompile();
    const sentinel = join(fixture.root, "sentinel");
    await writeFile(sentinel, "keep\n");
    const generated = await generateKParserGrammar(
      spec(fixture.mainFile),
      options(fixture, { KTOOL_CAPTURE_MODE: "raw" }),
    );

    expect([...generated.source.bytes]).toEqual([255, 112, 97, 114, 115, 101, 114, 10]);
    expect(await readFile(sentinel, "utf8")).toBe("keep\n");
    const entries = await readdir(fixture.root);
    expect(entries.some((entry) => entry.startsWith(".ktool-k-parser-"))).toBe(false);
  });

  test.each([
    [{ genGlrBisonParser: true }, "GLR"],
    [{ bisonParserLibrary: true }, "libraries"],
    [{ postProcess: "echo bad" }, "post-process"],
    [{ readOnly: true }, "read-only"],
  ] as const)("rejects unsupported strict-profile spec %s", async (extra) => {
    const fixture = await fakeKompile();
    try {
      await generateKParserGrammar({ ...spec(fixture.mainFile), ...extra }, options(fixture));
      throw new Error("expected unsupported request to fail");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "invalid-request" });
    }
  });

  test("rejects a K release outside the internal capture profile", async () => {
    const fixture = await fakeKompile();
    try {
      await generateKParserGrammar(spec(fixture.mainFile), options(fixture, { KTOOL_CAPTURE_VERSION: "v7.1.338" }));
      throw new Error("expected unsupported K version to fail");
    } catch (error: unknown) {
      expect(error).toMatchObject({
        code: "unsupported-k-version",
        expected: "v7.1.337",
        actual: "v7.1.338",
      });
    }
  });

  test("reports missing or non-directory caller workspace parents as invalid requests", async () => {
    const fixture = await fakeKompile();
    const missing = join(fixture.root, "missing-parent");
    const file = join(fixture.root, "not-a-directory");
    await writeFile(file, "not a directory\n");

    for (const parent of [missing, file]) {
      try {
        await generateKParserGrammar(spec(fixture.mainFile), { ...options(fixture), temporaryParent: parent });
        throw new Error("expected an invalid workspace parent to fail");
      } catch (error: unknown) {
        expect(error).toMatchObject({ code: "invalid-request", paths: [parent] });
      }
    }

    const retentionParent = join(fixture.root, "missing-retention-parent");
    const retentionDestination = join(retentionParent, "retained");
    try {
      await generateKParserGrammar(spec(fixture.mainFile), {
        ...options(fixture),
        retainArtifactsTo: retentionDestination,
      });
      throw new Error("expected an invalid retention parent to fail");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "invalid-request", paths: [retentionParent] });
    }
  });

  test("reports private workspace creation failure distinctly", async () => {
    const fixture = await fakeKompile();
    try {
      await generateKParserGrammar(spec(fixture.mainFile), { ...options(fixture), temporaryParent: "/proc" });
      throw new Error("expected workspace creation to fail");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "workspace-creation-failed", paths: ["/proc"] });
    }
  });

  test.each([
    ["failure", "kompile-failed"],
    ["multiple", "parser-artifact-multiple"],
    ["missing-source", "parser-artifact-missing"],
    ["extra-parser", "parser-target-unsupported"],
  ] as const)("returns a typed failure for %s and removes the workspace", async (mode, code) => {
    const fixture = await fakeKompile();
    const sentinel = join(fixture.root, "sentinel");
    await writeFile(sentinel, "keep\n");
    try {
      await generateKParserGrammar(spec(fixture.mainFile), options(fixture, { KTOOL_CAPTURE_MODE: mode }));
      throw new Error("expected capture failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(KParserGrammarCaptureError);
      expect(error).toMatchObject({ code });
      if (error instanceof KParserGrammarCaptureError && mode === "failure") {
        expect(error.process?.returncode).toBe(113);
        expect(error.diagnostics[0]?.message).toBe("fake generation failure");
      }
    }
    expect(await readFile(sentinel, "utf8")).toBe("keep\n");
    const entries = await readdir(fixture.root);
    expect(entries.some((entry) => entry.startsWith(".ktool-k-parser-"))).toBe(false);
  });

  test("isolates concurrent captures sharing one temporary parent", async () => {
    const fixture = await fakeKompile();
    const [first, second] = await Promise.all([
      generateKParserGrammar(spec(fixture.mainFile), options(fixture, { KTOOL_CAPTURE_ID: "first" })),
      generateKParserGrammar(spec(fixture.mainFile), options(fixture, { KTOOL_CAPTURE_ID: "second" })),
    ]);

    expect(new TextDecoder().decode(first.source.bytes)).toBe("parser:first\n");
    expect(new TextDecoder().decode(second.source.bytes)).toBe("parser:second\n");
    const entries = await readdir(fixture.root);
    expect(entries.some((entry) => entry.startsWith(".ktool-k-parser-"))).toBe(false);
  });

  test("allows repeated captures with the same temporary parent", async () => {
    const fixture = await fakeKompile();
    const first = await generateKParserGrammar(spec(fixture.mainFile), options(fixture, { KTOOL_CAPTURE_ID: "one" }));
    const second = await generateKParserGrammar(spec(fixture.mainFile), options(fixture, { KTOOL_CAPTURE_ID: "two" }));

    expect(new TextDecoder().decode(first.source.bytes)).toBe("parser:one\n");
    expect(new TextDecoder().decode(second.source.bytes)).toBe("parser:two\n");
  });

  test("retains a failed workspace only at the explicit fresh destination", async () => {
    const fixture = await fakeKompile();
    const retained = join(fixture.root, "retained-failure");
    try {
      await generateKParserGrammar(spec(fixture.mainFile), {
        ...options(fixture, { KTOOL_CAPTURE_MODE: "missing-source" }),
        retainArtifactsTo: retained,
      });
      throw new Error("expected capture failure");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "parser-artifact-missing", retainedArtifactsTo: retained });
    }
    expect(await exists(join(retained, ".kompile-fake"))).toBe(true);

    try {
      await generateKParserGrammar(spec(fixture.mainFile), {
        ...options(fixture),
        retainArtifactsTo: retained,
      });
      throw new Error("expected an occupied retention destination to fail");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "invalid-request" });
    }
  });

  test("cleans its workspace when a retention destination appears after validation", async () => {
    const fixture = await fakeKompile();
    const retained = join(fixture.root, "racing-retention");
    try {
      await generateKParserGrammar(spec(fixture.mainFile), {
        ...options(fixture, { KTOOL_CAPTURE_RACE_DEST: retained }),
        retainArtifactsTo: retained,
      });
      throw new Error("expected retention race to fail");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "retention-destination-not-fresh" });
    }

    expect(await readFile(join(retained, "sentinel"), "utf8")).toBe("racing sentinel\n");
    const entries = await readdir(fixture.root);
    expect(entries.some((entry) => entry.startsWith(".ktool-k-parser-"))).toBe(false);
  });

  test("cleans the workspace after a timeout", async () => {
    const fixture = await fakeKompile();
    try {
      await generateKParserGrammar(spec(fixture.mainFile), {
        ...options(fixture, { KTOOL_CAPTURE_MODE: "sleep" }),
        timeoutMs: 20,
        killGraceMs: 0,
      });
      throw new Error("expected capture timeout to fail");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "kompile-failed" });
    }
    const entries = await readdir(fixture.root);
    expect(entries.some((entry) => entry.startsWith(".ktool-k-parser-"))).toBe(false);
  });
});
