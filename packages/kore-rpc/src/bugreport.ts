/**
 * Replayable failure recording — the `@kframework-ts/kore-rpc/bugreport` entry
 * point: pyk's `BugReport` tar archive, and a {@link Transport} decorator that
 * fills one in as a session runs.
 *
 * Transcribed from pyk's `BugReport` (`k/pyk/src/pyk/utils.py:696-743`), its
 * client-side producer (`k/pyk/src/pyk/kore/rpc.py:371-385`) and its two
 * server-side producers (`rpc.py:1417-1427` for `KoreServer`,
 * `rpc.py:1548-1552` for `BoosterServer`). The archive's **consumer** is not in
 * pyk at all — it is `kore-rpc-client run-tarball`
 * (`haskell-backend/booster/tools/rpc-client/RpcClient.hs:488-645`), which is
 * what makes this a wire format rather than a private convenience, and which is
 * cited below wherever it constrains a choice.
 *
 * ```ts
 * import { KoreClient, tcpTransport } from "@kframework-ts/kore-rpc";
 * import { bugReport, recordingTransport } from "@kframework-ts/kore-rpc/bugreport";
 * import { koreRpcServer } from "@kframework-ts/kore-rpc/server";
 *
 * const report = bugReport("proof-42.tar");
 * const server = await koreRpcServer({ kompiledDir, moduleName: "IMP", bugReport: report });
 * const client = new KoreClient(
 *   recordingTransport(await tcpTransport(server.host, server.port, { timeout: 30_000 }), report, {
 *     id: "proof-42",
 *   }),
 * );
 * ```
 *
 * # Why the recorder is a transport decorator
 *
 * pyk records inside `JsonRpcClient.request`, between building the request text
 * and parsing the response text (`rpc.py:365-385`). That is the only place pyk
 * *can* record, because its transport is an implementation detail of the
 * client. Here {@link Transport} is already the seam over
 * **already-serialized JSON text**, so recording is a decorator over it and
 * nothing in `client.ts` has to know the feature exists: the bytes the recorder
 * writes are the bytes that went on the wire, by construction rather than by
 * agreement.
 *
 * The one thing the decorator does not get for free is pyk's `req_id`, which
 * upstream reads off the client object. It is recovered from the payload
 * instead — see {@link recordingTransport}.
 *
 * # The layout, and what reads it
 *
 * ```text
 * definition.kore                                  the haskell definition
 * server_version.txt                               `<server> --version`
 * server_instance.json                             {exe, module, extra_args}
 * llvm_definition/definition.kore                  booster only
 * llvm_version.txt                                 booster only
 * <id>/<instance>/<req-id>_request.json            one per request
 * <id>/<instance>/<req-id>_response.json           one per response
 * sequence/000                                     "<the arcname above>"
 * sequence/001                                     …
 * commands/NNN.sh                                  a re-runnable command line
 * ```
 *
 * `run-tarball` unpacks every `*.json` that lives in a **subdirectory**
 * (`RpcClient.hs:557-586`: a top-level file is skipped), pairs each
 * `X_request.json` with `X_response.json` (`:592-599`), and orders the pairs by
 * looking each request's *path* up in a map built from `sequence/NNN`, whose
 * file **contents** are that path (`:580-584`, `:551-555`). Three consequences
 * this module is built around, none of them obvious from pyk's side:
 *
 * 1. the string written into `sequence/NNN` must be **byte-identical** to the
 *    member name of the request it orders, or the pair silently sorts by name;
 * 2. requests must live at least one directory deep;
 * 3. a member whose name does not end in `_request.json`/`_response.json` is
 *    inert — which is what makes {@link recordingTransport}'s `_cancel.json`
 *    files (deviation 5 below) safe to add.
 *
 * # Deliberate deviations from pyk
 *
 * 1. **The archive is deterministic, byte for byte.** pyk writes every member
 *    through a `NamedTemporaryFile` and lets `tarfile` stamp it with that
 *    file's mode (`0600`), the process's uid/gid and name, and the wall clock
 *    (`utils.py:718-722`), so two identical sessions produce two different
 *    archives. Here mode is {@link BUG_REPORT_MODE}, mtime is
 *    {@link BUG_REPORT_MTIME}, and uid/gid/uname/gname are zero and empty.
 *    A recording is then a diffable artifact: two runs of the same proof
 *    produce the same bytes, and a diff is a real behavioural difference. That
 *    is a hard requirement here (an agent-driven run must leave an artifact a
 *    human can compare), and nothing downstream reads any of those fields —
 *    `run-tarball` looks at the name, the type flag and the size, and nothing
 *    else. Both are overridable per report if a caller wants real timestamps.
 * 2. **No temporary files.** pyk's `add_file_contents` writes a temp file only
 *    so that `tarfile.add` has a path to stat; the bytes are the same either
 *    way, and skipping it removes a filesystem dependency from the pure half of
 *    this module.
 * 3. **The instance segment counts from 1.** pyk's is `id(self)`, the client
 *    object's memory address (`rpc.py:372`), which is unique per live client
 *    and different on every run. {@link BugReport.newInstanceId} hands out
 *    `1`, `2`, … per report, which has the same "distinct per client" property
 *    and is deterministic — deviation (1) would be pointless without it.
 * 4. **Arcname segments are sanitized.** pyk's ids are always
 *    `<address>-<NNN>`, so no id it builds can contain a `/`. This package lets
 *    a caller label a client freely ({@link client!KoreClientOptions.label}),
 *    and a label with a slash in it would create a directory and break the
 *    `sequence/` ↔ member-name identity that `run-tarball` depends on. See
 *    {@link sanitizeSegment}.
 * 5. **A `cancel` is recorded, out of sequence.** pyk's `send_interrupt` never
 *    reaches its recorder, so a cancelled request appears in the archive as a
 *    request with a `-32000` response and no trace of what caused it. The
 *    decorator writes the cancel payload as `<req-id>_cancel.json` and
 *    deliberately does **not** index it in `sequence/`: it has no response, so
 *    a replayer must not try to send it, and the name is inert to
 *    `RpcClient.hs:531` (`stripSuffix "_request.json"`).
 * 6. **A failing `--version` probe does not stop the server.** See
 *    `server.ts`; pyk's `run_process_2` raises (`rpc.py:1420`).
 *
 * # What is *not* a deviation
 *
 * GNU tar format, including the `././@LongLink` prefix entry for a member name
 * over 99 bytes; the two-zero-block terminator padded out to a 10 240-byte
 * record; the archive being rewritten to a valid state after **every** member,
 * so a session killed mid-proof still leaves a readable report; the
 * `_file_remap` table and the argument rewriting {@link BugReport.addCommand}
 * does with it; the shared counter behind `sequence/` and `commands/`; and the
 * `.tar` suffix replacement on the path the report is constructed with.
 *
 * # Replaying a recording
 *
 * There is no replayer here and there is no replayer in pyk either; upstream's
 * is the `kore-rpc-client` binary that ships with the haskell backend
 * (`RpcClient.hs:440-462`). Given `proof-42.tar`:
 *
 * ```sh
 * tar xf proof-42.tar definition.kore server_instance.json   # and llvm_definition/ for a booster
 * jq -r .module server_instance.json                         # -> <MODULE>
 * kore-rpc definition.kore --module <MODULE> --server-port 12341 &
 * kore-rpc-client run-tarball proof-42.tar --port 12341
 * ```
 *
 * `run-tarball` replays every recorded request in `sequence/` order and diffs
 * each answer against the recorded response, exiting `2` on the first
 * divergence (`--keep-going` to see them all). Reading one request or response
 * by hand is `kore-rpc-ts rpc-print`, and turning a recorded response back into
 * the next request to send is `kore-rpc-ts rpc-kast` — see `inspect.ts`, which is
 * the other half of this loop.
 */

