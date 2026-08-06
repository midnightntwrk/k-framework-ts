/**
 * Rendering a {@link CTerm} as text — a transcription of pyk's
 * `cterm/show.py` (99 L) at K **v7.1.337**.
 *
 * # The printer is a seam, not a dependency
 *
 * Upstream `CTermShow.__init__` takes `printer: Callable[[KInner], str]` and
 * every caller passes `PrettyPrinter(definition).print` (`kcfg/tui.py:218`,
 * `__main__.py:287`).  That callable is the *only* thing this module needs
 * from the pretty-printing world, so it stays a callable here too: this file
 * imports nothing beyond `@kframework-ts/kast` and {@link CTerm}, which keeps
 * it inside the package's browser-safe main entry point.  Composing a real
 * `KPrint`/`PrettyPrinter` into that seam belongs at the CLI or test edge.
 *
 * # What the 99 lines actually do
 *
 * Three transformations run over the configuration before printing, in this
 * order (`show.py:64-71`) — and note that only the *configuration* is ever
 * rewritten, never the constraints:
 *
 * 1. **break cell collections** — a cell whose single argument is a `_Set_` /
 *    `_List_` / `_Map_` application has that collection flattened, every item
 *    printed *by the injected printer*, and the results joined with newlines
 *    into a single {@link KToken} whose sort is the cell name with its angle
 *    brackets stripped.  The printer therefore runs twice over those items:
 *    once here, and once again on the token text-as-a-token.
 * 2. **omit labels** — any `KApply` whose label is named in `omitLabels`
 *    becomes `DOTS`.  This is a *label* filter, not a cell filter: it matches
 *    non-cell applications too.
 * 3. **minimize** — `minimizeTerm(config, keepVars = freeVars(constraint))`.
 *
 * Constraints are then printed one per constraint, each line prefixed `#And `
 * and continuation lines indented two spaces (`show.py:73-81`).
 */

import {
  flattenLabel,
  isCell,
  kapply,
  ktoken,
  ksort,
  topDown,
  freeVars,
  minimizeTerm,
  type KInner,
} from "@kframework-ts/kast";
import { DOTS } from "@kframework-ts/kast/prelude/k";

import { CTerm } from "./cterm.js";

/**
 * The seam: pyk's `Callable[[KInner], str]`.
 *
 * In pyk this is always `PrettyPrinter(definition).print`. Anything that turns
 * a term into text works here — a real pretty-printer, a `KPrint`, or a stub.
 */
export type TermPrinter = (term: KInner) => string;

/** The three keyword arguments of `CTermShow.__init__` (`show.py:28-38`). */
export interface CTermShowOptions {
  /** `minimize` (default `true`): run `minimizeTerm` over the configuration. */
  readonly minimize?: boolean | undefined;
  /** `break_cell_collections` (default `true`): print collection cells one item per line. */
  readonly breakCellCollections?: boolean | undefined;
  /** `omit_labels` (default empty): applications with these label names print as `...`. */
  readonly omitLabels?: Iterable<string> | undefined;
}

/**
 * `_Set_`, `_List_`, `_Map_` — the three collection labels
 * `_break_cells_visitor` recognizes (`show.py:89`).
 */
const COLLECTION_LABELS: ReadonlySet<string> = new Set(["_Set_", "_List_", "_Map_"]);

/**
 * `CTermShow` (`show.py:21-99`): a `CTerm` rendered as a list of lines.
 *
 * The value is immutable; {@link CTermShow.let} returns a reconfigured copy,
 * exactly as pyk's `let` does.
 */
export class CTermShow {
  readonly #printer: TermPrinter;
  /** `_minimize` (`show.py:24`). */
  readonly minimize: boolean;
  /** `_break_cell_collections` (`show.py:25`). */
  readonly breakCellCollections: boolean;
  /** `_omit_labels` (`show.py:26`), in the order given. */
  readonly omitLabels: readonly string[];

  constructor(printer: TermPrinter, options: CTermShowOptions = {}) {
    this.#printer = printer;
    this.minimize = options.minimize ?? true;
    this.breakCellCollections = options.breakCellCollections ?? true;
    this.omitLabels = Object.freeze([...(options.omitLabels ?? [])]);
    Object.freeze(this);
  }

  /** The injected printer itself, so a `NodePrinter` can pass it along. */
  get printer(): TermPrinter {
    return this.#printer;
  }

  /** `print_lines` (`show.py:40-41`): print, then split on newlines. */
  printLines(kast: KInner): readonly string[] {
    return this.#printer(kast).split("\n");
  }

  /** `let` (`show.py:43-56`): a copy with the same printer and selected overrides. */
  let(changes: CTermShowOptions = {}): CTermShow {
    return new CTermShow(this.#printer, {
      minimize: changes.minimize ?? this.minimize,
      breakCellCollections: changes.breakCellCollections ?? this.breakCellCollections,
      omitLabels: changes.omitLabels ?? this.omitLabels,
    });
  }

  /** `show` (`show.py:58-62`): the configuration's lines, then the constraints'. */
  show(cterm: CTerm): readonly string[] {
    return [...this.showConfig(cterm), ...this.showConstraints(cterm)];
  }

  /** `show_config` (`show.py:64-71`). Constraints are carried but never rewritten. */
  showConfig(cterm: CTerm): readonly string[] {
    let current = cterm;
    if (this.breakCellCollections) {
      current = new CTerm(
        topDown((kast) => this.#breakCellsVisitor(kast), current.config),
        current.constraints,
      );
    }
    if (this.omitLabels.length > 0) {
      current = new CTerm(
        topDown((kast) => this.#omitLabelsVisitor(kast), current.config),
        current.constraints,
      );
    }
    if (this.minimize) {
      current = new CTerm(minimizeTerm(current.config, freeVars(current.constraint)), current.constraints);
    }
    return this.printLines(current.config);
  }

  /**
   * `show_constraints` (`show.py:73-81`).
   *
   * `len(constraint_strs) > 0` is always true for `str.split`, which never
   * returns an empty list; the guard is transcribed anyway so the shapes match.
   */
  showConstraints(cterm: CTerm): readonly string[] {
    const out: string[] = [];
    for (const constraint of cterm.constraints) {
      const lines = this.printLines(constraint).map((line) => `#And ${line}`);
      const [first, ...rest] = lines;
      if (first === undefined) continue;
      out.push(first);
      for (const line of rest) out.push(`  ${line}`);
    }
    return out;
  }

  /** `_break_cells_visitor` (`show.py:83-94`). */
  #breakCellsVisitor(kast: KInner): KInner {
    if (kast.node !== "KApply" || !isCell(kast) || kast.args.length !== 1) return kast;
    const [only] = kast.args;
    if (only === undefined || only.node !== "KApply" || !COLLECTION_LABELS.has(only.label.name)) return kast;
    const items = flattenLabel(only.label.name, only);
    // The cell name loses its angle brackets: `<accounts>` -> sort `accounts`.
    const printed = ktoken(items.map((item) => this.#printer(item)).join("\n"), ksort(kast.label.name.slice(1, -1)));
    return kapply(kast.label, [printed]);
  }

  /** `_omit_labels_visitor` (`show.py:96-99`). */
  #omitLabelsVisitor(kast: KInner): KInner {
    if (kast.node === "KApply" && this.omitLabels.includes(kast.label.name)) return DOTS;
    return kast;
  }
}
