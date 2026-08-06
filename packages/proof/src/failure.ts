/**
 * `APRFailureInfo` (`proof/reachability.py:984-1079`), data and rendering only.
 *
 * Upstream's `from_proof` (`:1008-1040`) calls the backend twice per failing
 * node — `simplify`, `implication_failure_reason`, optionally `get_model` — so
 * it belongs with the prover. The value and its `print()` are pure, and
 * `print()` has an exact golden in the upstream unit suite, so both land here.
 *
 * `models` stays a structured variable → pretty-printed-term list rather than
 * a string blob: Kontrol reads it to generate counterexample tests.
 */

import type { FailureInfo } from "./proof.js";

/** One `var = term` pair of a counterexample model. */
export type ModelBinding = readonly [variable: string, term: string];

/** Constructor fields, named as `APRFailureInfo.__init__` (`reachability.py:992-998`). */
export interface APRFailureInfoFields {
  readonly failingNodes: Iterable<number>;
  readonly pendingNodes: Iterable<number>;
  readonly pathConditions: ReadonlyMap<number, string> | Readonly<Record<number, string>>;
  readonly failureReasons: ReadonlyMap<number, string> | Readonly<Record<number, string>>;
  readonly models?: ReadonlyMap<number, Iterable<ModelBinding>> | Readonly<Record<number, Iterable<ModelBinding>>>;
}

function toMap<T>(source: ReadonlyMap<number, T> | Readonly<Record<number, T>> | undefined): ReadonlyMap<number, T> {
  if (source === undefined) return new Map();
  if (source instanceof Map) return source;
  const out = new Map<number, T>();
  const entries: readonly (readonly [string, T])[] = Object.entries(source);
  for (const [key, value] of entries) out.set(Number(key), value);
  return out;
}

/** Why an `APRProof` failed, as far as it can be described without a backend. */
export class APRFailureInfo implements FailureInfo {
  readonly failingNodes: readonly number[];
  readonly pendingNodes: readonly number[];
  readonly pathConditions: ReadonlyMap<number, string>;
  readonly failureReasons: ReadonlyMap<number, string>;
  readonly models: ReadonlyMap<number, readonly ModelBinding[]>;

  constructor(fields: APRFailureInfoFields) {
    // Upstream holds `frozenset`s; iteration order there is unspecified, and
    // `print()` sorts the pending nodes but *not* the failing ones. Insertion
    // order is preserved here so the rendered order is at least reproducible.
    this.failingNodes = Object.freeze([...new Set(fields.failingNodes)]);
    this.pendingNodes = Object.freeze([...new Set(fields.pendingNodes)]);
    this.pathConditions = toMap(fields.pathConditions);
    this.failureReasons = toMap(fields.failureReasons);
    const models = new Map<number, readonly ModelBinding[]>();
    for (const [nodeId, bindings] of toMap(fields.models)) models.set(nodeId, Object.freeze([...bindings]));
    this.models = models;
    Object.freeze(this);
  }

  /** `APRFailureInfo.print` (`reachability.py:1042-1079`), line for line. */
  print(): readonly string[] {
    const lines: string[] = [];
    const numPending = this.pendingNodes.length;
    const numFailing = this.failingNodes.length;
    lines.push(`${numPending + numFailing} Failure nodes. (${numPending} pending and ${numFailing} failing)`);

    if (numPending > 0) {
      lines.push("");
      // Python renders a sorted list as `[6, 7, 8]`.
      lines.push(`Pending nodes: [${[...this.pendingNodes].toSorted((a, b) => a - b).join(", ")}]`);
    }

    if (numFailing > 0) {
      lines.push("");
      lines.push("Failing nodes:");
      for (const nodeId of this.failingNodes) {
        const reason = this.failureReasons.get(nodeId) ?? "";
        const pathCondition = this.pathConditions.get(nodeId) ?? "";
        lines.push("");
        lines.push(`  Node id: ${nodeId}`);

        lines.push("  Failure reason:");
        lines.push(...reason.split("\n").map((line) => `    ${line}`));

        lines.push("  Path condition:");
        lines.push(`    ${pathCondition}`);

        const model = this.models.get(nodeId);
        if (model !== undefined) {
          lines.push("  Model:");
          for (const [variable, term] of model) lines.push(`    ${variable} = ${term}`);
        } else {
          lines.push("  Failed to generate a model.");
        }
      }

      lines.push("");
      lines.push("Join the Runtime Verification Discord server for support: https://discord.gg/CurfmXNtbN");
    }
    return lines;
  }
}
