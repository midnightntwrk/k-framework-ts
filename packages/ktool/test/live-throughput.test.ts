/**
 * The three B9 fast paths, against a real K installation.
 *
 * `describeKompiled` keeps this suite inert unless `KFRAMEWORK_TS_K_BIN`
 * explicitly selects the pinned K distribution; the fixture is
 * `fixtures/live-k/tiny-parser.k`, kompiled **once per test session** with
 * `--gen-glr-bison-parser` so the kompiled directory carries a real
 * `parser_Exp_TINY-PARSER-SYNTAX` binary.
 *
 * # What each test is actually claiming
 *
 * Every item in this file has the same acceptance criterion, and it is not "is
 * it faster": it is **"does this loop avoid starting a JVM"**. That is
 * checkable without a stopwatch, so it is checked without one:
 *
 * - the native parser — `KparseResult.parser !== undefined` is the statement
 *   "this parse ran a 30 KB C binary, not `java -cp …`", and the KORE it
 *   produced is asserted **byte-identical** to what `kast --output kore`
 *   produces for the same text, because a fast path that answered differently
 *   would be a bug and not an optimisation;
 * - the definition cache — object identity across loads;
 * - the kserver — the socket answers a Nailgun probe, and `kast` run against it
 *   produces the same bytes as `kast` run cold.
 *
 * Nothing here asserts a *duration*. A shared CI runner can be arbitrarily slow
 * and a test that failed on one would be deleted within a month; the measured
 * numbers live in `src/kparse.ts`'s and `src/kserver.ts`'s module headers, where
 * they can carry the machine and the release they were taken on.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ksort, ktoken } from "@kframework-ts/kast";
import { loadKompiledLayout } from "@kframework-ts/kompiled";
import { KoreParser, koreText } from "@kframework-ts/kore";
import { describeKompiled, requireKTestEnvironment } from "@kframework-ts/ktool/testing";

import { clearKompiledDefinitionCache, loadKompiledDefinitionCached } from "../src/definition-cache.ts";
import { llvmInterpret } from "../src/interpreter.ts";
import { runKast } from "../src/kast-cli.ts";
import { korePrint } from "../src/kore-print.ts";
import { findBisonParser, kparse, resolveKparseTarget } from "../src/kparse.ts";
import { KPrint } from "../src/kprint.ts";
import { kserverRunning, kserverSocketPath, KSERVER_SOCKET_ENV, spawnKserver } from "../src/kserver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TINY = join(HERE, "fixtures", "live-k", "tiny-parser.k");

/** A short socket directory: `<dir>/socket` must fit in 104 bytes of `sun_path`. */
const scratchDirs: string[] = [];
async function shortScratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-ks-"));
  scratchDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PROGRAM = "1 + 2 + 3";

/**
 * Bun's per-test default is 5 s, which a cold `kompile --backend llvm` blows
 * through: the session-scoped fixture compiles inside whichever test awaits it
 * first, and the SIGTERM that follows looks like a kompile failure rather than
 * a timeout.  120 s is what the other live suites in this monorepo use.
 */
const LIVE_TIMEOUT_MS = 120_000;

/** A cold JVM plus a Nailgun bind, twice, on a loaded runner. */
const KSERVER_TIMEOUT_MS = 180_000;

