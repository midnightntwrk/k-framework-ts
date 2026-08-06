/**
 * **Producing** the two binary inputs: the hint stream, and the rich header it
 * is decoded against.
 *
 * Two spawns, and they have very different requirements:
 *
 * | call | runs | needs K on `PATH`? |
 * | --- | --- | --- |
 * | {@link generateProofHints} | `<definitionDir>/interpreter` | **no** |
 * | {@link generateKoreRichHeader} | `kore-rich-header` | yes |
 *
 * The asymmetry is worth stating because it decides how a corpus runner is
 * built: the header is produced **once per definition** and can be shipped with
 * it, after which every traced run is a bare native `interpreter` spawn with no
 * K installation anywhere near it.  That is the whole R9 argument for this path
 * over kore-rpc — the engine does not change, and nothing warms up.
 *
 * # `generateProofHints` is pyk's `generate_hints`
 *
 * `pyk/src/pyk/kllvm/compiler.py:101-130`:
 *
 * ```python
 * args = [str(interpreter), str(input_kore_file), '-1', str(hints_file), '--proof-output']
 * ```
 *
 * — the interpreter's ordinary `<input> <depth> <output>` argv
 * (`@kframework-ts/ktool`'s `llvmInterpretArgs`) with `--proof-output`
 * appended, which repurposes the third positional from "the final
 * configuration" to "the hint stream".  Nothing else changes, including the
 * `-1` sentinel for "run to completion".
 *
 * **Verified equivalent to `krun --proof-hint`** at K v7.1.337: the same
 * program through both paths produced byte-identical 2 537-byte files.  So this
 * function is not a lesser version of the `krun` route; it is the same bytes
 * without the JVM.
 *
 * # Why this does not go through `llvmInterpretRaw`
 *
 * `@kframework-ts/ktool`'s wrapper builds the same argv and would be the right
 * call, but it reads its output file as **UTF-8 text**
 * (`ktool/src/stdio.ts:120`, `readFile(path, "utf8")`) and a hint stream is
 * binary — every multi-byte sentinel would come back as replacement
 * characters.  So the temp-file dance is repeated here against `readFile` with
 * no encoding, and `runProcess`/`checkFilePath`/`withStdinFile` are reused
 * unchanged.  The `/dev/stdin` hazard that forced ktool's `stdio.ts` into
 * existence applies here identically and is avoided the same way.
 *
 * # Failure is not an error
 *
 * An interpreter whose input does not parse still writes the eight-byte
 * `HINT`+version header and exits non-zero — measured.  `check` therefore
 * defaults to **`false`**, unlike everywhere else in this monorepo: R10 asks
 * that a failing run still produce a trace, and throwing away the bytes the
 * backend did write in order to raise on the exit status would be the opposite.
 * The status is returned instead.
 */

import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { koreText, type Pattern } from "@kframework-ts/kore";
import {
  checkFilePath,
  llvmInterpretArgs,
  runProcess,
  withStdinFile,
  type CompletedProcess,
  type ProcessLogger,
} from "@kframework-ts/ktool";

import { KoreHeader } from "./header.js";

/** `--proof-output` — the interpreter flag (`pyk/kllvm/compiler.py:124`). */
export const PROOF_OUTPUT_FLAG = "--proof-output" as const;

/** The default `kore-rich-header` command, as found on `PATH`. */
export const KORE_RICH_HEADER = "kore-rich-header" as const;

/** Options shared by both spawns. */
export interface GenerateOptions {
  /** The child's working directory. */
  readonly cwd?: string;
  /** The child's whole environment, replacing this process's. */
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
}

/** Options for one traced interpreter run. */
export interface GenerateProofHintsOptions extends GenerateOptions {
  /** Maximal number of rewrite steps.  Absent means `-1`, "to completion". */
  readonly depth?: number;
  /**
   * Throw on a non-zero exit.  Defaults to **`false`** — see the module header.
   */
  readonly check?: boolean;
  /** Where the temporary input and hint files are created.  Defaults to the system temp directory. */
  readonly directory?: string;
}

/** A traced run: the bytes, and what the interpreter did. */
export interface ProofHintsResult {
  /** The whole hint stream, ready for {@link parseProofTrace}. */
  readonly hints: Uint8Array;
  /** The child's exit status, stderr and argv — `@kframework-ts/ktool`'s shape. */
  readonly process: CompletedProcess;
}

