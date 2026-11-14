#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createNoteUrl,
  noteUrl,
  notebookUrl,
  tagUrl,
  UpNoteRepository,
  type CreateNoteParams,
  type FindNotesParams,
  type NotebookResult,
  type TagResult,
} from "./upnote";
import { openUpNoteUrl } from "./url";

const repository = new UpNoteRepository();
function formatSearchResults(query: string, notes: ReturnType<UpNoteRepository["searchNotes"]>): string {
  if (notes.length === 0) {
    return `No notes matched query="${query}".`;
  }

  return [
    `Search results for query="${query}": ${notes.length} item(s)`,
    ...notes.map((note, index) =>
      [
        `${index + 1}. ${note.title}`,
        `id: ${note.id}`,
        `url: ${note.url}`,
        `updatedAt: ${note.updatedAt ?? "unknown"}`,
        note.preview ? `preview: ${note.preview}` : "preview: none",
      ].join("\n"),
    ),
  ].join("\n\n");
}

function formatNotebooks(notebooks: NotebookResult[]): string {
  if (notebooks.length === 0) {
    return "No notebooks were found.";
  }
  return [
    `Notebook list: ${notebooks.length} item(s)`,
    ...notebooks.map((nb) =>
      [
        `- ${nb.title}`,
        `  id: ${nb.id}`,
        `  url: ${nb.url}`,
        `  noteCount: ${nb.noteCount}`,
        nb.parent ? `  parent: ${nb.parent}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

function formatTags(tags: TagResult[]): string {
  if (tags.length === 0) {
    return "No tags were found.";
  }
  return [
    `Tag list: ${tags.length} item(s)`,
    ...tags.map((tag) => `- ${tag.title}  (id: ${tag.id})  url: ${tag.url}`),
  ].join("\n");
}

function formatNoteDetail(note: ReturnType<UpNoteRepository["getNote"]>): string {
  return [
    `title: ${note.title}`,
    `id: ${note.id}`,
    `url: ${note.url}`,
    `updatedAt: ${note.updatedAt ?? "unknown"}`,
    `createdAt: ${note.createdAt ?? "unknown"}`,
    `version: ${note.version}`,
    "",
    note.content || "(no content)",
  ].join("\n");
}

function formatOpenResult(label: string, url: string): string {
  return [`Opened ${label} in UpNote.`, `url: ${url}`].join("\n");
}

function formatCreateResult(url: string): string {
  return [`Created a note in UpNote using the official URL scheme.`, `url: ${url}`].join("\n");
}

function formatTimeBasedResults(label: string, notes: ReturnType<UpNoteRepository["listRecentNotes"]>): string {
  if (notes.length === 0) {
    return `No notes were found for ${label}.`;
  }

  return [
    `${label}: ${notes.length} item(s)`,
    ...notes.map((note, index) =>
      [
        `${index + 1}. ${note.title}`,
        `id: ${note.id}`,
        `url: ${note.url}`,
        `updatedAt: ${note.updatedAt ?? "unknown"}`,
        note.preview ? `preview: ${note.preview}` : "preview: none",
      ].join("\n"),
    ),
  ].join("\n\n");
}

async function main(): Promise<void> {
  const server = new McpServer({
    name: "upnote-reader",
    version: "0.1.0",
  });

  server.registerTool(
    "search_notes",
    {
      description: [
        "Search UpNote notes by keyword across title, body text, and summary.",
        "Use this when you want to find notes by a word or phrase.",
        "Use search_by_tag instead when you want tag-based filtering.",
        "Results include note IDs. Call get_note with a returned ID when you need the full note body.",
        "If limit is omitted, 10 results are returned.",
      ].join(" "),
      inputSchema: {
        query: z.string().min(1).describe("Search keyword or phrase"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum number of results. Defaults to 10"),
      },
    },
    async ({ query, limit }) => {
      const notes = repository.searchNotes({ query, limit });

      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(query, notes),
          },
        ],
        structuredContent: {
          query,
          count: notes.length,
          notes,
          dbPath: repository.getResolvedDbPath(),
        },
      };
    },
  );

  server.registerTool(
    "list_recent_notes",
    {
      description: [
        "List the most recently updated UpNote notes.",
        "Use this when you want the latest note activity without a search query.",
        "Results include note IDs and deep links.",
      ].join(" "),
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("Maximum number of notes. Defaults to 10"),
      },
    },
    async ({ limit }) => {
      const notes = repository.listRecentNotes(limit ?? 10);
      return {
        content: [{ type: "text", text: formatTimeBasedResults("Recent notes", notes) }],
        structuredContent: {
          count: notes.length,
          notes,
          dbPath: repository.getResolvedDbPath(),
        },
      };
    },
  );

  server.registerTool(
    "find_notes",
    {
      description: [
        "Find UpNote notes by combining a time period with an optional keyword query and optional tag filter.",
        "Use this when you want one-step searches like 'this week's AI notes' or 'this month's meeting-tagged notes'.",
        "The period is based on updatedAt.",
      ].join(" "),
      inputSchema: {
        period: z.enum(["recent", "this_week", "this_month"]).optional().describe("Time window based on updatedAt. Defaults to recent"),
        query: z.string().optional().describe("Optional keyword query across title, body text, and summary"),
        tag: z.string().optional().describe("Optional tag filter, with or without #"),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of notes. Defaults to 10"),
      },
    },
    async ({ period, query, tag, limit }) => {
      const params: FindNotesParams = { period, query, tag, limit };
      const notes = repository.findNotes(params);
      const label = [
        period ?? "recent",
        query ? `query=${JSON.stringify(query)}` : "",
        tag ? `tag=${JSON.stringify(tag)}` : "",
      ]
        .filter(Boolean)
        .join(", ");

      return {
        content: [{ type: "text", text: formatTimeBasedResults(`Filtered notes (${label})`, notes) }],
        structuredContent: {
          params,
          count: notes.length,
          notes,
          dbPath: repository.getResolvedDbPath(),
        },
      };
    },
  );

  server.registerTool(
    "find_and_open_note",
    {
      description: [
        "Find UpNote notes by combining a time period with an optional keyword query and optional tag filter, then open the first matching note in UpNote.",
        "Use this when you want one-step actions like 'open this week's AI note' or 'open the latest note tagged meeting'.",
        "The period is based on updatedAt and the most recently updated match is opened.",
      ].join(" "),
      inputSchema: {
        period: z.enum(["recent", "this_week", "this_month"]).optional().describe("Time window based on updatedAt. Defaults to recent"),
        query: z.string().optional().describe("Optional keyword query across title, body text, and summary"),
        tag: z.string().optional().describe("Optional tag filter, with or without #"),
        limit: z.number().int().min(1).max(100).optional().describe("Search depth before opening the first match. Defaults to 10"),
      },
    },
    async ({ period, query, tag, limit }) => {
      const params: FindNotesParams = { period, query, tag, limit };
      const notes = repository.findNotes(params);

      if (notes.length === 0) {
        return {
          content: [{ type: "text", text: "No matching notes were found to open." }],
          structuredContent: {
            params,
            count: 0,
            notes: [],
            dbPath: repository.getResolvedDbPath(),
          },
        };
      }

      const note = notes[0];
      if (!note) {
        throw new Error("A matching note was expected but none was available.");
      }
      await openUpNoteUrl(note.url);

      return {
        content: [{ type: "text", text: formatOpenResult(`note ${note.title}`, note.url) }],
        structuredContent: {
          params,
          openedNote: note,
          count: notes.length,
          notes,
          dbPath: repository.getResolvedDbPath(),
        },
      };
    },
  );

  server.registerTool(
    "open_note",
    {
      description: [
        "Open an existing UpNote note in the UpNote desktop app by note ID.",
        "Use an ID returned from search_notes or search_by_tag.",
        "This launches UpNote through the official URL scheme.",
      ].join(" "),
      inputSchema: {
        id: z.string().min(1).describe("Note ID returned by search_notes or search_by_tag"),
      },
    },
    async ({ id }) => {
      const url = noteUrl(id);
      await openUpNoteUrl(url);

      return {
        content: [{ type: "text", text: formatOpenResult(`note ${id}`, url) }],
        structuredContent: {
          id,
          url,
          executed: true,
        },
      };
    },
  );

  server.registerTool(
    "get_note",
    {
      description: [
        "Fetch the full contents of a specific UpNote note by note ID.",
        "Use an ID returned from search_notes or search_by_tag.",
        "If you do not know the ID yet, call search_notes or search_by_tag first.",
        "Returns title, plain text body, HTML, summary, timestamps, and an UpNote deep link.",
      ].join(" "),
      inputSchema: {
        id: z.string().min(1).describe("Note ID returned by search_notes or search_by_tag"),
      },
    },
    async ({ id }) => {
      const note = repository.getNote(id);

      return {
        content: [
          {
            type: "text",
            text: formatNoteDetail(note),
          },
        ],
        structuredContent: {
          note,
          dbPath: repository.getResolvedDbPath(),
        },
      };
    },
  );

  server.registerTool(
    "open_notebook",
    {
      description: [
        "Open an existing UpNote notebook in the UpNote desktop app by notebook ID.",
        "Use an ID returned from list_notebooks.",
        "This launches UpNote through the official URL scheme.",
      ].join(" "),
      inputSchema: {
        id: z.string().min(1).describe("Notebook ID returned by list_notebooks"),
      },
    },
    async ({ id }) => {
      const url = notebookUrl(id);
      await openUpNoteUrl(url);

      return {
        content: [{ type: "text", text: formatOpenResult(`notebook ${id}`, url) }],
        structuredContent: {
          id,
          url,
          executed: true,
        },
      };
    },
  );

  server.registerTool(
    "list_notebooks",
    {
      description: [
        "List notebooks available in UpNote with notebook name, ID, note count, and deep link.",
        "Use this first when you need to discover what notebooks exist.",
        "If you want notes from a specific notebook, use the notebook name in a follow-up search_notes query.",
      ].join(" "),
      inputSchema: {},
    },
    async () => {
      const notebooks = repository.listNotebooks();
      return {
        content: [{ type: "text", text: formatNotebooks(notebooks) }],
        structuredContent: {
          count: notebooks.length,
          notebooks,
          dbPath: repository.getResolvedDbPath(),
        },
      };
    },
  );

  server.registerTool(
    "list_notes_this_week",
    {
      description: [
        "List UpNote notes updated during the current week.",
        "The week starts on Monday in local time.",
        "Use this when you want notes touched this week without providing a search query.",
      ].join(" "),
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of notes. Defaults to 50"),
      },
    },
    async ({ limit }) => {
      const notes = repository.listNotesThisWeek(limit ?? 50);
      return {
        content: [{ type: "text", text: formatTimeBasedResults("Notes updated this week", notes) }],
        structuredContent: {
          count: notes.length,
          notes,
          dbPath: repository.getResolvedDbPath(),
        },
      };
    },
  );

  server.registerTool(
    "list_notes_this_month",
    {
      description: [
        "List UpNote notes updated during the current month.",
        "Use this when you want notes touched this month without providing a search query.",
        "This is based on updatedAt, not createdAt.",
      ].join(" "),
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of notes. Defaults to 50"),
      },
    },
    async ({ limit }) => {
      const notes = repository.listNotesThisMonth(limit ?? 50);
      return {
        content: [{ type: "text", text: formatTimeBasedResults("Notes updated this month", notes) }],
        structuredContent: {
          count: notes.length,
          notes,
          dbPath: repository.getResolvedDbPath(),
        },
      };
    },
  );

  server.registerTool(
    "update_note",
    {
      description: [
        "Edit an existing note without changing its ID, after a verified full database backup.",
        "First call get_note and pass its version as expectedVersion. Use dryRun=true to preview.",
        "content replaces the body by default; mode=append preserves existing rich text and attachments.",
        "Quit UpNote for normal edits. allowWhileRunning=true enables experimental live writes only for a synced note.",
        "Live writes may be overwritten by UpNote's UI cache; database verification does not prove cloud sync.",
        "For app-visible edits and sync acknowledgement while running, prefer prepare_app_note_edit, computer-use paste, and complete_app_note_edit.",
        "After a conflict or a committed-but-unverified result, inspect the note and backup; never retry blindly.",
      ].join(" "),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        id: z.string().min(1),
        expectedVersion: z.string().regex(/^[a-f\d]{64}$/).describe("version from the latest get_note result"),
        title: z.string().min(1).optional().describe("Optional new title"),
        content: z.string().optional().describe("Body without the title; empty string clears the body in replace mode"),
        contentFormat: z.enum(["markdown", "text"]).optional(),
        mode: z.enum(["replace", "append"]).optional(),
        dryRun: z.boolean().optional().describe("Preview changed fields without writing or creating a backup"),
        allowWhileRunning: z.boolean().optional().describe("Explicitly permit experimental live edits; default false"),
      },
    },
    async (params) => {
      const result = await repository.updateNote(params);
      const failed = result.databaseVerification === "conflict" || result.databaseVerification === "unavailable";
      return {
        isError: failed,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { ...result, dbPath: repository.getResolvedDbPath() },
      };
    },
  );

  server.registerTool(
    "get_upnote_bridge_status",
    {
      description: "Check the opt-in local UpNote CDP bridge without Computer Use. Requires UPNOTE_CDP_URL. With UPNOTE_AUTO_START=1, prepares a closed app automatically. Checks DB columns/affinities/unique IDs and internal methods/state types, plus profile/lock state. App version is informational. Optional id validates note data and reports editor/sync metadata. Never force-restarts or unlocks UpNote.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { id: z.string().min(1).optional() },
    },
    async ({ id }) => {
      const result = await repository.getNativeBridgeStatus(id);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: { ...result, dbPath: repository.getResolvedDbPath() } };
    },
  );

  server.registerTool(
    "update_note_in_app",
    {
      description: [
        "Edit the same note through UpNote's internal updateNotes action over local CDP, refresh its editor and await app sync acknowledgement. No Computer Use, typing or clipboard.",
        "Requires the opt-in bridge (UPNOTE_CDP_URL), compatible internal APIs and DB structure/data, the correct profile, and no unsaved editor changes or open pop-out note windows. App version is informational only.",
        "First get_note and pass its version as expectedVersion. A verified DB backup is required before the app action. The MCP server never writes note rows or sync flags in this workflow.",
        "Only state=synced confirms expected content, editor reflection, and a fresh app-reported sync acknowledgement; other-device receipt is not independently checked.",
        "On timeout, conflict or unknown outcome, query get_upnote_bridge_status; never repeat a mutation automatically.",
      ].join(" "),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        id: z.string().min(1), expectedVersion: z.string().regex(/^[a-f\d]{64}$/),
        title: z.string().min(1).optional(), content: z.string().optional(),
        contentFormat: z.enum(["markdown", "text"]).optional(), mode: z.enum(["replace", "append"]).optional(),
        dryRun: z.boolean().optional(), waitMs: z.number().int().min(0).max(30_000).optional(),
      },
    },
    async ({ waitMs, ...params }) => {
      const result = await repository.updateNoteInApp(params, waitMs);
      return {
        isError: result.state === "conflict" || result.state === "unavailable",
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { ...result, dbPath: repository.getResolvedDbPath() },
      };
    },
  );

  server.registerTool(
    "prepare_app_note_edit",
    {
      description: [
        "Prepare a backed-up app-native edit without writing the UpNote database. Windows only; UpNote must be running and the note synced.",
        "Requires a computer-use client to apply the edit to UpNote's editor. Read get_note first and pass its version.",
        "Creates a verified full DB backup and stages rich HTML plus text on the Windows clipboard. Refuses images/attachments.",
        "Follow the returned instructions, verify the target note, and paste into its editor; then call complete_app_note_edit with the returned ticket.",
        "Keep the MCP server alive through completion. Tickets expire after ten minutes. Do not use direct SQLite writes for this workflow.",
      ].join(" "),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        id: z.string().min(1),
        expectedVersion: z.string().regex(/^[a-f\d]{64}$/),
        title: z.string().min(1).optional(),
        content: z.string().optional().describe("Body without title"),
        contentFormat: z.enum(["markdown", "text"]).optional(),
        mode: z.enum(["replace", "append"]).optional(),
      },
    },
    async (params) => {
      const result = await repository.prepareAppNoteEdit(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: { ...result, dbPath: repository.getResolvedDbPath() } };
    },
  );

  server.registerTool(
    "complete_app_note_edit",
    {
      description: "Read-only verification after the computer-use client pastes a prepared edit into UpNote. Waits for matching content under the original ID and a fresh app sync acknowledgement. Only state=synced acknowledges sync; awaiting states are incomplete. Never changes synced/syncedAt or retries input. Other-device receipt is not independently verified.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { ticket: z.string().uuid(), waitMs: z.number().int().min(0).max(30_000).optional() },
    },
    async ({ ticket, waitMs }) => {
      const result = await repository.completeAppNoteEdit(ticket, waitMs);
      return {
        isError: result.state === "conflict" || result.state === "unavailable",
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { ...result, dbPath: repository.getResolvedDbPath() },
      };
    },
  );

  server.registerTool(
    "create_note",
    {
      description: [
        "Create a new UpNote note through the official URL scheme.",
        "Use this when you want to save generated text or draft content into UpNote safely without writing to the SQLite database directly.",
        "At least one of title or text must be provided.",
      ].join(" "),
      inputSchema: {
        title: z.string().optional().describe("Optional note title"),
        text: z.string().optional().describe("Optional note body text"),
        notebook: z.string().optional().describe("Optional target notebook name"),
        markdown: z.boolean().optional().describe("Whether the text should be treated as Markdown. Defaults to true"),
        newWindow: z.boolean().optional().describe("Whether UpNote should open the note in a new window. Defaults to false"),
      },
    },
    async ({ title, text, notebook, markdown, newWindow }) => {
      if (!title && !text) {
        throw new Error("create_note requires at least one of title or text.");
      }

      const params: CreateNoteParams = {
        title,
        text,
        notebook,
        markdown: markdown ?? true,
        newWindow: newWindow ?? false,
      };
      const url = createNoteUrl(params);
      await openUpNoteUrl(url);

      return {
        content: [{ type: "text", text: formatCreateResult(url) }],
        structuredContent: {
          url,
          executed: true,
          params,
        },
      };
    },
  );

  server.registerTool(
    "list_tags",
    {
      description: [
        "List tags available in UpNote with tag name, ID, and deep link.",
        "Use this when you need to discover tag names or confirm tag spelling.",
        "Once you know the tag name, call search_by_tag to fetch notes for that tag.",
      ].join(" "),
      inputSchema: {},
    },
    async () => {
      const tags = repository.listTags();
      return {
        content: [{ type: "text", text: formatTags(tags) }],
        structuredContent: {
          count: tags.length,
          tags,
          dbPath: repository.getResolvedDbPath(),
        },
      };
    },
  );

  server.registerTool(
    "search_by_tag",
    {
      description: [
        "List notes that have a specific UpNote tag.",
        "The tag works with or without a leading # character.",
        "If you do not know the tag name yet, call list_tags first.",
        "Results include note IDs. Call get_note with a returned ID when you need the full note body.",
        "Use search_notes instead when you want keyword-based search rather than tag filtering.",
      ].join(" "),
      inputSchema: {
        tag: z.string().min(1).describe("Tag name, with or without #"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum number of results. Defaults to 10"),
      },
    },
    async ({ tag, limit }) => {
      const notes = repository.searchByTag(tag, limit);
      return {
        content: [
          {
            type: "text",
            text: notes.length === 0
              ? `No notes were found for tag "${tag}".`
              : formatSearchResults(tag, notes),
          },
        ],
        structuredContent: {
          tag,
          count: notes.length,
          notes,
          dbPath: repository.getResolvedDbPath(),
        },
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

}

main().catch((error) => {
  console.error("An error occurred in the UpNote MCP server.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
