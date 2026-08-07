/**
 * `@kframework-ts/kore-rpc` — the wire protocol of the K Framework
 * haskell-backend's symbolic-execution servers (`kore-rpc`,
 * `kore-rpc-booster`, `booster-dev`, `kore-rpc-dev`).
 *
 * Five payload methods — `execute`, `implies`, `simplify`, `add-module`,
 * `get-model` — plus a `cancel` side channel, spoken as JSON-RPC 2.0 over a
 * raw TCP socket, one single-line `\n`-terminated response per request.
 *
 * This package is a hand-transcription of the normative Haskell wire types
 * (`haskell-backend/kore-rpc-types/src/Kore/JsonRpc/*`) at haskell-backend
 * `v0.1.155`, cross-checked against the reference client
 * (`k/pyk/src/pyk/kore/rpc.py`) at K `v7.1.337`. Where the two disagree the
 * Haskell wins; where the *prose specification* disagrees with either, it is
 * stale and loses to both. See `THIRD-PARTY-NOTICES.md` for the BSD-3-Clause
 * notices that travel with a port of these sources, and `version.ts` for the
 * hashes of every file transcribed.
 *
 * # What is here, and what is behind another door
 *
 * This entry point is the **codec core** plus the client half: wire types,
 * encoders and decoders in both directions, the error taxonomy, the two log
 * families, a byte-exact emitter, the substitution flattener, the TCP
 * transport, {@link KoreClient}, the recorded-traffic readers
 * ({@link rpcPrint} / {@link rpcKast}), and the upstream-drift check
 * ({@link checkKoreRpcSources}, which the `kore-rpc-ts check-k` command shells
 * around).
 *
 * The only I/O in it is `transport.ts`'s `node:net` socket, and it is behind
 * the {@link Transport} interface — the codec, the errors, the logs, the
 * substitution decoder and the two inspectors touch nothing but values, so the
 * whole protocol layer stays testable against recorded traffic, and a runtime
 * with no `node:net` can bring its own transport and still use
 * {@link KoreClient}. There are no timers other than the connect-retry loop,
 * no `child_process` and no `node:fs`; the two capabilities that need them
 * live behind subpaths of their own:
 *
 * - `@kframework-ts/kore-rpc/server` — the spawner (`koreServer` /
 *   `boosterServer` / `koreRpcServer`, plus the pure `buildKoreServerCommand`),
 *   which is where `child_process` is;
 * - `@kframework-ts/kore-rpc/bugreport` — `BugReport` and
 *   `recordingTransport`, the replayable-session recorder, which is where
 *   `node:fs` is. Its archive is what `rpcPrint`/`rpcKast` above are for
 *   reading.
 *
 * Three modules are deliberately not re-exported: `src/internal.ts` (the
 * shared strict-JSON reading machinery, not API), and `src/cli.ts` /
 * `src/bin.ts` (the `kore-rpc-ts` executable, every command of which is reachable
 * as a library function without going through argv).
 */

export * from "./client.js";
export * from "./codec.js";
export * from "./errors.js";
export * from "./inspect.js";
export * from "./keyorder.js";
export * from "./ksources.js";
export * from "./logs.js";
export * from "./substitution.js";
export * from "./transport.js";
export * from "./types.js";
export * from "./version.js";
