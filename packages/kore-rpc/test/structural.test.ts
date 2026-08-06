/**
 * The structural tier: `fixtures/booster-rpc`, all eight vendored
 * `test-*` directories.
 *
 * These files are **not wire bytes**. `kore-rpc-client --expect` re-encodes
 * what it received with `encodePretty'` and hands both sides to `diffJson`,
 * which decodes them into typed values before comparing
 * (`booster/library/Booster/JsonRpc/Utils.hs:48-70`) — so whitespace and key
 * order carry no information here and only structure does. Every comparison
 * below is therefore a deep JSON equality, never a byte equality, exactly as
 * `fixtures/PROVENANCE.md` §"Responses are PRETTY-PRINTED and compared
 * STRUCTURALLY" requires.
 *
 * What this suite adds over `golden.test.ts` is *breadth of shape*. This is
 * the only corpus that carries real request envelopes with their own ids
 * (including `name-as-id` add-module requests), the only one with the two
 * indeterminate `implies` statuses, the only one with error codes 8 and 9, and
 * the only one that records **two different servers answering the same
 * request** — the `.booster-dev` / `.kore-rpc-dev` variants.
 *
 * # Counted skips
 *
 * Exactly one file is read but not exercised as protocol input:
 *
 * - `test-simplify/params-with-logging.json` — an orphan upstream (PROVENANCE
 *   §"Deviation note": no `state-with-logging.simplify`, no
 *   `response-with-logging.json`, so `runDirectoryTest.sh` never globs it). It
 *   also carries `log-successful-simplifications` /
 *   `log-failed-simplifications`, which `SimplifyRequest` (`Types.hs:71-80`)
 *   does not have at v0.1.155 — it is a fragment of an older protocol. It is
 *   asserted to still be that fragment, so it cannot change unnoticed, and it
 *   is not fed to `encodeSimplifyParams`. See {@link ORPHAN_FIXTURES}.
 *
 * The six `README.md` files are documentation. Everything else — 46 `.send`
 * envelopes, 38 bare-term state files, 1 module text, 10 params fragments and
 * 101 responses — is decoded and re-encoded below, and
 * {@link "every booster-rpc file is classified and exercised"} enforces that
 * the classification is total.
 */

import { describe, expect, test } from "bun:test";
import { type JsonValue, decodeKoreJson, encodeKoreJsonValue } from "@kframework-ts/kore";
import { decodeResponse, decodeResult, encodeRequest } from "../src/codec.ts";
import {
  type KoreRpcError,
  DuplicateModuleError,
  ImplicationError,
  InvalidModuleError,
  PatternError,
  UnknownModuleError,
  decodeKoreRpcError,
} from "../src/errors.ts";
import type { ImpliesStatus, KoreRpcMethod, SatResult } from "../src/types.ts";
import {
  decodeParams,
  decodeRequestEnvelope,
  encodeParamsFor,
  encodeResultFor,
  expectRoundTrip,
  listDirs,
  listFiles,
  readFixture,
  readFixtureJson,
} from "./fixtures.ts";
import { defined, jsonMember, jsonMemberOrAbsent, jsonRecord } from "./helpers/assert.ts";

const BOOSTER = "booster-rpc";

/** The default method of each directory, for responses with no state file to ask. */
const DIR_METHOD: Readonly<Record<string, KoreRpcMethod>> = {
  "test-a-to-f": "execute",
  "test-get-model": "get-model",
  "test-implies": "implies",
  "test-implies-smt": "implies",
  "test-implies2": "implies",
  "test-module-addition": "execute",
  "test-pathological-add-module": "add-module",
  "test-simplify": "simplify",
};

/** Read but not exercised — see the file header. */
const ORPHAN_FIXTURES: Readonly<Record<string, string>> = {
  "test-simplify/params-with-logging.json": "orphan upstream; carries pre-v0.1.155 simplify logging params",
};

//////////////////////
// Classification   //
//////////////////////

/** What a file in this corpus is, decided by its name alone. */
type Role =
  /** `README*` — documentation. */
  | "readme"
  /** `*.send` — a complete JSON-RPC request envelope, sent as-is. */
  | "send"
  /** `state-*.{execute,simplify,get-model}` — a bare KORE-JSON term, not an envelope. */
  | "term"
  /** `state-*.add-module` — textual KORE, the `module` param's value. */
  | "module"
  /** `params-*.json` — a params fragment merged into a reconstructed request. */
  | "params"
  /** `response-*.{json,booster-dev,kore-rpc-dev}` — an expected response. */
  | "response";

