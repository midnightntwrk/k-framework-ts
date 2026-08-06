/**
 * Proof summaries (`proof/proof.py:271-318`, `reachability.py:945-981`,
 * `implies.py:284-296` and `:398-408`).
 *
 * Every summary is pure formatting over already-derived numbers. The exact
 * line text is a compatibility surface: Kontrol's `foundry list` golden is a
 * concatenation of `APRSummary.lines`, so both the labels and the Python
 * spellings of `ProofStatus`/`bool` are reproduced verbatim.
 */

import { formatProofStatus, formatPythonBool, type ProofStatus } from "./status.js";

/** `ProofSummary` (`proof.py:294-303`). */
export interface ProofSummary {
  readonly id: string;
  readonly status: ProofStatus;
  /** The rendered block, one entry per line. */
  readonly lines: readonly string[];
}

/** `str(summary)` (`proof.py:302-303`). */
export function summaryToString(summary: ProofSummary): string {
  return summary.lines.join("\n");
}

/** The anonymous `BaseSummary` `Proof.summary` builds (`proof.py:272-279`). */
export class BaseSummary implements ProofSummary {
  readonly id: string;
  readonly status: ProofStatus;

  constructor(id: string, status: ProofStatus) {
    this.id = id;
    this.status = status;
    Object.freeze(this);
  }

  get lines(): readonly string[] {
    return [`Proof: ${this.id}`, `    status: ${formatProofStatus(this.status)}`];
  }
}

/**
 * `CompositeSummary` (`proof.py:306-318`).
 *
 * `id` and `status` come from the first member, which is always the proof's
 * own summary; upstream leaves both unset on the dataclass and nothing reads
 * them, but the interface is easier to use with them present.
 */
export class CompositeSummary implements ProofSummary {
  readonly summaries: readonly ProofSummary[];

  constructor(summaries: Iterable<ProofSummary>) {
    this.summaries = Object.freeze([...summaries]);
    Object.freeze(this);
  }

  get id(): string {
    return this.summaries[0]?.id ?? "";
  }

  get status(): ProofStatus {
    return this.summaries[0]?.status ?? "pending";
  }

  get lines(): readonly string[] {
    return this.summaries.flatMap((summary) => [...summary.lines]);
  }
}

/** `APRSummary` (`reachability.py:945-981`) — fourteen fields, all derived. */
export class APRSummary implements ProofSummary {
  readonly id: string;
  readonly status: ProofStatus;
  readonly admitted: boolean;
  readonly nodes: number;
  readonly pending: number;
  readonly failing: number;
  readonly vacuous: number;
  readonly stuck: number;
  readonly terminal: number;
  readonly refuted: number;
  readonly bmcDepth: number | undefined;
  readonly bounded: number;
  readonly subproofs: number;
  readonly formattedExecTime: string;

  constructor(fields: {
    readonly id: string;
    readonly status: ProofStatus;
    readonly admitted: boolean;
    readonly nodes: number;
    readonly pending: number;
    readonly failing: number;
    readonly vacuous: number;
    readonly stuck: number;
    readonly terminal: number;
    readonly refuted: number;
    readonly bmcDepth?: number | undefined;
    readonly bounded: number;
    readonly subproofs: number;
    readonly formattedExecTime: string;
  }) {
    this.id = fields.id;
    this.status = fields.status;
    this.admitted = fields.admitted;
    this.nodes = fields.nodes;
    this.pending = fields.pending;
    this.failing = fields.failing;
    this.vacuous = fields.vacuous;
    this.stuck = fields.stuck;
    this.terminal = fields.terminal;
    this.refuted = fields.refuted;
    this.bmcDepth = fields.bmcDepth;
    this.bounded = fields.bounded;
    this.subproofs = fields.subproofs;
    this.formattedExecTime = fields.formattedExecTime;
    Object.freeze(this);
  }

  /** `APRSummary.lines` (`reachability.py:962-981`); `bmc depth` only when set. */
  get lines(): readonly string[] {
    const lines = [
      `APRProof: ${this.id}`,
      `    status: ${formatProofStatus(this.status)}`,
      `    admitted: ${formatPythonBool(this.admitted)}`,
      `    nodes: ${this.nodes}`,
      `    pending: ${this.pending}`,
      `    failing: ${this.failing}`,
      `    vacuous: ${this.vacuous}`,
      `    stuck: ${this.stuck}`,
      `    terminal: ${this.terminal}`,
      `    refuted: ${this.refuted}`,
      `    bounded: ${this.bounded}`,
      `    execution time: ${this.formattedExecTime}`,
    ];
    if (this.bmcDepth !== undefined) lines.push(`    bmc depth: ${this.bmcDepth}`);
    lines.push(`Subproofs: ${this.subproofs}`);
    return lines;
  }
}

/** `EqualitySummary` (`implies.py:284-296`). */
export class EqualitySummary implements ProofSummary {
  readonly id: string;
  readonly status: ProofStatus;
  readonly admitted: boolean;

  constructor(id: string, status: ProofStatus, admitted: boolean) {
    this.id = id;
    this.status = status;
    this.admitted = admitted;
    Object.freeze(this);
  }

  get lines(): readonly string[] {
    return [
      `EqualityProof: ${this.id}`,
      `    status: ${formatProofStatus(this.status)}`,
      `    admitted: ${formatPythonBool(this.admitted)}`,
    ];
  }
}

/** `RefutationSummary` (`implies.py:398-408`). */
export class RefutationSummary implements ProofSummary {
  readonly id: string;
  readonly status: ProofStatus;

  constructor(id: string, status: ProofStatus) {
    this.id = id;
    this.status = status;
    Object.freeze(this);
  }

  get lines(): readonly string[] {
    return [`RefutationProof: ${this.id}`, `    status: ${formatProofStatus(this.status)}`];
  }
}
