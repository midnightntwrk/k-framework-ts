#!/usr/bin/env node
/**
 * The `kompiled` executable.  All logic lives in `cli.ts`, which is a pure
 * function of its arguments and its injected effects; this file exists only to
 * bind that to the process, so the command can be tested without spawning one.
 */

import { main } from "./cli.js";

/**
 * The slice of `process` this needs, narrowed through `globalThis`.
 *
 * See `ksources.ts` for why a global is reached by assertion rather than by an
 * ambient declaration.
 */
interface ProcessLike {
  readonly argv: readonly string[];
  exitCode: number;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const process = (globalThis as unknown as { process: ProcessLike }).process;

process.exitCode = await main(
  process.argv.slice(2),
  (text) => void process.stdout.write(text),
  (text) => void process.stderr.write(text),
);