interface Fixture {
  readonly dir: string;
  readonly file: string;
  /** `test-a-to-f/response-branching.json`. */
  readonly key: string;
  readonly role: Role;
  /** For `send`/`term`/`module`/`params`/`response`: the case name in the middle of the filename. */
  readonly name: string;
  /** For `term`/`module`: the suffix that names the method (`runDirectoryTest.sh:105-127`). */
  readonly method: KoreRpcMethod;
}

const TERM_SUFFIXES: Readonly<Record<string, KoreRpcMethod>> = {
  execute: "execute",
  simplify: "simplify",
  "get-model": "get-model",
  "add-module": "add-module",
};

function classify(dir: string, file: string): Fixture {
  const key = `${dir}/${file}`;
  const base = { dir, file, key } as const;
  const dirMethod = DIR_METHOD[dir];
  if (dirMethod === undefined) throw new Error(`unknown booster-rpc directory: ${dir}`);

  if (file.startsWith("README")) return { ...base, role: "readme", name: "", method: dirMethod };

  if (file.endsWith(".send")) {
    return { ...base, role: "send", name: file.slice("state-".length, -".send".length), method: dirMethod };
  }

  const stateMatch = /^state-(.+)\.([a-z-]+)$/.exec(file);
  if (stateMatch !== undefined && stateMatch !== null) {
    const [, name = "", suffix = ""] = stateMatch;
    const method = TERM_SUFFIXES[suffix];
    if (method !== undefined) {
      return { ...base, role: method === "add-module" ? "module" : "term", name, method };
    }
    // `test-a-to-f/state-terminal-rule-with-logging.json` — a state file whose
    // suffix is `.json`, so `runDirectoryTest.sh:105` never globs it and it is
    // inert upstream (PROVENANCE §"Deviation note"). It is still a bare
    // KORE-JSON term, and the directory says which method it belongs to.
    if (suffix === "json") return { ...base, role: "term", name, method: dirMethod };
  }

  const paramsMatch = /^params-(.+)\.json$/.exec(file);
  if (paramsMatch !== undefined && paramsMatch !== null) {
    return { ...base, role: "params", name: paramsMatch[1] ?? "", method: dirMethod };
  }

  const responseMatch = /^response-(.+)\.(json|booster-dev|kore-rpc-dev)$/.exec(file);
  if (responseMatch !== undefined && responseMatch !== null) {
    return { ...base, role: "response", name: responseMatch[1] ?? "", method: dirMethod };
  }

  throw new Error(`unclassifiable booster-rpc fixture: ${key}`);
}

const DIRS: readonly string[] = listDirs(BOOSTER);

const FIXTURES: readonly Fixture[] = DIRS.flatMap((dir) => listFiles(BOOSTER, dir).map((file) => classify(dir, file)));

function withRole(role: Role): readonly Fixture[] {
  return FIXTURES.filter((f) => f.role === role);
}

/** Look a sibling up by name, so a response can ask its state file which method it is. */
function sibling(fixture: Fixture, role: Role): Fixture | undefined {
  return FIXTURES.find((f) => f.dir === fixture.dir && f.role === role && f.name === fixture.name);
}

/**
 * The method a response belongs to.
 *
 * `runDirectoryTest.sh:105-127` derives it from the state file's suffix (or,
 * for a `.send`, from the envelope itself), so that is what is consulted
 * first; the directory's own method is the fallback for the one response whose
 * state file is inert (`test-a-to-f/response-terminal-rule-with-logging`).
 */
function responseMethod(fixture: Fixture): KoreRpcMethod {
  const send = sibling(fixture, "send");
  if (send !== undefined) {
    const { request } = decodeRequestEnvelope(readFixtureJson(BOOSTER, send.dir, send.file));
    if (request.method === "cancel") throw new Error(`unexpected cancel in ${send.key}`);
    return request.method;
  }
  const term = sibling(fixture, "term") ?? sibling(fixture, "module");
  return term?.method ?? fixture.method;
}

//////////////////////
// Requests         //
//////////////////////

