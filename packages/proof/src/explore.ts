/**
 * `withExplore` — the context that owns a backend for a proof run.
 *
 * A kompiled directory goes in, a live `KCFGExplore` comes out, and the
 * resources this session starts are torn down on the way out. Its construction
 * follows `kevm_pyk.utils.legacy_explore` (`utils.py:351-420`); `ProveRpc`
 * accepts an `explore_context` callable, and `withExplore` provides that
 * lifecycle as a reusable TypeScript interface.
 *
 * The tower it assembles is the one `pyk.testing`'s `KCFGExploreTest` builds
 * (`_kompiler.py:206-279`) and the one this package's live suite already builds
 * by hand:
 *
 * ```text
 * kompiled dir ──> KPrint ────────────────┐
 *              └─> koreRpcServer ─> tcpTransport ─> KoreClient ─> CTermSymbolic ─> KCFGExplore
 * ```
 *
 * # Lifetimes, per the kore-rpc README
 *
 * - **A server handle resolving means started, not ready.** The connect-retry
 *   loop is the readiness mechanism, and a server that died on a usage error
 *   refuses connections exactly like one that is still opening its socket — so
 *   the connect is raced against `server.exited`.
 * - **The client's lifetime belongs to whoever constructed it.** This session
 *   constructed them, so it closes them: the default one and every extra one
 *   {@link ExploreSession.createExplore} hands out.
 * - **A server this session did not start is not stopped by it.** Passing
 *   `port` connects to somebody else's server, which is `start_server=False`
 *   upstream.
 * - **`add-module` state is per session.** Every extra client is a fresh
 *   session, so a prover holding one must file its own modules — which
 *   `APRProver.initProof` does, per prover, by construction.
 */

import { CTermSymbolic } from "@kframework-ts/cterm/symbolic";
import type { KDefinition } from "@kframework-ts/kast";
import { DefaultKCFGSemantics, KCFGExplore, type KCFGSemantics } from "@kframework-ts/kcfg/explore";
import { KoreClient, tcpTransport } from "@kframework-ts/kore-rpc";
import { koreRpcServer, type KoreServerHandle } from "@kframework-ts/kore-rpc/server";
import { KPrint } from "@kframework-ts/ktool";

import { ProofError } from "./proof.js";

/** How long {@link withExplore} keeps retrying the connect, in milliseconds. */
export const DEFAULT_CONNECT_TIMEOUT = 300_000;

/** What {@link withExplore} needs to stand a backend up (`utils.py:352-377`). */
export interface ExploreSessionOptions {
  /** The `*-kompiled/` directory: `definition.kore` for the server, `compiled.json` for `KPrint`. */
  readonly definitionDir: string;
  /** The server's `--module`. Defaults to the definition's own main module. */
  readonly moduleName?: string;
  /** The `KCFGSemantics` every explorer this session makes will carry. */
  readonly semantics?: KCFGSemantics;
  /** `KCFGExplore.id`, and the default `KoreClient` label — pyk's `client_label`. */
  readonly id?: string;
  /** Defaults to the started server's host, or `127.0.0.1` for an existing one. */
  readonly host?: string;
  /**
   * Connect to a server already listening here instead of starting one
   * (the `legacy_explore` source function's `port` plus `start_server=False`).
   */
  readonly port?: number;
  /** Force the choice `port` otherwise makes: start a server even when a port is given. */
  readonly startServer?: boolean;
  /** The server executable and its own flags; a string is split on whitespace, as pyk splits it. */
  readonly koreRpcCommand?: string | readonly string[];
  /** Supplying this — and only this — selects `kore-rpc-booster` (`rpc.py:1591-1601`). */
  readonly llvmDefinitionDir?: string;
  /**
   * `GHCRTS=-N<n>` on the server.
   *
   * The one knob that lets a server answer more than one request at a time, so
   * a concurrent run wants it set to at least its worker count.
   */
  readonly haskellThreads?: number;
  readonly smtTimeout?: number;
  readonly smtRetryLimit?: number;
  /** Connect-retry budget in milliseconds; defaults to {@link DEFAULT_CONNECT_TIMEOUT}. */
  readonly connectTimeout?: number;
  /** An already-loaded `KPrint`, so a caller that has one does not pay for a second. */
  readonly kprint?: KPrint;
  /** The `kast` command `KPrint` shells out to; defaults to `['kast']` on `PATH`. */
  readonly kastCommand?: readonly string[];
  /** The `kore-print` command; defaults to `['kore-print']` on `PATH`. */
  readonly korePrintCommand?: readonly string[];
}

/** Options for one extra explorer over the same server (`ExploreSession.createExplore`). */
export interface CreateExploreOptions {
  /** `KCFGExplore.id` and the new client's label. Defaults to the session's. */
  readonly id?: string;
  /** Defaults to the session's semantics. */
  readonly semantics?: KCFGSemantics;
}

/** An extra explorer and the client it owns; `close` is idempotent. */
export interface ExploreHandle {
  readonly explore: KCFGExplore;
  readonly client: KoreClient;
  /** Release this explorer's client. The session closes anything still open. */
  close(): void;
}