import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Transport } from "./transport.js";

//////////////////////
// Tar encoding     //
//////////////////////

/** One tar header, and the unit every member is padded to. */
export const TAR_BLOCK_SIZE = 512;

/**
 * The blocking factor tar writes to: 20 blocks.
 *
 * `tarfile` pads the whole archive out to a multiple of this on close, and so
 * does this module — an archive that stops on a block boundary but not a record
 * boundary is legal, but it is not what pyk's file looks like.
 */
export const TAR_RECORD_SIZE = 20 * TAR_BLOCK_SIZE;

/** Every member's mode — see deviation (1). Overridable per report. */
export const BUG_REPORT_MODE = 0o644;

/** Every member's mtime, in **seconds** — see deviation (1). */
export const BUG_REPORT_MTIME = 0;

/** `typeflag` for a regular file. */
const TYPE_REGULAR = "0";

/** `typeflag` for GNU's long-name prefix entry. */
const TYPE_LONG_NAME = "L";

/** The name GNU gives the long-name prefix entry. Not a path; a marker. */
const LONG_NAME_MARKER = "././@LongLink";

/** The longest `name[100]` a header can hold, with room for the terminating NUL. */
const MAX_NAME_BYTES = 99;

const UTF8 = new TextEncoder();

/** Per-member header overrides — see {@link BUG_REPORT_MODE} and deviation (1). */
export interface TarMemberOptions {
  /** Unix mode bits. Defaults to {@link BUG_REPORT_MODE}. */
  readonly mode?: number;
  /** Modification time, **seconds** since the epoch. Defaults to {@link BUG_REPORT_MTIME}. */
  readonly mtime?: number;
}

