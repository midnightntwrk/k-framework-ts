/**
 * Reading and re-aiming recorded kore-rpc traffic by hand — the two halves of
 * the manual RPC-debugging loop, and the library behind
 * `kore-rpc-ts rpc-print` / `kore-rpc-ts rpc-kast`.
 *
 * Transcribed from pyk's `exec_rpc_print` and `exec_rpc_kast`
 * (`k/pyk/src/pyk/__main__.py:136-216` and `:218-236`), whose CLI surface is
 * declared at `k/pyk/src/pyk/cli/pyk.py:409-437`. The corpus those two commands
 * are tested against upstream (`pyk/src/tests/integration/test_pyk.py:101-188`)
 * is vendored here under `fixtures/pyk-rpc/`, and `test/inspect.test.ts` runs
 * against it.
 *
 * # The loop these two are for
 *
 * A backend misbehaves somewhere inside a long proof. You have a recording —
 * a `BugReport` tar (`bugreport.ts`), or the `*.json` files a `--bug-report`
 * run left behind. {@link rpcPrint} tells you what any one of those files
 * *says*; {@link rpcKast} takes the response at the point things went wrong and
 * builds the request that would resume from there, by grafting the response's
 * state into a request you already have. Send that one request against a server
 * you started by hand and you have a reproduction two orders of magnitude
 * smaller than the proof.
 *
 * # Deliberate deviations from pyk
 *
 * 1. **Terms are printed as KORE, not as pretty-printed K.** pyk's `rpc-print`
 *    takes a kompiled definition and runs the state through
 *    `KPrint.kore_to_kast` + `pretty_print` (`__main__.py:137-138`, `:148-150`).
 *    This package deliberately has no KAST layer at all — conversion is
 *    `@kframework-ts/konvert`'s job and depending on it here would invert the
 *    layering documented in the README — so a term is rendered with
 *    `@kframework-ts/kore`'s `koreText`, i.e. the surface syntax the server
 *    itself speaks. Everything *structural* in the output (the method, the
 *    depth, the halt reason, the rule, the next-state count, the non-state
 *    parameters) is pyk's, line for line. The practical difference: no
 *    `definition_dir` argument, no kompiled definition needed, and a term you
 *    can paste straight back into a request.
 * 2. **Parameter keys are sorted.** pyk iterates
 *    `set(params.keys()).difference(['state'])` (`__main__.py:144`, and again
 *    at `:181`), so the order of those lines varies between runs of the same
 *    command on the same file. Output that cannot be diffed is not much use to
 *    an automated caller, so they are sorted; `state` still comes last, as it
 *    does upstream.
 * 3. **Values are rendered as JSON, not as Python repr.** pyk's
 *    `f'{key}: {params[key]}'` prints `True` and `['RULE']`; here that is
 *    `true` and `["RULE"]`. The file being described is JSON, so JSON is the
 *    spelling that can be pasted back.
 * 4. **Four response shapes pyk cannot read are read.** pyk detects the
 *    response method by exact key-list equality — `['state']` is simplify,
 *    `['module']` is add-module, anything else is assumed to be execute
 *    (`__main__.py:189-207`). That misreads a simplify or add-module response
 *    that also carries `haskell-log-entries` (the request asked for it), and it
 *    crashes outright on an `implies` response, a `get-model` response, and on
 *    any error response. Dispatch here is on the *discriminating member*
 *    (`satisfiable`, `implication`, `reason`, `state`, `module`), and an
 *    `error` member is reported rather than being called "neither a request nor
 *    a response".
 * 5. **Failures are exceptions.** pyk logs and calls `exit(1)` from inside the
 *    printer (`__main__.py:184`, `:194`, `:206`, `:214`). Here both functions
 *    throw and `cli.ts` maps that to the exit code, so the library half is
 *    usable from a program that would rather not have its process ended for it.
 *
 * # What is *not* a deviation
 *
 * The line vocabulary, exactly: `JSON RPC request` / `JSON RPC Response` (the
 * capitalization really is inconsistent upstream, and it is what somebody's
 * `grep` is written against), `id:`, `Method:`, `Depth:`, `Stop reason:`,
 * `Stop rule:`, `Number of next states:`, `State:`, `Next state #N:`,
 * `Module:`. The `Stop rule:` line only on `terminal-rule`/`cut-point-rule`.
 * The state a response is described by is the **combined** one — term ∧
 * substitution ∧ predicate, `State.kore` (`rpc.py:588-595`), which is
 * `substitution.ts`'s `stateKore` here — while a *request*'s state is the bare
 * pattern it carries. And {@link rpcKast}'s output: the reference request's
 * envelope and every non-`state` parameter, with `state` replaced by the
 * response's combined state in a fresh KORE-JSON envelope.
 */

