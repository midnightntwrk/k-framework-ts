/** Generation of the `Sorts.lean` module. */

import { hasAtt, type CollectionInfo, type SortDecl, type SymbolDecl, type Sort } from "@kframework-ts/kore";

import { leanIdentifier, renderLeanModule, type LeanCommand, type LeanDeclaration } from "./lean.js";
import { leanSymbolIdentifier } from "./names.js";

const PRELUDE_SORTS = new Set([
  "SortBool",
  "SortBytes",
  "SortId",
  "SortInt",
  "SortString",
  "SortStringBuffer",
  "SortEndianness",
  "SortSignedness",
]);

export interface SortsDefinition {
  readonly sorts: ReadonlyMap<string, SortDecl>;
  readonly symbols: ReadonlyMap<string, SymbolDecl>;
  readonly subsorts: ReadonlyMap<string, readonly string[]>;
  readonly constructors: ReadonlyMap<string, readonly string[]>;
  readonly collections: ReadonlyMap<string, CollectionInfo>;
}

export interface SortsOptions {
  readonly deriveBeq?: boolean;
  readonly deriveDecidableEq?: boolean;
}

export interface StructureField {
  readonly name: string;
  readonly type: string;
}

function sortText(sort: Sort): string | undefined {
  return sort.tag === "SortApp" && sort.sorts.length === 0 ? sort.name : undefined;
}

function isCell(sort: string): boolean {
  return sort.endsWith("Cell");
}

/** The constructor symbol of a cell/collection structure, where KLean has one. */
export function structureSymbols(definition: SortsDefinition): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  for (const [sort] of definition.sorts) {
    if (!isCell(sort) && !definition.collections.has(sort)) continue;
    const constructors = definition.constructors.get(sort) ?? [];
    if (constructors.length > 0) result.set(sort, constructors);
  }
  return result;
}

/** Fields used when lowering K cell and collection constructor applications. */
export function structureFields(definition: SortsDefinition): ReadonlyMap<string, readonly StructureField[]> {
  const result = new Map<string, readonly StructureField[]>();
  for (const [sort] of definition.sorts) {
    const collection = definition.collections.get(sort);
    if (collection !== undefined) {
      const element = definition.symbols.get(collection.element);
      const params = element?.paramSorts.map(sortText);
      if (params?.every((entry): entry is string => entry !== undefined)) {
        const type =
          collection.kind === "List" || collection.kind === "Set"
            ? `List ${params[0]}`
            : collection.kind === "Map"
              ? `List (${params[0]} × ${params[1]})`
              : undefined;
        if (type !== undefined) result.set(sort, [{ name: "coll", type }]);
      }
      continue;
    }
    if (!isCell(sort)) continue;
    const constructors = definition.constructors.get(sort) ?? [];
    if (constructors.length !== 1) continue;
    const [constructor] = constructors;
    if (constructor === undefined) continue;
    const declaration = definition.symbols.get(constructor);
    if (declaration === undefined) continue;
    const params = declaration.paramSorts.map(sortText);
    if (!params.every((entry): entry is string => entry !== undefined)) continue;
    const [value] = params;
    const fields = params.every(isCell)
      ? params.map((type) => {
          const stem = type.slice(4, -4);
          return { name: `${stem.slice(0, 1).toLowerCase()}${stem.slice(1)}`, type };
        })
      : params.length === 1 && value !== undefined
        ? [{ name: "val", type: value }]
        : [];
    if (fields.length > 0) result.set(sort, fields);
  }
  return result;
}

function sortDependencies(definition: SortsDefinition, sort: string): readonly string[] {
  const dependencies = new Set(definition.subsorts.get(sort) ?? []);
  for (const symbol of definition.constructors.get(sort) ?? []) {
    const declaration = definition.symbols.get(symbol);
    for (const parameter of declaration?.paramSorts ?? []) {
      const name = sortText(parameter);
      if (name !== undefined) dependencies.add(name);
    }
  }
  const collection = definition.collections.get(sort);
  if (collection !== undefined) {
    for (const parameter of definition.symbols.get(collection.element)?.paramSorts ?? []) {
      const name = sortText(parameter);
      if (name !== undefined) dependencies.add(name);
    }
  }
  dependencies.delete(sort);
  return [...dependencies].toSorted();
}

