import { parseDocument } from "htmlparser2";
import { decodeHTML } from "entities";
import { HtmlEntityDecoder, DecodingMode } from "entities/decode";
import { htmlToPlainText, renderBody } from "./editing";

type Node = ReturnType<typeof parseDocument>["children"][number];
type Element = Extract<Node, { attribs: Record<string, string> }>;
const element = (node: Node): node is Element => "attribs" in node;
const blocks = new Set("address article aside blockquote div dl dt dd fieldset figure figcaption footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td th thead tr ul".split(" "));
const atomicTags = new Set("script style template textarea svg math img iframe object embed audio video input br hr".split(" "));
const normalizeHeading = (text: string) => text.replace(/\s+/gu, " ").trim();
const normalizeText = (raw: string) => decodeHTML(raw.replace(/\r\n?/g, "\n"));

export type HeadingSelector = { heading?: string; level?: number; occurrence?: number; index?: number };
export type PartialOperation =
  | { type: "replace_text"; find: string; replacement: string; occurrence?: number; all?: boolean; expectedMatches?: number; section?: HeadingSelector }
  | { type: "replace_section" | "append_section"; section: HeadingSelector; content: string; contentFormat?: "markdown" | "text" }
  | { type: "rename_heading"; section: HeadingSelector; heading: string };
export type ContextOptions = { find?: string; section?: HeadingSelector; sectionFormat?: "html" | "text"; maxChars?: number; offset?: number; limit?: number };
type Piece = { start: number; end: number; text: string; runStart: number };
type Run = { text: string; pieces: Piece[] };
type Match = { run: Run; start: number; end: number };
type Span = { start: number; end: number };
type Heading = Span & { node: Element; text: string; rawText: string; level: number; contentStart: number; contentEnd: number };
type Splice = Span & { value: string };

function checkedText(value: string, name: string, empty = false) {
  if (typeof value !== "string" || (!empty && !value) || !value.isWellFormed() || value.includes("\0")) throw new Error(`${name} must be ${empty ? "" : "non-empty "}well-formed text without NUL characters.`);
}
function protectedElement(node: Element): boolean {
  return atomicTags.has(node.name) || node.attribs.contenteditable?.toLowerCase() === "false" || Object.keys(node.attribs).some(key => /data-(?:non-editable|file-id|drawing-id|upnote-file)/i.test(key));
}
function spliced(source: string, edits: Splice[]): string {
  const ordered = edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: string[] = []; let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > source.length) throw new Error("Overlapping or invalid HTML edit ranges.");
    parts.push(source.slice(cursor, edit.start), edit.value); cursor = edit.end;
  }
  parts.push(source.slice(cursor)); return parts.join("");
}

/** Map only requested decoded-text boundaries, without allocating a map per character. */
function rawOffsets(raw: string, targets: number[]): Map<number, number> {
  const wanted = [...new Set(targets)].sort((a, b) => a - b);
  const mapped = new Map<number, number>(); let target = 0; let decoded = 0; let pos = 0; let entityText = "";
  const decoder = new HtmlEntityDecoder(cp => { entityText += String.fromCodePoint(cp); });
  while (true) {
    while (wanted[target] === decoded) { mapped.set(decoded, pos); target++; }
    if (target === wanted.length) break;
    if (pos >= raw.length) break;
    let size = 1; let width = 1;
    if (raw[pos] === "&") {
      entityText = ""; decoder.startEntity(DecodingMode.Legacy);
      let consumed = decoder.write(raw, pos + 1);
      if (consumed < 0) consumed = decoder.end();
      if (consumed > 0) { size = consumed; width = entityText.length; }
    }
    if (size === 1 && raw[pos] === "\r" && raw[pos + 1] === "\n") size = 2;
    else if (size === 1) { size = String.fromCodePoint(raw.codePointAt(pos)!).length; width = size; }
    if (wanted[target] !== undefined && wanted[target]! < decoded + width) throw new Error("A match splits a Unicode character or multi-character HTML entity; replace the whole character/entity.");
    pos += size; decoded += width;
  }
  if (mapped.size !== wanted.length) throw new Error("Cannot map the requested text safely to the original HTML.");
  return mapped;
}

class HtmlIndex {
  private document: ReturnType<typeof parseDocument>;
  readonly headings: Heading[] = [];
  readonly runs: Run[] = [];
  readonly protectedSpans: Span[] = [];
  readonly titleHeading: Heading | undefined;