/** Round `bytes` up to the next whole {@link TAR_BLOCK_SIZE}. */
function padTo(bytes: number, unit: number): number {
  const remainder = bytes % unit;
  return remainder === 0 ? bytes : bytes + (unit - remainder);
}

/**
 * Write an octal numeric field: `width - 1` zero-padded digits, then a NUL.
 *
 * This is `tarfile.itn`'s GNU branch for a value that fits (`0000600\0`,
 * `00000000021\0`). Values too large for the field would need GNU's base-256
 * escape, which nothing here can produce: the only numeric fields are a mode, a
 * zero uid/gid, an mtime and a size, and a member large enough to overflow a
 * 12-digit octal size (8 GiB) is not a bug report anyone can mail.
 */
function octalField(target: Uint8Array, offset: number, width: number, value: number): void {
  const digits = width - 1;
  const text = Math.trunc(value).toString(8).padStart(digits, "0");
  if (text.length > digits) {
    throw new RangeError(`Value does not fit a ${String(width)}-byte octal tar field: ${String(value)}`);
  }
  for (let index = 0; index < digits; index += 1) {
    // `charCodeAt` is safe: octal digits are ASCII by construction.
    target[offset + index] = text.charCodeAt(index);
  }
  target[offset + digits] = 0;
}

/**
 * Write bytes at `offset`, NUL-padded to `width`.
 *
 * Bytes and not a string, because the one field that can overflow — `name[100]`
 * — is truncated to a byte count, and truncating a *string* would either split
 * a multi-byte character into a replacement character (changing the bytes) or
 * need a second encode to find out how long the result was.
 */
function bytesField(target: Uint8Array, offset: number, width: number, bytes: Uint8Array): void {
  if (bytes.length > width) {
    throw new RangeError(`Value does not fit a ${String(width)}-byte tar field: ${String(bytes.length)} bytes`);
  }
  target.set(bytes, offset);
}

/** {@link bytesField} for a value that is known to be ASCII and to fit. */
function textField(target: Uint8Array, offset: number, width: number, text: string): void {
  bytesField(target, offset, width, UTF8.encode(text));
}