import {
  type JsonObject,
  type JsonValue,
  KORE_JSON_FORMAT,
  KORE_JSON_VERSION,
  decodeKoreJson,
  koreText,
  patternToJson,
} from "@kframework-ts/kore";
import { decodeExecuteResult, decodeGetModelResult, decodeImpliesResult } from "./codec.js";
import { stateKore } from "./substitution.js";
import type { ExecuteResult, ExecuteState } from "./types.js";

//////////////////////
// Small helpers    //
//////////////////////

/** A JSON object, or a failure naming what was expected. */
function asRecord(value: unknown, what: string): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected ${what} to be a JSON object`);
  }
  // The caller has already established this came out of `JSON.parse`; the
  // narrowing is the shape check above, not this assertion.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Readonly<Record<string, JsonValue>>;
}

/**
 * How an `id` is shown: bare when it is a string, JSON otherwise.
 *
 * pyk's f-string prints a Python `str` without quotes and an `int` as digits,
 * which is the same thing.
 */
function showId(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

/** One `key: value` line, JSON-valued — deviation (3). */
function showEntry(key: string, value: JsonValue): string {
  return `${key}: ${JSON.stringify(value)}`;
}

/**
 * A member that is supposed to be a plain string, shown as one.
 *
 * A document is untrusted, so the member may be anything; a `String(…)` on a
 * JSON object would put `[object Object]` in the output, which describes
 * nothing. Falling back to JSON keeps a malformed field legible.
 */
function showScalar(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A term-valued member, as KORE surface syntax — deviation (1). */
function showTerm(value: JsonValue): string {
  return koreText(decodeKoreJson(value).term);
}

/** A response state, combined the way pyk's `State.kore` combines it. */
function showState(state: ExecuteState): string {
  return koreText(stateKore(state));
}

//////////////////////
// rpc-print        //
//////////////////////

/** The `Stop rule:` line exists only for these two — `__main__.py:156-157`. */
function stopRuleOf(result: ExecuteResult): string | undefined {
  return result.reason === "terminal-rule" || result.reason === "cut-point-rule" ? result.rule : undefined;
}

/** How many next states a result has, counting an absent list as zero (`__main__.py:159-160`). */
function nextStatesOf(result: ExecuteResult): readonly ExecuteState[] {
  return result.reason === "branching" || result.reason === "cut-point-rule" ? result.nextStates : [];
}

/** pyk's `pretty_print_request` (`__main__.py:142-150`), with deviations (1)-(3). */
function printRequestParams(params: Readonly<Record<string, JsonValue>>): readonly string[] {
  const lines: string[] = [];
  const state = params["state"];
  for (const key of Object.keys(params).toSorted()) {
    if (key === "state") continue;
    lines.push(showEntry(key, params[key] ?? null));
  }
  // No `state` at all is an `add-module` request, which pyk prints as bare
  // key/value lines and nothing else (`__main__.py:175-179`).
  if (state === undefined) return lines;
  lines.push("State:", showTerm(state));
  return lines;
}

/** pyk's `pretty_print_execute_response` (`__main__.py:152-169`). */
function printExecuteResult(result: ExecuteResult): readonly string[] {
  const lines: string[] = [`Depth: ${String(result.depth)}`, `Stop reason: ${result.reason}`];
  const rule = stopRuleOf(result);
  if (rule !== undefined) lines.push(`Stop rule: ${rule}`);
  const nextStates = nextStatesOf(result);
  lines.push(`Number of next states: ${String(nextStates.length)}`, "State:", showState(result.state));
  nextStates.forEach((next, index) => {
    lines.push(`Next state #${String(index)}:`, showState(next));
  });
  return lines;
}

/**
 * Which method a `result` member belongs to — deviation (4).
 *
 * The order matters and is not arbitrary: `satisfiable` and `implication` are
 * unique to one method each, `reason` is unique to `execute`, and only then are
 * the two single-field results left, which is exactly the set pyk could
 * recognize.
 */
function methodOfResult(result: Readonly<Record<string, JsonValue>>): string | undefined {
  if ("satisfiable" in result) return "get-model";
  if ("implication" in result) return "implies";
  if ("reason" in result) return "execute";
  if ("state" in result) return "simplify";
  if ("module" in result) return "add-module";
  return undefined;
}

