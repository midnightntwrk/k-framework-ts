import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  generateBisonGrammar,
  GeneratedBisonGrammarError,
  GeneratedBisonGrammarSchema,
  type GenerateBisonGrammarOptions,
} from "../src/generated-bison.ts";

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-generated-bison-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeGeneration {
  readonly root: string;
  readonly binDir: string;
  readonly kompileExecutable: string;
  readonly bisonExecutable: string;
  readonly mainFile: string;
  readonly tempDir: string;
  readonly outputDir: string;
  readonly bypassBinDir: string;
}

async function fakeGeneration(): Promise<FakeGeneration> {
  const root = await scratch();
  const binDir = join(root, "bin");
  const kompileExecutable = join(binDir, "kompile");
  const bisonExecutable = join(binDir, "bison");
  const mainFile = join(root, "mini.k");
  const tempDir = join(root, "temp");
  const outputDir = join(root, "output");
  const bypassBinDir = join(root, "bypass-bin");
  await mkdir(binDir);
  await mkdir(bypassBinDir);
  await mkdir(tempDir);
  await writeFile(mainFile, "module MINI endmodule\n");
  await writeFile(
    bisonExecutable,
    `#!/bin/bash
if [[ "$1" == "--version" ]]; then
  echo "bison (GNU Bison) 3.8.2"
  echo "Written by Robert Corbett and Richard Stallman."
  exit 0
fi
candidate="$(/usr/bin/dirname "\${!#}")"
version="3.8.2"
if [[ "\${KTOOL_FAKE_MODE:-normal}" == "marker-mismatch" ]]; then version="3.8.1"; fi
/usr/bin/printf '#define YYBISON_VERSION "%s"\n' "$version" > "$candidate/parser.tab.c"
/usr/bin/printf '/* A Bison parser, made by GNU Bison %s.  */\n\n' "$version" > "$candidate/parser.tab.h"
if [[ "\${KTOOL_FAKE_MODE:-normal}" == "marker-disagreement" ]]; then
  /usr/bin/printf '/* A Bison parser, made by GNU Bison 3.8.1.  */\n\n' > "$candidate/parser.tab.h"
fi
if [[ "\${KTOOL_FAKE_MODE:-normal}" == "duplicate-c-marker" ]]; then
  /usr/bin/printf '#define YYBISON_VERSION "3.8.2"\n' >> "$candidate/parser.tab.c"
fi
if [[ "\${KTOOL_FAKE_MODE:-normal}" == "duplicate-header-marker" ]]; then
  /usr/bin/printf '/* A Bison parser, made by GNU Bison 3.8.2.  */\n' >> "$candidate/parser.tab.h"
fi
if [[ "\${KTOOL_FAKE_MODE:-normal}" == "misplaced-header-marker" ]]; then
  /usr/bin/printf '/* unexpected prefix */\n/* A Bison parser, made by GNU Bison 3.8.2.  */\n\n' > "$candidate/parser.tab.h"
fi
exit 0
`,
  );
  await writeFile(
    join(bypassBinDir, "bison"),
    `#!/bin/bash
if [[ "$1" == "--version" ]]; then echo "bison (GNU Bison) 3.8.2"; exit 0; fi
candidate="$(/usr/bin/dirname "\${!#}")"
/usr/bin/printf '#define YYBISON_VERSION "3.8.2"\n' > "$candidate/parser.tab.c"
/usr/bin/printf '/* A Bison parser, made by GNU Bison 3.8.2.  */\n\n' > "$candidate/parser.tab.h"
exit 0
`,
  );
  await writeFile(
    kompileExecutable,
    `#!/bin/bash
if [[ "$1" == "--version" ]]; then
  echo "K version:    v7.1.337"
  echo "Build date:   fake"
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
if [[ "\${KTOOL_FAKE_MODE:-normal}" == "failure" ]]; then
  echo "[Error] Inner Parser: fake generation failure" >&2
  exit 113
fi
/bin/mkdir -p "$output" "$temporary/.kompile-fake"
candidate="$temporary/.kompile-fake"
if [[ "\${KTOOL_FAKE_MODE:-normal}" != "zero" ]]; then
  top="SortPgm__"
  if [[ "\${KTOOL_FAKE_MODE:-normal}" == "wrong-top" ]]; then top="SortWrong__"; fi
  /usr/bin/printf '%%define lr.type ielr\n%%start top\n%%%%\ntop: %s ;\n%%%%\n' "$top" > "$candidate/parser.y"
fi
if [[ "\${KTOOL_FAKE_MODE:-normal}" == "wrapper-bypass" ]]; then PATH="$KTOOL_BYPASS_BIN:$PATH"; fi
if [[ "\${KTOOL_FAKE_MODE:-normal}" != "zero" ]]; then
  if [[ "\${KTOOL_FAKE_MODE:-normal}" == "wrong-bison-cwd" ]]; then
    bison -d -Wno-other -Wno-conflicts-sr -Wno-conflicts-rr "$candidate/parser.y"
  elif [[ "\${KTOOL_FAKE_MODE:-normal}" == "wrong-bison-argv" ]]; then
    (cd "$candidate" && bison -d -Wno-conflicts-sr -Wno-conflicts-rr "$candidate/parser.y")
  else
    (
      cd "$candidate"
      bison -d -Wno-other -Wno-conflicts-sr -Wno-conflicts-rr "$candidate/parser.y"
    )
  fi
fi
if [[ "\${KTOOL_FAKE_MODE:-normal}" == "multiple" ]]; then
  /bin/mkdir -p "$temporary/.kompile-second"
  /bin/cp "$candidate/parser.y" "$temporary/.kompile-second/parser.y"
fi
/usr/bin/touch "$output/parser_Pgm_MINI-SYNTAX"
/bin/ln -s "parser_Pgm_MINI-SYNTAX" "$output/parser_PGM"
if [[ "\${KTOOL_FAKE_MODE:-normal}" == "extra-parser" ]]; then
  /usr/bin/touch "$output/parser_Aux_AUX"
  /bin/ln -s "parser_Aux_AUX" "$output/parser_AUX"
fi
echo "retained successful stderr" >&2
exit 0
`,
  );
  await Promise.all([
    chmod(kompileExecutable, 0o755),
    chmod(bisonExecutable, 0o755),
    chmod(join(bypassBinDir, "bison"), 0o755),
  ]);
  return { root, binDir, kompileExecutable, bisonExecutable, mainFile, tempDir, outputDir, bypassBinDir };
}

