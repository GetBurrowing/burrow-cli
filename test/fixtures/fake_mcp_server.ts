/**
 * A stdio MCP server for tests: newline-delimited JSON-RPC on stdin/stdout.
 *
 *   FAKE_MCP_TOOLS  comma-separated tool names it lists (default: none)
 *   FAKE_MCP_LOG    a file it appends one line per request to (`<method>[ <tool>]`)
 *   FAKE_MCP_SILENT set: never answers, for the unreachable case
 *
 * tools/call answers `pong:<tool>`.
 */
import { appendFileSync } from "node:fs";

const tools = (process.env.FAKE_MCP_TOOLS ?? "").split(",").filter((t) => t !== "");
const log = (line: string) => {
  if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, `${line}\n`);
};
const reply = (id: unknown, result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === "") continue;
    const msg = JSON.parse(line) as { id?: unknown; method?: string; params?: { name?: string } };
    log(msg.method === "tools/call" ? `tools/call ${msg.params?.name ?? ""}` : String(msg.method));
    if (process.env.FAKE_MCP_SILENT) continue;
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") reply(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
    else if (msg.method === "tools/list") reply(msg.id, { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) });
    else if (msg.method === "tools/call") reply(msg.id, { content: [{ type: "text", text: `pong:${msg.params?.name ?? ""}` }] });
    else reply(msg.id, {});
  }
});
process.stdin.on("end", () => process.exit(0));
