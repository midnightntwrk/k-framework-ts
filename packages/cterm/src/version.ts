/** Source identity for the CTerm transcription. */

export const K_RELEASE = "v7.1.337" as const;
export const K_COMMIT = "4a46d1231473b599c699160132fd6e76a5c46406" as const;

export interface CtermTranscribedSource {
  readonly path: string;
  readonly sha256: string;
  readonly lines: number;
  readonly why: string;
}

export const TRANSCRIBED_FROM: readonly CtermTranscribedSource[] = [
  {
    path: "pyk/src/pyk/cterm/cterm.py",
    sha256: "a31ddc31151e398f098a42694bb9541f9f8489e0b82b2409c26f22080966e7be",
    lines: 474,
    why: "CTerm/CSubst construction, matching, serialization, predicates, constraint operations (including the `_ml_impl` helper the implication failure reason builds on), anti-unification, and builders",
  },
  {
    path: "pyk/src/pyk/cterm/symbolic.py",
    sha256: "2c2a6ec4e845d3db4b94590af16dff176965f39a37c6eefb7b9c2d329e9dcdac",
    lines: 476,
    why: "async symbolic adapter: the per-instance request defaults (log_succ_rewrites/log_fail_rewrites/booster_only_simplify/HASKELL_LOGGING_ENTRIES) stamped onto every request, KAST/KORE conversion, execute/simplify/kast-simplify/model/implies response handling, the CTermSMTError translation of a backend SMT failure, RHS-only variable binding, the implication failure-reason walk (failing cells and the remaining implication), the #Ceil definedness construction, and add-module",
  },
  {
    path: "pyk/src/pyk/cterm/show.py",
    sha256: "1422f777db12d77c32aec50eb565fd76774a53800b29faef75f7fb772917e868",
    lines: 99,
    why: "`CTermShow`: the injected-printer seam, cell-collection breaking, omitted labels, configuration minimization, and the `#And`-prefixed constraint block",
  },
  {
    path: "pyk/src/tests/unit/test_cterm.py",
    sha256: "9eaa7fc78e34af4195a9500d025aa68af67d26759eecc4cc1dcc98a3be84f896",
    lines: 275,
    why: "offline parity corpus for matching, constrained matching, CSubst predicates, application, and CTerm KAST conversion",
  },
];
