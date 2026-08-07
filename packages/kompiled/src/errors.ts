/**
 * The error contract.
 *
 * A `*-kompiled/` directory can be *well-formed and still unusable*, and the
 * three ways that happens are all "your directory was built wrong" rather than
 * "your file is corrupt".  They share a code path, and each says what to do
 * rather than what went wrong at the syscall:
 *
 * | condition                     | class                                | what the message must say                  |
 * | ----------------------------- | ------------------------------------ | ------------------------------------------ |
 * | no `compiled.json`            | {@link MissingCompiledJsonError}     | re-kompile with `--emit-json`              |
 * | `compiled.json` is KAST v3    | {@link UnsupportedKastVersionError}  | version found, version required, K release |
 * | no `backend.txt` (or another) | {@link MissingKompiledFileError}     | which file, in which directory             |
 *
 * All three extend {@link KompiledError}, so a caller that only wants to
 * distinguish "bad kompiled directory" from a real I/O failure can catch one
 * class.  They are `Error` subclasses with `name` set explicitly, because
 * `instanceof` across duplicated copies of a package is unreliable and `name`
 * is not.
 */

import { KAST_VERSION, KAST_VERSION_4_SINCE } from "./version.js";

/** Base class for every "this kompiled directory cannot be used" failure. */
export class KompiledError extends Error {
  /** The directory the failure is about. */
  readonly dir: string;

  constructor(dir: string, message: string) {
    super(message);
    this.name = "KompiledError";
    this.dir = dir;
  }
}

/**
 * A file the reader needs is not there.
 *
 * Used for the always-present artifacts (`backend.txt`, `mainModule.txt`,
 * `mainSyntaxModule.txt`, `timestamp`) and for the KORE artifacts.
 * `compiled.json` gets its own class, because its absence has a *cause* worth
 * naming — see {@link MissingCompiledJsonError}.
 */
export class MissingKompiledFileError extends KompiledError {
  /** The file's name within {@link KompiledError.dir}. */
  readonly file: string;

  constructor(dir: string, file: string, hint?: string) {
    super(dir, `Missing ${file} in kompiled directory: ${dir}${hint === undefined ? "" : `\n${hint}`}`);
    this.name = "MissingKompiledFileError";
    this.file = file;
  }
}

/**
 * `compiled.json` is absent — and that is the *default*, not an accident.
 *
 * `emitJson` defaults to `false` in the Java frontend
 * (`KompileOptions.java:159-161`) and to `True` in pyk
 * (`ktool/kompile.py:558`), so a directory built by a plain CLI `kompile` has
 * no `compiled.json` at all.  Reporting an ENOENT here sends people looking for
 * a missing file; what they need is a flag.
 */
export class MissingCompiledJsonError extends KompiledError {
  readonly file = "compiled.json";

  constructor(dir: string) {
    super(
      dir,
      `Missing compiled.json in kompiled directory: ${dir}\n` +
        "kompile does not emit it by default (KompileOptions.java:159-161). " +
        "Re-kompile with --emit-json.",
    );
    this.name = "MissingCompiledJsonError";
  }
}

/**
 * `compiled.json` is a KAST-JSON document of the wrong version.
 *
 * The message names all three things a reader needs: what was found, what is
 * required, and the K release that started emitting it.  `@kframework-ts/kast`
 * is v4-only by design (`kast/src/version.ts`); if you have a v3 directory and
 * cannot re-kompile, `@kframework-ts/kast-json` reads both.
 */
export class UnsupportedKastVersionError extends KompiledError {
  /** The KAST artifact that carried the unsupported envelope. */
  readonly file: "compiled.json" | "parsed.json";
  /** The version found in the document — `undefined` when the field was absent or not a number. */
  readonly found: number | undefined;
  /** The version this package requires: {@link KAST_VERSION}. */
  readonly required: number = KAST_VERSION;

  constructor(dir: string, found: number | undefined, file: "compiled.json" | "parsed.json" = "compiled.json") {
    super(
      dir,
      `Unsupported KAST format version in ${dir}/${file}: found ${found ?? "none"}, ` +
        `version ${KAST_VERSION} required.\n` +
        `K emits version ${KAST_VERSION} since ${KAST_VERSION_4_SINCE} (ToJson.java:56); re-kompile with a newer K, ` +
        "or read the document with @kframework-ts/kast-json, which supports versions 3 and 4.",
    );
    this.name = "UnsupportedKastVersionError";
    this.file = file;
    this.found = found;
  }
}

/**
 * `compiled.json` is not a KAST document at all — no `format`/`version`
 * envelope, or not JSON.
 *
 * Distinct from {@link UnsupportedKastVersionError} because the remedy differs:
 * a wrong version is a toolchain age problem, a wrong shape is a wrong file.
 */
export class InvalidKompiledFileError extends KompiledError {
  readonly file: string;

  constructor(dir: string, file: string, detail: string) {
    super(dir, `Invalid ${file} in kompiled directory: ${dir}\n${detail}`);
    this.name = "InvalidKompiledFileError";
    this.file = file;
  }
}

/**
 * `findKompiledDir` found no `*-kompiled` directory, or more than one.
 *
 * `Kompile.default_directory` (`ktool/kompile.py:228-238`) raises `ValueError`
 * with these two messages; they are kept close to verbatim because tooling
 * downstream of pyk greps for them.
 */
export class KompiledDirNotFoundError extends KompiledError {
  /** The `*-kompiled` directories found — empty, or two or more. */
  readonly candidates: readonly string[];

  constructor(cwd: string, candidates: readonly string[]) {
    super(
      cwd,
      candidates.length === 0
        ? `Could not find \`*-kompiled\` directory in ${cwd}, use --definition to specify one.`
        : `More than one \`*-kompiled\` directory found in ${cwd} ` +
            `(${candidates.slice(0, 2).join(", ")}, ...), use \`--definition\` to specify one.`,
    );
    this.name = "KompiledDirNotFoundError";
    this.candidates = candidates;
  }
}