describeKompiled(
  describe,
  "B9 spawn-layer throughput",
  {
    backend: "llvm",
    mainFile: TINY,
    mainModule: "TINY-PARSER",
    syntaxModule: "TINY-PARSER-SYNTAX",
    genGlrBisonParser: true,
  },
  (definitionDirPromise) => {
    //////////////////////////////
    // 1. the native parser     //
    //////////////////////////////

    test(
      "kompile --gen-glr-bison-parser writes the binary kparse's rule looks for",
      async () => {
        const definitionDir = await definitionDirPromise;
        const layout = await loadKompiledLayout(definitionDir);

        // The defaults resolve with no help from the caller: module from
        // `mainSyntaxModule.txt`, sort from `declaredConfigVar_PGM`.
        expect(resolveKparseTarget(layout)).toEqual({ sort: "Exp", module: "TINY-PARSER-SYNTAX" });

        const parser = await findBisonParser(definitionDir, layout);
        expect(parser).toBeDefined();
        expect(parser?.path).toBe(join(definitionDir, "parser_Exp_TINY-PARSER-SYNTAX"));
        expect((await stat(parser?.path ?? "")).isFile()).toBe(true);
      },
      LIVE_TIMEOUT_MS,
    );

    test(
      "the native parser and `kast --output kore` agree, byte for byte",
      async () => {
        const definitionDir = await definitionDirPromise;
        const environment = await requireKTestEnvironment();

        const native = await kparse({ definitionDir, text: PROGRAM });
        const jvm = await kparse({
          definitionDir,
          text: PROGRAM,
          native: false,
          command: [join(environment.binDir, "kast")],
        });

        // The claim that matters: no JVM on the first, a JVM on the second.
        expect(native.parser).toBeDefined();
        expect(jvm.parser).toBeUndefined();
        // And the claim that licenses it: same bytes.
        expect(native.kore).toBe(jvm.kore);
        expect(native.kore).toContain("Lbl'UndsPlusUndsUnds'TINY-PARSER-SYNTAX");
      },
      LIVE_TIMEOUT_MS,
    );

    test(
      "a loop of N parses starts N native parsers and zero JVMs",
      async () => {
        const definitionDir = await definitionDirPromise;
        const layout = await loadKompiledLayout(definitionDir);
        // Resolve once, as a harness in a hot loop would.
        const parser = await findBisonParser(definitionDir, layout);
        expect(parser).toBeDefined();

        const results = [];
        for (let n = 0; n < 20; n += 1) {
          results.push(await kparse({ definitionDir, text: `${n} + 1`, ...(parser === undefined ? {} : { parser }) }));
        }
        expect(results.every((r) => r.parser !== undefined)).toBe(true);
        expect(new Set(results.map((r) => r.kore)).size).toBe(20);
      },
      LIVE_TIMEOUT_MS,
    );

    test(
      "KPrint.parseToken takes the native path and returns the same KAST as `kast` does",
      async () => {
        const definitionDir = await definitionDirPromise;
        const environment = await requireKTestEnvironment();
        const kprint = await KPrint.load(definitionDir, { command: [join(environment.binDir, "kast")] });

        expect(await kprint.bisonParser({ sort: "Exp" })).toBeDefined();

        const token = ktoken(PROGRAM, ksort("Exp"));
        const fast = await kprint.parseToken(token);
        const slow = await kprint.parseToken(token, { native: false });
        expect(fast).toEqual(slow);
      },
      LIVE_TIMEOUT_MS,
    );

    test(
      "`asRule` never takes the native path — a program grammar has no variables",
      async () => {
        const definitionDir = await definitionDirPromise;
        const environment = await requireKTestEnvironment();
        const kprint = await KPrint.load(definitionDir, { command: [join(environment.binDir, "kast")] });

        // The generated parser would reject `X:Int`; `kast --input rule` accepts
        // it, which is the observable difference between the two routes.
        const rule = await kprint.parseToken(ktoken("X:Int + 1", ksort("Exp")), { asRule: true });
        expect(rule).toBeDefined();
      },
      LIVE_TIMEOUT_MS,
    );

    //////////////////////////////
    // 1b. unparsing, no JVM    //
    //////////////////////////////

    test(
      "kore-print and the interpreter actually run — the /dev/stdin regression",
      async () => {
        // Both of these were **completely broken** before `src/stdio.ts`: pyk
        // passes `/dev/stdin`, and a child that Node or Bun spawned cannot open
        // it. There is no subtlety to this test; it exists because the two
        // functions could not be called at all.
        const definitionDir = await definitionDirPromise;
        const { kore } = await kparse({ definitionDir, text: PROGRAM });

        const pretty = await korePrint(kore, { definitionDir, output: "pretty" });
        expect(pretty).toBe(PROGRAM);

        // `1 + 2` and not `1 + 2 + 3`: the fixture's one rule needs two Ints, and
        // `(1 + 2) + 3` has an Exp on the left, so only the shorter term reduces.
        const { kore: reducible } = await kparse({ definitionDir, text: "1 + 2" });
        const initial =
          `LblinitGeneratedTopCell{}(Lbl'Unds'Map'Unds'{}(Lbl'Stop'Map{}(),` +
          `Lbl'UndsPipe'-'-GT-Unds'{}(inj{SortKConfigVar{}, SortKItem{}}(\\dv{SortKConfigVar{}}("$PGM")),` +
          `inj{SortExp{}, SortKItem{}}(${reducible}))))`;
        const final = await llvmInterpret(definitionDir, new KoreParser(initial).pattern());
        expect(koreText(final)).toContain(`\\dv{SortInt{}}("3")`);
      },
      LIVE_TIMEOUT_MS,
    );

    test(
      "KORE → text with no child process at all",
      async () => {
        // B9's "native kprint/kore-print for unparsing" asks for unparsing that
        // does not spawn. The in-process route is konvert + the Formatter, and
        // this pins that it agrees with `kore-print --output pretty`, which does.
        const definitionDir = await definitionDirPromise;
        const kprint = await KPrint.load(definitionDir, { conversionStrategy: "pure" });
        const { kore } = await kprint.kparse(PROGRAM);
        const pattern = new KoreParser(kore).pattern();

        const inProcess = kprint.formatPrint(await kprint.koreToKast(pattern));
        const viaKorePrint = await korePrint(pattern, { definitionDir, output: "pretty" });
        expect(inProcess.trim()).toBe(viaKorePrint.trim());
      },
      LIVE_TIMEOUT_MS,
    );

    //////////////////////////////
    // 2. the definition cache  //
    //////////////////////////////

    test(
      "N loads of one kompiled directory parse compiled.json once",
      async () => {
        const definitionDir = await definitionDirPromise;
        clearKompiledDefinitionCache(definitionDir);

        const first = await loadKompiledDefinitionCached(definitionDir);
        // Force the parse, so the identity assertions below are about a
        // *parsed* definition and not about two equally lazy wrappers.
        expect(first.definition).toBeDefined();

        for (let n = 0; n < 20; n += 1) {
          const again = await loadKompiledDefinitionCached(definitionDir);
          expect(again).toBe(first);
          expect(again.definition).toBe(first.definition);
        }
      },
      LIVE_TIMEOUT_MS,
    );

    //////////////////////////////
    // 3. the kserver           //
    //////////////////////////////

    test(
      "spawnKserver starts a JVM the K binaries then reuse, and stopKserver stops it",
      async () => {
        const definitionDir = await definitionDirPromise;
        const environment = await requireKTestEnvironment();
        const socketDir = await shortScratch();

        const before = process.env[KSERVER_SOCKET_ENV];
        const kserver = await spawnKserver({ socketDir });

        try {
          expect(kserver.spawned).toBe(true);
          expect(kserver.socketPath).toBe(kserverSocketPath(socketDir));
          expect((await stat(kserver.socketPath)).isSocket()).toBe(true);
          // The probe `checkJava` makes on every K invocation.
          expect(await kserverRunning({ socketDir })).toBe(true);
          // The integration: the variable is published, so a wrapper that
          // inherits the environment routes through the server with no plumbing.
          expect(process.env[KSERVER_SOCKET_ENV]).toBe(socketDir);
          expect(kserver.env[KSERVER_SOCKET_ENV]).toBe(socketDir);

          const kast = [join(environment.binDir, "kast")];
          const args = {
            command: kast,
            definitionDir,
            input: "program",
            output: "kore",
            sort: "Exp",
          } as const;

          const first = await runKast({ ...args, file: await programFile() });
          const second = await runKast({ ...args, file: await programFile() });

          // Same answer through the server as without it. Durations are not
          // asserted; see the file header.
          const cold = await runKast({ ...args, file: await programFile(), env: withoutKserver() });
          expect(first.stdout).toBe(cold.stdout);
          expect(second.stdout).toBe(cold.stdout);

          // `reset` clears the definition cache without killing the JVM, which is
          // what a harness does between generations of a recompiled definition.
          await kserver.reset();
          expect(await kserverRunning({ socketDir })).toBe(true);
        } finally {
          expect(await kserver.stop()).toBe(true);
        }

        expect(await kserverRunning({ socketDir })).toBe(false);
        // The export is undone, absence restored as absence.
        expect(process.env[KSERVER_SOCKET_ENV]).toBe(before);
      },
      KSERVER_TIMEOUT_MS,
    );

    test(
      "a second spawnKserver on a live socket adopts rather than starting a second JVM",
      async () => {
        const socketDir = await shortScratch();
        const first = await spawnKserver({ socketDir, exportSocket: false });
        try {
          const second = await spawnKserver({ socketDir, exportSocket: false });
          expect(second.spawned).toBe(false);
          expect(second.pid).toBeUndefined();
          // Stopping an adopted handle leaves the server alone.
          await second.stop();
          expect(await kserverRunning({ socketDir })).toBe(true);
        } finally {
          await first.stop();
        }
      },
      KSERVER_TIMEOUT_MS,
    );
  },
);

/** A scratch file holding {@link PROGRAM} — `runKast` takes a path, not text. */
let programPath: Promise<string> | undefined;
function programFile(): Promise<string> {
  programPath ??= (async () => {
    const dir = await shortScratch();
    const path = join(dir, "p.exp");
    await Bun.write(path, PROGRAM);
    return path;
  })();
  return programPath;
}

/** `process.env` with `KSERVER_SOCKET` pointed nowhere, forcing a cold JVM. */
function withoutKserver(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  env[KSERVER_SOCKET_ENV] = join(tmpdir(), "ktool-no-such-kserver");
  return env;
}
