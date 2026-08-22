---
name: upnote-url-note-organization
description: タグ未設定でURLだけを含むUpNoteノートを、元ノートを変更せず詳細要約ノートへ整理するときに使う。元ノートへのリンクと末尾の仕切り線を含め、未指定時は1件ずつ安全に作成する。
---

# UpNote URL-only ノート整理

このSkillは、このリポジトリで登録したローカルMCP `upnote-local` を使い、URL-onlyノートから新しい整理ノートを作るための手順である。SQLite DBは読み取り専用のまま扱い、ノート作成は `create_note` の `upnote://` URL Scheme 経由で行う。

## 対象の選定

- `list_recent_notes` または `search_notes` で候補を見つけ、必ず `get_note` で本文を確認する。
- 対象は、タグがなく、本文が1本の `http://` または `https://` URLだけであるノートに限定する。URLの前後の空白は無視してよい。
- 元ノートのID、URL、既存のタイトルを記録する。対象外のノートや複数URLのノートを推測で処理しない。
- 処理件数が未指定なら1件だけにする。ユーザーが複数件または件数を明示した場合は、その指定件数を処理してよい。

## 記事の取得と要約

- 記事はブラウザまたはHTTP取得で本文を確認する。Computer Useは使わない。
- 記事タイトルを新しいUpNoteノートのタイトルにする。`[詳細整理]` などの固定接頭辞は付けない。
- 原文を丸写しせず、見出し・論点・根拠・実務上の示唆を含む日本語の詳細要約にする。記事の言語に合わせる必要がある場合はユーザーの指示を優先する。
- 元記事URLを明記し、元のURL-onlyノートへ開けるリンクも含める。リンクURLは `upnote://x-callback-url/openNote?noteId=<元ノートID>` とする。

## 作成内容

`create_note` には `markdown: true` を指定し、本文を次の順に組み立てる。

```markdown
# <記事タイトル>

## 詳細要約

<詳細要約>

## 元記事

<記事URL>

## 元ノート

[元のURL-onlyノートを開く](upnote://x-callback-url/openNote?noteId=<元ノートID>)

---

## 元記事の全文（手動貼り付け欄）
```

- 本文は配列の `join()` の末尾要素に任せず、本文本体の後へ `"\n\n---\n\n## 元記事の全文（手動貼り付け欄）"` を直接連結して完成させる。この見出しの下へ、ユーザーが原文全文を手動で貼り付ける。Windows版UpNoteの `note/new` URL Scheme は末尾の空行を削除するため、表示上の空白に依存しない。
- 作成先に `Clipper > WebClipper` を指定するときは `notebook: "Clipper/WebClipper"` を使う。このPCのUpNote UIで、ユーザーがこの指定により子ノートブックへ作成されることを確認した。
- Windows版UpNote 9.21.0.0では、ノートブック所属は `notes.notebookLinks` や `organizers` ではなく、`lists.id = "notebooks_<notebookId>"` の `content` JSON配列に記録される。作成先をDBで確認する場合は、この配列にノートIDが含まれるかを読む。SQLiteへの書き込みはしない。
- 名前だけの `notebook: "WebClipper"` は同名のトップレベルノートブックを生成した実例がある。`notebook: "Clipper > WebClipper"` は同名のトップレベルノートブックを作成し、子ノートブックIDを直接渡す方式もID名のトップレベルノートブックを作成した。これらは使わない。

## 実行後の確認と停止条件

- `create_note` の後は、読み取り専用の一覧・検索・`get_note` で、タイトル、元記事URL、元ノートリンク、仕切り線後の空行を確認する。本文全体をログへ出力しない。末尾の空行が保存されなければ、重複ノートを作成して補正せず、そのノートを結果として報告する。
- DBへの直接INSERT・UPDATE・DELETEをしない。元ノートの更新、タグ変更、ノートブック移動、ゴミ箱移動も実行しない。
- 作成先ノートブックが確認できない、記事本文を取得できない、または候補がURL-onlyでない場合は、ノートを作らずに理由を報告する。
