#!/usr/bin/env node

import { main } from "./cli.js";

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
