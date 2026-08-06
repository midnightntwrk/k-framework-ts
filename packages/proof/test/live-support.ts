/**
 * Shared plumbing for the live-K suites that were added with the façade.
 *
 * `live-k.test.ts` builds the `KPrint` → server → client → `CTermSymbolic` →
 * `KCFGExplore` tower by hand on purpose: that suite is where the tower itself
 * is under test. Everything added afterwards goes through the library's own
 * {@link withExplore} instead, which is both less code and a standing check
 * that the session helper this package now ships really does stand up a
 * backend.
 *
 * Spec files are copied into a temporary directory before loading, because
 * `ClaimLoader` writes its `<spec>.json` parse cache next to the spec and
 * `fixtures/` is not a scratch directory.
 */

import type { CTermSymbolic } from "@kframework-ts/cterm/symbolic";
import type { KClaim, KDefinition } from "@kframework-ts/kast";
import type { KCFGExplore, KCFGSemantics } from "@kframework-ts/kcfg/explore";
import { ClaimLoader, kDistributionFrom, KproveModuleParser, type KPrint } from "@kframework-ts/ktool";
import { requireKTestEnvironment } from "@kframework-ts/ktool/testing";
import { expect } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { withExplore, type ExploreSession } from "../src/prove.ts";

/** Everything vendored under `fixtures/live-k`. */
export const FIXTURES = join(import.meta.dir, "../fixtures/live-k");
/** `imp.k` is vendored once, by `@kframework-ts/kompiled`. */
export const KOMPILED_SRC = join(import.meta.dir, "../../kompiled/fixtures/src");
/** `cell-map.k` and `simple-proofs.k` are vendored once, by `@kframework-ts/konvert`. */
export const KONVERT_SRC = join(import.meta.dir, "../../konvert/fixtures/src");

/** Live suites kompile, start servers and prove; a minute is not enough. */
export const TIMEOUT = 900_000;

export interface ClaimSelection {
  readonly specModuleName?: string;
  readonly claimLabels?: readonly string[];
  readonly includeDirs?: readonly string[];
}

export interface LiveContext {
  readonly session: ExploreSession;
  readonly explore: KCFGExplore;
  readonly symbolic: CTermSymbolic;
  readonly definition: KDefinition;
  readonly kprint: KPrint;
  /** A writable directory removed with the rest of the run. */
  readonly scratch: string;
  /** K's `include/kframework/builtin`, for `ClaimLoader`'s digest. */
  readonly builtinDir: string;
  /** Paths of the K binaries, for suites that drive the façade or the CLI. */
  readonly binDir: string;
  /** Copy a spec somewhere writable and load its claims. */
  claims(specFile: string, options?: ClaimSelection): Promise<KClaim[]>;
  /** The writable copy of a fixture spec file, which is what the façade is pointed at. */
  copySpec(specFile: string): Promise<string>;
}

export interface LiveSessionOptions {
  /**
   * `--smt-timeout` on the server, in milliseconds.
   *
   * `kore-rpc`'s default is 40 ms, which is enough for everything these suites
   * ask; the knob is here because a query that needs more is a real failure
   * mode — see `live-goto.test.ts`.
   */
  readonly smtTimeout?: number;
}

/**
 * Stand up a backend over one kompiled definition and run `body`.
 *
 * The client is labelled with the suite name — this package's answer to pyk's
 * per-proof `client_label` ContextVar, which `@kframework-ts/kore-rpc` takes at
 * client construction instead.
 */
export async function withLiveSession(
  definitionDir: string,
  moduleName: string,
  semantics: KCFGSemantics,
  label: string,
  body: (context: LiveContext) => Promise<void>,
  options: LiveSessionOptions = {},
): Promise<void> {
  const environment = await requireKTestEnvironment();
  const distribution = kDistributionFrom(environment.kompilePath);
  const scratch = await mkdtemp(join(tmpdir(), "kframework-ts-proof-live-"));
  try {
    await withExplore(
      {
        definitionDir,
        moduleName,
        semantics,
        id: label,
        koreRpcCommand: [join(environment.binDir, "kore-rpc")],
        ...(options.smtTimeout === undefined ? {} : { smtTimeout: options.smtTimeout }),
        kastCommand: [join(environment.binDir, "kast")],
        korePrintCommand: [join(environment.binDir, "kore-print")],
      },
      async (session) => {
        const loader = new ClaimLoader(
          new KproveModuleParser({ definitionDir, command: [join(environment.binDir, "kprove")] }),
        );
        const copySpec = async (specFile: string): Promise<string> => {
          const copied = join(scratch, basename(specFile));
          await copyFile(specFile, copied);
          return copied;
        };
        await body({
          session,
          explore: session.explore,
          symbolic: session.symbolic,
          definition: session.definition,
          kprint: session.kprint,
          scratch,
          builtinDir: distribution.builtinDir,
          binDir: environment.binDir,
          copySpec,
          claims: async (specFile, selection = {}) =>
            loader.loadClaims(await copySpec(specFile), {
              ...(selection.specModuleName === undefined ? {} : { specModuleName: selection.specModuleName }),
              ...(selection.claimLabels === undefined ? {} : { claimLabels: selection.claimLabels }),
              includeDirs: selection.includeDirs ?? [],
              builtinDir: distribution.builtinDir,
            }),
        });
      },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The one element of a list that must have exactly one. */
export function single<T>(values: readonly T[]): T {
  expect(values).toHaveLength(1);
  return values[0]!;
}
