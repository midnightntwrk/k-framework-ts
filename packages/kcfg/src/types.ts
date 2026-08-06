import type { CSubstDict, CTermDict } from "@kframework-ts/cterm";

export type NodeId = number;
export type NodeIdLike = NodeId | `@${string}`;

export interface KCFGNodeDict {
  readonly id: number;
  readonly cterm: CTermDict;
  readonly attrs: readonly string[];
}
export interface EdgeDict {
  readonly source: number;
  readonly target: number;
  readonly depth: number;
  readonly rules: readonly string[];
}
export interface MergedEdgeDict {
  readonly source: number;
  readonly target: number;
  readonly edges: readonly EdgeDict[];
}
export interface CoverDict {
  readonly source: number;
  readonly target: number;
  readonly csubst: CSubstDict;
}
export interface SplitTargetDict {
  readonly target: number;
  readonly csubst: CSubstDict;
}
export interface SplitDict {
  readonly source: number;
  readonly targets: readonly SplitTargetDict[];
}
export interface NDBranchDict {
  readonly source: number;
  readonly targets: readonly number[];
  readonly rules: readonly string[];
}
export interface KCFGDict {
  readonly next?: number;
  readonly nodes?: readonly KCFGNodeDict[];
  readonly edges?: readonly EdgeDict[];
  readonly merged_edges?: readonly MergedEdgeDict[];
  readonly covers?: readonly CoverDict[];
  readonly splits?: readonly SplitDict[];
  readonly ndbranches?: readonly NDBranchDict[];
  readonly aliases?: Readonly<Record<string, number>>;
}