function options(fixture: FakeGeneration, env: Readonly<Record<string, string>> = {}): GenerateBisonGrammarOptions {
  return {
    spec: {
      backend: "haskell",
      mainFile: fixture.mainFile,
      mainModule: "MINI",
      syntaxModule: "MINI-SYNTAX",
      haskellBinary: false,
    },
    startSort: "Pgm",
    syntaxModule: "MINI-SYNTAX",
    expectedKVersion: "v7.1.337",
    expectedBisonVersion: "3.8.2",
    kompileExecutable: fixture.kompileExecutable,
    bisonExecutable: fixture.bisonExecutable,
    tempDir: fixture.tempDir,
    outputDir: fixture.outputDir,
    env: { PATH: "", ...env },
  };
}

describe("generateBisonGrammar without K", () => {
  test("forces deterministic generation policy and retains exact source/process/version evidence", async () => {
    const fixture = await fakeGeneration();
    const generated = await generateBisonGrammar(options(fixture));
    expect(GeneratedBisonGrammarSchema.safeParse(generated).success).toBe(true);

    expect(generated.startSort).toBe("Pgm");
    expect(generated.syntaxModule).toBe("MINI-SYNTAX");
    expect(generated.source).toContain("%define lr.type ielr");
    expect(new TextDecoder().decode(generated.sourceBytes)).toBe(generated.source);
    expect(generated.sourceSha256).toHaveLength(64);
    expect(generated.kVersion.text).toBe("v7.1.337");
    expect(generated.bisonVersion.version).toBe("3.8.2");
    expect(generated.generatedBisonVersion).toBe("3.8.2");
    expect(generated.bisonInvocation).toMatchObject({
      requestedExecutable: fixture.bisonExecutable,
      requestedRealPath: fixture.bisonExecutable,
      snapshotSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      snapshotSize: (await readFile(fixture.bisonExecutable)).byteLength,
      cwd: dirname(generated.artifacts.parserSource),
    });
    expect(generated.bisonInvocation.argv).toEqual([
      generated.bisonInvocation.snapshotExecutable,
      "-d",
      "-Wno-other",
      "-Wno-conflicts-sr",
      "-Wno-conflicts-rr",
      generated.artifacts.parserSource,
    ]);
    expect(generated.versionMarkers.c).toEqual({ version: "3.8.2", line: '#define YYBISON_VERSION "3.8.2"' });
    expect(generated.versionMarkers.header).toEqual({
      version: "3.8.2",
      line: "/* A Bison parser, made by GNU Bison 3.8.2.  */",
    });
    expect(generated.kompile.process.stderr).toBe("retained successful stderr\n");
    expect(generated.kDiagnostics).toEqual([]);

    const argv = generated.kompile.process.args;
    expect(argv).toContain("--gen-bison-parser");
    expect(argv).not.toContain("--gen-glr-bison-parser");
    expect(argv).toContain("--debug");
    expect(argv).toContain("--warnings-to-errors");
    expect(argv.slice(argv.indexOf("--warnings"), argv.indexOf("--warnings") + 2)).toEqual(["--warnings", "all"]);
    expect(argv.slice(argv.indexOf("--type-inference-mode"), argv.indexOf("--type-inference-mode") + 2)).toEqual([
      "--type-inference-mode",
      "checked",
    ]);
    expect(argv.slice(argv.indexOf("-Wno"), argv.indexOf("-Wno") + 2)).toEqual(["-Wno", "unused-symbol"]);
    expect(argv.slice(argv.indexOf("--temp-dir"), argv.indexOf("--temp-dir") + 2)).toEqual([
      "--temp-dir",
      fixture.tempDir,
    ]);
    expect(argv.slice(argv.indexOf("--output-definition"), argv.indexOf("--output-definition") + 2)).toEqual([
      "--output-definition",
      fixture.outputDir,
    ]);
  });

  test.each([
    ["zero", "bison-invocation-unverified"],
    ["multiple", "parser-artifact-multiple"],
    ["wrong-top", "parser-identity-unsupported"],
    ["extra-parser", "parser-identity-unsupported"],
    ["marker-mismatch", "generated-bison-version-mismatch"],
    ["marker-disagreement", "generated-bison-version-mismatch"],
    ["duplicate-c-marker", "generated-bison-version-mismatch"],
    ["duplicate-header-marker", "generated-bison-version-mismatch"],
    ["misplaced-header-marker", "generated-bison-version-mismatch"],
  ] as const)("rejects %s output as %s", async (mode, code) => {
    const fixture = await fakeGeneration();
    expect(generateBisonGrammar(options(fixture, { KTOOL_FAKE_MODE: mode }))).rejects.toMatchObject({ code });
  });

  test("preserves diagnostics and CompletedProcess on K failure", async () => {
    const fixture = await fakeGeneration();
    try {
      await generateBisonGrammar(options(fixture, { KTOOL_FAKE_MODE: "failure" }));
      throw new Error("expected generation failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GeneratedBisonGrammarError);
      if (!(error instanceof GeneratedBisonGrammarError)) throw error;
      expect(error.code).toBe("kompile-failed");
      expect(error.process?.returncode).toBe(113);
      expect(error.process?.stderr).toContain("fake generation failure");
      expect(error.diagnostics).toHaveLength(1);
      expect(error.diagnostics[0]?.message).toBe("fake generation failure");
    }
  });

  test("rejects a K wrapper that shadows the selected same-version Bison", async () => {
    const fixture = await fakeGeneration();
    expect(
      generateBisonGrammar(
        options(fixture, { KTOOL_FAKE_MODE: "wrapper-bypass", KTOOL_BYPASS_BIN: fixture.bypassBinDir }),
      ),
    ).rejects.toMatchObject({ code: "bison-invocation-unverified" });
  });

  test.each(["wrong-bison-cwd", "wrong-bison-argv"])("rejects K's %s invocation", async (mode) => {
    const fixture = await fakeGeneration();
    expect(generateBisonGrammar(options(fixture, { KTOOL_FAKE_MODE: mode }))).rejects.toMatchObject({
      code: "bison-invocation-unverified",
    });
  });

  test("checks both selected tool versions before generation", async () => {
    const kFixture = await fakeGeneration();
    expect(generateBisonGrammar({ ...options(kFixture), expectedKVersion: "v7.1.338" })).rejects.toMatchObject({
      code: "k-version-mismatch",
    });
    const bisonFixture = await fakeGeneration();
    expect(generateBisonGrammar({ ...options(bisonFixture), expectedBisonVersion: "3.8.1" })).rejects.toMatchObject({
      code: "bison-version-mismatch",
    });
  });

  test("requires absolute fresh caller-owned paths and never removes their existing contents on failure", async () => {
    const fixture = await fakeGeneration();
    const sentinel = join(fixture.tempDir, "caller-owned");
    await writeFile(sentinel, "keep\n");
    expect(generateBisonGrammar(options(fixture, { KTOOL_FAKE_MODE: "zero" }))).rejects.toBeInstanceOf(
      GeneratedBisonGrammarError,
    );
    expect(await readFile(sentinel, "utf8")).toBe("keep\n");

    expect(generateBisonGrammar({ ...options(fixture), tempDir: "relative-temp" })).rejects.toMatchObject({
      code: "invalid-path",
    });
    expect(generateBisonGrammar(options(fixture))).rejects.toMatchObject({ code: "output-not-fresh" });
  });

  test("rejects caller attempts to request GLR, parser libraries, or a different syntax module", async () => {
    const fixture = await fakeGeneration();
    const base = options(fixture);
    expect(generateBisonGrammar({ ...base, spec: { ...base.spec, genGlrBisonParser: true } })).rejects.toMatchObject({
      code: "invalid-request",
    });
    expect(generateBisonGrammar({ ...base, spec: { ...base.spec, bisonParserLibrary: true } })).rejects.toMatchObject({
      code: "invalid-request",
    });
    expect(generateBisonGrammar({ ...base, syntaxModule: "OTHER" })).rejects.toMatchObject({
      code: "invalid-request",
    });
  });
});