/**
 * The header checksum: the unsigned sum of all 512 bytes with the checksum
 * field itself read as eight spaces, written as six octal digits, a NUL and a
 * space (`016303\0 `).
 *
 * The trailing `NUL SPACE` rather than `SPACE NUL` is what GNU tar and Python's
 * `tarfile` both write; readers accept either, and matching the producer this
 * transcribes keeps a golden comparison against `tarfile` meaningful.
 */
function writeChecksum(header: Uint8Array): void {
  for (let index = 148; index < 156; index += 1) header[index] = 0x20;
  let sum = 0;
  for (const byte of header) sum += byte;
  const text = sum.toString(8).padStart(6, "0");
  for (let index = 0; index < 6; index += 1) header[148 + index] = text.charCodeAt(index);
  header[154] = 0;
  header[155] = 0x20;
}

/** One 512-byte GNU header block. `name` is already truncated to 100 bytes. */
function tarHeader(name: Uint8Array, size: number, typeflag: string, mode: number, mtime: number): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  bytesField(header, 0, 100, name);
  octalField(header, 100, 8, mode);
  octalField(header, 108, 8, 0); // uid — deviation (1)
  octalField(header, 116, 8, 0); // gid — deviation (1)
  octalField(header, 124, 12, size);
  octalField(header, 136, 12, mtime);
  textField(header, 156, 1, typeflag);
  // GNU's magic is the six bytes `ustar ` followed by the version ` \0`, which
  // is what distinguishes it from POSIX ustar's `ustar\0` / `00`.
  textField(header, 257, 6, "ustar ");
  header[263] = 0x20;
  header[264] = 0;
  // uname/gname stay empty — deviation (1). Everything after them (devmajor,
  // devminor, and GNU's atime/ctime/offset/sparse block) is zero for a plain
  // regular file, which is what `tarfile` writes too.
  writeChecksum(header);
  return header;
}

/**
 * One complete archive member: header, contents, and padding to a block
 * boundary — with GNU's `././@LongLink` prefix entry when the name does not fit
 * `name[100]`.
 *
 * The long-name entry is a member of its own whose *contents* are the real
 * name plus a NUL (hence `+ 1` in its size) and whose type flag is `L`; the
 * real header then follows with its `name[100]` holding the first 100 bytes of
 * the name, which is what a reader that does not understand `L` will see.
 * `run-tarball` reads the archive through `Tar.decodeLongNames`
 * (`RpcClient.hs:510`), so it resolves them.
 */
export function tarMember(name: string, contents: Uint8Array, options: TarMemberOptions = {}): Uint8Array {
  const mode = options.mode ?? BUG_REPORT_MODE;
  const mtime = options.mtime ?? BUG_REPORT_MTIME;
  const nameBytes = UTF8.encode(name);

  const parts: Uint8Array[] = [];
  if (nameBytes.length > MAX_NAME_BYTES) {
    const marker = new Uint8Array(padTo(nameBytes.length + 1, TAR_BLOCK_SIZE));
    marker.set(nameBytes, 0);
    // The long-name entry carries no ownership or timestamp of its own: GNU
    // writes it with a zero mode and a zero mtime, and so does `tarfile`.
    parts.push(tarHeader(UTF8.encode(LONG_NAME_MARKER), nameBytes.length + 1, TYPE_LONG_NAME, 0, 0), marker);
  }

  parts.push(tarHeader(nameBytes.subarray(0, 100), contents.length, TYPE_REGULAR, mode, mtime));

  const body = new Uint8Array(padTo(contents.length, TAR_BLOCK_SIZE));
  body.set(contents, 0);
  parts.push(body);

  return concat(parts);
}

/**
 * The end-of-archive marker for a body of `bodyBytes`: two zero blocks, then
 * enough further zeros to land on a {@link TAR_RECORD_SIZE} boundary.
 *
 * Padding to the record and not merely to the two blocks is `tarfile.close`'s
 * behaviour, and it is why a pyk bug report is always a multiple of 10 240
 * bytes.
 */
