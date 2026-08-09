/**
 * A deliberately small, typed Lean 4 output model.
 *
 * KLean does not parse Lean.  Terms are opaque strings because the generated
 * theory contains Lean syntax (proof terms, `match`, `where`, collection
 * literals) that would turn this package into a Lean frontend.  Declarations,
 * binders, alternatives, imports, modifiers, and indentation stay structured
 * so the generator has one deterministic place to render them.
 */

import { z } from "zod";

/** An opaque Lean expression/type leaf supplied by a lowering pass. */
export type LeanTerm = z.infer<typeof leanTermSchema>;

/** Construct an opaque Lean term while making call sites self-documenting. */
export function leanTerm(text: string): LeanTerm {
  return text;
}

export type LeanModule = z.infer<typeof leanModuleSchema>;

export type LeanCommand = LeanDeclaration | LeanMutual;

export interface LeanMutual {
  readonly tag: "mutual";
  readonly commands: readonly LeanDeclaration[];
}

export type LeanDeclaration = LeanAxiom | LeanAbbrev | LeanInductive | LeanInstance | LeanDefinition | LeanStructure;

export type LeanAxiom = z.infer<typeof leanAxiomSchema>;
export type LeanAbbrev = z.infer<typeof leanAbbrevSchema>;
export type LeanInductive = z.infer<typeof leanInductiveSchema>;
export type LeanInstance = z.infer<typeof leanInstanceSchema>;
export type LeanDefinition = z.infer<typeof leanDefinitionSchema>;
export type LeanStructure = z.infer<typeof leanStructureSchema>;
export type LeanDeclarationIdentifier = z.infer<typeof leanDeclarationIdentifierSchema>;

/** Convenience constructor for declaration names, including universe levels. */
export function leanIdentifier(text: string, universes?: readonly string[]): LeanDeclarationIdentifier {
  return universes === undefined ? { text } : { text, universes };
}

export type LeanConstructor = z.infer<typeof leanConstructorSchema>;
export type LeanSignature = z.infer<typeof leanSignatureSchema>;
export type LeanBinder = z.infer<typeof leanBinderSchema>;
export type LeanExplicitBinder = z.infer<typeof leanExplicitBinderSchema>;
export type LeanImplicitBinder = z.infer<typeof leanImplicitBinderSchema>;
export type LeanInstanceBinder = z.infer<typeof leanInstanceBinderSchema>;
export type LeanDeclarationValue = z.infer<typeof leanDeclarationValueSchema>;
export type LeanSimpleValue = z.infer<typeof leanSimpleValueSchema>;
export type LeanStructureValue = z.infer<typeof leanStructureValueSchema>;
export type LeanAlternativesValue = z.infer<typeof leanAlternativesValueSchema>;
export type LeanInstanceField = z.infer<typeof leanInstanceFieldSchema>;
export type LeanFieldValue = z.infer<typeof leanFieldValueSchema>;
export type LeanSimpleFieldValue = z.infer<typeof leanSimpleFieldValueSchema>;
export type LeanAlternativesFieldValue = z.infer<typeof leanAlternativesFieldValueSchema>;
export type LeanAlternative = z.infer<typeof leanAlternativeSchema>;
export type LeanStructureConstructor = z.infer<typeof leanStructureConstructorSchema>;
export type LeanStructureIdentifier = z.infer<typeof leanStructureIdentifierSchema>;
export type LeanModifiers = z.infer<typeof leanModifiersSchema>;
export type LeanAttribute = z.infer<typeof leanAttributeSchema>;
export type LeanAttributeKind = z.infer<typeof leanAttributeKindSchema>;
export type LeanVisibility = z.infer<typeof leanVisibilitySchema>;
export type LeanTotality = z.infer<typeof leanTotalitySchema>;

