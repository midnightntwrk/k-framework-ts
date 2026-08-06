/** Pure, injected-fetcher source-drift check for the KLean transcription. */

import { K_RELEASE, TRANSCRIBED_FROM, type KleanTranscribedSource } from "./version.js";

export type KleanSourceStatus = "unchanged" | "changed" | "missing";

export interface KleanSourceOutcome {
  readonly path: string;
  readonly status: KleanSourceStatus;
  readonly expected: string;
  readonly actual?: string;
  readonly lines: number;
  readonly why: string;
}

export type KleanSourcesVerdict = "unchanged" | "changed" | "could-not-locate";

export interface KleanSourcesReport {
  readonly release: string;
  readonly recordedAt: string;
  readonly verdict: KleanSourcesVerdict;
  readonly files: readonly KleanSourceOutcome[];
}

/** Fetch a K repository file at a named release; undefined means not found. */
export type KleanSourceFetcher = (path: string, release: string) => Promise<Uint8Array | undefined>;

interface SubtleLike {
  digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>;
}

/** Lowercase SHA-256 through Web Crypto, keeping this module Node-independent. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { crypto } = globalThis as unknown as { crypto: { subtle: SubtleLike } };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compare injected upstream bytes with the package's recorded source hashes. */
export async function checkKleanSources(
  release: string,
  fetcher: KleanSourceFetcher,
  sources: readonly KleanTranscribedSource[] = TRANSCRIBED_FROM,
  recordedAt: string = K_RELEASE,
): Promise<KleanSourcesReport> {
  const files = await Promise.all(
    sources.map(async (source): Promise<KleanSourceOutcome> => {
      const bytes = await fetcher(source.path, release);
      if (bytes === undefined)
        return {
          path: source.path,
          status: "missing",
          expected: source.sha256,
          lines: source.lines,
          why: source.why,
        };
      const actual = await sha256Hex(bytes);
      return {
        path: source.path,
        status: actual === source.sha256 ? "unchanged" : "changed",
        expected: source.sha256,
        actual,
        lines: source.lines,
        why: source.why,
      };
    }),
  );
  const verdict = files.some((file) => file.status === "changed")
    ? "changed"
    : files.some((file) => file.status === "missing")
      ? "could-not-locate"
      : "unchanged";
  return { release, recordedAt, verdict, files };
}