export function tarEndOfArchive(bodyBytes: number): Uint8Array {
  return new Uint8Array(padTo(bodyBytes + 2 * TAR_BLOCK_SIZE, TAR_RECORD_SIZE) - bodyBytes);
}

/** Join byte arrays, because `Uint8Array` has no `concat`. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

//////////////////////
// Where it goes    //
//////////////////////

/**
 * Where a {@link BugReport}'s bytes live, and where the files it archives are
 * read from.
 *
 * Two operations rather than an "append", because the archive is kept **valid
 * after every member**: the terminator written last time has to be overwritten
 * by the next member, so a sink is asked to make the archive exactly
 * `existing[0 … offset] ++ bytes` and nothing more. That is what `tarfile`'s
 * append mode does internally, and it is what gives a killed session a readable
 * report.
 */
export interface BugReportSink {
  /** What this sink is, for messages — a path, or something like `<memory>`. */
  readonly description: string;

  /** Truncate to `offset`, then write `bytes` there. */
  write(offset: number, bytes: Uint8Array): void;

  /** The bytes of an input file being archived by path. */
  readFile(path: string): Uint8Array;
}

/** A {@link BugReportSink} that keeps the archive in memory — tests, and callers that ship bytes elsewhere. */
export class MemoryBugReportSink implements BugReportSink {
  readonly description = "<memory>";

  private bytes = new Uint8Array(0);

  private readonly files: Map<string, Uint8Array>;

  constructor(files: ReadonlyMap<string, Uint8Array> = new Map()) {
    this.files = new Map(files);
  }

  /** The archive as it stands, terminator included. */
  get archive(): Uint8Array {
    return this.bytes;
  }

  write(offset: number, bytes: Uint8Array): void {
    const out = new Uint8Array(offset + bytes.length);
    out.set(this.bytes.subarray(0, offset), 0);
    out.set(bytes, offset);
    this.bytes = out;
  }

  readFile(path: string): Uint8Array {
    const contents = this.files.get(path);
    if (contents === undefined) throw new Error(`No such file in this sink: ${path}`);
    return contents;
  }
}

/** Options for {@link fileBugReportSink} and {@link bugReport}. */
export interface FileBugReportOptions {
  /**
   * Where a warning about an existing archive being removed goes.
   *
   * pyk logs it (`utils.py:707-709`); this package has no logger, and deleting
   * a previous report without saying so is the kind of silence that costs
   * somebody an afternoon.
   */
  readonly onWarn?: (message: string) => void;
}

/**
 * A {@link BugReportSink} writing to a real `.tar` — the one you want.
 *
 * An archive already at `path` is **removed**, as pyk does (`utils.py:707-709`):
 * a report is one session, and appending a second session's requests to the
 * first's would produce a tarball that replays as neither. The parent directory
 * is created if it does not exist, which pyk does not do — a `--bug-report
 * out/reports/x.tar` that fails on the first request because `out/reports` is
 * missing is a worse failure than the one it reports on.
 */
