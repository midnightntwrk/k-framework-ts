#!/usr/bin/env node
/**
 * The `kompile-soak` entry point.  All logic lives in `kompile-soak.ts`, which
 * is a function of its arguments and its two injected sinks; this file exists
 * only to bind that to the process — the same split `packages/kompiled`'s
 * `bin.ts`/`cli.ts` uses, and for the same reason: the command stays testable
 * without spawning one.
 */

import { main } from "./kompile-soak.js";

/** The slice of `process` this needs, narrowed through `globalThis` (see `bin.ts` in `kompiled`). */
interface ProcessLike {
  readonly argv: readonly string[];
  exitCode: number;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const currentProcess = (globalThis as unknown as { process: ProcessLike }).process;

currentProcess.exitCode = main(
  currentProcess.argv.slice(2),
  (text) => void currentProcess.stdout.write(text),
  (text) => void currentProcess.stderr.write(text),
);
