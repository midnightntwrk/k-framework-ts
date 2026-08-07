/**
 * `@kframework-ts/kompiled/core` — the package with **no `node:fs`** in it.
 *
 * The root entry point re-exports `fs.ts`, so a static
 * `import … from "@kframework-ts/kompiled"` pulls `node:fs`, `node:fs/promises`
 * and `node:path` into the module graph whether or not the importer ever calls
 * `loadKompiledDefinition`.  A bundler that tree-shakes will drop them again;
 * a runtime that does not tree-shake (a browser `import`, a Deno/Workers-style
 * environment with no `node:fs`, a plain `<script type=module>`) will not, and
 * the README's "build a `KompiledSource` yourself" story is exactly the case
 * where none of that code is wanted.
 *
 * So this subpath exists for it.  It is the same modules the root exports,
 * minus `fs.ts` and minus nothing else:
 *
 * - {@link KompiledDefinition} and {@link KompiledSource} (`kompiled.ts`)
 * - {@link parseKompiledLayout} and friends (`layout.ts`)
 * - the error classes (`errors.ts`)
 * - the transcription manifest (`version.ts`, `ksources.ts`)
 *
 * ```ts
 * import { KompiledDefinition, parseKompiledLayout } from "@kframework-ts/kompiled/core";
 *
 * const layout = parseKompiledLayout({ mainModule, mainSyntaxModule, backend, timestampMtimeMs });
 * const kompiled = new KompiledDefinition({ path: "<zip>", layout, read: (a) => zip.get(a) });
 * ```
 *
 * The root export includes everything in this subpath.
 */

export * from "./errors.js";
export * from "./kompiled.js";
export * from "./ksources.js";
export * from "./layout.js";
export * from "./parser-artifacts.js";
export * from "./version.js";
