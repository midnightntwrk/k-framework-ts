#!/usr/bin/env node
/**
 * The `kore-rpc` executable.  All logic lives in `cli.ts`, which is a pure
 * function of its arguments; this file exists only to bind that to the
 * process, so the command can be tested without spawning one.
 *
 * Note that this is the *drift-check* CLI, not a way to run a kore-rpc
 * server — starting one of those is `@kframework-ts/kore-rpc/server`.
 */

import { main } from "./cli.js";

process.exitCode = await main(
  process.argv.slice(2),
  (text) => void process.stdout.write(text),
  (text) => void process.stderr.write(text),
);
