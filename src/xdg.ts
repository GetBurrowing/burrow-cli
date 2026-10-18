/**
 * The three XDG base directories this CLI writes under, and the name of its
 * own directory inside each. Shared by paths.ts (where things live now) and
 * migrate.ts (where they lived before 0.9.0), which is why it is its own
 * module: migrate.ts must not import paths.ts, because paths.ts consults it.
 */
import { isAbsolute, resolve } from "node:path";

export type Env = Record<string, string | undefined>;

/** This CLI's directory name under each base: `<config>/burrow`, `<data>/burrow`, `<state>/burrow`. */
export const BURROW_DIRNAME = "burrow";

export function home(env: Env): string {
  const h = env.HOME;
  if (h === undefined || h === "") {
    throw new Error("HOME is not set; cannot resolve the user config directory");
  }
  return h;
}

/** An XDG variable counts only when it is set, non-empty and absolute (the spec says to ignore a relative one). */
function xdg(env: Env, name: string, fallback: string[]): string {
  const v = env[name];
  return v !== undefined && v !== "" && isAbsolute(v) ? v : resolve(home(env), ...fallback);
}

/** `$XDG_CONFIG_HOME`, else `~/.config`. */
export function configBase(env: Env = process.env): string {
  return xdg(env, "XDG_CONFIG_HOME", [".config"]);
}

/** `$XDG_DATA_HOME`, else `~/.local/share`. */
export function dataBase(env: Env = process.env): string {
  return xdg(env, "XDG_DATA_HOME", [".local", "share"]);
}

/** `$XDG_STATE_HOME`, else `~/.local/state`. */
export function stateBase(env: Env = process.env): string {
  return xdg(env, "XDG_STATE_HOME", [".local", "state"]);
}

export type BaseKind = "config" | "data" | "state";

export function base(kind: BaseKind, env: Env = process.env): string {
  return kind === "config" ? configBase(env) : kind === "data" ? dataBase(env) : stateBase(env);
}

/** `<base>/burrow` for one of the three kinds. */
export function burrowRoot(kind: BaseKind, env: Env = process.env): string {
  return resolve(base(kind, env), BURROW_DIRNAME);
}
