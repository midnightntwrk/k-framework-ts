#!/usr/bin/env node
/**
 * The `ktool` executable.  All logic lives in `cli.ts`, which is a function of
 * its arguments and its injected sinks; this file exists only to bind that to
 * the process, so every subcommand can be tested without spawning one.
 */

import { main } from "./cli.js";

/**
 * The slice of `process` this needs, narrowed through `globalThis`.
 *
 * This package's emit config does have `@types/node` — `proc.ts` needs it — but
 * the binding is written the way every sibling's is, so a reader comparing
 * `bin.ts` files finds one file and not two.
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
