/**
 * Who may edit this agent's config files from the Burrow install, decided ON
 * THIS MACHINE (task 01a17b1c).
 *
 * The permission is a product, never a bare boolean:
 *
 *   (federation kind) x (opt-in)
 *
 * - kind: the relationship between this machine's agent and the install. The
 *   only kind that can ever be enabled is `own_agent_in_member_install`, an
 *   agent of the owner's own, in an install the owner belongs to. Anything else
 *   is hard-off. No flag, environment variable or config key widens
 *   {@link ENABLEABLE_KINDS}; adding a kind is a code change and a review. (The
 *   remote terminal, `src/terminal/permission.ts` on its branch, carries the
 *   same list; keep them equal.)
 * - opt-in, per agent folder, set here with `burrow config-access`:
 *     off         (default) the host does not even join the topic;
 *     owner_only  requests from the runtime's owner are served;
 *     admins      the owner and install root admins.
 *
 * Core relays the actor's ROLE (`owner` | `admin`) in every request and refuses
 * first; this check is the second lock and it holds if core is wrong.
 */
import { readAgentRecordExact, serializeAgentRecord, agentConfigPath, canonicalDir, type AgentRecord } from "../agent_connections.ts";
import { chmodSync, writeFileSync, renameSync } from "node:fs";

export type ConfigAccess = "off" | "owner_only" | "admins";
export type ActorRole = "owner" | "admin";

export const FEDERATION_OWN_AGENT = "own_agent_in_member_install";
export const ENABLEABLE_KINDS: readonly string[] = [FEDERATION_OWN_AGENT];

/** A saved connection is the owner's own agent in the install the owner joined. */
export function connectionKind(_record: AgentRecord): string {
  return FEDERATION_OWN_AGENT;
}

/** Accepts the CLI spellings: off, owner / owner_only, admins. */
export function parseAccess(raw: string): ConfigAccess | null {
  const v = raw.trim().toLowerCase();
  if (v === "off") return "off";
  if (v === "owner" || v === "owner_only" || v === "owner-only") return "owner_only";
  if (v === "admins" || v === "admin") return "admins";
  return null;
}

export function accessOf(record: AgentRecord): ConfigAccess {
  return record.configAccess ?? "off";
}

/** The pure decision for one request. */
export function permits(access: ConfigAccess, role: unknown): boolean {
  if (access === "owner_only") return role === "owner";
  if (access === "admins") return role === "owner" || role === "admin";
  return false;
}

export type SetResult = { ok: true; access: ConfigAccess } | { ok: false; reason: string };

/**
 * Save the opt-in. Turning it on is refused for any kind outside
 * {@link ENABLEABLE_KINDS}; turning it off never is.
 */
export function setConfigAccess(
  env: Record<string, string | undefined>,
  dir: string,
  access: ConfigAccess,
  kind?: string,
): SetResult {
  const found = readAgentRecordExact(env, canonicalDir(dir));
  if (found === null) return { ok: false, reason: `${dir} is not a connected agent folder (run \`burrow init\` there first)` };
  const k = kind ?? connectionKind(found.record);
  if (access !== "off" && !ENABLEABLE_KINDS.includes(k)) {
    return { ok: false, reason: `config editing cannot be enabled for this kind of connection (${k === "" ? "unknown" : k})` };
  }
  const next: AgentRecord = { ...found.record };
  if (access === "off") delete next.configAccess;
  else next.configAccess = access;
  const path = agentConfigPath(env, found.record.dir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, serializeAgentRecord(next), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return { ok: true, access };
}
