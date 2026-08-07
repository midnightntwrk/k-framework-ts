/**
 * The LLVM runtime's coverage-log naming surface (`runtime/io/io.cpp:539-551`).
 *
 * The grammar below is pinned by {@link IO_CPP_IDENTITY}'s sha256 and verified
 * by {@link checkKcovrSources}; it is an implementation detail of the LLVM
 * runtime, not an official K CLI contract.
 */

/** Selects the directory where LLVM `#logToFile` flushes coverage hit logs. */
export const K_LOG_DIR_ENV = "K_LOG_DIR" as const;

/** Prefixes the LLVM runtime's per-process coverage-log filename. */
export const K_LOG_PREFIX_ENV = "K_LOG_PREFIX" as const;

/** The suffix the LLVM runtime appends after its process id. */
export const COVERAGE_LOG_SUFFIX = "_coverage.txt" as const;

/**
 * A parsed LLVM coverage-log filename.
 *
 * Attribution is exact only when the caller supplied the expected prefix.
 * Otherwise the maximal trailing digit run is a heuristic.  A multi-digit run
 * is ambiguous because one or more of its leading digits could instead belong
 * to a digit-ending prefix.
 */
export type ParsedCoverageLogName =
  | {
      readonly attribution: "exact";
      readonly ambiguous: false;
      /** The process id in the filename. */
      readonly pid: number;
      /** The caller-supplied prefix. */
      readonly prefix: string;
    }
  | {
      readonly attribution: "heuristic";
      readonly ambiguous: boolean;
      /** The process id obtained from the maximal trailing digit run. */
      readonly pid: number;
      /** Everything before that maximal trailing digit run. */
      readonly prefix: string;
    };

/**
 * Name the per-process coverage log that LLVM writes for `pid`.
 *
 * `pid` must be a finite, non-negative safe integer.  The runtime's PID is a
 * C integer, and rejecting values JavaScript cannot represent exactly avoids
 * producing a name whose numeric identity the parser cannot return faithfully.
 */
export function coverageLogName(pid: number, prefix = ""): string {
  if (!Number.isSafeInteger(pid) || pid < 0) {
    throw new RangeError(`coverage-log pid must be a finite non-negative safe integer, got ${String(pid)}`);
  }
  return `${prefix}${pid}${COVERAGE_LOG_SUFFIX}`;
}

/**
 * Decompose an LLVM per-process coverage-log name.
 *
 * With `expectedPrefix`, this is exact-prefix attribution: foreign names and
 * a prefix mismatch return `undefined`.  Without one, the maximal trailing
 * digit run before {@link COVERAGE_LOG_SUFFIX} is reported as a heuristic, not
 * silently treated as exact.  A run of two or more digits is marked ambiguous
 * because `case142` can mean `case` + pid 142, `case1` + pid 42, or
 * `case14` + pid 2.  Supply the expected prefix to resolve that ambiguity.
 */
export function parseCoverageLogName(name: string, expectedPrefix?: string): ParsedCoverageLogName | undefined {
  if (!name.endsWith(COVERAGE_LOG_SUFFIX)) return undefined;

  const stem = name.slice(0, -COVERAGE_LOG_SUFFIX.length);
  if (expectedPrefix !== undefined) {
    if (!stem.startsWith(expectedPrefix)) return undefined;
    const digits = stem.slice(expectedPrefix.length);
    const pid = parsePid(digits);
    return pid === undefined ? undefined : { attribution: "exact", ambiguous: false, pid, prefix: expectedPrefix };
  }

  const match = /^(.*?)(\d+)$/u.exec(stem);
  if (match === null) return undefined;
  const [, parsedPrefix, digits] = match;
  const pid = parsePid(digits ?? "");
  return pid === undefined
    ? undefined
    : {
        attribution: "heuristic",
        ambiguous: (digits?.length ?? 0) > 1,
        pid,
        prefix: parsedPrefix ?? "",
      };
}

function parsePid(digits: string): number | undefined {
  if (!/^\d+$/u.test(digits)) return undefined;
  const pid = Number(digits);
  return Number.isSafeInteger(pid) && pid >= 0 ? pid : undefined;
}

/**
 * Build a child environment ready for `KRunOptions.env` composition.
 *
 * The builder is intentionally pure: call `checkCoverageLogDir` before the
 * spawn, and use a fresh directory per run/scan instead of resetting logs.
 * An omitted prefix deliberately overrides any inherited `K_LOG_PREFIX` with
 * the runtime-equivalent empty string.
 */
export function coverageLogEnv(
  opts: Readonly<{ dir: string; prefix?: string }>,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined) env[name] = value;
  env[K_LOG_DIR_ENV] = opts.dir;
  env[K_LOG_PREFIX_ENV] = opts.prefix ?? "";
  return env;
}
