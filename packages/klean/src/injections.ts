/** Generation of subsort `Inj` instances. */

import { leanIdentifier, renderLeanModule, type LeanDeclaration } from "./lean.js";
import type { SortsDefinition } from "./sorts.js";

function injectionValue(subsort: string, supersort: string, definition: SortsDefinition): string {
  const below = (definition.subsorts.get(subsort) ?? []).filter((sort) => !sort.endsWith("CellMap")).toSorted();
  if (below.length === 0) return `${supersort}.inj_${subsort}`;
  const alternatives = below.map((sort) => `| ${subsort}.inj_${sort} x => ${supersort}.inj_${sort} x`);
  if ((definition.constructors.get(subsort)?.length ?? 0) > 0)
    alternatives.push(`| x => ${supersort}.inj_${subsort} x`);
  return `fun x => match x with\n${alternatives.map((alternative) => `  ${alternative}`).join("\n")}`;
}

function retractionValue(subsort: string, supersort: string, definition: SortsDefinition): string {
  const below = (definition.subsorts.get(subsort) ?? []).filter((sort) => !sort.endsWith("CellMap")).toSorted();
  const alternatives = below.map((sort) => `| ${supersort}.inj_${sort} x => some (${subsort}.inj_${sort} x)`);
  alternatives.push(`| ${supersort}.inj_${subsort} x => some x`);
  const covered = below.length + 1;
  const total =
    (definition.constructors.get(supersort)?.length ?? 0) + (definition.subsorts.get(supersort)?.length ?? 0);
  if (total > covered) alternatives.push("| _ => none");
  return alternatives.join("\n");
}

/** Render `Inj.lean`; deliberately skips K's peculiar value-to-CellMap injections. */
export function generateInjectionsModule(definition: SortsDefinition, sortsImport = "Sorts"): string {
  const commands: LeanDeclaration[] = [];
  for (const [supersort, listed] of [...definition.subsorts.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (supersort.endsWith("CellMap")) continue;
    for (const subsort of [...listed].toSorted()) {
      commands.push({
        tag: "instance",
        identifier: leanIdentifier(`inj_${subsort}_${supersort}`),
        signature: { type: `Inj ${subsort} ${supersort}` },
        value: {
          tag: "structure",
          fields: [
            { identifier: "inj", value: { tag: "simple", term: injectionValue(subsort, supersort, definition) } },
            {
              identifier: "retr",
              value: {
                tag: "alternatives",
                alternatives: retractionValue(subsort, supersort, definition)
                  .split("\n")
                  .map((line) => {
                    const match = /^\| (.*) => (.*)$/u.exec(line);
                    return { patterns: [match?.[1] ?? "_"], rhs: match?.[2] ?? "none" };
                  }),
              },
            },
          ],
        },
      });
    }
  }
  return renderLeanModule({ imports: [sortsImport], commands });
}