/** A live backend, plus the handles a caller may legitimately want. */
export interface ExploreSession {
  /** The explorer built at session start; `createExplore` makes more. */
  readonly explore: KCFGExplore;
  /** The adapter `explore` holds — `ImpliesProver` and `initializeAprProof` take it directly. */
  readonly symbolic: CTermSymbolic;
  readonly client: KoreClient;
  readonly kprint: KPrint;
  readonly definition: KDefinition;
  readonly host: string;
  readonly port: number;
  /** The server this session started, or `undefined` when it connected to one. */
  readonly server: KoreServerHandle | undefined;
  /**
   * Another `KCFGExplore` over a **new** `KoreClient` to the same server.
   *
   * This is what a concurrent run needs: `parallel_advance_proof` requires one
   * prover — and therefore one client — per worker (`proof.py:346-347`), while
   * one server serves them all. Close the handle when the prover holding it
   * closes; the session closes whatever is left.
   */
  createExplore(options?: CreateExploreOptions): Promise<ExploreHandle>;
}

/**
 * Stand up a backend, run `body`, and tear everything down again.
 *
 * Teardown runs whether `body` returned or threw, and in the reverse order of
 * construction: extra clients, the default client, then the server — and only
 * if this call started it.
 */
export async function withExplore<T>(
  options: ExploreSessionOptions,
  body: (session: ExploreSession) => Promise<T>,
): Promise<T> {
  const semantics = options.semantics ?? new DefaultKCFGSemantics();
  const connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
  const kprint =
    options.kprint ??
    (await KPrint.load(options.definitionDir, {
      ...(options.kastCommand === undefined ? {} : { command: options.kastCommand }),
      ...(options.korePrintCommand === undefined ? {} : { korePrintCommand: options.korePrintCommand }),
    }));
  const moduleName = options.moduleName ?? kprint.mainModule;
  const startServer = options.startServer ?? options.port === undefined;

  let server: KoreServerHandle | undefined;
  const clients = new Set<KoreClient>();
  try {
    if (startServer) {
      server = await koreRpcServer({
        kompiledDir: options.definitionDir,
        moduleName,
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.koreRpcCommand === undefined ? {} : { command: options.koreRpcCommand }),
        ...(options.llvmDefinitionDir === undefined ? {} : { llvmKompiledDir: options.llvmDefinitionDir }),
        ...(options.haskellThreads === undefined ? {} : { haskellThreads: options.haskellThreads }),
        ...(options.smtTimeout === undefined ? {} : { smtTimeout: options.smtTimeout }),
        ...(options.smtRetryLimit === undefined ? {} : { smtRetryLimit: options.smtRetryLimit }),
      });
    } else if (options.port === undefined) {
      throw new ProofError("withExplore needs a port to connect to when startServer is false");
    }
    const host = server?.host ?? options.host ?? "127.0.0.1";
    const port = server?.port ?? options.port;
    if (port === undefined) throw new ProofError("withExplore could not determine a port");

    const connect = async (label: string | undefined): Promise<KoreClient> => {
      const transport = await raceServerExit(server, tcpTransport(host, port, { timeout: connectTimeout }));
      const client = new KoreClient(transport, label === undefined ? {} : { label });
      clients.add(client);
      return client;
    };

    const client = await connect(options.id);
    const symbolic = new CTermSymbolic(client, kprint.definition);
    const explore = new KCFGExplore(symbolic, {
      semantics,
      ...(options.id === undefined ? {} : { id: options.id }),
    });

    const session: ExploreSession = {
      explore,
      symbolic,
      client,
      kprint,
      definition: kprint.definition,
      host,
      port,
      server,
      createExplore: async (extra: CreateExploreOptions = {}): Promise<ExploreHandle> => {
        const id = extra.id ?? options.id;
        const extraClient = await connect(id);
        return {
          explore: new KCFGExplore(new CTermSymbolic(extraClient, kprint.definition), {
            semantics: extra.semantics ?? semantics,
            ...(id === undefined ? {} : { id }),
          }),
          client: extraClient,
          close: () => {
            // Idempotent by bookkeeping: a handle closed twice, or closed and
            // then closed again by the session, closes its socket once.
            if (clients.delete(extraClient)) extraClient.close();
          },
        };
      },
    };
    return await body(session);
  } finally {
    for (const client of [...clients].toReversed()) client.close();
    // Only a server this call started is this call's to stop.
    await server?.close();
  }
}

/**
 * Race a connect against the server's exit (kore-rpc README, `KoreServerHandle.exited`).
 *
 * Without this a server that died on a usage error is indistinguishable from
 * one still opening its socket, and the connect spends its whole timeout
 * retrying a corpse.
 */
async function raceServerExit<T>(server: KoreServerHandle | undefined, connecting: Promise<T>): Promise<T> {
  if (server === undefined) return connecting;
  return Promise.race([
    connecting,
    server.exited.then((exit): never => {
      throw new ProofError(
        `kore-rpc server exited before accepting a connection: code ${String(exit.code)}, signal ${String(exit.signal)}`,
      );
    }),
  ]);
}