function orderedSccs(definition: SortsDefinition): readonly (readonly string[])[] {
  const names = [...definition.sorts.keys()].toSorted();
  const graph = new Map(
    names.map((name) => [name, sortDependencies(definition, name).filter((dep) => definition.sorts.has(dep))]),
  );
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const groups: string[][] = [];
  let next = 0;
  const visit = (name: string): void => {
    index.set(name, next);
    low.set(name, next);
    next += 1;
    stack.push(name);
    active.add(name);
    for (const dependency of graph.get(name) ?? []) {
      if (!index.has(dependency)) {
        visit(dependency);
        low.set(name, Math.min(requiredIndex(low, name), requiredIndex(low, dependency)));
      } else if (active.has(dependency))
        low.set(name, Math.min(requiredIndex(low, name), requiredIndex(index, dependency)));
    }
    if (low.get(name) !== index.get(name)) return;
    const group: string[] = [];
    for (;;) {
      const item = stack.pop();
      if (item === undefined) throw new Error("Tarjan stack unexpectedly emptied before its root");
      active.delete(item);
      group.push(item);
      if (item === name) break;
    }
    groups.push(group.toSorted());
  };
  for (const name of names) if (!index.has(name)) visit(name);
  const byItem = new Map<string, number>();
  groups.forEach((group, i) => group.forEach((item) => byItem.set(item, i)));
  const pending = new Set(groups.map((_, i) => i));
  const output: string[][] = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((group) =>
        groups[group]?.every((name) =>
          (graph.get(name) ?? []).every((dep) => {
            const dependencyGroup = byItem.get(dep);
            return dependencyGroup === undefined || !pending.has(dependencyGroup) || dependencyGroup === group;
          }),
        ),
      )
      .toSorted((a, b) => (groups[a]?.[0] ?? "").localeCompare(groups[b]?.[0] ?? ""));
    const group = ready[0];
    if (group === undefined) break;
    pending.delete(group);
    const component = groups[group];
    if (component === undefined) throw new Error("Ready Tarjan component is missing");
    output.push(component);
  }
  return output;
}

function deriving(definition: SortsDefinition, sort: string, options: SortsOptions): readonly string[] | undefined {
  const values: string[] = [];
  if (options.deriveBeq === true) values.push("BEq");
  if (options.deriveDecidableEq === true && !dependsOnSortKItem(definition, sort)) values.push("DecidableEq");
  return values.length === 0 ? undefined : values;
}

/** `DecidableEq` cannot be derived for SortKItem or anything recursively containing it. */
function dependsOnSortKItem(definition: SortsDefinition, root: string): boolean {
  const seen = new Set<string>();
  const pending = [root];
  for (let sort = pending.pop(); sort !== undefined; sort = pending.pop()) {
    if (sort === "SortKItem") return true;
    if (seen.has(sort)) continue;
    seen.add(sort);
    pending.push(...sortDependencies(definition, sort));
  }
  return false;
}

function declarationFor(
  definition: SortsDefinition,
  sort: string,
  fields: ReadonlyMap<string, readonly StructureField[]>,
  options: SortsOptions,
): LeanDeclaration | undefined {
  if (PRELUDE_SORTS.has(sort)) return undefined;
  const decl = definition.sorts.get(sort);
  if (decl === undefined) return undefined;
  const structure = fields.get(sort);
  if (structure !== undefined) {
    const derived = deriving(definition, sort, options);
    return {
      tag: "structure",
      identifier: leanIdentifier(sort),
      signature: { type: "Type" },
      constructor: {
        fields: structure.map((field) => ({ tag: "explicit", identifiers: [field.name], type: field.type })),
      },
      ...(derived === undefined ? {} : { deriving: derived }),
    };
  }
  if (decl.hooked || hasAtt(decl.attrs, "hasDomainValues") || isCell(sort)) return undefined;
  const constructors = [
    ...(definition.subsorts.get(sort) ?? []).toSorted().map((subsort) => ({
      identifier: `inj_${subsort}`,
      signature: { binders: [{ tag: "explicit" as const, identifiers: ["x"], type: subsort }], type: sort },
    })),
    ...(definition.constructors.get(sort) ?? []).toSorted().flatMap((symbol) => {
      const symbolDecl = definition.symbols.get(symbol);
      const parameters = symbolDecl?.paramSorts.map(sortText);
      if (parameters === undefined || !parameters.every((item): item is string => item !== undefined)) return [];
      return [
        {
          identifier: leanSymbolIdentifier(symbol),
          signature: {
            binders: parameters.map((type, i) => ({ tag: "explicit" as const, identifiers: [`x${i}`], type })),
            type: sort,
          },
        },
      ];
    }),
  ];
  const derived = deriving(definition, sort, options);
  return {
    tag: "inductive",
    identifier: leanIdentifier(sort),
    signature: { type: "Type" },
    constructors,
    ...(derived === undefined ? {} : { deriving: derived }),
  };
}

/** Render `Sorts.lean`; callers add their library prefix to the Prelude import. */
export function generateSortsModule(
  definition: SortsDefinition,
  options: SortsOptions = {},
  preludeImport = "Prelude",
): string {
  const fields = structureFields(definition);
  const commands: LeanCommand[] = [];
  for (const group of orderedSccs(definition)) {
    const declarations = group
      .map((sort) => declarationFor(definition, sort, fields, options))
      .filter((entry): entry is LeanDeclaration => entry !== undefined);
    if (declarations.length === 1) {
      const [declaration] = declarations;
      if (declaration === undefined) throw new Error("Single sort SCC is missing its declaration");
      commands.push(declaration);
    } else if (declarations.length > 1) commands.push({ tag: "mutual", commands: declarations });
  }
  return renderLeanModule({ imports: [preludeImport], commands });
}

function requiredIndex(values: ReadonlyMap<string, number>, key: string): number {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Tarjan index is missing ${JSON.stringify(key)}`);
  return value;
}