/** Named structural dependencies of {@link leanModuleSchema}; objects strip unknown keys by default. */
export const leanTermSchema = z.string();
export const leanAttributeKindSchema = z.enum(["scoped", "local"]);
export const leanVisibilitySchema = z.enum(["private", "protected"]);
export const leanTotalitySchema = z.enum(["partial", "nonrec"]);
export const leanAttributeSchema = z.object({
  text: z.string(),
  kind: leanAttributeKindSchema.optional(),
});
export const leanModifiersSchema = z.object({
  attributes: z.array(leanAttributeSchema).readonly().optional(),
  visibility: leanVisibilitySchema.optional(),
  noncomputable: z.boolean().optional(),
  unsafe: z.boolean().optional(),
  totality: leanTotalitySchema.optional(),
});
export const leanDeclarationIdentifierSchema = z.object({
  text: z.string(),
  universes: z.array(z.string()).readonly().optional(),
});
export const leanExplicitBinderSchema = z.object({
  tag: z.literal("explicit"),
  identifiers: z.array(z.string()).readonly(),
  type: leanTermSchema.optional(),
});
export const leanImplicitBinderSchema = z.object({
  tag: z.literal("implicit"),
  identifiers: z.array(z.string()).readonly(),
  type: leanTermSchema.optional(),
  strict: z.boolean().optional(),
});
export const leanInstanceBinderSchema = z.object({
  tag: z.literal("instance"),
  type: leanTermSchema,
  identifier: z.string().optional(),
});
export const leanBinderSchema = z.discriminatedUnion("tag", [
  leanExplicitBinderSchema,
  leanImplicitBinderSchema,
  leanInstanceBinderSchema,
]);
export const leanSignatureSchema = z.object({
  binders: z.array(leanBinderSchema).readonly().optional(),
  type: leanTermSchema.optional(),
});
export const leanConstructorSchema = z.object({
  identifier: z.string(),
  signature: leanSignatureSchema.optional(),
  modifiers: leanModifiersSchema.optional(),
});
export const leanSimpleValueSchema = z.object({ tag: z.literal("simple"), term: leanTermSchema });
export const leanAlternativeSchema = z.object({ patterns: z.array(leanTermSchema).readonly(), rhs: leanTermSchema });
export const leanSimpleFieldValueSchema = z.object({ tag: z.literal("simple"), term: leanTermSchema });
export const leanAlternativesFieldValueSchema = z.object({
  tag: z.literal("alternatives"),
  alternatives: z.array(leanAlternativeSchema).readonly(),
});
export const leanFieldValueSchema = z.discriminatedUnion("tag", [
  leanSimpleFieldValueSchema,
  leanAlternativesFieldValueSchema,
]);
export const leanInstanceFieldSchema = z.object({
  identifier: z.string(),
  value: leanFieldValueSchema,
  signature: leanSignatureSchema.optional(),
});
export const leanStructureValueSchema = z.object({
  tag: z.literal("structure"),
  fields: z.array(leanInstanceFieldSchema).readonly(),
});
export const leanAlternativesValueSchema = z.object({
  tag: z.literal("alternatives"),
  alternatives: z.array(leanAlternativeSchema).readonly(),
});
export const leanDeclarationValueSchema = z.discriminatedUnion("tag", [
  leanSimpleValueSchema,
  leanStructureValueSchema,
  leanAlternativesValueSchema,
]);
export const leanStructureIdentifierSchema = z.object({
  text: z.string(),
  modifiers: leanModifiersSchema.optional(),
});
export const leanStructureConstructorSchema = z.object({
  identifier: leanStructureIdentifierSchema.optional(),
  fields: z.array(leanBinderSchema).readonly(),
});
export const leanAxiomSchema = z.object({
  tag: z.literal("axiom"),
  identifier: leanDeclarationIdentifierSchema,
  signature: leanSignatureSchema,
  modifiers: leanModifiersSchema.optional(),
});
export const leanAbbrevSchema = z.object({
  tag: z.literal("abbrev"),
  identifier: leanDeclarationIdentifierSchema,
  value: leanTermSchema,
  signature: leanSignatureSchema.optional(),
  modifiers: leanModifiersSchema.optional(),
});
export const leanInductiveSchema = z.object({
  tag: z.literal("inductive"),
  identifier: leanDeclarationIdentifierSchema,
  signature: leanSignatureSchema.optional(),
  constructors: z.array(leanConstructorSchema).readonly().optional(),
  deriving: z.array(z.string()).readonly().optional(),
  modifiers: leanModifiersSchema.optional(),
});
export const leanInstanceSchema = z.object({
  tag: z.literal("instance"),
  signature: leanSignatureSchema,
  value: leanDeclarationValueSchema,
  attributeKind: leanAttributeKindSchema.optional(),
  priority: z.number().optional(),
  identifier: leanDeclarationIdentifierSchema.optional(),
  modifiers: leanModifiersSchema.optional(),
});
export const leanDefinitionSchema = z.object({
  tag: z.literal("definition"),
  identifier: leanDeclarationIdentifierSchema,
  value: leanDeclarationValueSchema,
  signature: leanSignatureSchema.optional(),
  deriving: z.array(z.string()).readonly().optional(),
  modifiers: leanModifiersSchema.optional(),
});
export const leanStructureSchema = z.object({
  tag: z.literal("structure"),
  identifier: leanDeclarationIdentifierSchema,
  signature: leanSignatureSchema.optional(),
  extends: z.array(leanTermSchema).readonly().optional(),
  constructor: leanStructureConstructorSchema.optional(),
  deriving: z.array(z.string()).readonly().optional(),
  modifiers: leanModifiersSchema.optional(),
});
export const leanDeclarationSchema: z.ZodType<LeanDeclaration> = z.discriminatedUnion("tag", [
  leanAxiomSchema,
  leanAbbrevSchema,
  leanInductiveSchema,
  leanInstanceSchema,
  leanDefinitionSchema,
  leanStructureSchema,
]);
export const leanMutualSchema: z.ZodType<LeanMutual> = z.object({
  tag: z.literal("mutual"),
  commands: z.array(leanDeclarationSchema).readonly(),
});
export const leanCommandSchema: z.ZodType<LeanCommand> = z.union([leanDeclarationSchema, leanMutualSchema]);
export const leanModuleSchema = z.object({
  imports: z.array(z.string()).readonly().optional(),
  commands: z.array(leanCommandSchema).readonly().optional(),
});

