/**
 * A deliberately small, typed Lean 4 output model.
 *
 * KLean does not parse Lean.  Terms are opaque strings because the generated
 * theory contains Lean syntax (proof terms, `match`, `where`, collection
 * literals) that would turn this package into a Lean frontend.  Declarations,
 * binders, alternatives, imports, modifiers, and indentation stay structured
 * so the generator has one deterministic place to render them.
 */

/** An opaque Lean expression/type leaf supplied by a lowering pass. */
export type LeanTerm = string;

/** Construct an opaque Lean term while making call sites self-documenting. */
export function leanTerm(text: string): LeanTerm {
  return text;
}

export interface LeanModule {
  readonly imports?: readonly string[];
  readonly commands?: readonly LeanCommand[];
}

export type LeanCommand = LeanDeclaration | LeanMutual;

export interface LeanMutual {
  readonly tag: "mutual";
  readonly commands: readonly LeanDeclaration[];
}

export type LeanDeclaration = LeanAxiom | LeanAbbrev | LeanInductive | LeanInstance | LeanDefinition | LeanStructure;

export interface LeanAxiom {
  readonly tag: "axiom";
  readonly identifier: LeanDeclarationIdentifier;
  readonly signature: LeanSignature;
  readonly modifiers?: LeanModifiers;
}

export interface LeanAbbrev {
  readonly tag: "abbrev";
  readonly identifier: LeanDeclarationIdentifier;
  readonly value: LeanTerm;
  readonly signature?: LeanSignature;
  readonly modifiers?: LeanModifiers;
}

export interface LeanInductive {
  readonly tag: "inductive";
  readonly identifier: LeanDeclarationIdentifier;
  readonly signature?: LeanSignature;
  readonly constructors?: readonly LeanConstructor[];
  readonly deriving?: readonly string[] | undefined;
  readonly modifiers?: LeanModifiers;
}

export interface LeanInstance {
  readonly tag: "instance";
  readonly signature: LeanSignature;
  readonly value: LeanDeclarationValue;
  readonly attributeKind?: LeanAttributeKind;
  readonly priority?: number;
  readonly identifier?: LeanDeclarationIdentifier;
  readonly modifiers?: LeanModifiers;
}

export interface LeanDefinition {
  readonly tag: "definition";
  readonly identifier: LeanDeclarationIdentifier;
  readonly value: LeanDeclarationValue;
  readonly signature?: LeanSignature;
  readonly deriving?: readonly string[] | undefined;
  readonly modifiers?: LeanModifiers;
}

export interface LeanStructure {
  readonly tag: "structure";
  readonly identifier: LeanDeclarationIdentifier;
  readonly signature?: LeanSignature;
  readonly extends?: readonly LeanTerm[];
  readonly constructor?: LeanStructureConstructor;
  readonly deriving?: readonly string[];
  readonly modifiers?: LeanModifiers;
}

export interface LeanDeclarationIdentifier {
  readonly text: string;
  readonly universes?: readonly string[];
}

/** Convenience constructor for declaration names, including universe levels. */
export function leanIdentifier(text: string, universes?: readonly string[]): LeanDeclarationIdentifier {
  return universes === undefined ? { text } : { text, universes };
}

export interface LeanConstructor {
  readonly identifier: string;
  readonly signature?: LeanSignature;
  readonly modifiers?: LeanModifiers;
}

export interface LeanSignature {
  readonly binders?: readonly LeanBinder[] | undefined;
  readonly type?: LeanTerm;
}

export type LeanBinder = LeanExplicitBinder | LeanImplicitBinder | LeanInstanceBinder;

export interface LeanExplicitBinder {
  readonly tag: "explicit";
  readonly identifiers: readonly string[];
  readonly type?: LeanTerm;
}

export interface LeanImplicitBinder {
  readonly tag: "implicit";
  readonly identifiers: readonly string[];
  readonly type?: LeanTerm;
  /** Strict implicits render with `⦃`/`⦄`, otherwise `{`/`}`. */
  readonly strict?: boolean;
}

export interface LeanInstanceBinder {
  readonly tag: "instance";
  readonly type: LeanTerm;
  readonly identifier?: string;
}

export type LeanDeclarationValue = LeanSimpleValue | LeanStructureValue | LeanAlternativesValue;

export interface LeanSimpleValue {
  readonly tag: "simple";
  readonly term: LeanTerm;
}

export interface LeanStructureValue {
  readonly tag: "structure";
  readonly fields: readonly LeanInstanceField[];
}

export interface LeanAlternativesValue {
  readonly tag: "alternatives";
  readonly alternatives: readonly LeanAlternative[];
}

export interface LeanInstanceField {
  readonly identifier: string;
  readonly value: LeanFieldValue;
  readonly signature?: LeanSignature;
}

export type LeanFieldValue = LeanSimpleFieldValue | LeanAlternativesFieldValue;

export interface LeanSimpleFieldValue {
  readonly tag: "simple";
  readonly term: LeanTerm;
}

export interface LeanAlternativesFieldValue {
  readonly tag: "alternatives";
  readonly alternatives: readonly LeanAlternative[];
}

export interface LeanAlternative {
  readonly patterns: readonly LeanTerm[];
  readonly rhs: LeanTerm;
}

export interface LeanStructureConstructor {
  readonly identifier?: LeanStructureIdentifier;
  readonly fields: readonly LeanBinder[];
}

export interface LeanStructureIdentifier {
  readonly text: string;
  readonly modifiers?: LeanModifiers;
}

export interface LeanModifiers {
  readonly attributes?: readonly LeanAttribute[];
  readonly visibility?: LeanVisibility;
  readonly noncomputable?: boolean;
  readonly unsafe?: boolean;
  readonly totality?: LeanTotality;
}

export interface LeanAttribute {
  readonly text: string;
  readonly kind?: LeanAttributeKind;
}

export type LeanAttributeKind = "scoped" | "local";
export type LeanVisibility = "private" | "protected";
export type LeanTotality = "partial" | "nonrec";

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