function printResult(result: Readonly<Record<string, JsonValue>>): readonly string[] {
  const method = methodOfResult(result);
  switch (method) {
    case "execute":
      return [`Method: ${method}`, ...printExecuteResult(decodeExecuteResult(result))];
    case "simplify":
      return [`Method: ${method}`, "State:", showTerm(result["state"] ?? null)];
    case "add-module":
      // The module is textual KORE already — the one term-shaped field in the
      // protocol that is not a KORE-JSON envelope, so nothing is decoded.
      return [`Method: ${method}`, "Module:", showScalar(result["module"])];
    case "implies": {
      const implies = decodeImpliesResult(result);
      const lines = [
        `Method: ${method}`,
        `Status: ${implies.status}`,
        "Implication:",
        koreText(implies.implication.term),
      ];
      if (implies.condition !== undefined) {
        lines.push(
          "Condition substitution:",
          koreText(implies.condition.substitution.term),
          "Condition predicate:",
          koreText(implies.condition.predicate.term),
        );
      }
      return lines;
    }
    case "get-model": {
      const model = decodeGetModelResult(result);
      const lines = [`Method: ${method}`, `Satisfiable: ${model.satisfiable}`];
      if (model.satisfiable === "Sat" && model.substitution !== undefined) {
        lines.push("Substitution:", koreText(model.substitution.term));
      }
      return lines;
    }
    default:
      throw new TypeError(
        `Could not tell which method this result belongs to; its members are: ${Object.keys(result).join(", ")}`,
      );
  }
}

/**
 * Describe one recorded kore-rpc request or response in readable form — pyk's
 * `pyk rpc-print` (`__main__.py:136-216`).
 *
 * `input` is the parsed JSON of a whole envelope, untrusted: a request (it has
 * a `method` member) or a response (it has `result` or `error`). The returned
 * text has no trailing newline; `cli.ts` adds one.
 *
 * @throws {TypeError} when the document is neither, or when a member it needs
 *   is missing or malformed — deviation (5).
 */
export function rpcPrint(input: unknown): string {
  const envelope = asRecord(input, "the input document");

  if ("method" in envelope) {
    const method = envelope["method"];
    return [
      "JSON RPC request",
      `id: ${showId(envelope["id"])}`,
      `Method: ${typeof method === "string" ? method : JSON.stringify(method)}`,
      ...printRequestParams(asRecord(envelope["params"] ?? {}, "params")),
    ].join("\n");
  }

  const header = ["JSON RPC Response", `id: ${showId(envelope["id"])}`];

  if ("error" in envelope) {
    // Deviation (4): pyk calls this "neither a request nor a response" and
    // exits. An error response is the single most interesting thing a bug
    // report can contain.
    const error = asRecord(envelope["error"], "error");
    const lines = [...header, `Error: ${JSON.stringify(error["code"] ?? null)} ${showScalar(error["message"])}`];
    if ("data" in error) lines.push("Data:", JSON.stringify(error["data"], null, 2));
    return lines.join("\n");
  }

  if (!("result" in envelope)) {
    throw new TypeError('The input is neither a request nor a response: it has no "method", "result" or "error"');
  }

  return [...header, ...printResult(asRecord(envelope["result"], "result"))].join("\n");
}

//////////////////////
// rpc-kast         //
//////////////////////

/**
 * Turn an `execute` response into the next request to send, by grafting its
 * state into a reference request — pyk's `pyk rpc-kast`
 * (`__main__.py:218-236`).
 *
 * The reference request supplies the envelope (`jsonrpc`, `id`, `method`) and
 * every parameter except `state`; the response supplies `state`, combined the
 * way `State.kore` combines it (term ∧ substitution ∧ predicate) and rewrapped
 * in a `{"format":"KORE","version":1,…}` envelope. Because the method comes
 * from the reference, an `execute` response can be turned into either the next
 * `execute` or the `simplify` that asks what that state reduces to — which is
 * the whole point of the command.
 *
 * Parameters are emitted sorted with `state` last (deviation 2); upstream
 * compares this output structurally (`test_pyk.py:186-188`), so the order is
 * ours to fix.
 *
 * @throws {TypeError} if either document is not the shape this needs.
 */
export function rpcKast(referenceRequest: unknown, response: unknown): JsonObject {
  const reference = asRecord(referenceRequest, "the reference request");
  const referenceParams = asRecord(reference["params"] ?? {}, "the reference request's params");
  const result = decodeExecuteResult(asRecord(response, "the response")["result"]);

  const params: Record<string, JsonValue> = {};
  for (const key of Object.keys(referenceParams).toSorted()) {
    if (key === "state") continue;
    params[key] = referenceParams[key] ?? null;
  }
  params["state"] = {
    format: KORE_JSON_FORMAT,
    version: KORE_JSON_VERSION,
    term: patternToJson(stateKore(result.state)),
  };

  return {
    jsonrpc: reference["jsonrpc"] ?? "2.0",
    id: reference["id"] ?? null,
    method: reference["method"] ?? null,
    params,
  };
}
