# upnote-mcp-win

Windows上のUpNoteを検索し、**起動中のアプリをローカルCDP（Chrome DevTools Protocol）経由で編集するMCPサーバー**です。ノートIDを維持し、編集前バックアップ、アプリへの反映、新しい同期応答を確認します。長文は変更箇所だけを指定でき、未変更部分のHTMLを維持します。

[English](README.md) · [内部構成・代替編集方式](docs/architecture.md) · [検証範囲](docs/verification.md) · [公開手順](docs/releasing.md)

[bellx2/upnote-mcp](https://github.com/bellx2/upnote-mcp)を元にした、独立したWindows向けforkです。保守先は[ten9miq/upnote-mcp-win](https://github.com/ten9miq/upnote-mcp-win)。UpNoteとは提携・承認・保守の関係にありません。CDP編集は公開された公式APIではなく、非公開のアプリ内部処理を利用します。

## 名前・配布先

| 項目 | このfork |
| --- | --- |
| リポジトリ・問い合わせ | [ten9miq/upnote-mcp-win](https://github.com/ten9miq/upnote-mcp-win) / [Issues](https://github.com/ten9miq/upnote-mcp-win/issues) |
| npm用パッケージ名 | @ten9miq/upnote-mcp-win |
| 実行コマンド・バンドル名 | upnote-mcp-win |
| バージョン体系 | 元プロジェクトの0.2.xから独立した0.1.0 |

**現時点の導入手順はソースのcheckoutを使います。** パッケージ名・ビルド設定があることと、npmや配布バンドルが公開済みであることは別です。公開物の有無はこのリポジトリのリリースを確認してください。@bellx2/upnote-mcpを導入しても、このforkのCDP機能には切り替わりません。

## 他の実装との違い

比較は2026年11月14日に確認したリンク先READMEに基づきます。同名のすべてのMCP実装を対象にした比較ではありません。

| 実装 | 読み取り・新規作成 | 既存ノート編集 | 起動中のアプリ・同期 |
| --- | --- | --- | --- |
| [bellx2/upnote-mcp](https://github.com/bellx2/upnote-mcp#readme)（元プロジェクト） | SQLite読み取り専用・公式URLスキーム | 編集ツールの記載なし | 起動中の編集手順の記載なし |
| [bug-breeder/upnote-mcp](https://github.com/bug-breeder/upnote-mcp#readme)（設計の参考） | SQLite・URLスキーム | Python。SQLite直接編集で移動・削除・タグ変更・結合などにも対応 | 確実な編集にはアプリ終了が必要と記載。起動中の上書き許可オプションあり |
| **このfork** | SQLite読み取り専用・URLスキーム | Bun/TypeScript。CDPからアプリ内部の保存処理を呼び、文字列・節の部分編集にも対応 | 起動したまま保存し、本文・エディター・新しい同期応答を確認。DB直接編集の代替経路も保持 |

このforkは起動中の本文編集を重視しています。bug-breeder版の移動・削除・結合・タグ管理ツールをすべて移植したものではありません。

~~~mermaid
flowchart LR
  AI["MCPクライアント"] -->|stdio| MCP["upnote-mcp-win"]
  MCP -->|読み取り専用検索| DB[("ローカルSQLite")]
  MCP -->|編集前のノート単位バックアップ| Backup[("バックアップ")]
  MCP -->|ローカルCDP: 内部保存処理| App["起動中のUpNote"]
  App -->|保存| DB
  App -->|アプリ自身の同期処理| Cloud["UpNoteクラウド"]
  MCP -->|保存HTML・画面・同期情報の照合| App
~~~

CDP経路ではMCPがノート行や同期フラグを直接書き換えません。短時間のDB書き込み予約で版の確認とバックアップを行い、予約を解除してからアプリに保存を依頼します。アプリ自身の状態と同期処理を通すことで、DBだけを書き換えた場合のキャッシュ不整合を避けます。新規作成は引き続き公式URLスキームです。

## 動作条件

- Windows 10/11とUpNoteデスクトップ版。実機検証は **Windows・UpNote 9.22.9・Bun 1.4.0** で実施しました。[検証範囲](docs/verification.md)を参照してください。
- ソース版には[Bun](https://bun.sh) **1.4.0以上**が必要です。Markdown変換を含み、Node.jsだけでは実行できません。
- 以下の手順はGitとWindows PowerShellを使用します。
- 通常起動・自動起動用ランチャーは **Microsoft Store版**が対象です。別形式のインストールでは、一度きりの起動用スクリプトに実行ファイルを指定できますが、自動起動には対応しません。
- クラウド同期確認にはUpNoteへのログイン、ロック解除、ネットワーク接続が必要です。ローカル検索だけならCDPやオンライン接続は不要です。

元のmacOS向けDBパス・URL処理はソースに残っていますが、このforkのCDP方式とWindowsバンドルについてmacOS/Linuxでの動作確認はしていません。

## ソースから導入する

PowerShellで実行します。

~~~powershell
git clone https://github.com/ten9miq/upnote-mcp-win.git
Set-Location upnote-mcp-win
bun install --frozen-lockfile
bun run check
(Get-Command bun.exe).Source
~~~

checkoutは移動しない場所に置きます。MCP設定には、その絶対パスと上で表示されたbun.exeのパスを使います。DBの既定パスは%APPDATA%\UpNote\upnote.sqlite3です。別プロファイルなどを使う場合はUPNOTE_DBを指定してください。検索専用なら、次のCDP起動とCDP用の環境変数は不要です。

### 1. CDP付きでUpNoteを起動する

現在の内容を保存し、トレイのプロセスも含めて **UpNoteを通常終了**してから、checkout内で実行します。

~~~powershell
powershell.exe -NoProfile -File .\scripts\start-upnote-bridge.ps1
# Store版以外では、実際にインストールされたUpNote.exeを指定:
# powershell.exe -NoProfile -File .\scripts\start-upnote-bridge.ps1 -ExePath 'C:\path\to\UpNote.exe'
~~~

ランチャーは--remote-debugging-address=127.0.0.1と--remote-debugging-port=19330を付け、UpNoteとCDPの所有プロセスを検査して接続先を表示します。起動中のアプリは拒否し、強制終了・再起動はしません。通常の導入に管理者権限は不要です。実行ポリシーで止まる場合はスクリプトを確認し、組織の方針に沿って対応してください。この手順はシステム全体のポリシーを変更しません。

CDPはアプリを操作できる強い権限のデバッグ接続で、UpNoteが終了するまで有効です。MCPはループバックIPのHTTP接続だけを受け付けます。ネットワーク公開・プロキシ・トンネルで外部に転送しないでください。同じPCの他のプログラムも、このポートに接続できればアプリを操作できるため、信頼できるローカル環境で使用します。

### 2. MCPクライアントへ登録する

CursorやClaude Desktopなど、JSON形式のstdio設定を使うクライアントの例です。パスは自分の環境に置き換えます。

~~~json
{
  "mcpServers": {
    "upnote-mcp-win": {
      "command": "C:\\Users\\YOUR_NAME\\.bun\\bin\\bun.exe",
      "args": ["run", "C:\\path\\to\\upnote-mcp-win\\src\\index.ts"],
      "env": {
        "UPNOTE_DB": "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\UpNote\\upnote.sqlite3",
        "UPNOTE_CDP_URL": "http://127.0.0.1:19330"
      }
    }
  }
}
~~~

Codexでは同じコマンド・引数・環境変数をMCP用TOMLへ登録します。[Codex設定例](docs/architecture.md#codex-configuration)を参照してください。起動待ち30秒、ツール待ち90秒を設定すると、起動・ノートのバックアップ・同期待ちに余裕を持たせられます。設定変更・checkout更新後はMCPを再接続します。既存登録のキー名はそのままでも構いません。ツール名は変更していません。

最初にensure_upnote_connectionまたはget_upnote_bridge_statusを呼びます。DBパス・内部API・スキーマの互換性を確認します。ログインやロック解除の代行はしません。

### 3. 任意: 普段のショートカット・Windows自動起動でも使う

Store版では、常設ランチャーのテンプレートをコピーします。

~~~powershell
$helperDir = Join-Path $env:LOCALAPPDATA 'UpNoteMcp'
New-Item -ItemType Directory -Path $helperDir -Force | Out-Null
Copy-Item -LiteralPath .\scripts\start-upnote-default.ps1 -Destination (Join-Path $helperDir 'launch.ps1')
Copy-Item -LiteralPath .\scripts\upnote-default.vbs -Destination (Join-Path $helperDir 'launch.vbs')
~~~

wscript.exeを起動するWindowsショートカットを作り、引数を"C:\Users\YOUR_NAME\AppData\Local\UpNoteMcp\launch.vbs"とします。Windowsログイン時も起動する場合は、shell:startupで開いたフォルダーへショートカットを置き、引数の末尾に--backgroundを付けます。この例はポート19330を使います。

普段の起動先もこのランチャーに切り替えます。UpNote自身の自動起動がCDPなしで先に起動する場合は、アプリ設定で無効にしてください。元のStoreショートカットやタスクバーのピン留めは自動変更しません。ランチャーは毎回現在のStoreパッケージを解決し、バージョン付きの実行ファイルパスを固定しません。CDP付きで起動済みなら再利用し、CDPなしで起動済みなら通常終了を求めます。

配置後、MCPの環境変数へUPNOTE_AUTO_START=1を追加します。UPNOTE_AUTO_START_LAUNCHERで起動スクリプトの場所を変更でき、既定は%LOCALAPPDATA%\UpNoteMcp\launch.ps1です。以後、MCP起動時や内部API操作前に、終了しているUpNoteをバックグラウンドで準備します。複数クライアントの同時起動も調整します。自動で繰り返すのは接続・初期化確認だけで、編集命令は再送しません。

解除するには、スタートアップのショートカットを外し、普段のUpNote起動先を戻して、MCPのUPNOTE_AUTO_START・UPNOTE_CDP_URLを削除します。UpNoteを通常終了し、通常の方法で起動すればデバッグポートも閉じます。アプリ本体へのパッチは行いません。

## 長文を全文再送せず編集する

1. get_note_edit_contextにノートIDと必要なfind・sectionを指定し、版・サイズ・同期状態と必要な範囲だけを読みます。
2. patch_note_in_appへその版と変更指示だけを送ります。すべての変更は **同じ元の本文** を対象にし、重複する変更や曖昧な指定は拒否します。
3. dryRun=trueで事前確認できます。プレビューでは編集もバックアップも行いません。実際の編集時まで版が変わっていないことが必要です。

~~~json
{
  "id": "NOTE_ID",
  "expectedVersion": "VERSION_FROM_GET_NOTE_EDIT_CONTEXT",
  "operations": [
    { "type": "replace_text", "find": "古い表現", "replacement": "新しい表現" },
    { "type": "replace_section", "section": { "heading": "次の作業", "level": 2 },
      "content": "- **更新後の作業**", "contentFormat": "markdown" }
  ]
}
~~~

| 操作 | 動作 |
| --- | --- |
| replace_text | ブロック内の表示文字列を置換。インラインタグをまたげます。置換内容は通常文字列として扱い、最初に一致したテキストの書式を引き継ぎます。 |
| replace_section | 見出し自体を残し、次の同階層・上位階層の見出しまでの本文を変更。 |
| append_section | 節の既存HTMLを残して末尾へ追記。 |
| rename_heading | 本文内の見出し名だけを変更。タグ・属性を維持し、ノートタイトルは対象外。 |

同じ文字列が複数ある場合はoccurrence、またはall=trueと正確なexpectedMatchesを指定します（1操作あたり最大10000件）。見出しはheadingと必要に応じたlevel・occurrence、または一覧の1始まりのindexで指定します。未変更部分は元のHTMLから直接つなぎ、Markdownから作り直しません。ただしアプリ内部への保存は全文HTMLなので、MCPへの送信量を減らしてもUpNoteの容量上限は変わりません。

タイトル変更・本文全体の置換・末尾追記には、get_noteのversionを使ってupdate_note_in_appを呼びます。全文置換ではUpNote独自の装飾をすべて再現できる保証はありません。

## バックアップ・完了判定・制約

- **バックアップ:** 編集対象ノートのSQLite行全体（HTML・本文・保存済みの各項目）だけを `note.sqlite3` に保存し、一致・整合性を検査してフラッシュします。ほかのノート・別テーブル・外部の添付ファイル本体は含みません。既定はDB横の `MCP Backups/edit-…/note.sqlite3`、変更は `UPNOTE_BACKUPS_DIR` です。編集ごとの保存は続け、自動削除はしません。以前の全体バックアップも残ります。書き込み予約で他の保存が一時的に待つ場合があります。ノート単位の復旧資料であり、UpNoteのDBそのものと置き換えるファイルではありません。[形式・検証結果と復旧時の注意](docs/note-backups.md)を参照してください。
- **競合・互換性:** expectedVersionはノート行全体を照合します。DBとアプリの差、未保存入力、ロック、異なるプロファイル、別ノートウィンドウなどがあれば停止します。内部API・状態の型、必要列・型互換性、IDの一意性、実データを毎回確認し、アプリの版番号では固定しません。ただし名前・型が同じ将来の内部処理の意味までは保証できません。
- **完了:** state=syncedで保存本文・エディター・新しいアプリ同期応答が確認済みです。部分編集ではhtmlPreserved=trueも必要です。cloudSync=app_acknowledgedは **別端末での受信を独立に確認した意味ではありません**。オフライン・タイムアウト・結果不明時は未完了として、状態とバックアップを確認します。編集の自動再送やDB自動復元はしません。
- **容量:** [UpNote公式のHTML上限は約1MB](https://help.getupnote.com/resources/upnote-premium/premium-faqs)です。この実装は安全側に **UTF-8のHTML100万バイト**を上限とし、プレビューも超過時は拒否します。既存の超過ノートを読み、短くする操作は可能です。保存要求は30秒、同期確認は別の上限時間で待ちます。MCPの既定受信上限は変更していません。
- **書式・添付:** 文字列置換は段落・改行・保護オブジェクトの境界を越えません。タイトルや安全に区切れない節は保護します。画像・添付・保護オブジェクトを含む節の置換は拒否しますが、ほかの箇所の編集や追記で残せる場合があります。新しい添付の挿入には対応しません。新規本文のMarkdown・テキストはHTMLに変換して保存します。
- **その他:** 移動・削除・結合・タグ管理API、公式の公開クラウドAPI連携、同期時間の保証、将来の非公開APIの動作保証はありません。URLによる新規作成は送信のみで、確定した新規IDを返しません。検索は部分一致で、関連度付き全文検索ではありません。

高度な代替経路として、DB直接編集のupdate_noteと、クリップボード経由のprepare_app_note_edit・complete_app_note_editも残しています。[代替方式の説明](docs/architecture.md#fallback-workflows)を確認して使ってください。DBへの書き込み一致だけでは、画面反映や同期完了を意味しません。

## ツール一覧

| 用途 | ツール |
| --- | --- |
| 検索・読み取り | search_notes, list_recent_notes, list_notes_this_week, list_notes_this_month, find_notes, get_note, list_notebooks, list_tags, search_by_tag |
| URLによる表示・作成 | find_and_open_note, open_note, open_notebook, create_note |
| CDP接続 | ensure_upnote_connection, get_upnote_bridge_status |
| CDP編集 | update_note_in_app, get_note_edit_context, patch_note_in_app |
| 高度な代替方式 | update_note, prepare_app_note_edit, complete_app_note_edit |

## 開発・検証

~~~powershell
bun install --frozen-lockfile
bun run check
bun run test
bun run pack
# Windows用のコンパイル済みバンドル（MCPBパッカーのダウンロードが必要）:
bun run build:mcpb
~~~

自動テストは一時DBを使います。Bun 1.4.0/WindowsのVM・ネイティブクラッシュへの対処として、テストファイルごとにOSプロセスを分けます。通信試験にはプロセス一覧・ローカルポートへのアクセスが必要です。実機用スクリプトは専用テストノートと明示オプションが必要で、自動実行しません。[検証記録](docs/verification.md)では模擬試験と実機の同期応答を区別しています。

パッケージ内容・手動公開は[公開手順](docs/releasing.md)を参照してください。MCPBのローカルビルドと、Claude Desktopへ実際に導入できることは別の確認項目です。

## ライセンス・帰属

MIT。[LICENSE](LICENSE)に元のbellx2の著作権表示を保持しています。基盤はbellx2/upnote-mcp、DB直接編集の設計ではbug-breeder/upnote-mcpを参考にしました。このforkの問い合わせは[こちらのIssues](https://github.com/ten9miq/upnote-mcp-win/issues)へお願いします。元プロジェクトの作者がこのforkを保守するものではありません。
