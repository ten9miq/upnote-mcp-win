import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: bun run scripts/verify-codex-connection.ts OUTPUT_JSON");
const config: any = Bun.TOML.parse(readFileSync(join(process.env.USERPROFILE!, ".codex", "config.toml"), "utf8"));
const registration = config.mcp_servers?.["upnote-local"];
if (!registration || registration.enabled === false || registration.env?.UPNOTE_AUTO_START !== "1") throw new Error("UpNote auto-connection is not enabled in Codex.");
const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const clients: Client[] = [];
async function connect(name: string) {
  const client = new Client({ name, version: "1.0.0" });
  clients.push(client);
  const transport = new StdioClientTransport({ command: registration.command, args: registration.args,
    env: { ...inherited, ...registration.env }, cwd: registration.cwd, stderr: "pipe" });
  const started = Date.now();
  await client.connect(transport);
  const handshakeMs = Date.now() - started;
  const tools = (await client.listTools()).tools.map(item => item.name);
  if (!tools.includes("ensure_upnote_connection")) throw new Error("The registered MCP does not expose connection preparation.");
  return { client, handshakeMs };
}
try {
  const startedAt = new Date().toISOString();
  const sessions = await Promise.all([connect("codex-connection-check-a"), connect("codex-connection-check-b")]);
  const prepared = await Promise.all(sessions.map(async session => {
    const result = await session.client.callTool({ name: "ensure_upnote_connection", arguments: {} });
    const status = result.structuredContent as { ready?: boolean } | undefined;
    if (result.isError || !status?.ready) throw new Error(JSON.stringify(result.content));
    return { handshakeMs: session.handshakeMs, status: result.structuredContent };
  }));
  const noteResult = await sessions[0]!.client.callTool({ name: "get_note", arguments: { id: "01a1d954-723c-74a0-8762-fde1a59c94d8" } });
  if (noteResult.isError) throw new Error("The existing test note could not be read after app preparation.");
  const note = (noteResult.structuredContent as { note: { id: string; sync: unknown } }).note;
  await sessions[0]!.client.close();
  const reconnected = await connect("codex-connection-check-reconnected");
  const repeated = await reconnected.client.callTool({ name: "ensure_upnote_connection", arguments: {} });
  if (repeated.isError || !(repeated.structuredContent as { ready?: boolean } | undefined)?.ready) throw new Error("MCP reconnection did not become ready.");
  const evidence = { startedAt, finishedAt: new Date().toISOString(), usedSavedCodexRegistration: true,
    command: registration.command, args: registration.args,
    configuration: { autoStart: true, endpoint: registration.env.UPNOTE_CDP_URL,
      startupTimeoutSec: registration.startup_timeout_sec, toolTimeoutSec: registration.tool_timeout_sec },
    parallelSessions: prepared, reconnectedSession: { handshakeMs: reconnected.handshakeMs, status: repeated.structuredContent },
    existingTestNote: { id: note.id, sync: note.sync }, noteMutationsPerformed: false };
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ outputPath, parallelReady: prepared.length, reconnectedReady: true,
    handshakesMs: [...prepared.map(session => session.handshakeMs), reconnected.handshakeMs], noteReadable: true }));
} finally { await Promise.allSettled(clients.map(client => client.close())); }
