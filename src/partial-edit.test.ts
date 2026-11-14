import { expect, test } from "bun:test";
import { planPartialEdit, noteEditContext, type PartialOperation } from "./partial-edit";
import { assertNoteHtmlSize } from "./editing";

const patch = (html: string, operations: PartialOperation[]) => planPartialEdit(html, "Title", operations).html;
test("literal edits preserve all markup, styles, attributes and untouched bytes across inline tags", () => {
  const html = '<h2>Title</h2><!--keep--><div data-custom="a>b"><span style="color:red">Hello <b>old</b> text</span></div><p><a href="https://example.com/old">link old</a></p>';
  expect(patch(html, [{ type: "replace_text", find: "Hello old", replacement: "New & <value>" }])).toBe(html.replace("Hello ", "New &amp; &lt;value&gt;").replace("old</b>", "</b>"));
  expect(patch(html, [{ type: "replace_text", find: "link old", replacement: "new label" }])).toBe(html.replace("link old", "new label"));
});

test("entities, non-semicolon references, emoji and CRLF map to exact source boundaries", () => {
  const html = '<h2>Title</h2><p>A &amp; B &#x1F600; &notit;</p><pre>first\r\nsecond</pre>';
  const result = patch(html, [{ type: "replace_text", find: "& B 😀", replacement: "replaced" }, { type: "replace_text", find: "¬it;", replacement: "entity" }, { type: "replace_text", find: "first\nsecond", replacement: "a\nb" }]);
  expect(result).toBe('<h2>Title</h2><p>A replaced entity</p><pre>a<br>b</pre>');
  expect(() => patch('<h2>Title</h2><p>&NotEqualTilde;</p>', [{ type: "replace_text", find: "≂", replacement: "x" }])).toThrow("splits");
  expect(() => patch('<h2>Title</h2><p>😀</p>', [{ type: "replace_text", find: "\ud83d", replacement: "x" }])).toThrow("well-formed");
});

test("ambiguous text requires an explicit occurrence or all with exact expected count", () => {
  const html = '<h2>Title</h2><p>old old</p><div>old</div>';
  expect(() => patch(html, [{ type: "replace_text", find: "old", replacement: "x" }])).toThrow("ambiguous");
  expect(patch(html, [{ type: "replace_text", find: "old", replacement: "x", occurrence: 2 }])).toBe(html.replace("old old", "old x"));
  expect(patch(html, [{ type: "replace_text", find: "old", replacement: "x", all: true, expectedMatches: 3 }])).toBe(html.replaceAll("old", "x"));
  expect(() => patch(html, [{ type: "replace_text", find: "old", replacement: "x", all: true }])).toThrow("expectedMatches");
  expect(() => patch(html, [{ type: "replace_text", find: "old", replacement: "x", all: true, expectedMatches: 2 }])).toThrow("count differs");
});

test("literal matching cannot edit titles, attributes, comments or protected object contents", () => {
  const html = '<h2>Title</h2><p title="secret">before<img src="secret"><a data-file-id="file">secret</a>after</p><!--secret--><script>secret</script>';
  for (const find of ["Title", "secret", "beforeafter"]) expect(() => patch(html, [{ type: "replace_text", find, replacement: "x" }])).toThrow();
  expect(patch(html, [{ type: "replace_text", find: "before", replacement: "new" }])).toBe(html.replace("before", "new"));
  expect(() => patch('<h2>Title</h2><p>a</p><p>b</p>', [{ type: "replace_text", find: "ab", replacement: "x" }])).toThrow();
});

test("section replacement retains its heading and stops before the next same/higher-level heading", () => {
  const html = '<h2>Title</h2><h2 style="color:red"><b>Section</b></h2><p>old</p><h3>Sub</h3><p>nested</p><h2>Keep</h2><div data-x="keep"><em>same</em></div>';
  const result = patch(html, [{ type: "replace_section", section: { heading: "Section" }, content: "**new**" }]);
  expect(result).toBe('<h2>Title</h2><h2 style="color:red"><b>Section</b></h2>\n<p><strong>new</strong></p>\n<h2>Keep</h2><div data-x="keep"><em>same</em></div>');
});

test("append and heading rename preserve existing section HTML and heading attributes", () => {
  const html = '<h2>Title</h2><div class="box"><h2 style="color:red"><b>Section</b></h2><p>old</p></div><h2>Keep</h2><p>tail</p>';
  const result = patch(html, [{ type: "append_section", section: { heading: "Section" }, content: "added", contentFormat: "text" }, { type: "rename_heading", section: { heading: "Section" }, heading: "Renamed & safe" }]);
  expect(result).toBe(html.replace("<b>Section</b>", "<b>Renamed &amp; safe</b>").replace("<p>old</p></div>", "<p>old</p>\n<p>added</p></div>"));
});

