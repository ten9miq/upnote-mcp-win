import { UpNoteRepository } from "../src/upnote";

const repository = new UpNoteRepository();
let failed = false;

function run<T>(label: string, fn: () => T): T | undefined {
  try {
    const result = fn();
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    failed = true;
    console.error(`[${label}] ERROR:`, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

const recentNotes = run("database_connection_and_list_recent_notes", () => {
  const notes = repository.listRecentNotes(3);
  return {
    dbPath: repository.getResolvedDbPath(),
    count: notes.length,
    notes: notes.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
  };
});

run("list_notebooks", () => {
  const notebooks = repository.listNotebooks();
  return {
    count: notebooks.length,
    notebooks: notebooks.slice(0, 3).map(({ id, title, noteCount }) => ({ id, title, noteCount })),
  };
});

run("list_tags", () => {
  const tags = repository.listTags();
  return {
    count: tags.length,
    tags: tags.slice(0, 5).map(({ id, title }) => ({ id, title })),
  };
});

run("get_note (first recent note)", () => {
  const first = recentNotes?.notes[0];
  if (!first) {
    return { skipped: true, reason: "No notes exist in the UpNote database." };
  }
  const note = repository.getNote(first.id);
  return { id: note.id, title: note.title, contentLength: note.content.length };
});

if (failed) {
  process.exitCode = 1;
}