/** Render a module with one final newline whenever it has output. */
export function renderLeanModule(module: LeanModule): string {
  const imports = (module.imports ?? []).map((entry) => `import ${entry}`).join("\n");
  const commands = (module.commands ?? []).map(renderLeanCommand).join("\n\n");
  const text = [imports, commands].filter((section) => section.length > 0).join("\n\n");
  return text.length === 0 ? "" : `${text}\n`;
}

export function renderLeanCommand(command: LeanCommand): string {
  if (command.tag !== "mutual") return renderLeanDeclaration(command);
  const commands = command.commands
    .map(renderLeanDeclaration)
    .map((text) => indentLean(text, 2))
    .join("\n\n");
  return commands.length === 0 ? "mutual\nend" : `mutual\n${commands}\nend`;
}

export function renderLeanDeclaration(declaration: LeanDeclaration): string {
  const modifiers = renderLeanModifiers(declaration.modifiers);
  const prefix = modifiers.length === 0 ? "" : `${modifiers} `;
  switch (declaration.tag) {
    case "axiom":
      return `${prefix}axiom ${renderLeanDeclarationIdentifier(declaration.identifier)} ${renderLeanSignature(declaration.signature)}`;
    case "abbrev": {
      const signature = declaration.signature === undefined ? "" : ` ${renderLeanSignature(declaration.signature)}`;
      return `${prefix}abbrev ${renderLeanDeclarationIdentifier(declaration.identifier)}${signature} := ${declaration.value}`;
    }
    case "inductive":
      return renderLeanInductive(declaration, prefix);
    case "instance":
      return renderLeanInstance(declaration, prefix);
    case "definition":
      return renderLeanDefinition(declaration, prefix);
    case "structure":
      return renderLeanStructure(declaration, prefix);
  }
  return unreachableLeanVariant(declaration);
}

