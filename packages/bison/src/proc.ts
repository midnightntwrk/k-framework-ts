import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";

import { z } from "zod";

export type ProcessLogger = (message: string) => void;

/** A signal name reported by the operating system when a process exits by signal. */
export type ProcessSignal = string;

export interface CompletedProcess {
  readonly args: readonly string[];
  readonly returncode?: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: ProcessSignal | undefined;
  readonly cancelledBy?: "timeout" | "abort" | undefined;
}

export const CompletedProcessSchema: z.ZodType<CompletedProcess> = z.object({
  args: z.array(z.string()),
  returncode: z.number().optional(),
  stdout: z.string(),
  stderr: z.string(),
  signal: z.union([z.string(), z.undefined()]),
  cancelledBy: z.enum(["timeout", "abort"]).optional(),
});

export interface ProcessControlOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly killGraceMs?: number;
}

export interface RunProcessOptions extends ProcessControlOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
  readonly check?: boolean;
}

export class ProcessError extends Error {
  readonly result: CompletedProcess;

  constructor(result: CompletedProcess) {
    super(`Command failed with status ${String(result.returncode)}: ${result.args.join(" ")}`);
    this.name = "ProcessError";
    this.result = result;
  }
}

export async function checkDirPath(path: string): Promise<void> {
  const status = await stat(path);
  if (!status.isDirectory()) throw new Error(`Not a directory: ${path}`);
}

export async function checkFilePath(path: string): Promise<void> {
  const status = await stat(path);
  if (!status.isFile()) throw new Error(`Not a file: ${path}`);
}

export async function resolveOnPath(
  command: string,
  path: string | undefined,
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  if (command === "") return undefined;
  const candidates =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [isAbsolute(command) ? command : resolvePath(cwd, command)]
      : (path ?? "").split(delimiter).map((entry) => join(entry || ".", command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

export async function runProcess(args: readonly string[], options: RunProcessOptions = {}): Promise<CompletedProcess> {
  const executable = args[0];
  if (executable === undefined || executable === "") throw new Error("Cannot run an empty command");
  if (options.cwd !== undefined) await checkDirPath(options.cwd);
  if (options.signal?.aborted === true) throw new Error(`Command was aborted before it started: ${args.join(" ")}`);

  return new Promise<CompletedProcess>((resolve, reject) => {
    const child = spawn(executable, args.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    let stdout = "";
    let stderr = "";
    let cancelledBy: CompletedProcess["cancelledBy"];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      stop("abort");
    };
    const stop = (reason: "timeout" | "abort") => {
      if (cancelledBy !== undefined) return;
      cancelledBy = reason;
      child.kill("SIGTERM");
      const grace = options.killGraceMs ?? 2_000;
      setTimeout(() => {
        child.kill("SIGKILL");
      }, grace).unref();
    };
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        stop("timeout");
      }, options.timeoutMs);
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Uint8Array) => {
      const text = Buffer.from(chunk).toString("utf8");
      stdout += text;
      options.logger?.(text);
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      const text = Buffer.from(chunk).toString("utf8");
      stderr += text;
      options.logger?.(text);
    });
    child.once("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const result: CompletedProcess = Object.freeze({
        args: Object.freeze([...args]),
        ...(code === null ? {} : { returncode: code }),
        stdout,
        stderr,
        signal: signal ?? undefined,
        ...(cancelledBy === undefined ? {} : { cancelledBy }),
      });
      if (options.check !== false && (result.returncode !== 0 || result.cancelledBy !== undefined))
        reject(new ProcessError(result));
      else resolve(result);
    });
  });
}
