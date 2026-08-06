# Distribution

Each public workspace package is released independently under the
`@kframework-ts` npm scope. The npm tarball is the canonical artifact: it
contains compiled ESM, TypeScript declarations, licenses, third-party notices,
and the package README.

## Installing a release

Use a package registry client and a semver range:

```sh
npm install @kframework-ts/kast
# or: bun add / pnpm add / yarn add @kframework-ts/kast
```

Packages support Node.js 20 or newer and Bun 1.3.14 or newer. Published packages
are ESM-only.

Git dependencies are not a supported distribution channel. A git URL addresses
the repository as a whole rather than one workspace package, and a source
checkout does not contain the ignored `dist/` directories referenced by package
exports. Consumers that need an unpublished build should use a local link or a
packed tarball instead.

### Git-dependency compatibility evidence

This boundary was tested on Linux with npm 10.9.4, Bun 1.3.14, and Node
v22.21.1. Neither npm nor Bun can select a workspace subdirectory from a git
URL. In Bun, each of the following fragment forms is parsed as a commit name:

| spec                                   | Bun response                                                            |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `…#path:/packages/kast-json`           | `no commit matching "path:/packages/kast-json" found (but repo exists)` |
| `…#workspace=@kframework-ts/kast-json` | `no commit matching "workspace=@kframework-ts/kast-json" found`         |
| `…#subdirectory=packages/kast-json`    | `no commit matching "subdirectory=packages/kast-json" found`            |

Two package managers not in play here do support it: Yarn Berry accepts
`#workspace=`, and pnpm accepts `#path:`. Neither npm nor Bun has an
equivalent.

npm and Bun also have materially different git-install behavior. npm clones,
installs development dependencies, runs `prepare`, and packs the result using
the `files` allowlist. Bun copies the checkout, does not apply `files`, and
blocks `prepare` by default. Trusting the dependency permits the script but
does not install its development dependencies. A direct probe of
`github:isaacs/rimraf`, whose `dist/` is gitignored and whose `prepare` runs
`tshy`, produced both outcomes:

```text
$ bun add github:isaacs/rimraf
Blocked 1 postinstall. Run `bun pm untrusted` for details.
$ ls node_modules/rimraf/
… package.json src test tsconfig.json …  # no dist/

$ # with "trustedDependencies": ["rimraf"]
/usr/bin/bash: line 1: tshy: command not found
error: prepare script from "rimraf" exited with 127
```

A root wrapper can make a git URL useful to npm, but it does not make the
source checkout usable to Bun unless generated `dist/` files are committed.
The wrapper's allowlist must use `packages/*/dist/**`: the superficially
similar `packages/*/dist` matched zero files in `npm pack --dry-run --json`;
the corrected pattern matched 24. Committing generated output introduces
source/artifact drift and merge-conflict risk, so it is not a release channel.

## Local development

Build and register the package once:

```sh
bun run build
cd packages/kast
bun link
```

Then link it from the consumer:

```sh
bun link @kframework-ts/kast
```

The consumer records a `link:` dependency backed by Bun's machine-local link
registry. Every fresh machine and CI environment must register the link, and
the package must be rebuilt after source changes because its exports resolve to
`dist/`.

A `link:` specifier is a development overlay, not a portable dependency
declaration. It is recorded in `package.json` and `bun.lock`, but its target is
Bun's machine-local registry. An install with an empty `BUN_INSTALL` registry
fails with `Failed to install 1 package`. A semver declaration does not use a
registered link as a fallback: Bun resolves it through the registry instead.

## Reproducible prerelease artifacts

To test or share the exact artifact that will be published, pack it with Bun:

```sh
cd packages/kast
bun run build
bun pm pack --destination /absolute/output/directory
```

Install the resulting `.tgz` in a scratch consumer with npm, Bun, pnpm, or Yarn.
Use `bun pm pack`, not `npm pack`: Bun resolves `workspace:*` dependencies to
concrete package versions, while npm preserves the workspace protocol and
produces a tarball that registry consumers cannot install.

A packed tarball was installed through Bun from a local HTTP server and
imported with plain Node. It preserved the scoped package name and prebuilt
`dist/`, so neither git-install behavior nor a dependency build step is
involved. The same test is appropriate for a release asset: HTTPS rather than
HTTP is the only transport difference.

The CI smoke matrix applies this process to every public package on Node 20, 22,
and 24. It packs all unpublished workspace dependencies into the same scratch
install, so entry points and dependency declarations are checked without
requiring an existing registry release.

## Publishing

A release requires ownership of the `@kframework-ts` npm scope and publish
credentials for it. From a clean checkout:

1. Set the package's semver version and update any workspace consumers that
   should require the new version.
2. Run `bun install --frozen-lockfile`, `bun run build`, and `bun run check` at
   the repository root.
3. Run `bun publish` from the package directory. Its `prepublishOnly` gate runs
   the repository checks and rebuilds the package.
4. Create and push the tag `<package>-v<version>` only for the published
   artifact.
5. Install the published version in an empty project and run the package's
   `ci/smoke.mjs` with plain Node.

When releasing several packages together, publish dependencies before their
consumers. A valid order for the complete workspace is:

1. `kast`, `kast-json`, `kore`
2. `k-parser`, `konvert`, `kore-rpc`, `klean`, `kompiled`
3. `ktool`, `kcovr`, `cterm`
4. `kcfg`, `kfuzz`, `prooftrace`
5. `proof`

Packages within one row do not depend on each other and may be published in any
order. Private fixture packages are never packed or published.
