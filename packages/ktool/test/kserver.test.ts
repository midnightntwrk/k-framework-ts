/**
 * `src/kserver.ts`'s K-free half: the address arithmetic, the environment
 * channel, and the one pre-flight check upstream does not make.
 *
 * There is no pyk counterpart to any of this — `grep -r kserver pyk/src/` is
 * empty at `v7.1.337` — so the goldens are read off
 * `k-distribution/src/main/scripts/lib/checkJava:24-26` and
 * `bin/spawn-kserver:4`. Actually starting a JVM belongs in
 * `test/live-throughput.test.ts`, behind `KFRAMEWORK_TS_K_BIN`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { caughtAsync } from "./caught.ts";
import {
  KSERVER_SOCKET_ENV,
  KSERVER_SOCKET_FILE,
  KSERVER_SOCKET_PATH_MAX,
  KserverError,
  kserverEnv,
  kserverSocketDir,
  kserverSocketPath,
  spawnKserver,
} from "../src/kserver.ts";

const previous = process.env[KSERVER_SOCKET_ENV];

afterEach(() => {
  if (previous === undefined) delete process.env[KSERVER_SOCKET_ENV];
  else process.env[KSERVER_SOCKET_ENV] = previous;
});

describe("kserverSocketDir — `checkJava:25`", () => {
  test("defaults to $HOME/.kserver", () => {
    expect(kserverSocketDir({})).toBe(join(homedir(), ".kserver"));
  });

  test("$KSERVER_SOCKET wins", () => {
    expect(kserverSocketDir({ [KSERVER_SOCKET_ENV]: "/tmp/ks" })).toBe("/tmp/ks");
  });

  test("an empty variable is treated as unset, as `${VAR:-default}` treats it", () => {
    expect(kserverSocketDir({ [KSERVER_SOCKET_ENV]: "" })).toBe(join(homedir(), ".kserver"));
  });

  test("reads process.env by default", () => {
    process.env[KSERVER_SOCKET_ENV] = "/tmp/from-env";
    expect(kserverSocketDir()).toBe("/tmp/from-env");
  });
});

describe("kserverSocketPath — the variable names a directory, not a socket (`checkJava:26`)", () => {
  test("the socket is <dir>/socket", () => {
    expect(kserverSocketPath("/tmp/ks")).toBe(join("/tmp/ks", "socket"));
    expect(KSERVER_SOCKET_FILE).toBe("socket");
  });
});

describe("kserverEnv — the only channel the K scripts read", () => {
  test("merges into the base rather than replacing it, because `proc.ts` replaces", () => {
    const env = kserverEnv("/tmp/ks", { PATH: "/bin", HOME: "/home/x" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/x", [KSERVER_SOCKET_ENV]: "/tmp/ks" });
  });

  test("overrides an existing value", () => {
    expect(kserverEnv("/tmp/new", { [KSERVER_SOCKET_ENV]: "/tmp/old" })[KSERVER_SOCKET_ENV]).toBe("/tmp/new");
  });

  test("drops undefined entries, which process.env can carry and a spawn env cannot", () => {
    expect(kserverEnv("/tmp/ks", { A: "1", B: undefined })).toEqual({ A: "1", [KSERVER_SOCKET_ENV]: "/tmp/ks" });
  });
});

describe("spawnKserver's sun_path check — the failure `spawn-kserver` reports only into its log", () => {
  test("a socket path at or over the AF_UNIX limit throws before anything is spawned", async () => {
    // 104 is the limit; leave room for `/socket` and go past it.
    const dir = `/tmp/${"k".repeat(KSERVER_SOCKET_PATH_MAX)}`;
    const error = await caughtAsync(spawnKserver({ socketDir: dir }), KserverError);
    expect(error.code).toBe("socket-path-too-long");
    expect(error.message).toContain(String(KSERVER_SOCKET_PATH_MAX - 1));
    expect(error.socketDir).toBe(dir);
    // Nothing was published, because the check precedes the export.
    expect(process.env[KSERVER_SOCKET_ENV]).toBe(previous);
  });

  test("the limit is the one Nailgun's SockaddrUn enforces on both platforms", () => {
    expect(KSERVER_SOCKET_PATH_MAX).toBe(104);
  });
});
