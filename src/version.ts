/**
 * Single source of truth for the CLI version at runtime.
 *
 * install.sh reads the same value out of package.json when it renders the
 * entrypoint, so `burrow --version` answers identically whether it is served by
 * the POSIX launcher (no bun required) or by this module.
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = (pkg as { version: string }).version;

/**
 * The command's name, for every user-facing hint and error prefix.
 *
 * One constant so the `suite` -> `burrow` rename (0.8.0) is a single edit the
 * next time it moves. The installed `suite` launcher is an alias of this
 * command (install.sh renders both); messages always name `burrow`.
 */
export const CLI_NAME = "burrow";
