import { describe, expect, test } from "bun:test";

import { USAGE, exitCodeFor, fetchFromGitHub, main, render, type KleanCliEffects } from "../src/cli.ts";
import { KleanOutputExistsError } from "../src/fs.ts";
import type { KleanSourceFetcher } from "../src/ksources.ts";
import { TRANSCRIBED_FROM } from "../src/version.ts";

function sinks() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (text: string) => void stdout.push(text),
    err: (text: string) => void stderr.push(text),
  };
}

function effects(overrides: Partial<KleanCliEffects> = {}): KleanCliEffects {
  return {
    readText: async () => {
      throw new Error("fixture not configured");
    },
    writeProject: async () => "/out/demo",
    ...overrides,
  };
}

/** Every declared file exists but hashes differently (bodies are empty). */
const everythingChanged: KleanSourceFetcher = () => Promise.resolve(new Uint8Array());
/** Every declared file is gone at that tag. */
const everythingGone: KleanSourceFetcher = () => Promise.resolve(undefined);
const offline: KleanSourceFetcher = () => Promise.reject(new Error("offline"));
const mustNotFetch: KleanSourceFetcher = () => Promise.reject(new Error("fetch must not run"));

/** Effects that fail loudly, so a command that must not touch disk cannot. */
function noDisk(): KleanCliEffects {
  return effects({
    readText: () => Promise.reject(new Error("readText must not run")),
    writeProject: () => Promise.reject(new Error("writeProject must not run")),
  });
}

describe("klean CLI", () => {
  test("help and missing positional arguments have stable codes", async () => {
    const help = sinks();
    expect(await main(["--help"], help.out, help.err, effects())).toBe(0);
    expect(help.stdout.join("")).toBe(`${USAGE}\n`);
    const missing = sinks();
    expect(await main([], missing.out, missing.err, effects())).toBe(2);
    expect(missing.stderr.join("")).toContain("takes exactly DEFN_DIR and PKG_NAME");
  });

  test("reports input failures without writing", async () => {
    let wrote = false;
    const output = sinks();
    const code = await main(
      ["defn", "demo"],
      output.out,
      output.err,
      effects({
        readText: async () => {
          throw new Error("missing definition.kore");
        },
        writeProject: async () => {
          wrote = true;
          return "never";
        },
      }),
    );
    expect(code).toBe(1);
    expect(wrote).toBe(false);
    expect(output.stderr.join("")).toContain("missing definition.kore");
  });

  test("preserves upstream's output-collision status 115", async () => {
    const output = sinks();
    const code = await main(
      ["defn", "demo"],
      output.out,
      output.err,
      effects({
        readText: async () => {
          throw new KleanOutputExistsError("/out/demo");
        },
      }),
    );
    expect(code).toBe(115);
  });
});

/**
 * `check-k`, exercised offline: the fetcher is injected, so the point under
 * test is the verdict logic and the exit contract, not GitHub. An `unchanged`
 * verdict cannot be produced here without serving the real upstream bytes;
 * `test/version.test.ts` covers the verdict logic over a synthetic manifest,
 * and {@link render} is exercised directly below.
 */
describe("klean check-k CLI", () => {
  test("has distinct contractual exit codes", () => {
    expect(exitCodeFor("unchanged")).toBe(0);
    expect(exitCodeFor("changed")).toBe(1);
    expect(exitCodeFor("could-not-locate")).toBe(3);
  });

  test("reports usage failures with exit code 2", async () => {
    const missing = sinks();
    expect(await main(["check-k"], missing.out, missing.err, noDisk(), mustNotFetch)).toBe(2);
    expect(missing.stderr.join("")).toContain("check-k takes exactly one K release tag");
    const extra = sinks();
    expect(await main(["check-k", "v9.9.9", "v9.9.8"], extra.out, extra.err, noDisk(), mustNotFetch)).toBe(2);
  });

  test("a changed source exits 1 and names the file", async () => {
    const output = sinks();
    const code = await main(["check-k", "v9.9.9"], output.out, output.err, noDisk(), everythingChanged);
    expect(code).toBe(1);
    expect(output.stdout.join("")).toContain("DIFF");
    expect(output.stdout.join("")).toContain("pyk/src/pyk/klean/k2lean4.py");
  });

  test("a moved path is could-not-locate: exit 3, not a compatibility verdict", async () => {
    const output = sinks();
    const code = await main(["check-k", "v9.9.9"], output.out, output.err, noDisk(), everythingGone);
    expect(code).toBe(3);
    expect(output.stdout.join("")).toContain("GONE");
    expect(output.stdout.join("")).toContain("not a verdict about compatibility");
  });

  test("a fetch failure is could-not-run: exit 2, and no verdict is printed", async () => {
    const output = sinks();
    const code = await main(["check-k", "v9.9.9"], output.out, output.err, noDisk(), offline);
    expect(code).toBe(2);
    expect(output.stderr.join("")).toContain("could not check v9.9.9: offline");
    expect(output.stdout.join("")).toBe("");
  });

  test("renders an unchanged report as current for the requested release", () => {
    const text = render({
      release: "v9.9.9",
      recordedAt: "v7.1.337",
      verdict: "unchanged",
      files: [{ path: "pyk/src/pyk/klean/model.py", status: "unchanged", expected: "abc", lines: 631, why: "printer" }],
    });
    expect(text).toContain("ok    pyk/src/pyk/klean/model.py");
    expect(text).toContain("unchanged since v7.1.337");
    expect(text).toContain("transcription is current for K v9.9.9");
  });

  // The two exit contracts this CLI carries are disjoint, which is what makes
  // 115 and 3 able to coexist: `check-k` writes nothing, so it can never raise
  // `KleanOutputExistsError`, and generation fetches nothing, so it can never
  // reach a `could-not-locate`. USAGE says so; this pins both halves.
  test("check-k never writes, and the generator is still reachable as ./check-k", async () => {
    const gone = sinks();
    expect(await main(["check-k", "v9.9.9"], gone.out, gone.err, noDisk(), everythingGone)).toBe(3);

    const generated = sinks();
    const read: string[] = [];
    const code = await main(
      ["./check-k", "demo"],
      generated.out,
      generated.err,
      effects({
        readText: (path) => {
          read.push(path);
          return Promise.reject(new Error("no such definition"));
        },
      }),
      mustNotFetch,
    );
    expect(code).toBe(1);
    expect(read).toEqual(["./check-k/definition.kore"]);
    expect(USAGE).toContain("it never returns 115");
  });

  test("percent-encodes the cookiecutter-braced template paths", async () => {
    const braced = TRANSCRIBED_FROM.find((source) => source.path.includes("{{"))?.path;
    expect(braced).toBeDefined();

    const seen: string[] = [];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const globals = globalThis as unknown as { fetch: unknown };
    const original = globals.fetch;
    globals.fetch = (url: string) => {
      seen.push(url);
      return Promise.resolve({
        status: 200,
        ok: true,
        statusText: "OK",
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    };
    try {
      expect(await fetchFromGitHub(braced ?? "", "v7.1.337")).toEqual(new Uint8Array());
    } finally {
      globals.fetch = original;
    }

    expect(seen[0]).toBe(
      "https://raw.githubusercontent.com/runtimeverification/k/v7.1.337/pyk/src/pyk/klean/template/" +
        "%7B%7B%20cookiecutter.package_name%20%7D%7D/%7B%7B%20cookiecutter.library_name%20%7D%7D/Prelude.lean",
    );
  });
});
