/** Offline-testable source-drift check for the pyk KCFG transcription. */

import { K_RELEASE, TRANSCRIBED_FROM, type KcfgTranscribedSource } from "./version.js";

/** What one manifest path was found to be at a requested K release. */
export type KcfgSourceStatus = "unchanged" | "changed" | "missing";

export interface KcfgSourceOutcome {
  readonly path: string;
  readonly status: KcfgSourceStatus;
  readonly expected: string;
  readonly actual?: string;
  readonly tier: KcfgTranscribedSource["tier"];
  readonly why: string;
}

/** Three-valued source-drift result; a missing path is not a compatibility verdict. */
export type KcfgSourcesVerdict = "unchanged" | "changed" | "could-not-locate";

export interface KcfgSourcesReport {
  readonly release: string;
  readonly recordedAt: string;
  readonly verdict: KcfgSourcesVerdict;
  readonly files: readonly KcfgSourceOutcome[];
}

/** Fetches one path from one K release; `undefined` means an unambiguous 404. */
export type KcfgSourceFetcher = (path: string, release: string) => Promise<Uint8Array | undefined>;

interface SubtleLike {
  digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>;
}

/** Lowercase SHA-256 for precisely the supplied byte view, without a Node import. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { crypto } = globalThis as unknown as { crypto: { subtle: SubtleLike } };
  // A Uint8Array can be a window into a larger buffer; hash only that window.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare this package's declared pyk files with one K release.
 *
 * Fetch failures deliberately propagate: inability to contact GitHub is not a
 * fact about the requested K release. A definite changed file outranks a
 * missing file, while an all-unchanged set is the only success result.
 */
export async function checkKcfgSources(
  release: string,
  fetcher: KcfgSourceFetcher,
  sources: readonly KcfgTranscribedSource[] = TRANSCRIBED_FROM,
  recordedAt: string = K_RELEASE,
): Promise<KcfgSourcesReport> {
  const files = await Promise.all(
    sources.map(async (source): Promise<KcfgSourceOutcome> => {
      const bytes = await fetcher(source.path, release);
      if (bytes === undefined) {
        return {
          path: source.path,
          status: "missing",
          expected: source.sha256,
          tier: source.tier,
          why: source.why,
        };
      }
      const actual = await sha256Hex(bytes);
      return {
        path: source.path,
        status: actual === source.sha256 ? "unchanged" : "changed",
        expected: source.sha256,
        actual,
        tier: source.tier,
        why: source.why,
      };
    }),
  );
  const verdict: KcfgSourcesVerdict = files.some((file) => file.status === "changed")
    ? "changed"
    : files.some((file) => file.status === "missing")
      ? "could-not-locate"
      : "unchanged";
  return { release, recordedAt, verdict, files };
}
