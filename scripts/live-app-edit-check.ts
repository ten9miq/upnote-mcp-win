import { Database } from "bun:sqlite";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveUpnoteDbPath } from "../src/upnote";

const [id, outputPath, optIn, recoveryPath] = process.argv.slice(2);
if (!id || !outputPath || !["--prepare-test-note", "--repair-test-note"].includes(optIn ?? "")) throw new Error("Usage: bun run scripts/live-app-edit-check.ts TEST_NOTE_ID OUTPUT_JSON --prepare-test-note (or --repair-test-note FAILED_EVIDENCE_JSON)");
const dbPath = resolveUpnoteDbPath();
const db = new Database(dbPath, { readonly: true, create: false });
const before = db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(id);
let repairTitle: string | undefined;
if (optIn === "--repair-test-note") {
  if (!recoveryPath) throw new Error("A previous failed-test evidence file is required for repair.");
  const previous = JSON.parse(readFileSync(recoveryPath, "utf8"));
  if (!before || previous.before?.id !== id || previous.after?.id !== id || previous.verification?.state !== "conflict" ||
      !String(previous.before.title).startsWith("MCP実機テスト ") || before.title !== previous.after.title || before.text !== previous.after.text) {
    throw new Error("The target does not match the documented failed test; refusing repair.");
  }
  repairTitle = previous.before.title;
} else if (!before || !String(before.title).startsWith("MCP実機テスト ")) throw new Error("Refusing to prepare an app edit for a non-test note.");
const client = new Client({ name: "upnote-app-edit-live-check", version: "1.0.0" });
const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const transport = new StdioClientTransport({ command: process.execPath, args: ["run", resolve(import.meta.dir, "../src/index.ts")], env: { ...environment, UPNOTE_DB: dbPath }, stderr: "pipe" });
try {
  await client.connect(transport);
  const read = await client.callTool({ name: "get_note", arguments: { id } });
  const current = (read.structuredContent as { note: { version: string } }).note;
  const prepared = await client.callTool({ name: "prepare_app_note_edit", arguments: {
    id, expectedVersion: current.version,
    ...(repairTitle ? { title: repairTitle } : {}),
    content: "## アプリ経由の即時反映・同期テスト\n\nAPP-NATIVE-SYNC-COMPLETE\n\n**太字の表示確認** & 日本語\n\n- 同じノートIDを維持\n- 自動バックアップを検査\n- UpNote自身の保存・同期を利用\n",
    contentFormat: "markdown", mode: "replace",
  } });
  if (prepared.isError) throw new Error(JSON.stringify(prepared.content));
  const plan = prepared.structuredContent as { ticket: string; backupPath: string; id: string };
  const backup = new Database(plan.backupPath, { readonly: true, create: false });
  let backupChecks;
  try {
    backupChecks = {
      matchesBeforeRow: JSON.stringify(backup.query("SELECT * FROM notes WHERE id=?").get(id)) === JSON.stringify(before),
      integrity: backup.query("PRAGMA integrity_check").all(), bytes: statSync(plan.backupPath).size,
    };
  } finally { backup.close(); }
  writeFileSync(outputPath, JSON.stringify({ before, plan, backupChecks, phase: "awaiting_editor_paste" }, null, 2));
  console.log(JSON.stringify({ phase: "awaiting_editor_paste", id, ticket: plan.ticket, backupPath: plan.backupPath, backupChecks, outputPath }));
  const deadline = Date.now() + 240_000;
  let lastState;
  do {
    const result = await client.callTool({ name: "complete_app_note_edit", arguments: { ticket: plan.ticket, waitMs: 0 } });
    const verified = result.structuredContent as { state: string };
    if (verified.state !== lastState) { console.log(JSON.stringify({ at: new Date().toISOString(), ...verified })); lastState = verified.state; }
    if (verified.state === "synced" || result.isError) {
      const after = db.query("SELECT id,title,text,html,synced,syncedAt,revision,updatedAt,createdAt FROM notes WHERE id=?").get(id);
      writeFileSync(outputPath, JSON.stringify({ before, plan, backupChecks, verification: verified, after, completedAt: new Date().toISOString() }, null, 2));
      if (result.isError) process.exitCode = 1;
      break;
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for computer-use paste and app sync. Do not paste again automatically.");
    await Bun.sleep(500);
  } while (true);
} finally { await client.close(); db.close(); }
