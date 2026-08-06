/**
 * Rendering an {@link APRProof} — a transcription of pyk's `proof/show.py`
 * (112 L) at K **v7.1.337**.
 *
 * This module is thin on purpose: `@kframework-ts/kcfg/show` does the graph
 * drawing and `@kframework-ts/cterm`'s `CTermShow` does the term printing, and
 * everything here is the *proof-aware* delta on top of them:
 *
 * - {@link APRProofNodePrinter} adds `init` / `target` / `pending` / `refuted` /
 *   `terminal` / `bounded` to a node's attribute list, and **removes `stuck`**
 *   once a node is terminal or bounded (`show.py:42-49`) — a proof knows why a
 *   node has no successors, and the graph does not.
 * - {@link APRProofShow.prettySegments} appends a `Target Node:` segment when
 *   the proof still has pending nodes.
 * - {@link APRProofShow.show} names the module `SUMMARY-<ID>`.
 * - {@link APRProofShow.dot} draws the two edge classes the KCFG cannot: a
 *   ` ???` edge from every pending node to the target, and a ` false` edge from
 *   every stuck node to the target.
 * - {@link APRProofShow.dump} writes `<id>.json` (the `proof.json` schema)
 *   beside the KCFG dump.
 *
 * The printer reaches this module the same way it reaches the sibling
 * packages: as an injected callable on `KCFGShowOptions`. `KPrint` composition
 * belongs in `cli.ts` and in tests, not here.
 *
 * # One divergence of this package's own: `showRules`
 *
 * `@kframework-ts/kcfg/show` adds a `showRules` option that prints each
 * successor's rule ids under its label — output pyk has nowhere, because
 * `KCFGShow` renders an edge as `(N steps)` and never names a rule.  It is
 * carried on {@link KCFGPrettyOptions} / {@link KCFGShowRequest} and therefore
 * reaches {@link APRProofShow.prettySegments}, {@link APRProofShow.pretty} and
 * {@link APRProofShow.show} unchanged; `kproof show --show-rules` is the
 * command form.  This is the *proof* reader's feature more than the graph
 * reader's: when an `APRProof` fails, the first question is which rule fired
 * on the edge into the failing node, and until now the answer lived only in
 * `kcfg.json`.
 *
 * **It stays opt-in here, exactly as in `kcfg`.**  The obvious alternative was
 * to turn it on by default in the failure report, and the failure report is
 * the one place in this package that cannot take it: `APRFailureInfo.print`
 * (`./failure.ts`) is transcribed line for line from
 * `reachability.py:1042-1079` and is pinned by an *upstream* golden, so
 * anything added to it is a parity break rather than a house deviation.  Every
 * other rendered surface here is likewise a straight transcription with frozen
 * goldens.  Defaulting to `false` keeps all of them byte-stable and leaves the
 * new output one flag away.
 */

import {
  KCFGShow,
  NodePrinter,
  dotDocument,
  dotEdge,
  type DotStatement,
  type KCFGDumpOptions,
  type KCFGPrettyOptions,
  type KCFGSegment,
  type KCFGShowOptions,
  type KCFGShowRequest,
  type NodePrinterOptions,
} from "@kframework-ts/kcfg/show";
import type { CTermShow } from "@kframework-ts/cterm";
import type { KCFG, KCFGNode } from "@kframework-ts/kcfg";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { APRProof } from "./apr.js";

/**
 * `APRProofNodePrinter` (`show.py:25-50`).
 *
 * `stuck` is *removed* — not skipped — when the proof considers the node
 * terminal or bounded, so a node that is both stuck and terminal prints only
 * `terminal`. The order of the remaining attributes is
 * `NodePrinter.node_attrs`' order followed by this class's appends.
 */
export class APRProofNodePrinter extends NodePrinter {
  readonly proof: APRProof;

  constructor(proof: APRProof, ctermShow: CTermShow, options: NodePrinterOptions = {}) {
    super(ctermShow, options);
    this.proof = proof;
  }

  /** `node_attrs` (`show.py:32-50`). */
  override nodeAttrs(kcfg: KCFG, node: KCFGNode): string[] {
    const attrs = super.nodeAttrs(kcfg, node);
    const discardStuck = (): void => {
      const at = attrs.indexOf("stuck");
      if (at !== -1) attrs.splice(at, 1);
    };
    if (this.proof.isInit(node.id)) attrs.push("init");
    if (this.proof.isTarget(node.id)) attrs.push("target");
    if (this.proof.isPending(node.id)) attrs.push("pending");
    if (this.proof.isRefuted(node.id)) attrs.push("refuted");
    if (this.proof.isTerminal(node.id)) {
      attrs.push("terminal");
      discardStuck();
    }
    if (this.proof.isBounded(node.id)) {
      attrs.push("bounded");
      discardStuck();
    }
    return attrs;
  }
}

