/** Offline-testable source-drift check for the pyk CTerm transcription. */

import { K_RELEASE, TRANSCRIBED_FROM, type CtermTranscribedSource } from "./version.js";

export type CtermSourceStatus = "unchanged" | "changed" | "missing";
export interface CtermSourceOutcome {
  readonly path: string;
  readonly status: CtermSourceStatus;
  readonly expected: string;
  readonly actual?: string;
  readonly why: string;
}
export type CtermSourcesVerdict = "unchanged" | "changed" | "could-not-locate";
export interface CtermSourcesReport {
  readonly release: string;
  readonly recordedAt: string;
  readonly verdict: CtermSourcesVerdict;
  readonly files: readonly CtermSourceOutcome[];
}
export type CtermSourceFetcher = (path: string, release: string) => Promise<Uint8Array | undefined>;

interface SubtleLike {
  digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { crypto } = globalThis as unknown as { crypto: { subtle: SubtleLike } };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function checkCtermSources(
  release: string,
  fetcher: CtermSourceFetcher,
  sources: readonly CtermTranscribedSource[] = TRANSCRIBED_FROM,
  recordedAt: string = K_RELEASE,
): Promise<CtermSourcesReport> {
  const files = await Promise.all(
    sources.map(async (source): Promise<CtermSourceOutcome> => {
      const bytes = await fetcher(source.path, release);
      if (bytes === undefined)
        return { path: source.path, status: "missing", expected: source.sha256, why: source.why };
      const actual = await sha256Hex(bytes);
      return {
        path: source.path,
        status: actual === source.sha256 ? "unchanged" : "changed",
        expected: source.sha256,
        actual,
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
