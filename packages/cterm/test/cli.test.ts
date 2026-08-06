import { describe, expect, test } from "bun:test";
import { exitCodeFor, main, render } from "../src/cli.ts";

const changedFetcher = async () => new TextEncoder().encode("not the recorded source");
const missingFetcher = async () => undefined;

describe("cterm check-k", () => {
  test("documents bad usage without attempting a fetch", async () => {
    let error = "";
    const status = await main(
      [],
      () => undefined,
      (text) => {
        error += text;
      },
    );
    expect(status).toBe(2);
    expect(error).toContain("cterm check-k");
  });

  test("retains changed and moved-source as distinct contractual outcomes", async () => {
    let output = "";
    expect(
      await main(
        ["check-k", "v9.9.9"],
        (text) => (output += text),
        () => undefined,
        changedFetcher,
      ),
    ).toBe(1);
    expect(output).toContain("DIFF");
    expect(
      await main(
        ["check-k", "v9.9.9"],
        () => undefined,
        () => undefined,
        missingFetcher,
      ),
    ).toBe(3);
  });
});

test("render and exit code retain the repository source-drift contract", () => {
  expect(exitCodeFor("unchanged")).toBe(0);
  expect(exitCodeFor("changed")).toBe(1);
  expect(exitCodeFor("could-not-locate")).toBe(3);
  expect(
    render({
      release: "v9.9.9",
      recordedAt: "v7.1.337",
      verdict: "could-not-locate",
      files: [{ path: "pyk/cterm/cterm.py", status: "missing", expected: "abc", why: "test" }],
    }),
  ).toContain("not a verdict about compatibility");
});
