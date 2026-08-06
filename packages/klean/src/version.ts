/** Version identity and upstream provenance for the KLean transcription. */

/** The K release whose `pyk.klean` implementation this package tracks. */
export const K_RELEASE = "v7.1.337" as const;

/** The immutable commit named by {@link K_RELEASE}. */
export const K_COMMIT = "4a46d1231473b599c699160132fd6e76a5c46406" as const;

/** Lean version used by KLean's generated Lake project at {@link K_RELEASE}. */
export const LEAN_TOOLCHAIN = "leanprover/lean4:v4.30.0" as const;

export interface KleanTranscribedSource {
  /** Path relative to the K Framework repository root. */
  readonly path: string;
  /** Lowercase SHA-256 of the source at {@link K_RELEASE}. */
  readonly sha256: string;
  /** Source line count, useful when reviewing source drift. */
  readonly lines: number;
  /** Why this source is relevant to this package. */
  readonly why: string;
}

/**
 * The upstream source files that define the v1 KLean compatibility surface.
 *
 * Hashes describe sources we transcribe or ship as a verbatim template; the
 * generator deliberately does not copy the old KEVM proof artifact.
 */
export const TRANSCRIBED_FROM: readonly KleanTranscribedSource[] = [
  {
    path: "pyk/src/pyk/klean/k2lean4.py",
    sha256: "737f5d6295f9f69ffd4ff41ef22f22557387988314b17eacfc5f3ee4cb062dc4",
    lines: 1217,
    why: "KORE-to-Lean naming, literal lowering, the function-rule Matcher hierarchy, SCC/`mutual` and `noncomputable` policy, and sort/function/rewrite generation",
  },
  {
    path: "pyk/src/pyk/klean/model.py",
    sha256: "cb4c2b276ddf2be2797875e6013b160ce2d7b3c78525f731978fd836a63b9916",
    lines: 631,
    why: "Small structured Lean declaration/printer model",
  },
  {
    path: "pyk/src/pyk/klean/generate.py",
    sha256: "9b5bfad50974bfd9346cbe02e5044c9feab4fd9c21a9c349961351682f882711",
    lines: 74,
    why: "Generated module graph and project-template boundary",
  },
  {
    path: "pyk/src/pyk/klean/__main__.py",
    sha256: "18a83c1f8324f1d2dc2f7ede43c414c6268d23ba20ded50d98285acd65c581b0",
    lines: 143,
    why: "CLI argument contract, default library naming, and refusal to overwrite output",
  },
  {
    path: "pyk/src/pyk/klean/template/{{ cookiecutter.package_name }}/{{ cookiecutter.library_name }}/Prelude.lean",
    sha256: "71ab9b4f7fc57258afe10de78dd0688216db735e2e7cbde2197f0c72bb9b0292",
    lines: 353,
    why: "Stock generated Lean Prelude template shipped by this package",
  },
  {
    path: "pyk/src/pyk/klean/template/{{ cookiecutter.package_name }}/lakefile.toml",
    sha256: "49088f40def569baa831216cea604a636e20b1114be1c2aec8fda2dc648af419",
    lines: 9,
    why: "Lake package metadata and max-heartbeats policy reproduced by the generated project shell",
  },
  {
    path: "pyk/src/pyk/klean/template/{{ cookiecutter.package_name }}/lean-toolchain",
    sha256: "54727eec5cba149c18842e6deb5c41b369d66455c93ce135d7d5347c782b2325",
    lines: 1,
    why: "Pinned Lean toolchain emitted by the generated project shell",
  },
  {
    path: "pyk/src/pyk/klean/template/{{ cookiecutter.package_name }}/{{ cookiecutter.library_name }}.lean",
    sha256: "e30753e7b2a74d5e969c1cd69c68816c365d6e12649c3641f0bb5fd87a4a047b",
    lines: 1,
    why: "Generated root library import reproduced by the project shell",
  },
  {
    path: "pyk/src/pyk/kore/internal.py",
    sha256: "1fb163402848cfd12f0a496c9b1a97262361662dedae4a53367277a2cc2a2010",
    lines: 260,
    why: "Rule filtering and relevant-definition projection contract",
  },
];
