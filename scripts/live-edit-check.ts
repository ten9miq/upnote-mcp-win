import { Database } from "bun:sqlite";
import { statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isUpNoteRunning } from "../src/editing";
import { resolveUpnoteDbPath } from "../src/upnote";

// Deliberately separate from automated tests: real writes require a specific,
// newly created test note and an explicit command-line opt-in.
const [id, outputPath, optIn] = process.argv.slice(2);
if (!id || !outputPath || optIn !== "--edit-test-note") {
  throw new Error("Usage: bun run scripts/live-edit-check.ts TEST_NOTE_ID OUTPUT_JSON --edit-test-note");
}
const dbPath = resolveUpnoteDbPath();
const db = new Database(dbPath, { readonly: true, create: false });
const client = new Client({ name: "upnote-live-edit-verification", version: "1.0.0" });
const row = () => db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(id)!;
const before = row();
if (!before || !String(before.title).startsWith("MCP実機テスト ") || !String(before.text).includes("BEFORE-LIVE-EDIT")) {
  throw new Error("Refusing to edit anything except a marked, unedited live-test note.");
}
if (!isUpNoteRunning() || before.synced !== 1) throw new Error("UpNote must be running and the test note synced before testing.");
const startedAt = new Date().toISOString();
const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const transport = new StdioClientTransport({
  command: process.execPath, args: ["run", resolve(import.meta.dir, "../src/index.ts")],
  env: { ...environment, UPNOTE_DB: dbPath }, stderr: "pipe",
});
try {
  await client.connect(transport);
  const read = await client.callTool({ name: "get_note", arguments: { id } });
  if (read.isError) throw new Error(JSON.stringify(read.content));
  const note = (read.structuredContent as { note: { version: string } }).note;
  const args = {
    id, expectedVersion: note.version, allowWhileRunning: true,
    content: "## 起動中の編集確認\n\n編集後の本文: AFTER-LIVE-EDIT\n\n- ノートIDを維持\n- 編集前バックアップを確認\n- UpNoteは起動したまま\n",
    contentFormat: "markdown", mode: "replace",
  };
  const preview = await client.callTool({ name: "update_note", arguments: { ...args, dryRun: true } });
  if (preview.isError) throw new Error(JSON.stringify(preview.content));
  const result = await client.callTool({ name: "update_note", arguments: args });
  const edit = result.structuredContent as { committed?: boolean; backupPath?: string; databaseVerification?: string } | undefined;
  if (!edit?.committed || !edit.backupPath) throw new Error(JSON.stringify(result));
  const backup = new Database(edit.backupPath, { readonly: true, create: false });
  let backupChecks;
  try {
    const backupRow = backup.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(id);
    const integrity = backup.query("PRAGMA integrity_check").all();
    backupChecks = {
      matchesEntireBeforeRow: JSON.stringify(backupRow) === JSON.stringify(before),
      containsBefore: String(backupRow?.text).includes("BEFORE-LIVE-EDIT"),
      containsAfter: String(backupRow?.text).includes("AFTER-LIVE-EDIT"),
      integrity, bytes: statSync(edit.backupPath).size,
    };
  } finally { backup.close(); }
  const samples = [];
  for (const delay of [0, 5_000, 10_000]) {
    if (delay) await Bun.sleep(delay);
    const current = row();
    samples.push({ at: new Date().toISOString(), appRunning: isUpNoteRunning(), id: current.id,
      title: current.title, text: current.text, synced: current.synced, revision: current.revision,
      sameId: current.id === before.id, sameCreatedAt: current.createdAt === before.createdAt,
      containsAfter: String(current.text).includes("AFTER-LIVE-EDIT"),
    });
  }
  const evidence = { startedAt, finishedAt: new Date().toISOString(), id, title: before.title, dbPath, before, edit, backupChecks, samples };
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ outputPath, edit, backupChecks, samples }, null, 2));
} finally {
  await client.close();
  db.close();
}