describe("booster-rpc: .send files are complete request envelopes", () => {
  test.each(withRole("send").map((f) => [f.key, f] as const))("%s", (_key, fixture) => {
    const raw = readFixtureJson(BOOSTER, fixture.dir, fixture.file);
    const { id, request } = decodeRequestEnvelope(raw);

    // These envelopes carry the ids the recording was made with — long numeric
    // strings from pyk, small integers from the add-module scripts.
    expect(typeof id === "string" || typeof id === "number").toBe(true);
    expect(request.method).toBe(defined(DIR_METHOD[fixture.dir], `the method of ${fixture.dir}`));

    // Nothing is dropped: every param present in the recording is a param the
    // encoder emits, so equality holds without any allowance for omission.
    expectRoundTrip(encodeRequest(id, request), raw);
  });

  test("the .send corpus is the only one carrying real request ids", () => {
    const sends = withRole("send");
    expect(sends).toHaveLength(46);
    const ids = sends.map((f) => decodeRequestEnvelope(readFixtureJson(BOOSTER, f.dir, f.file)).id);
    expect(ids.filter((id) => typeof id === "string").length).toBeGreaterThan(0);
    expect(ids.filter((id) => typeof id === "number").length).toBeGreaterThan(0);
  });

  test("add-module requests exercise name-as-id in both settings", () => {
    const params = withRole("send")
      .filter((f) => f.dir === "test-pathological-add-module")
      .map((f) => {
        const { request } = decodeRequestEnvelope(readFixtureJson(BOOSTER, f.dir, f.file));
        if (request.method !== "add-module") throw new Error(`expected add-module in ${f.key}`);
        return request.params;
      });
    expect(params.filter((p) => p.nameAsId === true).length).toBeGreaterThan(0);
    expect(params.filter((p) => p.nameAsId === undefined).length).toBeGreaterThan(0);
    for (const p of params) expect(p.module).toContain("module ");
  });
});

describe("booster-rpc: bare-term state files are KORE-JSON, not requests", () => {
  test.each(withRole("term").map((f) => [f.key, f] as const))("%s", (_key, fixture) => {
    const raw = readFixtureJson(BOOSTER, fixture.dir, fixture.file);

    // Not an envelope: it has no `method`, and asking for one must fail.
    expect(() => decodeRequestEnvelope(raw)).toThrow();

    const term = decodeKoreJson(raw);
    expect(term.format).toBe("KORE");
    expect(term.version).toBe(1);
    expectRoundTrip(encodeKoreJsonValue(term.term), raw);
  });

  test("the module-text state file is textual KORE, not JSON at all", () => {
    const modules = withRole("module");
    expect(modules).toHaveLength(1);
    const fixture = defined(modules[0], "the module-text fixture");
    expect(fixture.key).toBe("test-module-addition/state-03-add-new-module.add-module");

    const text = readFixture(BOOSTER, fixture.dir, fixture.file);
    expect(() => {
      JSON.parse(text);
    }).toThrow();
    expect(text).toContain("module ");
  });
});

/**
 * Reconstruct the request `runDirectoryTest.sh:105-127` would have built for a
 * state file: the state (or module text) plus `params-<TESTNAME>.json` when
 * one exists, under the method the suffix names.
 */
describe("booster-rpc: state + params reconstruct a request that round-trips", () => {
  const reconstructable = [...withRole("term"), ...withRole("module")];

  test.each(reconstructable.map((f) => [f.key, f] as const))("%s", (_key, fixture) => {
    const paramsFile = sibling(fixture, "params");
    const merged: Record<string, JsonValue> = {
      ...(paramsFile === undefined
        ? {}
        : jsonRecord(readFixtureJson(BOOSTER, paramsFile.dir, paramsFile.file), paramsFile.key)),
      ...(fixture.role === "module"
        ? { module: readFixture(BOOSTER, fixture.dir, fixture.file) }
        : { state: readFixtureJson(BOOSTER, fixture.dir, fixture.file) }),
    };

    const params = decodeParams(fixture.method, merged);
    expectRoundTrip(encodeParamsFor(fixture.method, params), merged);
  });

  test("params fragments are all consumed except the documented orphan", () => {
    const params = withRole("params");
    expect(params).toHaveLength(10);

    const orphans = params.filter((f) => sibling(f, "term") === undefined && sibling(f, "module") === undefined);
    expect(orphans.map((f) => f.key)).toEqual(Object.keys(ORPHAN_FIXTURES));

    // The orphan is still what PROVENANCE says it is: pre-v0.1.155 simplify
    // logging params, which `SimplifyRequest` has no field for.
    expect(readFixtureJson(BOOSTER, "test-simplify", "params-with-logging.json")).toEqual({
      "log-successful-simplifications": true,
      "log-failed-simplifications": true,
    });
  });
});

