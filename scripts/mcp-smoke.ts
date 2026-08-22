import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UpNoteRepository } from "../src/upnote";

type ToolResult = { isError?: boolean };

function assertSuccess(name: string, result: unknown): void {
  if ((result as ToolResult).isError) {
    throw new Error(`${name} returned an MCP tool error: ${JSON.stringify(result)}`);
  }
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

const repository = new UpNoteRepository();
const note = repository.listRecentNotes(1)[0];
const notebook = repository.listNotebooks()[0];

if (!note) {
  throw new Error("The UpNote database contains no active notes for the MCP integration smoke test.");
}

const rootDir = resolve(import.meta.dir, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", resolve(rootDir, "src", "index.ts")],
  cwd: rootDir,
  env: inheritedEnvironment(),
  stderr: "pipe",
});
const client = new Client({ name: "upnote-mcp-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const availableTools = (await client.listTools()).tools.map((tool) => tool.name);
  const requiredTools = [
    "search_notes",
    "get_note",
    "list_recent_notes",
    "list_notebooks",
    "list_tags",
    "open_note",
    "open_notebook",
    "create_note",
  ];

  for (const name of requiredTools) {
    if (!availableTools.includes(name)) {
      throw new Error(`MCP server did not advertise required tool: ${name}`);
    }
  }

  const calls: Array<[string, Record<string, unknown>]> = [
    ["list_recent_notes", { limit: 1 }],
    ["search_notes", { query: note.title || note.id, limit: 1 }],
    ["get_note", { id: note.id }],
    ["list_notebooks", {}],
    ["list_tags", {}],
    ["open_note", { id: note.id }],
  ];

  if (notebook) {
    calls.push(["open_notebook", { id: notebook.id }]);
  }

  for (const [name, args] of calls) {
    const result = await client.callTool({ name, arguments: args });
    assertSuccess(name, result);
    console.log(JSON.stringify({ name, ok: true, args }));
  }

  if (process.env.UPNOTE_MCP_CREATE_SMOKE === "1") {
    const title = `[MCP Windows URL smoke ${new Date().toISOString()}]`;
    const result = await client.callTool({
      name: "create_note",
      arguments: {
        title,
        text: "UpNote MCP Windows URL scheme verification. This is a clearly marked test note.",
        markdown: false,
      },
    });
    assertSuccess("create_note", result);
    await Bun.sleep(1_000);
    const persisted = new UpNoteRepository()
      .searchNotes({ query: title, limit: 1 })
      .some((createdNote) => createdNote.title === title);
    console.log(JSON.stringify({ name: "create_note", ok: true, title, persisted }));
  } else {
    console.log(JSON.stringify({
      name: "create_note",
      skipped: true,
      reason: "Set UPNOTE_MCP_CREATE_SMOKE=1 to create one clearly marked test note through the URL scheme.",
    }));
  }
} finally {
  await client.close();
}