test("duplicate headings are selectable by level/occurrence or compact outline index", () => {
  const html = '<h2>Title</h2><h2>A</h2><p>first</p><h3>A</h3><p>nested</p><h2>A</h2><p>last</p>';
  expect(() => patch(html, [{ type: "replace_section", section: { heading: "A" }, content: "x" }])).toThrow("ambiguous");
  const byName = patch(html, [{ type: "replace_section", section: { heading: "A", level: 2, occurrence: 2 }, content: "new", contentFormat: "text" }]);
  const byIndex = patch(html, [{ type: "replace_section", section: { index: 3 }, content: "new", contentFormat: "text" }]);
  expect(byIndex).toBe(byName); expect(byName).toBe(html.replace("<p>last</p>", "\n<p>new</p>"));
});

test("unsafe section boundaries and deletion of attachment/protected objects are refused", () => {
  const cross = '<h2>Title</h2><h2>A</h2><p>x</p><div><h2>B</h2><p>y</p></div>';
  expect(() => patch(cross, [{ type: "replace_section", section: { heading: "A" }, content: "x" }])).toThrow("crosses");
  const image = '<h2>Title</h2><h2>A</h2><p>safe<img src="keep"></p><h2>B</h2><p>other</p>';
  expect(() => patch(image, [{ type: "replace_section", section: { heading: "A" }, content: "x" }])).toThrow("protected object");
  expect(patch(image, [{ type: "replace_section", section: { heading: "B" }, content: "new", contentFormat: "text" }])).toContain('<p>safe<img src="keep"></p>');
  expect(patch(image, [{ type: "append_section", section: { heading: "A" }, content: "new", contentFormat: "text" }])).toContain('<p>safe<img src="keep"></p>\n<p>new</p>');
});

test("all operations use the original snapshot and overlapping edits are rejected", () => {
  const html = '<h2>Title</h2><h2>A</h2><p>old</p>';
  expect(() => patch(html, [{ type: "replace_text", find: "old", replacement: "new" }, { type: "replace_text", find: "missing", replacement: "x" }])).toThrow();
  expect(patch(html, [{ type: "rename_heading", section: { heading: "A" }, heading: "B" }, { type: "replace_section", section: { heading: "A" }, content: "new", contentFormat: "text" }])).toBe('<h2>Title</h2><h2>B</h2>\n<p>new</p>');
  expect(() => patch(html, [{ type: "replace_text", find: "old", replacement: "new" }, { type: "replace_section", section: { heading: "A" }, content: "whole section" }])).toThrow("Overlapping");
  const nested = '<h2>Title</h2><h2>A</h2><h3>Sub</h3><p>nested</p><h2>Keep</h2><p>tail</p>';
  expect(patch(nested, [{ type: "replace_section", section: { index: 1 }, content: "new", contentFormat: "text" }, { type: "rename_heading", section: { index: 3 }, heading: "Renamed" }])).toBe('<h2>Title</h2><h2>A</h2>\n<p>new</p><h2>Renamed</h2><p>tail</p>');
});

test("compact context paginates outlines/search and truncates only the requested section", () => {
  const html = '<h2>Title</h2><h2>A</h2><p>old old</p><h2>B</h2><p>' + "long ".repeat(5000) + '</p>';
  const context = noteEditContext(html, "Title", { find: "old", limit: 1, offset: 1, section: { heading: "B" }, maxChars: 20 });
  expect(context.outline.total).toBe(2); expect(context.outline.headings).toHaveLength(1);
  expect(context.search.total).toBe(0); expect(context.section.content.length).toBe(20); expect(context.section.truncated).toBe(true);
  expect(JSON.stringify(context).length).toBeLessThan(1000);
  const search = noteEditContext(html, "Title", { find: "old", limit: 1, offset: 1 });
  expect(search.search.total).toBe(2); expect(search.search.matches[0].occurrence).toBe(2);
});

test("long HTML and many inline matches preserve untouched source without full-note output", () => {
  const prefix = '<h2>Title</h2><h2>A</h2><div class="keep">';
  const html = prefix + '<b>old</b><i>same</i>'.repeat(8000) + '</div><h2>B</h2><p>' + "日本語の長文 ".repeat(120_000) + '</p>';
  const result = planPartialEdit(html, "Title", [{ type: "replace_text", find: "old", replacement: "new", all: true, expectedMatches: 8000 }]);
  expect(result.html).toBe(html.replaceAll("<b>old</b>", "<b>new</b>"));
  const { html: _, ...summary } = result;
  expect(JSON.stringify(summary).length).toBeLessThan(500);
  expect(JSON.stringify(noteEditContext(html, "Title", { find: "old", limit: 2 })).length).toBeLessThan(2000);
});

test("cloud size preflight counts UTF-8 HTML bytes rather than JavaScript characters", () => {
  expect(assertNoteHtmlSize("あ".repeat(333_333))).toBe(999_999);
  expect(() => assertNoteHtmlSize("あ".repeat(333_334))).toThrow("cloud-sync safety ceiling");
});