//////////////////////
// Responses        //
//////////////////////

const RESPONSES: readonly Fixture[] = withRole("response");

describe("booster-rpc: responses decode to typed values and re-encode structurally", () => {
  test.each(RESPONSES.map((f) => [f.key, f] as const))("%s", (_key, fixture) => {
    const raw = readFixtureJson(BOOSTER, fixture.dir, fixture.file);
    const response = decodeResponse(raw);

    if (response.kind === "error") {
      const error = jsonMember(raw, "error", fixture.key);
      const typed = decodeKoreRpcError(error);
      expect(typed).toBeInstanceOf(Error);
      expect(typed.code).toBe(response.error.code);
      expect(typed.data).toEqual(jsonMemberOrAbsent(error, "data", `${fixture.key}'s error object`));
      return;
    }

    const method = responseMethod(fixture);
    const result = decodeResult(method, response.result);
    expectRoundTrip(encodeResultFor(method, result), response.result);
  });
});

/**
 * A one-pass census of every response in the corpus, so the coverage
 * assertions below are about the corpus rather than about whichever test
 * happened to run last.
 */
interface Census {
  readonly statuses: Map<ImpliesStatus, string[]>;
  readonly satisfiable: Map<SatResult, string[]>;
  readonly errorCodes: Map<number, string[]>;
  readonly withLogs: string[];
  readonly results: number;
  readonly errors: number;
}

