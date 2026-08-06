#!/usr/bin/env node
/**
 * The `konvert` executable.  All logic lives in `cli.ts`, which is a pure
 * function of its arguments; this file exists only to bind that to the
 * process, so the command can be tested without spawning one.
 */

import { main } from "./cli.js";

/**
 * The slice of `process` this needs, narrowed through `globalThis`.
 *
 * The emit config sets `types: []` so the published `.d.ts` cannot drag
 * `@types/bun` into consumers, which leaves no ambient `process`; declaring one
 * would collide with Bun's under the development config.
 */
interface ProcessLike {
  readonly argv: readonly string[];
  exitCode: number;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

// See `ksources.ts` for why a global is reached by assertion rather than by an
// ambient declaration.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const process = (globalThis as unknown as { process: ProcessLike }).process;

process.exitCode = await main(
  process.argv.slice(2),
  (text) => void process.stdout.write(text),
  (text) => void process.stderr.write(text),
);
