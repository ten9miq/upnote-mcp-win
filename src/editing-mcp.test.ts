import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP get_note version, update preview, commit, backup and stale-write error use an isolated DB", async () => {
  const directory = mkdtempSync(join(tmpdir(), "upnote-edit-mcp-"));
  const path = join(directory, "fixture.sqlite3");
  const db = new Database(path);
  const client = new Client({ name: "edit-test", version: "1.0.0" });
  try {
    db.exec(`CREATE TABLE notes (
      id TEXT PRIMARY KEY,title TEXT,html TEXT,text TEXT,summary TEXT,updatedAt DOUBLE,createdAt DOUBLE,
      synced INTEGER,revision INTEGER,deleted INTEGER,trashed INTEGER,hasTodo INTEGER
    ); INSERT INTO notes VALUES ('test-note','Test','<h2>Test</h2><p>Before</p>','Test\nBefore','Before',1,1,1,0,0,0,0)`);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({
      command: process.execPath, args: ["run", resolve(import.meta.dir, "index.ts")],
      env: { ...env, UPNOTE_DB: path, UPNOTE_BACKUPS_DIR: join(directory, "backups"), UPNOTE_AUTO_START: "0" }, stderr: "pipe",
    });
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find((item) => item.name === "update_note");
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    const toolNames = (await client.listTools()).tools.map(item => item.name);
    const read = await client.callTool({ name: "get_note", arguments: { id: "test-note" } });
    const note = (read.structuredContent as { note: { version: string } }).note;
    expect(note.version).toMatch(/^[a-f\d]{64}$/);
    const args = { id: "test-note", expectedVersion: note.version, content: "**After**", allowWhileRunning: true };
    const preview = await client.callTool({ name: "update_note", arguments: { ...args, dryRun: true } });
    expect(preview.isError ? preview.content : false).toBe(false);
    expect(preview.structuredContent).toMatchObject({ committed: false, dryRun: true, dbPath: path });
    const written = await client.callTool({ name: "update_note", arguments: args });
    expect(written.isError).not.toBe(true);
    expect(written.structuredContent).toMatchObject({ id: "test-note", committed: true, databaseVerification: "matches", cloudSync: "unverified" });
    const result = written.structuredContent as { backupPath: string };
    const backup = new Database(result.backupPath, { readonly: true, create: false });
    try { expect(backup.query("SELECT text FROM notes").get()).toEqual({ text: "Test\nBefore" }); }
    finally { backup.close(); }
    const stale = await client.callTool({ name: "update_note", arguments: args });
    expect(stale.isError).toBe(true);
    expect(db.query("SELECT id,text FROM notes").get()).toEqual({ id: "test-note", text: "Test\nAfter" });
  } finally {
    await client.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
