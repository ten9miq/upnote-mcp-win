import { Database } from "bun:sqlite";
import { statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NativeConnection } from "../src/native-bridge";
import { resolveUpnoteDbPath, type NativeEditResult } from "../src/upnote";

const [id, outputPath, optIn] = process.argv.slice(2);
if (!id || !outputPath || optIn !== "--edit-test-note") throw new Error("Usage: bun run scripts/live-native-edit-check.ts TEST_NOTE_ID OUTPUT_JSON --edit-test-note");
const endpoint = process.env.UPNOTE_CDP_URL;
if (!endpoint) throw new Error("Set UPNOTE_CDP_URL first.");
const path = resolveUpnoteDbPath();
const db = new Database(path, { readonly: true, create: false });
const before = db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(id);
if (!before || !String(before.title).startsWith("MCP実機テスト ")) throw new Error("Refusing to edit a non-test note.");
const client = new Client({ name: "upnote-native-authenticated-test", version: "1.0.0" });
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const transport = new StdioClientTransport({ command: process.execPath, args: ["run", resolve(import.meta.dir, "../src/index.ts")], env: { ...env, UPNOTE_DB: path, UPNOTE_CDP_URL: endpoint }, stderr: "pipe" });
try {
  await client.connect(transport);
  const status = await client.callTool({ name: "get_upnote_bridge_status", arguments: { id } });
  if (status.isError) throw new Error(JSON.stringify(status.content));
  const read = await client.callTool({ name: "get_note", arguments: { id } });
  if (read.isError) throw new Error(JSON.stringify(read.content));
  const note = (read.structuredContent as { note: { version: string } }).note;
  const startedAt = new Date().toISOString();
  const response = await client.callTool({ name: "update_note_in_app", arguments: {
    id, expectedVersion: note.version,
    content: "## MCP単独で即時反映・クラウド同期\n\n**MCP-ONLY-CLOUD-SYNC** 日本語\n\n- 同じノートIDを維持\n- 編集前の自動バックアップ\n- UpNote内部の保存・同期処理を直接呼び出し\n\n検証実行: " + startedAt + "\n",
    contentFormat: "markdown", waitMs: 30_000,
  } });
  const result = response.structuredContent as NativeEditResult;
  if (!result?.backupPath) throw new Error(JSON.stringify(response));
  const after = db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(id)!;
  const backup = new Database(result.backupPath, { readonly: true, create: false });
  let backupChecks;
  try {
    backupChecks = {
      matchesEntireBeforeRow: JSON.stringify(backup.query("SELECT * FROM notes WHERE id=?").get(id)) === JSON.stringify(before),
      integrity: backup.query("PRAGMA integrity_check").all(), bytes: statSync(result.backupPath).size,
    };
  } finally { backup.close(); }
  const connection = await NativeConnection.connect(endpoint);
  let ui: { boldMarker: boolean; headings: string[]; listPreview?: string; [key: string]: unknown };
  try {
    ui = await connection.evaluate(`(() => {
      const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('coreStore');
      if(store.currentNoteId!==${JSON.stringify(id)})throw new Error('Unexpected displayed note');
      const editor=document.querySelector('.shine-editor');
      const listItem=document.getElementById(${JSON.stringify(id)});
      return { currentNoteId:store.currentNoteId, html:editor?.innerHTML, text:editor?.textContent,
        headings:editor?[...editor.querySelectorAll('h1,h2,h3')].map(e=>e.textContent):[],
        boldMarker:!![...editor?.querySelectorAll('b,strong')||[]].find(e=>e.textContent==='MCP-ONLY-CLOUD-SYNC'),
        listPreview:listItem?.textContent, unsavedEditorChanges:!!store.isCurrentNoteModified };
    })()`);
  } finally { connection.close(); }
  const evidence = {
    mcpProtocolTest: true, authenticatedProfileTest: true, computerUseUsed: false, clipboardUsed: false,
    startedAt, finishedAt: new Date().toISOString(), id, result, before, after, backupChecks, ui,
    sameId: before.id === after.id, sameCreatedAt: before.createdAt === after.createdAt,
    acknowledgementLatencyMs: Number(after.syncedAt) - Number(after.updatedAt), otherDeviceVerified: false,
  };
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ outputPath, state: result.state, applied: result.applied, uiUpdated: result.uiUpdated, cloudSync: result.cloudSync, sameId: evidence.sameId, sameCreatedAt: evidence.sameCreatedAt, backupChecks, syncedAt: result.note?.sync.syncedAt, acknowledgementLatencyMs: evidence.acknowledgementLatencyMs, ui }, null, 2));
  if (response.isError || result.state !== "synced" || !backupChecks.matchesEntireBeforeRow || JSON.stringify(backupChecks.integrity) !== '[{"integrity_check":"ok"}]' || !evidence.sameId || !evidence.sameCreatedAt || !ui.boldMarker || !ui.headings.includes("MCP単独で即時反映・クラウド同期") || !ui.listPreview?.includes("MCP単独で即時反映・クラウド同期")) process.exitCode = 1;
} finally { await client.close(); db.close(); }