/** Append to the list a key already has, or start one. */
function push<K>(map: Map<K, string[]>, key: K, value: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function census(): Census {
  const statuses = new Map<ImpliesStatus, string[]>();
  const satisfiable = new Map<SatResult, string[]>();
  const errorCodes = new Map<number, string[]>();
  const withLogs: string[] = [];
  let results = 0;
  let errors = 0;

  for (const fixture of RESPONSES) {
    const raw = readFixtureJson(BOOSTER, fixture.dir, fixture.file);
    const response = decodeResponse(raw);
    if (response.kind === "error") {
      errors += 1;
      push(errorCodes, response.error.code, fixture.key);
      continue;
    }
    results += 1;

    // Decoded per method with a literal, so each arm sees its own result type
    // rather than the five-way union.
    switch (responseMethod(fixture)) {
      case "implies": {
        const result = decodeResult("implies", response.result);
        push(statuses, result.status, fixture.key);
        if (result.logs !== undefined && result.logs.length > 0) withLogs.push(fixture.key);
        break;
      }
      case "get-model":
        push(satisfiable, decodeResult("get-model", response.result).satisfiable, fixture.key);
        break;
      case "execute": {
        const result = decodeResult("execute", response.result);
        if (result.logs !== undefined && result.logs.length > 0) withLogs.push(fixture.key);
        break;
      }
      case "simplify": {
        const result = decodeResult("simplify", response.result);
        if (result.logs !== undefined && result.logs.length > 0) withLogs.push(fixture.key);
        break;
      }
      case "add-module":
        // `AddModuleResult` has no `logs` — only `haskell-log-entries`.
        decodeResult("add-module", response.result);
        break;
    }
  }

  return { statuses, satisfiable, errorCodes, withLogs, results, errors };
}

const CENSUS = census();

describe("booster-rpc: the corpus covers every variant it is here for", () => {
  test("all three implies statuses occur, and indeterminate only under booster-only", () => {
    for (const status of ["valid", "invalid", "indeterminate"] as const) {
      expect(CENSUS.statuses.get(status) ?? []).not.toHaveLength(0);
    }
    // `indeterminate` is what a *standalone* booster returns where the proxy
    // would have escalated to kore and got a verdict — so every one of them is
    // a `.booster-dev` variant, and `test-implies-smt` contributes some.
    const indeterminate = CENSUS.statuses.get("indeterminate") ?? [];
    for (const key of indeterminate) expect(key).toEndWith(".booster-dev");
    expect(indeterminate.some((key) => key.startsWith("test-implies-smt/"))).toBe(true);
    // …and `test-implies-smt` alone carries all three.
    const smt = new Set(
      [...CENSUS.statuses].flatMap(([status, keys]) =>
        keys.some((key) => key.startsWith("test-implies-smt/")) ? [status] : [],
      ),
    );
    expect(smt).toEqual(new Set(["valid", "invalid", "indeterminate"]));
  });

  test("all three satisfiability verdicts occur in test-get-model", () => {
    for (const verdict of ["Sat", "Unsat", "Unknown"] as const) {
      const keys = CENSUS.satisfiable.get(verdict) ?? [];
      expect(keys).not.toHaveLength(0);
      for (const key of keys) expect(key).toStartWith("test-get-model/");
    }
    // PROVENANCE §3: the substitution of a `Sat` is not stable, so only its
    // presence is ever asserted — and it is present on some but not all.
    const sat = CENSUS.satisfiable.get("Sat") ?? [];
    expect(sat.length).toBeGreaterThan(1);
  });

  test("the add-module error codes 8 and 9 occur, with their typed classes", () => {
    for (const code of [8, 9]) {
      const keys = CENSUS.errorCodes.get(code) ?? [];
      expect(keys).not.toHaveLength(0);
      for (const key of keys) expect(key).toStartWith("test-pathological-add-module/");
    }

    const typed = (key: string): KoreRpcError => {
      const [dir = "", file = ""] = key.split("/");
      return decodeKoreRpcError(jsonMember(readFixtureJson(BOOSTER, dir, file), "error", key));
    };
    for (const key of CENSUS.errorCodes.get(8) ?? []) expect(typed(key)).toBeInstanceOf(InvalidModuleError);
    for (const key of CENSUS.errorCodes.get(9) ?? []) expect(typed(key)).toBeInstanceOf(DuplicateModuleError);

    // The other three codes the corpus carries, for completeness.
    for (const key of CENSUS.errorCodes.get(2) ?? []) expect(typed(key)).toBeInstanceOf(PatternError);
    for (const key of CENSUS.errorCodes.get(3) ?? []) expect(typed(key)).toBeInstanceOf(UnknownModuleError);
    for (const key of CENSUS.errorCodes.get(4) ?? []) expect(typed(key)).toBeInstanceOf(ImplicationError);
    expect([...CENSUS.errorCodes.keys()].toSorted((a, b) => a - b)).toEqual([2, 3, 4, 8, 9]);
  });

  test("the logging execute response parses its log entries", () => {
    expect(CENSUS.withLogs).toEqual(["test-a-to-f/response-terminal-rule-with-logging.json"]);

    const raw = readFixtureJson(BOOSTER, "test-a-to-f", "response-terminal-rule-with-logging.json");
    const response = decodeResponse(raw);
    if (response.kind !== "result") throw new Error("expected a result response");
    const result = decodeResult("execute", response.result);
    expect(result.reason).toBe("terminal-rule");

    const logs = result.logs ?? [];
    expect(logs).toHaveLength(2);
    for (const entry of logs) {
      expect(entry.tag).toBe("rewrite");
      if (entry.tag === "rewrite") expect(entry.result.tag).toBe("success");
    }
    // The params that asked for them are on disk next to it.
    expect(readFixtureJson(BOOSTER, "test-a-to-f", "params-terminal-rule-with-logging.json")).toMatchObject({
      "log-successful-rewrites": true,
    });
  });

  test("the response census adds up", () => {
    expect(CENSUS.results + CENSUS.errors).toBe(RESPONSES.length);
    expect(RESPONSES).toHaveLength(101);
    expect(CENSUS.errors).toBe(13);
  });
});

//////////////////////
// Per-binary variants //
//////////////////////

/** A `response-X.json` and the per-server-binary variant recorded beside it. */
interface VariantPair {
  readonly key: string;
  readonly base: Fixture;
  readonly variant: Fixture;
}

const VARIANT_PAIRS: readonly VariantPair[] = RESPONSES.flatMap((variant) => {
  if (variant.file.endsWith(".json")) return [];
  const base = RESPONSES.find((f) => f.dir === variant.dir && f.file === `response-${variant.name}.json`);
  if (base === undefined) throw new Error(`variant with no base: ${variant.key}`);
  return [{ key: variant.key, base, variant }];
});

/**
 * `.booster-dev` (standalone booster) and `.kore-rpc-dev` (standalone legacy
 * kore) record what a *different server binary* answered to the same request;
 * `.json` is the `kore-rpc-booster` proxy's answer and the fallback for both
 * (`runDirectoryTest.sh:117-126`). A variant file exists precisely because the
 * two disagree — which is the property asserted here.
 */
describe("booster-rpc: per-binary response variants", () => {
  test.each(VARIANT_PAIRS.map((p) => [p.key, p] as const))("%s decodes and differs from its .json", (_key, pair) => {
    const variant = readFixtureJson(BOOSTER, pair.variant.dir, pair.variant.file);
    const base = readFixtureJson(BOOSTER, pair.base.dir, pair.base.file);

    // Both decode — a variant is a different answer, never a malformed one.
    expect(() => decodeResponse(variant)).not.toThrow();
    expect(() => decodeResponse(base)).not.toThrow();

    // …and 15 of the 16 pairs really are different answers. The exception is
    // `test-a-to-f/response-branching.kore-rpc-dev`, which is byte-identical
    // in content to the proxy's `.json`: the proxy fell back to kore for that
    // request, so the two recordings are the same answer written twice.
    const identical = pair.key === "test-a-to-f/response-branching.kore-rpc-dev";
    expect(Bun.deepEquals(variant, base)).toBe(identical);
  });

  test("the variant corpus is 16 pairs across four directories", () => {
    expect(VARIANT_PAIRS).toHaveLength(16);
    expect(VARIANT_PAIRS.filter((p) => p.variant.file.endsWith(".booster-dev"))).toHaveLength(13);
    expect(VARIANT_PAIRS.filter((p) => p.variant.file.endsWith(".kore-rpc-dev"))).toHaveLength(3);
    expect(new Set(VARIANT_PAIRS.map((p) => p.variant.dir))).toEqual(
      new Set(["test-a-to-f", "test-implies", "test-implies-smt", "test-implies2", "test-pathological-add-module"]),
    );
  });

  test("the three branching recordings differ in exactly the way the binaries do", () => {
    const nextStates = (file: string) => {
      const raw = readFixtureJson(BOOSTER, "test-a-to-f", file);
      const response = decodeResponse(raw);
      if (response.kind !== "result") throw new Error("expected a result response");
      const result = decodeResult("execute", response.result);
      if (result.reason !== "branching") throw new Error("expected a branching result");
      return result.nextStates;
    };

    const proxy = nextStates("response-branching.json");
    const booster = nextStates("response-branching.booster-dev");
    const kore = nextStates("response-branching.kore-rpc-dev");

    expect(proxy).toHaveLength(2);
    expect(booster).toHaveLength(2);
    expect(kore).toEqual(proxy);

    // A standalone booster reports the rule's *predicate* alongside its
    // substitution; the proxy's answer (which came from kore) does not.
    for (const state of booster) {
      expect(state.ruleId).toBeDefined();
      expect(state.rulePredicate).toBeDefined();
    }
    for (const state of proxy) {
      expect(state.ruleId).toBeDefined();
      expect(state.rulePredicate).toBeUndefined();
    }
  });
});

//////////////////////
// Coverage         //
//////////////////////

test("every booster-rpc file is classified and exercised", () => {
  // The eight directories PROVENANCE vendors, and its file counts per
  // directory (table at lines 213-222).
  expect(DIRS).toEqual([
    "test-a-to-f",
    "test-get-model",
    "test-implies",
    "test-implies-smt",
    "test-implies2",
    "test-module-addition",
    "test-pathological-add-module",
    "test-simplify",
  ]);
  const counts = Object.fromEntries(DIRS.map((dir) => [dir, FIXTURES.filter((f) => f.dir === dir).length]));
  expect(counts).toEqual({
    "test-a-to-f": 21,
    "test-get-model": 21,
    "test-implies": 23,
    "test-implies-smt": 16,
    "test-implies2": 21,
    "test-module-addition": 17,
    "test-pathological-add-module": 49,
    "test-simplify": 34,
  });
  expect(FIXTURES).toHaveLength(202);

  // Every file lands in exactly one role, and the roles add up.
  const byRole = Object.fromEntries(
    (["readme", "send", "term", "module", "params", "response"] as const).map((role) => [role, withRole(role).length]),
  );
  expect(byRole).toEqual({ readme: 6, send: 46, term: 38, module: 1, params: 10, response: 101 });
  expect(Object.values(byRole).reduce((a, b) => a + b, 0)).toBe(202);
});