/** `APRProofShow` (`show.py:53-112`). */
export class APRProofShow {
  readonly kcfgShow: KCFGShow;

  constructor(options: KCFGShowOptions = {}) {
    this.kcfgShow = new KCFGShow(options);
  }

  /**
   * `pretty_segments` (`show.py:59-65`).
   *
   * The trailing `Target Node:` segment appears **only while nodes are still
   * pending** — a finished proof does not repeat its target — and its segment
   * id is `node_<target>`, which is already taken by the target's appearance
   * in the graph, so `makeUniqueSegments` gives this one the `_0` suffix.
   */
  prettySegments(proof: APRProof, options: KCFGPrettyOptions = {}): readonly KCFGSegment[] {
    const retLines: KCFGSegment[] = [...this.kcfgShow.prettySegments(proof.kcfg, options)];
    if (proof.pending.length > 0) {
      const lines = [
        "",
        "Target Node:",
        ...this.kcfgShow.nodePrinter.printNode(proof.kcfg, proof.kcfg.node(proof.target)),
      ];
      retLines.push({ id: `node_${proof.target}`, lines });
    }
    return KCFGShow.makeUniqueSegments(retLines);
  }

  /** `pretty` (`show.py:67-68`). */
  pretty(proof: APRProof, options: KCFGPrettyOptions = {}): readonly string[] {
    return this.prettySegments(proof, options).flatMap((segment) => [...segment.lines]);
  }

  /**
   * `show` (`show.py:70-88`).
   *
   * The one thing this adds to `KCFGShow.show` is the module name:
   * `SUMMARY-` + the proof id upper-cased with `_` replaced by `-`. A caller
   * that passes `moduleName` overrides it, which pyk has no way to do.
   */
  show(proof: APRProof, request: Omit<KCFGShowRequest, "moduleName"> & { readonly moduleName?: string } = {}) {
    return this.kcfgShow.show(proof.kcfg, {
      ...request,
      moduleName: request.moduleName ?? summaryModuleName(proof.id),
    });
  }

  /**
   * `dot` (`show.py:90-97`), as DOT statements.
   *
   * Note the label padding differs from `KCFGShow.dot`'s: upstream writes
   * `' ???'` and `' false'` with a single leading space and no trailing run,
   * where the KCFG's own edges get `'  {label}        '`.
   */
  dotStatements(proof: APRProof): readonly DotStatement[] {
    const statements: DotStatement[] = [...this.kcfgShow.dotStatements(proof.kcfg)];
    const attrs = { class: "target", style: "solid" } as const;
    for (const node of proof.pending) {
      statements.push(dotEdge(String(node.id), String(proof.target), " ???", attrs));
    }
    for (const node of proof.kcfg.stuck) {
      statements.push(dotEdge(String(node.id), String(proof.target), " false", attrs));
    }
    return statements;
  }

  /** {@link APRProofShow.dotStatements} as a complete DOT document. */
  dot(proof: APRProof): string {
    return dotDocument(this.dotStatements(proof));
  }

  /**
   * `dump` (`show.py:99-111`).
   *
   * `<id>.json` is the `proof.json` schema — `Proof.json`, i.e. `dict`, not
   * the proof-data schema `./store` writes. The KCFG is dumped alongside it
   * under `<id>_cfg`, always with `dot: false`: a caller asking for DOT gets
   * the *proof's* DOT, which includes the target edges, not the graph's.
   */
  async dump(proof: APRProof, dumpDir: string, options: KCFGDumpOptions = {}): Promise<void> {
    await mkdir(dumpDir, { recursive: true });

    await writeFile(join(dumpDir, `${proof.id}.json`), proof.json);

    if (options.dot === true) {
      await writeFile(join(dumpDir, `${proof.id}.dot`), this.dot(proof));
    }

    await this.kcfgShow.dump(`${proof.id}_cfg`, proof.kcfg, dumpDir, { dot: false });
  }
}

/** `f'SUMMARY-{proof.id.upper().replace("_", "-")}'` (`show.py:86`). */
export function summaryModuleName(proofId: string): string {
  return `SUMMARY-${proofId.toUpperCase().replaceAll("_", "-")}`;
}