  constructor(readonly html: string, title: string) {
    this.document = parseDocument(html, { decodeEntities: false, withStartIndices: true, withEndIndices: true });
    const texts: Piece[] = [];
    const discover = (node: Node, depth: number) => {
      if (depth > 256) throw new Error("HTML nesting is too deep for safe partial editing.");
      if (element(node)) {
        if (protectedElement(node)) {
          if (!["input", "br", "hr"].includes(node.name)) this.protectedSpans.push({ start: node.startIndex!, end: node.endIndex! + 1 });
          return;
        }
        if (/^h[1-6]$/.test(node.name)) {
          const bounds = this.bounds(node);
          const rawText = this.innerText(node).trim();
          this.headings.push({ ...bounds, node, level: Number(node.name[1]), rawText, text: normalizeHeading(rawText) });
        }
      } else if (node.type === "text") {
        const start = node.startIndex!; const end = node.endIndex! + 1;
        if (html.slice(start, end) !== node.data) throw new Error("The parser cannot locate a text node in the original HTML.");
        texts.push({ start, end, text: normalizeText(node.data), runStart: 0 });
      }
      if ("children" in node) for (const child of node.children) discover(child, depth + 1);
    };
    for (const node of this.document.children) discover(node, 0);
    const first = this.headings[0];
    this.titleHeading = first && first.text === normalizeHeading(title) && !texts.filter(piece => piece.start < first.start).some(piece => piece.text.trim()) ? first : undefined;
    let pieces: Piece[] = []; let chunks: string[] = []; let length = 0;
    const flush = () => { const text = chunks.join(""); if (text.trim()) this.runs.push({ text, pieces }); pieces = []; chunks = []; length = 0; };
    const visit = (node: Node) => {
      if (element(node) && (protectedElement(node) || node === this.titleHeading?.node)) { flush(); return; }
      const boundary = element(node) && blocks.has(node.name);
      if (boundary) flush();
      if (node.type === "text") {
        const text = normalizeText(node.data);
        pieces.push({ start: node.startIndex!, end: node.endIndex! + 1, text, runStart: length }); chunks.push(text); length += text.length;
      }
      if ("children" in node) for (const child of node.children) visit(child);
      if (boundary) flush();
    };
    for (const node of this.document.children) visit(node);
    flush();
  }

