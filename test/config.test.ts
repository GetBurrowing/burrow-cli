import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  DEFAULT_SESSION_NAMING,
  emptyConfig,
  parseConfig,
  readConfig,
  serializeConfig,
  writeConfig,
  type SuiteConfig,
} from "../src/config.ts";
import {
  DEFAULT_SCOPE,
  WriteRefused,
  assertWritable,
  configDir,
  configPath,
  dataDir,
  gitProbe,
} from "../src/paths.ts";
import { createStore, TOKEN_KEY } from "../src/secrets.ts";

/* Invented values only — this repository is public. */
const SUITE_URL = "https://suite.example.invalid";
const RUNTIME_ID = "runtime_00000000-0000-0000-0000-000000000000";
const TOKEN = "tok_wjq4vn8x2m6r0k5p9d3f7h1s4a8e2c6b0y9u";
const HEADER_NAME = "X-Example-Gateway-Id";
const HEADER_VALUE = "gw_11111111111111111111111111111111";

const scratches: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "suite-cli-cfg-"));
  scratches.push(dir);
  return dir;
}

async function scratchRepo(gitignore: string): Promise<string> {
  const dir = await scratch();
  Bun.spawnSync(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" });
  await writeFile(resolve(dir, ".gitignore"), gitignore);
  return dir;
}

afterEach(async () => {
  while (scratches.length > 0) {
    const dir = scratches.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

function fullConfig(): SuiteConfig {
  return {
    suiteUrl: SUITE_URL,
    runtimeId: RUNTIME_ID,
    headerNames: [HEADER_NAME],
    sessionNaming: "cwd",
  };
}

describe("config paths", () => {
  test("user scope is the default scope", () => {
    expect(DEFAULT_SCOPE).toBe("user");
  });

  // /home/nobody and /xdg do not exist: a cold host, which resolves to burrow.
  test("XDG_CONFIG_HOME wins, HOME/.config is the fallback", () => {
    expect(configDir({ HOME: "/home/nobody", XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/burrow");
    expect(configDir({ HOME: "/home/nobody" })).toBe("/home/nobody/.config/burrow");
    expect(configPath({ HOME: "/home/nobody" })).toBe("/home/nobody/.config/burrow/config.json");
  });

  test("the data dir does NOT move: lib and plugin paths under it are recorded elsewhere", () => {
    expect(dataDir({ HOME: "/home/nobody" })).toBe("/home/nobody/.local/share/suite");
  });

  test("a relative XDG_CONFIG_HOME is ignored rather than trusted", () => {
    expect(configDir({ HOME: "/home/nobody", XDG_CONFIG_HOME: "relative/path" })).toBe(
      "/home/nobody/.config/burrow",
    );
  });
});

describe("configDir resolves burrow-first by existence, never by migrating", () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
  });
  async function home(...dirs: string[]): Promise<string> {
    const h = await mkdtemp(join(tmpdir(), "suite-cfgdir-"));
    homes.push(h);
    for (const d of dirs) await mkdir(join(h, ".config", d), { recursive: true });
    return h;
  }

  test("an empty HOME (cold host) resolves to burrow, and nothing is created", async () => {
    const h = await home();
    expect(configDir({ HOME: h })).toBe(join(h, ".config", "burrow"));
    expect(await readdir(h)).toEqual([]);
  });

  test("an old host (only ~/.config/suite) keeps resolving to suite", async () => {
    const h = await home("suite");
    await writeFile(join(h, ".config", "suite", "config.json"), "{}\n");
    expect(configDir({ HOME: h })).toBe(join(h, ".config", "suite"));
    expect(configPath({ HOME: h })).toBe(join(h, ".config", "suite", "config.json"));
    // Not moved, not copied: burrow was never created.
    expect(await readdir(join(h, ".config"))).toEqual(["suite"]);
  });

  test("when both exist, burrow wins and the suite dir is left exactly as it was", async () => {
    const h = await home("suite", "burrow");
    await writeFile(join(h, ".config", "suite", "config.json"), "{}\n");
    expect(configDir({ HOME: h })).toBe(join(h, ".config", "burrow"));
    expect(await readdir(join(h, ".config", "suite"))).toEqual(["config.json"]);
  });

  test("the same rule applies under XDG_CONFIG_HOME", async () => {
    const h = await home();
    const xdg = join(h, "xdg");
    await mkdir(join(xdg, "suite"), { recursive: true });
    expect(configDir({ HOME: h, XDG_CONFIG_HOME: xdg })).toBe(join(xdg, "suite"));
  });
});

describe("the config file holds no secret", () => {
  test("serialized bytes contain neither the token nor any header value", async () => {
    const store = createStore();
    store.set(TOKEN_KEY, TOKEN);
    store.set(HEADER_NAME, HEADER_VALUE);

    const dir = await scratch();
    const target = resolve(dir, "config.json");
    await writeConfig(fullConfig(), { path: target });

    const bytes = await Bun.file(target).text();
    expect(bytes).toContain(SUITE_URL);
    expect(bytes).toContain(RUNTIME_ID);
    expect(bytes).toContain(HEADER_NAME); // the NAME is config
    expect(bytes).not.toContain(HEADER_VALUE); // the VALUE is not
    expect(bytes).not.toContain(TOKEN);
    for (const secret of store.values()) expect(bytes).not.toContain(secret);
  });

  test("serialisation whitelists keys, so a stray secret field cannot leak", () => {
    const smuggled = { ...fullConfig(), token: TOKEN, headers: { [HEADER_NAME]: HEADER_VALUE } };
    const text = serializeConfig(smuggled as SuiteConfig);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(HEADER_VALUE);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "suiteUrl",
      "runtimeId",
      "headerNames",
      "sessionNaming",
    ]);
  });

  test("round-trips through parse unchanged", () => {
    expect(parseConfig(serializeConfig(fullConfig()))).toEqual(fullConfig());
    expect(emptyConfig().sessionNaming).toBe(DEFAULT_SESSION_NAMING);
  });

  test("readConfig returns null when nothing has been written", async () => {
    const dir = await scratch();
    expect(await readConfig({ path: resolve(dir, "config.json") })).toBeNull();
  });
});

describe("the gitignore guard", () => {
  test("NEGATIVE: inside a git repo, not ignored — refused, nothing written", async () => {
    const repo = await scratchRepo("# nothing ignored\n");
    const target = resolve(repo, "suite", "config.json");

    let refusal: unknown;
    try {
      await writeConfig(fullConfig(), { path: target });
    } catch (e) {
      refusal = e;
    }

    expect(refusal).toBeInstanceOf(WriteRefused);
    const err = refusal as WriteRefused;
    expect(err.path).toBe(target);
    expect(err.message).toContain(target);
    expect(err.exitCode).not.toBe(0);
    // No file, and not even the directory: the refusal precedes every mkdir.
    expect(await Bun.file(target).exists()).toBe(false);
    expect(await readdir(repo)).not.toContain("suite");
  });

  test("POSITIVE CONTROL: same repo, target ignored — the write proceeds", async () => {
    // Load-bearing: a guard that refuses unconditionally passes the negative
    // case above. Only this case can tell a correct guard from a broken one.
    const repo = await scratchRepo("suite/\n");
    const target = resolve(repo, "suite", "config.json");

    await writeConfig(fullConfig(), { path: target });

    expect(await Bun.file(target).exists()).toBe(true);
    expect(await Bun.file(target).text()).toContain(RUNTIME_ID);
  });

  test("a target outside any git repo proceeds", async () => {
    const dir = await scratch();
    const target = resolve(dir, "nested", "config.json");
    expect(gitProbe.repoRoot(target)).toBeNull();
    await writeConfig(fullConfig(), { path: target });
    expect(await Bun.file(target).exists()).toBe(true);
  });

  test("a nested .gitignore is honoured, which hand-parsing would miss", async () => {
    const repo = await scratchRepo("# root ignores nothing\n");
    await mkdir(resolve(repo, "sub"), { recursive: true });
    await writeFile(resolve(repo, "sub", ".gitignore"), "config.json\n");
    const nested = resolve(repo, "sub", "config.json");
    expect(() => assertWritable(nested)).not.toThrow();
    expect(() => assertWritable(resolve(repo, "sub", "other.json"))).toThrow(WriteRefused);
  });
});