export function fileBugReportSink(path: string, options: FileBugReportOptions = {}): BugReportSink {
  if (existsSync(path)) {
    options.onWarn?.(`Bug report exists, removing: ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  // Truncate-or-create in one call, so a fresh report starts from zero bytes
  // whether or not one was there.
  closeSync(openSync(path, "w"));

  return {
    description: path,
    write(offset: number, bytes: Uint8Array): void {
      const fd = openSync(path, "r+");
      try {
        ftruncateSync(fd, offset);
        writeSync(fd, bytes, 0, bytes.length, offset);
      } finally {
        closeSync(fd);
      }
    },
    readFile(input: string): Uint8Array {
      return readFileSync(input);
    },
  };
}

//////////////////////
// The report       //
//////////////////////

/** Options for {@link BugReport}. */
export interface BugReportOptions extends TarMemberOptions {}

/**
 * pyk's `.tar` suffix rule: `Path(p).with_suffix('.tar')`
 * (`utils.py:703`).
 *
 * `pathlib` replaces the **last** suffix and adds one where there is none, and
 * a leading dot is not a suffix — so `x` → `x.tar`, `x.json` → `x.tar`,
 * `x.tar.gz` → `x.tar.tar`, `.hidden` → `.hidden.tar`. Reproduced exactly,
 * oddities included, because a caller who has read pyk's docs should get pyk's
 * file name.
 */
export function tarPathFor(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? `${path.slice(0, slash + 1)}${base.slice(0, dot)}.tar` : `${path}.tar`;
}

/**
 * What a name segment may contain — see deviation (4).
 *
 * Everything else becomes `_`. The set is deliberately narrow: the segment ends
 * up both as a path inside the archive and, for a request, as the literal
 * contents of a `sequence/` file that `run-tarball` compares against that path,
 * so anything a `tar` implementation or a shell might normalize differently is
 * a hazard. An empty result becomes `_` rather than vanishing, because a
 * vanished segment collapses two directory levels into one.
 */
export function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/gu, "_");
  return cleaned.length === 0 ? "_" : cleaned;
}

/**
 * A bug-report archive being written — pyk's `BugReport`
 * (`utils.py:696-743`).
 *
 * Every `add*` call appends one member and leaves the file valid, so the
 * archive is readable at any moment, including after the process that was
 * writing it died. Nothing here is async: pyk's is synchronous too, and a
 * recorder whose writes could interleave with each other would produce a
 * `sequence/` index that does not describe the session.
 *
 * Construct one with {@link bugReport} for the usual case (a path), or
 * directly over a {@link MemoryBugReportSink} to keep the bytes.
 */
export class BugReport {
  private readonly sink: BugReportSink;

  private readonly memberOptions: TarMemberOptions;

  /** Bytes of archive *body* — everything except the terminator. */
  private bodyBytes = 0;

  /** pyk's `_command_id`: shared by `sequence/` and `commands/` (`utils.py:698`). */
  private commandSeq = 0;

  /** Deviation (3): pyk's `id(self)`, made a counter. */
  private instanceSeq = 0;

  /** pyk's `_file_remap`: input path → arcname, and the dedupe for `addFile`. */
  private readonly remap = new Map<string, string>();

  constructor(sink: BugReportSink, options: BugReportOptions = {}) {
    this.sink = sink;
    this.memberOptions = options;
  }

  /** What this report is being written to — a path, or `<memory>`. */
  get description(): string {
    return this.sink.description;
  }

  /** How many `sequence/`+`commands/` entries have been written — pyk's `_command_id`. */
  get commandId(): number {
    return this.commandSeq;
  }

  /** The `input path → arcname` table {@link addCommand} rewrites against. */
  get fileRemap(): ReadonlyMap<string, string> {
    return this.remap;
  }

  /**
   * Archive a file from disk under `arcname` — pyk's `add_file`
   * (`utils.py:711-716`).
   *
   * **Idempotent per input path, not per arcname**: a path already archived is
   * skipped entirely, and the arcname it was first given stays in the remap
   * table. That is pyk's rule, and it is what makes archiving the same
   * `definition.kore` from two servers cost one member.
   */
  addFile(inputPath: string, arcname: string): void {
    if (this.remap.has(inputPath)) return;
    this.remap.set(inputPath, arcname);
    this.addMember(arcname, this.sink.readFile(inputPath));
  }

  /** Archive bytes under `arcname` — pyk's `add_file_contents` (`utils.py:718-722`), minus the temp file. */
  addFileContents(contents: string | Uint8Array, arcname: string): void {
    this.addMember(arcname, typeof contents === "string" ? UTF8.encode(contents) : contents);
  }

  /**
   * Index an already-archived member as the next step of the session — pyk's
   * `add_request` (`utils.py:724-726`).
   *
   * The member written is `sequence/NNN`, whose entire contents are `reqName`.
   * `run-tarball` builds `contents → NNN` and sorts the request list by it
   * (`RpcClient.hs:580-584`, `:551-555`), so `reqName` must be the *exact*
   * member name of the request or response it orders.
   */
  addRequest(reqName: string): void {
    this.addFileContents(reqName, `sequence/${this.nextCommandId()}`);
  }

  /**
   * Archive a command line as a runnable script — pyk's `add_command`
   * (`utils.py:728-743`).
   *
   * Every argument that names a file already archived is rewritten to that
   * file's arcname, including an argument *inside* an archived directory, so
   * the script refers to the unpacked report rather than to a machine nobody
   * else has. Arguments are joined with a single space and are **not** quoted,
   * exactly as pyk does — a path with a space in it produces a script that
   * needs an edit before it runs, which is upstream's behaviour and not worth
   * diverging from silently.
   */
  addCommand(args: Iterable<string>): void {
    const remapped = [...args].map((arg) => this.remapArg(arg));
    const script = `#!/usr/bin/env bash\nset -euxo pipefail\n${remapped.join(" ")}\n`;
    this.addFileContents(script, `commands/${this.nextCommandId()}.sh`);
  }

  /**
   * A fresh per-client directory segment — deviation (3), pyk's `id(self)`.
   *
   * {@link recordingTransport} calls this once per decorated transport, so two
   * transports sharing a report cannot collide on a request id.
   */
  newInstanceId(): string {
    this.instanceSeq += 1;
    return String(this.instanceSeq);
  }

  //////////////////////
  // Internals        //
  //////////////////////

  /** Append one member and re-write the terminator behind it. */
  private addMember(arcname: string, contents: Uint8Array): void {
    const member = tarMember(arcname, contents, this.memberOptions);
    const body = this.bodyBytes + member.length;
    this.sink.write(this.bodyBytes, concat([member, tarEndOfArchive(body)]));
    this.bodyBytes = body;
  }

  /** `NNN`, zero-padded to three, then bumped — pyk's `f'{self._command_id:03}'`. */
  private nextCommandId(): string {
    const id = String(this.commandSeq).padStart(3, "0");
    this.commandSeq += 1;
    return id;
  }

  /** pyk's `_remap_arg` (`utils.py:729-737`). */
  private remapArg(arg: string): string {
    const exact = this.remap.get(arg);
    if (exact !== undefined) return exact;
    for (const [input, arcname] of this.remap) {
      // `is_relative_to` on paths, done on strings: an argument is inside an
      // archived directory when it starts with that directory plus a
      // separator. Comparing raw strings (rather than normalizing) is pyk's
      // behaviour too — `Path` normalization would not survive the join below
      // any better.
      const prefix = input.endsWith("/") ? input : `${input}/`;
      if (arg.startsWith(prefix)) return `${arcname.replace(/\/+$/u, "")}/${arg.slice(prefix.length)}`;
    }
    return arg;
  }
}

/**
 * A {@link BugReport} writing to `path`, whose extension is replaced with
 * `.tar` — pyk's `BugReport(Path)` constructor.
 */
export function bugReport(path: string, options: BugReportOptions & FileBugReportOptions = {}): BugReport {
  return new BugReport(fileBugReportSink(tarPathFor(path), options), options);
}

//////////////////////
// The recorder     //
//////////////////////

/** pyk's default `base_name` when no `bug_report_id` was given (`rpc.py:371`). */
export const DEFAULT_BUG_REPORT_ID = "kore_rpc";

/** Options for {@link recordingTransport}. */
export interface RecordingTransportOptions {
  /**
   * pyk's `bug_report_id` (`rpc.py:309`): the top-level directory this
   * client's traffic goes under. Defaults to {@link DEFAULT_BUG_REPORT_ID}.
   *
   * Give it a per-proof value when several proofs share one report. pyk's own
   * reason is the same and is worth repeating: parallel workers writing into
   * one archive interleave, and the id is what lets a reader tell whose
   * requests are whose.
   */
  readonly id?: string;

  /**
   * The second path segment, overriding {@link BugReport.newInstanceId}.
   *
   * Only useful for a caller that wants a stable name for one specific client
   * across runs; the default already counts deterministically.
   */
  readonly instance?: string;
}

/**
 * The envelope prefix a request id can be read out of without parsing the
 * whole payload.
 *
 * `encodeRequest` (`codec.ts:477-485`) emits `jsonrpc`, then `id`, then
 * `method`, then `params`, and `JSON.stringify` preserves that order — so the
 * id is always within the first few dozen bytes and this anchored pattern
 * cannot reach into `params` and mistake some *other* `"id"` for it. A payload
 * that does not match (one built elsewhere, with a different key order) falls
 * back to the decorator's own counter, which costs a correlatable file name and
 * nothing else. Parsing instead would mean `JSON.parse` on a multi-megabyte
 * configuration for every request, to learn a string the caller already knows.
 */
const REQUEST_ID_PREFIX = /^\s*\{\s*"jsonrpc"\s*:\s*"[^"]*"\s*,\s*"id"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+))/u;

/** The `id` of a request payload, if it is where {@link REQUEST_ID_PREFIX} expects it. */
function requestIdOf(payload: string): string | undefined {
  const match = REQUEST_ID_PREFIX.exec(payload);
  if (match === null) return undefined;
  const [, quoted, numeric] = match;
  // The quoted branch is the escaped source text, which is what the id would
  // have to be sanitized down to anyway; an id needing an escape is already
  // going to lose characters to `sanitizeSegment`.
  return quoted ?? numeric;
}

/**
 * Wrap a {@link Transport} so that every request and response it carries is
 * archived into `report` — pyk's `bug_report` branches in
 * `JsonRpcClient.request` (`rpc.py:373-385`), moved to the seam.
 *
 * The recorded bytes are the bytes that went on the wire: the decorator sees
 * the same string the socket does, before and after, and neither builds nor
 * parses either one (bar the bounded id scan described on
 * {@link REQUEST_ID_PREFIX}).
 *
 * Ordering matches pyk's: the request is archived **before** it is sent and the
 * response **after** it arrives, so a request whose answer never came leaves a
 * `_request.json` with no `_response.json` — which `run-tarball` reports as
 * "Response file … is missing" (`RpcClient.hs:596-597`) rather than skipping.
 * That is the honest outcome: the session really did end there.
 *
 * The decorator adds no failure mode of its own. It does not catch what the
 * inner transport throws, and a sink that throws (a full disk, say) fails the
 * request it was recording — recording silently into nothing would leave a
 * report that looks complete and is not.
 */
export function recordingTransport(
  inner: Transport,
  report: BugReport,
  options: RecordingTransportOptions = {},
): Transport {
  const id = sanitizeSegment(options.id ?? DEFAULT_BUG_REPORT_ID);
  const instance = sanitizeSegment(options.instance ?? report.newInstanceId());
  const prefix = `${id}/${instance}`;
  let fallbackSeq = 0;

  const nameFor = (payload: string): string => {
    const requestId = requestIdOf(payload);
    if (requestId !== undefined) return `${prefix}/${sanitizeSegment(requestId)}`;
    fallbackSeq += 1;
    return `${prefix}/request-${String(fallbackSeq).padStart(3, "0")}`;
  };

  return {
    async request(payload: string): Promise<string> {
      const base = nameFor(payload);
      const requestName = `${base}_request.json`;
      report.addFileContents(payload, requestName);
      report.addRequest(requestName);

      const response = await inner.request(payload);

      const responseName = `${base}_response.json`;
      report.addFileContents(response, responseName);
      report.addRequest(responseName);
      return response;
    },

    interrupt(payload: string): void {
      // Deviation (5): archived, never sequenced. A `cancel` has no response,
      // so a replayer must not be told to send it.
      report.addFileContents(payload, `${nameFor(payload)}_cancel.json`);
      inner.interrupt(payload);
    },

    close(): void {
      inner.close();
    },
  };
}