  private innerText(node: Node, depth = 0): string {
    if (depth > 256) throw new Error("HTML nesting is too deep for safe partial editing.");
    if (node.type === "text") return normalizeText(node.data);
    if (element(node) && protectedElement(node)) return "";
    return "children" in node ? node.children.map(child => this.innerText(child, depth + 1)).join("") : "";
  }
  private bounds(node: Element) {
    const start = node.startIndex!; const end = node.endIndex! + 1;
    let quote = ""; let contentStart = start + 1;
    for (; contentStart < end; contentStart++) {
      const char = this.html[contentStart]!;
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") { contentStart++; break; }
    }
    const contentEnd = this.html.lastIndexOf("</", end - 1);
    if (contentEnd < contentStart || !new RegExp(`^</${node.name}\\s*>$`, "i").test(this.html.slice(contentEnd, end))) throw new Error(`Partial editing requires an explicit, balanced closing tag for ${node.name}.`);
    return { start, end, contentStart, contentEnd };
  }
  outline() {
    const counts = new Map<string, number>();
    return this.headings.filter(heading => heading !== this.titleHeading).map((heading, index) => {
      const key = heading.level + ":" + heading.text; const occurrence = (counts.get(key) ?? 0) + 1; counts.set(key, occurrence);
      return { index: index + 1, heading: heading.text.slice(0, 500), headingTruncated: heading.text.length > 500, level: heading.level, occurrence };
    });
  }
  select(selector: HeadingSelector): Heading {
    if (selector.heading !== undefined) checkedText(selector.heading, "section.heading");
    if (selector.level !== undefined && (!Number.isInteger(selector.level) || selector.level < 1 || selector.level > 6)) throw new Error("Heading level must be 1..6.");
    if (selector.occurrence !== undefined && (!Number.isInteger(selector.occurrence) || selector.occurrence < 1)) throw new Error("Heading occurrence must be a positive integer.");
    const bodyHeadings = this.headings.filter(heading => heading !== this.titleHeading);
    if (selector.index !== undefined) {
      if (!Number.isSafeInteger(selector.index) || selector.index < 1 || selector.occurrence !== undefined) throw new Error("Use a positive heading index without occurrence.");
      const found = bodyHeadings[selector.index - 1];
      if (!found || (selector.heading !== undefined && found.text !== normalizeHeading(selector.heading)) || (selector.level !== undefined && selector.level !== found.level)) throw new Error("Heading index or expected heading does not match.");
      return found;
    }
    if (selector.heading === undefined) throw new Error("Provide section.heading or section.index.");
    const matches = bodyHeadings.filter(heading => heading.text === normalizeHeading(selector.heading!) && (selector.level === undefined || selector.level === heading.level));
    if (!matches.length) throw new Error("The requested body heading was not found; the note title cannot be edited by a partial operation.");
    if (matches.length > 1 && selector.occurrence === undefined) throw new Error(`Heading is ambiguous (${matches.length} matches); specify level and/or occurrence.`);
    const heading = matches[(selector.occurrence ?? 1) - 1];
    if (!heading) throw new Error("Heading occurrence is out of range.");
    return heading;
  }
  section(heading: Heading): Span {
    const parent = heading.node.parent!;
    if (element(parent) && !["div", "section", "article", "body"].includes(parent.name)) throw new Error("This nested heading is not in a supported flow container; its section cannot be safely replaced.");
    const end = parent.type === "root" ? this.html.length : this.bounds(parent as Element).contentEnd;
    const next = this.headings.find(candidate => candidate.start >= heading.end && candidate.start < end && candidate.level <= heading.level);
    if (next && next.node.parent !== parent) throw new Error("Section boundary crosses an HTML container; narrow the edit instead.");
    return { start: heading.end, end: next?.start ?? end };
  }
  *matches(find: string, scope?: Span): Generator<Match> {
    checkedText(find, "find");
    for (const run of this.runs) {
      if (scope && (run.pieces[0]!.start < scope.start || run.pieces.at(-1)!.end > scope.end)) continue;
      let offset = 0;
      while (offset <= run.text.length - find.length) {
        const start = run.text.indexOf(find, offset); if (start < 0) break;
        yield { run, start, end: start + find.length }; offset = start + find.length;
      }
    }
  }
  textSplices(matches: Match[], replacement: string): Splice[] {
    checkedText(replacement, "replacement", true);
    const escaped = Bun.escapeHTML(replacement).replace(/\r\n?|\n/g, "<br>");
    const changes = new Map<Piece, Array<{ start: number; end: number; value: string }>>();
    for (const match of matches) {
      let inserted = false;
      let low = 0; let high = match.run.pieces.length;
      while (low < high) { const mid = (low + high) >>> 1; const piece = match.run.pieces[mid]!; if (piece.runStart + piece.text.length <= match.start) low = mid + 1; else high = mid; }
      for (let i = low; i < match.run.pieces.length; i++) {
        const piece = match.run.pieces[i]!;
        if (piece.runStart >= match.end) break;
        const start = Math.max(match.start, piece.runStart); const end = Math.min(match.end, piece.runStart + piece.text.length);
        if (start >= end) continue;
        const edits = changes.get(piece) ?? []; edits.push({ start: start - piece.runStart, end: end - piece.runStart, value: inserted ? "" : escaped }); changes.set(piece, edits); inserted = true;
      }
    }
    const edits: Splice[] = [];
    for (const [piece, changesHere] of changes) {
      const mapping = rawOffsets(this.html.slice(piece.start, piece.end), changesHere.flatMap(change => [change.start, change.end]));
      for (const change of changesHere) edits.push({ start: piece.start + mapping.get(change.start)!, end: piece.start + mapping.get(change.end)!, value: change.value });
    }
    return edits;
  }
}