export function renderLeanDeclarationIdentifier(identifier: LeanDeclarationIdentifier): string {
  const universes = identifier.universes?.join(", ");
  return universes === undefined || universes.length === 0 ? identifier.text : `${identifier.text}.{${universes}}`;
}

export function renderLeanSignature(signature: LeanSignature): string {
  const binders = (signature.binders ?? []).map(renderLeanBinder).join(" ");
  if (signature.type === undefined) return binders;
  return binders.length === 0 ? `: ${signature.type}` : `${binders} : ${signature.type}`;
}

export function renderLeanBinder(binder: LeanBinder): string {
  switch (binder.tag) {
    case "explicit":
      return renderLeanBracketBinder("(", ")", binder.identifiers, binder.type);
    case "implicit":
      return renderLeanBracketBinder(
        binder.strict === true ? "⦃" : "{",
        binder.strict === true ? "⦄" : "}",
        binder.identifiers,
        binder.type,
      );
    case "instance":
      return `[${binder.identifier === undefined ? "" : `${binder.identifier} : `}${binder.type}]`;
  }
  return unreachableLeanVariant(binder);
}

export function renderLeanModifiers(modifiers: LeanModifiers | undefined): string {
  if (modifiers === undefined) return "";
  const parts: string[] = [];
  if ((modifiers.attributes?.length ?? 0) > 0)
    parts.push(`@[${modifiers.attributes?.map(renderLeanAttribute).join(", ")}]`);
  if (modifiers.visibility !== undefined) parts.push(modifiers.visibility);
  if (modifiers.noncomputable === true) parts.push("noncomputable");
  if (modifiers.unsafe === true) parts.push("unsafe");
  if (modifiers.totality !== undefined) parts.push(modifiers.totality);
  return parts.join(" ");
}

export function renderLeanAlternative(alternative: LeanAlternative): string {
  return `| ${alternative.patterns.join(", ")} => ${alternative.rhs}`;
}

