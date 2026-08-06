import type { KCFG } from "./kcfg.js";
import { successorTargets, type KCFGSuccessor } from "./successor.js";
import type { NodeIdLike } from "./types.js";

/** An edge object plus the particular target selected when a split/branch is traversed. */
export interface KCFGPathStep {
  readonly successor: KCFGSuccessor;
  readonly target: number;
}
export type KCFGPath = readonly KCFGPathStep[];

export function successorWeight(successor: KCFGSuccessor): number {
  return successor.weight;
}
export function pathWeight(path: Iterable<KCFGSuccessor | KCFGPathStep>): number {
  let result = 0;
  for (const item of path) result += "successor" in item ? item.successor.weight : item.weight;
  return result;
}

/** Enumerate simple directed paths. This is intentionally exponential. */
export function pathsBetween(graph: KCFG, source: NodeIdLike, target: NodeIdLike): readonly KCFGPath[] {
  const from = graph.resolve(source);
  const to = graph.resolve(target);
  if (from === to) return Object.freeze([Object.freeze([])]);
  const paths: KCFGPath[] = [];
  const visit = (current: number, seen: ReadonlySet<number>, path: readonly KCFGPathStep[]): void => {
    const successor = graph.successor(current);
    if (successor === undefined) return;
    for (const next of successorTargets(successor)) {
      if (seen.has(next.id)) continue;
      const extended = Object.freeze([...path, Object.freeze({ successor, target: next.id })]);
      if (next.id === to) paths.push(extended);
      else visit(next.id, new Set([...seen, next.id]), extended);
    }
  };
  visit(from, new Set([from]), []);
  return Object.freeze(paths);
}

interface QueueEntry {
  readonly id: number;
  readonly distance: number;
  readonly serial: number;
  readonly path: KCFGPath;
}
function less(a: QueueEntry, b: QueueEntry): boolean {
  return a.distance !== b.distance
    ? a.distance < b.distance
    : a.serial !== b.serial
      ? a.serial < b.serial
      : a.id < b.id;
}

/** Dijkstra over the graph's successor objects. Equal distances use insertion then node-id order. */
export function shortestPathBetween(graph: KCFG, source: NodeIdLike, target: NodeIdLike): KCFGPath | undefined {
  const from = graph.resolve(source);
  const to = graph.resolve(target);
  if (from === to) return Object.freeze([]);
  const heap: QueueEntry[] = [];
  let serial = 0;
  const push = (entry: QueueEntry): void => {
    heap.push(entry);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (!less(heap[i]!, heap[parent]!)) break;
      [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
      i = parent;
    }
  };
  const pop = (): QueueEntry | undefined => {
    const first = heap[0];
    const last = heap.pop();
    if (first === undefined) return undefined;
    if (last !== undefined && heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let child = i;
        if (left < heap.length && less(heap[left]!, heap[child]!)) child = left;
        if (right < heap.length && less(heap[right]!, heap[child]!)) child = right;
        if (child === i) break;
        [heap[i], heap[child]] = [heap[child]!, heap[i]!];
        i = child;
      }
    }
    return first;
  };
  const distances = new Map<number, number>([[from, 0]]);
  push({ id: from, distance: 0, serial: serial++, path: Object.freeze([]) });
  for (let entry; (entry = pop()) !== undefined;) {
    if (entry.distance !== distances.get(entry.id)) continue;
    if (entry.id === to) return entry.path;
    const successor = graph.successor(entry.id);
    if (successor === undefined) continue;
    for (const next of successorTargets(successor)) {
      const distance = entry.distance + successor.weight;
      const old = distances.get(next.id);
      if (old !== undefined && old <= distance) continue;
      distances.set(next.id, distance);
      push({
        id: next.id,
        distance,
        serial: serial++,
        path: Object.freeze([...entry.path, Object.freeze({ successor, target: next.id })]),
      });
    }
  }
  return undefined;
}

export function shortestDistanceBetween(graph: KCFG, first: NodeIdLike, second: NodeIdLike): number | undefined {
  const forward = shortestPathBetween(graph, first, second);
  const reverse = shortestPathBetween(graph, second, first);
  const a = forward === undefined ? undefined : pathWeight(forward);
  const b = reverse === undefined ? undefined : pathWeight(reverse);
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

export function zeroDepthBetween(graph: KCFG, first: NodeIdLike, second: NodeIdLike): boolean {
  const a = graph.resolve(first);
  const b = graph.resolve(second);
  if (a === b) return true;
  const reaches = (from: number, to: number): boolean => {
    const seen = new Set<number>([from]);
    const pending = [from];
    while (pending.length > 0) {
      const id = pending.pop()!;
      const successor = graph.successor(id);
      if (successor === undefined || successor.weight !== 0) continue;
      for (const next of successorTargets(successor)) {
        if (next.id === to) return true;
        if (!seen.has(next.id)) {
          seen.add(next.id);
          pending.push(next.id);
        }
      }
    }
    return false;
  };
  return reaches(a, b) || reaches(b, a);
}
