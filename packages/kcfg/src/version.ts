/** Source identity for the pyk KCFG transcription. */

/** The K release every source in {@link TRANSCRIBED_FROM} was read at. */
export const K_RELEASE = "v7.1.337" as const;

/** Commit named by {@link K_RELEASE}, retained for checkout identification. */
export const K_COMMIT = "4a46d1231473b599c699160132fd6e76a5c46406" as const;

/** A pyk implementation or unit-test source used by this package. */
export interface KcfgTranscribedSource {
  /** Path within the runtimeverification/k tree. */
  readonly path: string;
  /** Lowercase sha256 of the file at {@link K_RELEASE}. */
  readonly sha256: string;
  /** Line count at the recorded release, for a human-scale cross-check. */
  readonly lines: number;
  /** Whether this was implementation code or a behavioral oracle. */
  readonly tier: "transcription" | "test-oracle";
  /** Why this source is relevant to the public package. */
  readonly why: string;
}

/**
 * The pyk KCFG sources this package transcribes or uses as its behavioral
 * oracle. This includes the currently exported graph, minimization,
 * exploration and display surfaces; the Node split store and the
 * `Edge.to_rule`/`to_rules`/`to_module` summary-module trio are transcribed
 * from `kcfg.py`. Python-only memory interning, `tui.py`, and APR proof code
 * are not package scope and intentionally do not appear here.
 */
export const TRANSCRIBED_FROM: readonly KcfgTranscribedSource[] = [
  {
    path: "pyk/src/pyk/kcfg/kcfg.py",
    sha256: "8fcf78a39f34a807c28c5376517b5cca5f9833faacbd0a11714134e84764978a",
    lines: 1363,
    tier: "transcription",
    why: "KCFG node/successor values, graph mutation and traversal, `KCFG.extend` including its `optimize_kcfg` step merge, pyk structural dictionaries, split-store layout, and the `Edge.to_rule`/`to_rules`/`to_module` summary-module trio.",
  },
  {
    path: "pyk/src/tests/unit/test_kcfg.py",
    sha256: "72d7c29dbd456353ec8b881b3f89dedc45a5c9a0dfd2191cedcd03fb2645c678",
    lines: 965,
    tier: "test-oracle",
    why: "Offline graph, successor, serialization, alias, reachability, cover, and split behavior oracle.",
  },
  {
    path: "pyk/src/pyk/kcfg/minimize.py",
    sha256: "cac8bdeedbe6d248420488167eeb14a7651703efd9aad25c16eeb9f50b0ee555",
    lines: 280,
    tier: "transcription",
    why: "Pure edge/split lifting and anti-unification-based graph minimization policy.",
  },
  {
    path: "pyk/src/tests/unit/kcfg/test_minimize.py",
    sha256: "44954382188209ad93a1448ef71142d60f1d70c1000efe182ed314c8e86c185d",
    lines: 427,
    tier: "test-oracle",
    why: "Minimizer depths, rules, constraints, and graph-shape oracle.",
  },
  {
    path: "pyk/src/pyk/kcfg/explore.py",
    sha256: "2d873b2ad5066def290e85bd6e7e18420839f0a9d41382a023c294736bad8858",
    lines: 286,
    tier: "transcription",
    why: "Symbolic execution result classification and graph-edit policy behind the async explore adapter.",
  },
  {
    path: "pyk/src/pyk/kcfg/exploration.py",
    sha256: "b5706f70524b46edb29393e0413ade885e8eb4ab9e0dbb44e5834db855fdc48a",
    lines: 114,
    tier: "transcription",
    why: "Terminal/explorable-node wrapper semantics.",
  },
  {
    path: "pyk/src/pyk/kcfg/show.py",
    sha256: "fe01f120639ca75414c8a157dc7b70fee422714da3098dabec2261a81898b811",
    lines: 479,
    tier: "transcription",
    why: "`NodePrinter` node attributes, `KCFGShow`'s segmented box-drawing rendering, unique segment ids, cell hiding, the summary module, node and node-delta printing, the DOT graph, and the dump directory layout.",
  },
  {
    path: "pyk/src/pyk/kcfg/semantics.py",
    sha256: "da527e72debc2a921939b3821f409da0b7dfc58f5fc4593224b6a7d883e3cfa6",
    lines: 77,
    tier: "transcription",
    why: "Language-specific terminal, abstraction, custom-step, loop, and merge policy seam.",
  },
];
