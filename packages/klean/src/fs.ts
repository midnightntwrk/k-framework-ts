/** Node-only materialisation of an in-memory KLean project. */

import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { GeneratedProject } from "./generate.js";

/** The destination package directory already exists. Nothing was written. */
export class KleanOutputExistsError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Directory exists: ${path}`);
    this.name = "KleanOutputExistsError";
    this.path = path;
  }
}

export interface WriteKleanProjectOptions {
  /** Write `klean-manifest.json` alongside the Lake project. Defaults to true. */
  readonly manifest?: boolean;
}

/** Stage every file, then install the complete project as `<packageName>/`. */
export async function writeKleanProject(
  project: GeneratedProject,
  outputDirectory: string,
  options: WriteKleanProjectOptions = {},
): Promise<string> {
  const output = resolve(outputDirectory);
  const destination = join(output, project.manifest.packageName);
  if (await pathExists(destination)) throw new KleanOutputExistsError(destination);

  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(output, `.${safeTemporaryName(project.manifest.packageName)}.klean-`));
  let installed = false;
  try {
    for (const [path, text] of project.files) {
      const target = safeProjectPath(staging, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
    }
    if (options.manifest !== false) {
      await writeFile(join(staging, "klean-manifest.json"), `${JSON.stringify(project.manifest, null, 2)}\n`, "utf8");
    }
    if (await pathExists(destination)) throw new KleanOutputExistsError(destination);
    await rename(staging, destination);
    installed = true;
    return destination;
  } finally {
    if (!installed) await rm(staging, { recursive: true, force: true });
  }
}

function safeProjectPath(root: string, path: string): string {
  if (path.length === 0 || isAbsolute(path)) throw new TypeError(`Unsafe generated path: ${JSON.stringify(path)}`);
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError(`Unsafe generated path: ${JSON.stringify(path)}`);
  }
  return target;
}

function safeTemporaryName(packageName: string): string {
  const name = basename(packageName).replaceAll(/[^A-Za-z0-9_.-]/gu, "-");
  return name.length === 0 ? "project" : name;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