/** Indent nonblank lines only, matching Lean's conventional blank-line layout. */
export function indentLean(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${prefix}${line}`))
    .join("\n");
}

function renderLeanInductive(declaration: LeanInductive, prefix: string): string {
  const signature = declaration.signature === undefined ? "" : ` ${renderLeanSignature(declaration.signature)}`;
  const constructors = declaration.constructors ?? [];
  const lines = [
    `${prefix}inductive ${renderLeanDeclarationIdentifier(declaration.identifier)}${signature}${constructors.length === 0 ? "" : " where"}`,
  ];
  lines.push(...constructors.map((constructor) => `  | ${renderLeanConstructor(constructor)}`));
  if ((declaration.deriving?.length ?? 0) > 0) lines.push(`  deriving ${declaration.deriving?.join(", ")}`);
  return lines.join("\n");
}

function renderLeanInstance(declaration: LeanInstance, prefix: string): string {
  if (declaration.signature.type === undefined) throw new TypeError("Lean instance declarations require a result type");
  if (declaration.priority !== undefined && (!Number.isInteger(declaration.priority) || declaration.priority < 0))
    throw new RangeError("Lean instance priority must be a non-negative integer");
  const attributeKind = declaration.attributeKind === undefined ? "" : `${declaration.attributeKind} `;
  const priority = declaration.priority === undefined ? "" : ` (priority := ${declaration.priority})`;
  const identifier =
    declaration.identifier === undefined ? "" : ` ${renderLeanDeclarationIdentifier(declaration.identifier)}`;
  const head = `${prefix}${attributeKind}instance${priority}${identifier} ${renderLeanSignature(declaration.signature)}`;
  return renderLeanValueDeclaration(head, declaration.value);
}

function renderLeanDefinition(declaration: LeanDefinition, prefix: string): string {
  const signature = declaration.signature === undefined ? "" : ` ${renderLeanSignature(declaration.signature)}`;
  const rendered = renderLeanValueDeclaration(
    `${prefix}def ${renderLeanDeclarationIdentifier(declaration.identifier)}${signature}`,
    declaration.value,
  );
  return (declaration.deriving?.length ?? 0) === 0
    ? rendered
    : `${rendered}\n  deriving ${declaration.deriving?.join(", ")}`;
}

function renderLeanStructure(declaration: LeanStructure, prefix: string): string {
  const signature = declaration.signature;
  const binders = signature?.binders?.map(renderLeanBinder).join(" ") ?? "";
  const extendsTypes = declaration.extends?.join(", ") ?? "";
  const type = signature?.type === undefined ? "" : ` : ${signature.type}`;
  const lines = [
    `${prefix}structure ${renderLeanDeclarationIdentifier(declaration.identifier)}${binders.length === 0 ? "" : ` ${binders}`}${extendsTypes.length === 0 ? "" : ` extends ${extendsTypes}`}${type}${declaration.constructor === undefined ? "" : " where"}`,
  ];
  if (declaration.constructor !== undefined) lines.push(...renderLeanStructureConstructor(declaration.constructor));
  if ((declaration.deriving?.length ?? 0) > 0) lines.push(`  deriving ${declaration.deriving?.join(", ")}`);
  return lines.join("\n");
}

function renderLeanValueDeclaration(head: string, value: LeanDeclarationValue): string {
  switch (value.tag) {
    case "simple":
      return `${head} := ${value.term}`;
    case "structure":
      return [`${head} where`, ...value.fields.map((field) => indentLean(renderLeanInstanceField(field), 2))].join(
        "\n",
      );
    case "alternatives":
      return [head, ...value.alternatives.map((alternative) => indentLean(renderLeanAlternative(alternative), 2))].join(
        "\n",
      );
  }
  return unreachableLeanVariant(value);
}

function renderLeanInstanceField(field: LeanInstanceField): string {
  const signature = field.signature === undefined ? "" : ` ${renderLeanSignature(field.signature)}`;
  const head = `${field.identifier}${signature}`;
  switch (field.value.tag) {
    case "simple":
      return `${head} := ${field.value.term}`;
    case "alternatives":
      return [
        head,
        ...field.value.alternatives.map((alternative) => indentLean(renderLeanAlternative(alternative), 2)),
      ].join("\n");
  }
  return unreachableLeanVariant(field.value);
}

function renderLeanConstructor(constructor: LeanConstructor): string {
  const modifiers = renderLeanModifiers(constructor.modifiers);
  const signature = constructor.signature === undefined ? "" : ` ${renderLeanSignature(constructor.signature)}`;
  return `${modifiers.length === 0 ? "" : `${modifiers} `}${constructor.identifier}${signature}`;
}

function renderLeanStructureConstructor(constructor: LeanStructureConstructor): string[] {
  const lines: string[] = [];
  if (constructor.identifier !== undefined) {
    const modifiers = renderLeanModifiers(constructor.identifier.modifiers);
    lines.push(`  ${modifiers.length === 0 ? "" : `${modifiers} `}${constructor.identifier.text} ::`);
  }
  for (const field of constructor.fields) {
    if (field.tag === "explicit" && field.identifiers.length === 1) {
      const identifier = field.identifiers[0];
      if (identifier === undefined) throw new TypeError("Lean structure field identifier is missing");
      lines.push(`  ${identifier}${field.type === undefined ? "" : ` : ${field.type}`}`);
    } else {
      lines.push(`  ${renderLeanBinder(field)}`);
    }
  }
  return lines;
}

function renderLeanBracketBinder(
  left: string,
  right: string,
  identifiers: readonly string[],
  type: LeanTerm | undefined,
): string {
  return `${left}${identifiers.join(" ")}${type === undefined ? "" : ` : ${type}`}${right}`;
}

function renderLeanAttribute(attribute: LeanAttribute): string {
  return attribute.kind === undefined ? attribute.text : `${attribute.kind} ${attribute.text}`;
}

function unreachableLeanVariant(value: never): never {
  throw new TypeError(`Unknown Lean output-model variant: ${JSON.stringify(value)}`);
}
