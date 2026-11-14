import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NativeConnection } from "../src/native-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { NativeEditResult } from "../src/upnote";

const endpoint = process.argv[2] ?? "http://127.0.0.1:19330";
const evidencePath = process.argv[3];
const path = resolve(".cache/upnote-cdp-probe/upnote.sqlite3");
const id = randomUUID();
const connection = await NativeConnection.connect(endpoint);
try {
  await connection.evaluate(`(async()=>{
    const root=document.querySelector('#app').__vue_app__;
    const pinia=root.config.globalProperties.$pinia;
    const store=pinia._s.get('coreStore');
    if(!window.upnote.sqlPreload.getLocation().includes('upnote-cdp-probe'))throw new Error('Disposable profile required');
    if(store.user || store.cachedUser)throw new Error('This isolated test must not use a signed-in account');
    const now=Date.now();
    store.updateNotes([{id:${JSON.stringify(id)},title:'MCP Native integration',html:'<h2>MCP Native integration</h2><p>BEFORE-NATIVE</p>',text:'MCP Native integration\\nBEFORE-NATIVE',createdAt:now,updatedAt:now}]);
    store.updateLocalDataLoaded(true);
    pinia._s.get('uiStore').showIntro(false);
    store.setNavigationState({...store.current,mode:'notes-all',noteId:${JSON.stringify(id)}});
    pinia._s.get('uiStore').setSelectedNoteId(${JSON.stringify(id)});
    await new Promise(r=>setTimeout(r,500));
  })()`);
} finally { connection.close(); }
const client = new Client({ name: "native-bridge-isolated-test", version: "1.0.0" });
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const transport = new StdioClientTransport({ command: process.execPath, args: ["run", resolve(import.meta.dir, "../src/index.ts")], env: { ...env, UPNOTE_DB: path, UPNOTE_CDP_URL: endpoint }, stderr: "pipe" });
const db = new Database(path, { readonly: true, create: false });
try {
  await client.connect(transport);
  const before = db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(id)!;
  const read = await client.callTool({ name: "get_note", arguments: { id } });
  const note = (read.structuredContent as { note: { version: string } }).note;
  const response = await client.callTool({ name: "update_note_in_app", arguments: { id, expectedVersion: note.version, content: "## 内部APIの直接呼び出し\n\n**MCP-NATIVE-DIRECT** 日本語\n\nComputer Useなし", contentFormat: "markdown", waitMs: 1500 } });
  if (response.isError) throw new Error(JSON.stringify(response.content));
  const result = response.structuredContent as NativeEditResult;
  const after = db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(id)!;
  if (!result.applied || !result.uiUpdated || result.state !== "awaiting_sync" || result.cloudSync !== "unverified") throw new Error(JSON.stringify(result));
  const backup = new Database(result.backupPath!, { readonly: true, create: false });
  let backupMatches;
  try {
    backupMatches = JSON.stringify(backup.query("SELECT * FROM notes WHERE id=?").get(id)) === JSON.stringify(before);
    if (!backupMatches) throw new Error("Backup differs from pre-edit row.");
    if (JSON.stringify(backup.query("PRAGMA integrity_check").get()) !== '{"integrity_check":"ok"}') throw new Error("Invalid backup.");
  } finally { backup.close(); }
  if (before.createdAt !== after.createdAt || before.id !== after.id) throw new Error("Identity changed.");
  const evidence = { isolatedProfile: true, mcpProtocolTest: true, authenticatedCloudTest: false, testedAt: new Date().toISOString(), id, result, before, after, backupMatches, sameId: before.id === after.id, sameCreatedAt: before.createdAt === after.createdAt };
  if (evidencePath) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ isolatedProfile: true, id, state: result.state, uiUpdated: result.uiUpdated, backupMatches, sameId: true, sameCreatedAt: true, cloudSync: result.cloudSync }));
} finally { await client.close(); db.close(); }
