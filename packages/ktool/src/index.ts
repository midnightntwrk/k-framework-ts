/**
 * `@kframework-ts/ktool` — the package that runs the K binaries.
 *
 * Every other package in this monorepo is hermetic: `kast`, `kore`, `konvert`,
 * `k-parser` and `kompiled` read bytes and return values, and none of them can
 * start a process. That is a property worth keeping, so the subprocess layer
 * lives here and only here. If you find yourself importing
 * `node:child_process` in a sibling, the code belongs in this package.
 *
 * At milestone 1 that meant **kompile**: constructing its argv, finding it on
 * `PATH`, running it, and reading its version back. The argv construction is
 * pure and is the bulk of the surface — `kompileArgs`, `kompileCallArgs` and
 * `buildKompileArgv` never touch a filesystem, so a build script can be tested
 * against a golden argv with no K installed at all. `kompile()` itself is the
 * thin spawning shell around them.
 *
 * ```ts
 * import { buildKompileArgv, kompile } from "@kframework-ts/ktool";
 *
 * const spec = { backend: "haskell", mainFile: "imp.k", mainModule: "IMP" } as const;
 * buildKompileArgv(spec, { outputDir: "out" });
 * // ["kompile", "imp.k", "--main-module", "IMP", "--emit-json",
 * //  "--backend", "haskell", "--output-definition", "out"]
 *
 * const dir = await kompile(spec, { outputDir: "out" });
 * ```
 *
 * The output of that is what `@kframework-ts/kompiled` reads — and `emitJson`
 * defaulting to `true` here (pyk's default, not the CLI's) is precisely why it
 * can.
 *
 * Milestone 2 adds the **run/print** half: `kast-cli.ts` (the `kast` binary,
 * and the 128 KiB expression→tempfile switch), `kore-print.ts`, `kprint.ts`
 * (`KPrint`, composed over `@kframework-ts/kompiled` rather than inherited
 * from), `krun.ts` (`KRun` and the argv golden table pyk's own unit test
 * pins) and `interpreter.ts` — the LLVM backend's `interpreter`, which is the
 * one wrapper here that needs **no K on `PATH`**.
 *
 * ```ts
 * import { KRun, llvmInterpret } from "@kframework-ts/ktool";
 *
 * const final = await llvmInterpret("imp-kompiled", pattern);   // no K needed
 *
 * const krun = await KRun.load("imp-kompiled");
 * const text = await krun.run(pattern, { output: "pretty" });   // needs krun
 * ```
 *
 * Milestone 3 adds the **claims** half: `claim-index.ts` (pure — an index over
 * a spec's `KClaim`s with dependency closure and topological order),
 * `claim-loader.ts` (the `<spec>.json` cache over an injected `ModuleParser`;
 * its digest scheme deliberately diverges from pyk's — see the module header)
 * and `parse-modules.ts` (the cterm-free `kprove --dry-run --emit-json-spec`
 * wrapper that is the default `ModuleParser`).
 *
 * Milestone 5 is the **throughput** half — three ways to not start a JVM, for
 * the workloads that spawn one in a loop:
 *
 * - `kparse.ts` — the K distribution's `kparse` lookup rule. A definition
 *   kompiled with `--gen-glr-bison-parser` carries native
 *   `parser_<Sort>_<Module>` binaries; using one costs ~0.8 ms where `kast`
 *   costs ~1 250 ms. `KPrint.parseToken` takes this path by default.
 * - `definition-cache.ts` — one parse of `compiled.json`/`definition.kore` per
 *   `(directory, build)`, shared by every `KPrint.load` of that directory.
 * - `kserver.ts` — `spawnKserver`/`stopKserver`/`resetKserver` and
 *   `KSERVER_SOCKET`, so the JVM tools that have no native path (`kompile`,
 *   `kprove`) run inside a warm Nailgun server. None of this is transcribed
 *   from pyk, which does none of it; the sources are the K distribution's shell
 *   scripts, cited file-and-line in each module header.
 *
 * ```ts
 * import { KPrint, spawnKserver } from "@kframework-ts/ktool";
 *
 * const kserver = await spawnKserver({ socketDir: "/tmp/ks" });   // every later spawn is warm
 * const kprint = await KPrint.load("imp-kompiled");               // compiled.json parsed once
 * const { parser } = await kprint.kparse("3 + 4", { sort: "AExp" });
 * parser !== undefined;                                           // ⇒ no JVM at all
 * await kserver.stop();
 * ```
 *
 * Milestone 4 ships it: `cli.ts`/`bin.ts` add the `ktool` command — `kompile`,
 * `run`, `parse`, `claims` and the house `check-k` — each a thin shell over one
 * of the calls above, with `ktool kompile … --dry-run` printing the argv and
 * spawning nothing. `cli.ts` is deliberately **not** re-exported here: a CLI is
 * a program, not an API, and this entry point is the whole public API — there is
 * no deep-import contract.
 */

export * from "./claim-index.js";
export * from "./claim-loader.js";
export * from "./definition-cache.js";
export * from "./distribution.js";
export * from "./interpreter.js";
export * from "./kast-cli.js";
export * from "./kompile.js";
export * from "./kore-print.js";
export * from "./kparse.js";
export * from "./kprint.js";
export * from "./krun.js";
export * from "./kserver.js";
export * from "./ksources.js";
export * from "./parse-modules.js";
export * from "./proc.js";
export * from "./stdio.js";
export * from "./version.js";
