/**
 * Handing a child process a *path* it can `open()`, because `/dev/stdin` and
 * `/dev/stdout` are not it.
 *
 * # The finding, and it is not a small one
 *
 * pyk hands three K tools the literal paths `/dev/stdin` and `/dev/stdout` in
 * their argv and delivers the data over the pipe:
 *
 * - `kore_print` — `['kore-print', '/dev/stdin', …]` with `input=pattern.text`
 *   (`pyk/kore/tools.py:58,77`);
 * - `llvm_interpret_raw` — `[interpreter, '/dev/stdin', depth, '/dev/stdout']`
 *   with `input=kore` (`pyk/ktool/krun.py:476-477`);
 * - and, by the same idiom, anything else that wants "stdin, but as a
 *   filename".
 *
 * **That does not work from Node or from Bun.** Both runtimes give a spawned
 * child a `socketpair(2)` for its piped stdio, not a `pipe(2)`. `/dev/stdin` is
 * a symlink to `/proc/self/fd/0`, and reopening a *socket* through `/proc` is
 * `ENXIO` — so the child fails with:
 *
 * ```text
 * cannot access '/dev/stdin': No such device or address
 * Cannot read file: /dev/stdin
 * ```
 *
 * …and the same for `/dev/stdout`. Verified on Linux with `node` 26 and `bun`
 * 1.3 (`readlink /proc/self/fd/0` in a spawned child prints
 * `socket:[…]`, and both `cat /dev/stdin` and `echo > /dev/stdout` fail). It is
 * **not** a WSL artefact and it is **not** a Bun bug: `libuv`'s
 * `UV_STDIO_CREATE_PIPE` is a socketpair on purpose, so that the same handle
 * type works for IPC. CPython's `subprocess` uses a real `pipe(2)`, which is
 * why the idiom is fine upstream and fatal here.
 *
 * A shell pipeline — `echo x | kore-print /dev/stdin` — works, because a shell
 * really does use `pipe(2)`. That is why the failure is invisible until you
 * drive the tool from a program, and why it survived into a published package.
 *
 * # The fix, and why it is a temp file rather than a probe
 *
 * Materialise the data as a real file and put *its* path in the argv. The
 * alternatives were considered and rejected:
 *
 * - **`stdio: 'inherit'`** would make `/dev/stdin` openable when the parent's
 *   own stdin is a file — and unopenable when it is a terminal or a pipe from
 *   the parent's parent. A library whose correctness depends on how its
 *   caller was invoked is not a library.
 * - **A named FIFO** avoids the write to disk but deadlocks on the open unless
 *   both ends are opened concurrently, and buys nothing: these payloads are
 *   KORE terms, and the write is dwarfed by the parse on the other side.
 * - **Runtime detection** (open `/dev/stdin` and see) costs a syscall per call
 *   to select between a path that works and a path that sometimes works.
 *
 * So: always a temp file, always deleted, deletion in a `finally` so a throwing
 * body still cleans up. {@link DEV_STDIN} and {@link DEV_STDOUT} are exported
 * because the *pure* argv builders still emit them — `llvmInterpretArgs` is
 * pyk's list and stays pyk's list — and a caller comparing an argv against a
 * golden should be able to name the constant rather than the string.
 */

import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `/dev/stdin` — what pyk puts in the argv, and what a child cannot open here. */
export const DEV_STDIN = "/dev/stdin" as const;

/** `/dev/stdout` — likewise (`pyk/ktool/krun.py:476`). */
export const DEV_STDOUT = "/dev/stdout" as const;

/** Where a substitute file is created, and what it is called. */
export interface StdioFileOptions {
  /** Defaults to the system temp directory. */
  readonly directory?: string;
  /** Defaults to `ktool-`. */
  readonly prefix?: string;
  /** Defaults to `''`. */
  readonly suffix?: string;
}

/**
 * Write `contents` to a fresh file, run `body` with its path, delete it.
 *
 * The substitute for `/dev/stdin`. The name is a UUID rather than a counter
 * because two concurrent calls against one definition must not collide, and
 * because `mkstemp`-style `O_EXCL` retry logic is not worth writing when
 * `randomUUID` exists.
 */
export async function withStdinFile<T>(
  contents: string,
  options: StdioFileOptions,
  body: (path: string) => Promise<T>,
): Promise<T> {
  const path = temporaryPath(options);
  await writeFile(path, contents, "utf8");
  try {
    return await body(path);
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

/**
 * Give `body` a path to write to, and hand back both its result and the bytes
 * that appeared there.
 *
 * The substitute for `/dev/stdout`. The file is **created empty first**, so a
 * child that opens it for reading — or a caller that reads it after a child
 * that wrote nothing — sees an empty file rather than `ENOENT`. That matters
 * for `llvmInterpret`, whose "produced no output" branch (`krun.py:449`) is a
 * real and distinguishable outcome, not an error.
 */
export async function withStdoutFile<T>(
  options: StdioFileOptions,
  body: (path: string) => Promise<T>,
): Promise<{ readonly result: T; readonly output: string }> {
  const path = temporaryPath(options);
  await writeFile(path, "", "utf8");
  try {
    const result = await body(path);
    return { result, output: await readFile(path, "utf8").catch(() => "") };
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

function temporaryPath(options: StdioFileOptions): string {
  return join(options.directory ?? tmpdir(), `${options.prefix ?? "ktool-"}${randomUUID()}${options.suffix ?? ""}`);
}