/**
 * The argv for one traced run — pyk's list (`kllvm/compiler.py:124`), pure.
 *
 * Exported so a caller can pin it against a golden, and so the `--proof-output`
 * position (last, after the three positionals) is stated somewhere testable.
 */
export function proofHintsArgs(definitionDir: string, inputFile: string, hintsFile: string, depth?: number): string[] {
  return [...llvmInterpretArgs(definitionDir, depth, inputFile, hintsFile), PROOF_OUTPUT_FLAG];
}

/**
 * Run `<definitionDir>/interpreter` over a KORE **pattern** with proof-hint
 * output enabled.
 *
 * The definition must have been kompiled with
 * `--llvm-proof-hint-instrumentation` (`@kframework-ts/ktool`'s
 * `llvmProofHintInstrumentation`).  Without it the run succeeds and the hint
 * file holds nothing but the header — which parses, to an empty trace, and is
 * the symptom to recognise.
 *
 * @throws {Error} when `<definitionDir>/interpreter` is not a file, checked
 *   before the spawn so a haskell-backend directory says so.
 */
export async function generateProofHints(
  definitionDir: string,
  input: Pattern | string,
  options: GenerateProofHintsOptions = {},
): Promise<ProofHintsResult> {
  await checkFilePath(join(definitionDir, "interpreter"));

  const hintsFile = temporaryPath(options.directory, "prooftrace-hints-", ".bin");
  // Created empty first, for the reason `ktool/src/stdio.ts` gives: a run that
  // writes nothing must be an empty file, not an `ENOENT`.
  await writeFile(hintsFile, new Uint8Array());
  try {
    const process = await withStdinFile(
      typeof input === "string" ? input : koreText(input),
      {
        ...(options.directory === undefined ? {} : { directory: options.directory }),
        prefix: "prooftrace-in-",
        suffix: ".kore",
      },
      (inputFile) =>
        runProcess(proofHintsArgs(definitionDir, inputFile, hintsFile, options.depth), {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.logger === undefined ? {} : { logger: options.logger }),
          check: options.check === true,
        }),
    );
    return Object.freeze({ hints: await readFile(hintsFile), process });
  } finally {
    await unlink(hintsFile).catch(() => undefined);
  }
}

/** Options for the header spawn. */
export interface KoreRichHeaderOptions extends GenerateOptions {
  /** The command to run.  Defaults to `["kore-rich-header"]`; pass a full path to skip `PATH`. */
  readonly command?: readonly string[];
  /** Where the temporary output file is created.  Defaults to the system temp directory. */
  readonly directory?: string;
}

/**
 * Run `kore-rich-header <definition.kore> -o <file>` and read the bytes back —
 * `tools/kore-rich-header/main.cpp`, and pyk's `header` fixture
 * (`pyk/src/pyk/testing/_kompiler.py:372-382`).
 *
 * `-o` rather than pyk's `stdout` capture, because
 * `@kframework-ts/ktool`'s `runProcess` decodes stdout as UTF-8 and this output
 * is binary.  The flag is the tool's own (`main.cpp:21-27`), not a workaround.
 *
 * The result is a **property of the definition**, not of a run: generate it
 * once, cache it beside `definition.kore`, reuse it for every trace.
 */
export async function generateKoreRichHeader(
  definitionKore: string,
  options: KoreRichHeaderOptions = {},
): Promise<Uint8Array> {
  await checkFilePath(definitionKore);
  const command = options.command ?? [KORE_RICH_HEADER];
  const outputFile = temporaryPath(options.directory, "prooftrace-header-", ".bin");
  await writeFile(outputFile, new Uint8Array());
  try {
    await runProcess([...command, definitionKore, "-o", outputFile], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      check: true,
    });
    return await readFile(outputFile);
  } finally {
    await unlink(outputFile).catch(() => undefined);
  }
}

/** {@link generateKoreRichHeader}, parsed — the call a caller almost always wants. */
export async function loadKoreRichHeader(
  definitionKore: string,
  options: KoreRichHeaderOptions = {},
): Promise<KoreHeader> {
  return KoreHeader.parse(await generateKoreRichHeader(definitionKore, options));
}

function temporaryPath(directory: string | undefined, prefix: string, suffix: string): string {
  return join(directory ?? tmpdir(), `${prefix}${randomUUID()}${suffix}`);
}
