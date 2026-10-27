/**
 * Who may be given a remote terminal: (federation kind) x (opt-in).
 *
 * A remote terminal is an attack vector, so the permission is not a bare
 * boolean. Today there is exactly one kind that can ever be enabled: an agent
 * of the owner's own, in an install the owner belongs to. Any other kind is
 * hard-off. There is deliberately no override: no flag, env var or config key
 * widens {@link ENABLEABLE_KINDS}; adding a kind is a code change and a review.
 */
export const FEDERATION_OWN_AGENT = "own_agent_in_member_install";

export type FederationKind = typeof FEDERATION_OWN_AGENT;

/** The only kinds a remote terminal can be switched on for. */
export const ENABLEABLE_KINDS: readonly string[] = [FEDERATION_OWN_AGENT];

/** This CLI runs the owner's own agent from its own saved connection, so this is the kind it is. */
export const THIS_CLI_KIND: FederationKind = FEDERATION_OWN_AGENT;

export type TerminalPermission = { enabled: true } | { enabled: false; reason: string };

export function remoteTerminalPermission(kind: string, optIn: boolean): TerminalPermission {
  if (!ENABLEABLE_KINDS.includes(kind)) {
    return { enabled: false, reason: `remote terminal is not available for this kind of connection (${kind === "" ? "unknown" : kind})` };
  }
  if (!optIn) return { enabled: false, reason: "remote terminal is off unless asked for" };
  return { enabled: true };
}