export function planPartialEdit(html: string, title: string, operations: PartialOperation[]) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 100) throw new Error("Provide 1..100 partial operations.");
  const changes: Array<{ type: string; matches: number; target: string; htmlCharsBefore: number; htmlCharsAfter: number }> = [];
  const originalLength = html.length;
  const index = new HtmlIndex(html, title);
  if (!index.titleHeading) throw new Error("The leading title heading is not recognized; partial editing is refused to preserve the title.");
  const allEdits: Splice[] = [];
  for (const operation of operations) {
    let edits: Splice[];
    let count = 1; let target = "";
    if (operation.type === "replace_text") {
      if (operation.all && operation.occurrence !== undefined) throw new Error("Use all or occurrence, not both.");
      if (operation.all && operation.expectedMatches === undefined) throw new Error("Replacing all matches requires expectedMatches.");
      for (const value of [operation.expectedMatches, operation.occurrence]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Match counts and occurrences must be positive integers.");
      const scope = operation.section ? index.section(index.select(operation.section)) : undefined;
      const selected: Match[] = []; count = 0;
      for (const match of index.matches(operation.find, scope)) {
        count++;
        if (operation.all || count === (operation.occurrence ?? 1)) selected.push(match);
        if (selected.length > 10_000) throw new Error("Too many replacements; narrow the section or split the edit.");
      }
      if (!count || (operation.expectedMatches !== undefined && operation.expectedMatches !== count)) throw new Error(`Text match count differs: found ${count}, expected ${operation.expectedMatches ?? "at least one"}.`);
      if (!operation.all && operation.occurrence === undefined && count !== 1) throw new Error(`Text is ambiguous (${count} matches); specify occurrence or all with expectedMatches.`);
      if (!selected.length) throw new Error("Text occurrence is out of range.");
      edits = index.textSplices(selected, operation.replacement); count = selected.length; target = operation.find.slice(0, 80);
    } else {
      const heading = index.select(operation.section); target = heading.text.slice(0, 80);
      if (operation.type === "rename_heading") {
        checkedText(operation.heading, "heading");
        if (/[\r\n]/.test(operation.heading)) throw new Error("New heading must be a single line.");
        const matches = [...index.matches(heading.rawText, { start: heading.contentStart, end: heading.contentEnd })];
        if (matches.length !== 1) throw new Error("Heading text cannot be mapped safely; use a more specific text edit.");
        edits = index.textSplices(matches, operation.heading);
      } else if (operation.type === "replace_section" || operation.type === "append_section") {
        checkedText(operation.content, "content", operation.type === "replace_section");
        if (operation.type === "append_section" && !operation.content.trim()) throw new Error("Append requires non-empty section content.");
        const section = index.section(heading);
        if (operation.type === "replace_section" && index.protectedSpans.some(span => span.start < section.end && span.end > section.start)) throw new Error("The target section contains an image, attachment or protected object; use a text edit or append instead.");
        const content = renderBody(operation.content, operation.contentFormat ?? "markdown");
        edits = [{ start: operation.type === "replace_section" ? section.start : section.end, end: section.end, value: content ? "\n" + content : "" }];
      } else throw new Error("Unsupported partial operation.");
    }
    allEdits.push(...edits);
    const delta = edits.reduce((sum, edit) => sum + edit.value.length - (edit.end - edit.start), 0);
    changes.push({ type: operation.type, matches: count, target, htmlCharsBefore: originalLength, htmlCharsAfter: originalLength + delta });
  }
  html = spliced(html, allEdits);
  return { html, changes, htmlCharsBefore: originalLength, htmlCharsAfter: html.length };
}

export function noteEditContext(html: string, title: string, options: ContextOptions = {}) {
  const index = new HtmlIndex(html, title);
  const limit = Math.min(100, Math.max(1, options.limit ?? 20)); const offset = Math.max(0, options.offset ?? 0);
  const outline = index.outline();
  const result: any = { partialEditingSupported: !!index.titleHeading, outline: { total: outline.length, offset, headings: outline.slice(offset, offset + limit) } };
  const section = options.section ? index.section(index.select(options.section)) : undefined;
  if (options.find !== undefined) {
    let total = 0; const matches: Array<{ occurrence: number; before: string; match: string; after: string }> = [];
    for (const match of index.matches(options.find, section)) {
      total++;
      if (matches.length < limit && total > offset) matches.push({ occurrence: total, before: match.run.text.slice(Math.max(0, match.start - 60), match.start), match: options.find.slice(0, 200), after: match.run.text.slice(match.end, match.end + 60) });
    }
    result.search = { total, matches };
  }
  if (section) {
    const content = options.sectionFormat === "html" ? html.slice(section.start, section.end) : htmlToPlainText(html.slice(section.start, section.end));
    const max = Math.min(64_000, Math.max(1, options.maxChars ?? 8000));
    result.section = { selector: options.section, format: options.sectionFormat ?? "text", content: content.slice(0, max), totalChars: content.length, truncated: content.length > max };
  }
  return result;
}
