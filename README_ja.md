# upnote-mcp

`UpNote` のローカルSQLiteを読み取り、MCP経由でノート検索と本文取得を行う `stdio` サーバーです。

これは非公式プロジェクトであり、UpNote とは提携・承認・保守の関係にありません。

## 機能

- `search_notes`: タイトル・本文・要約からノートを検索
- `get_note`: ノートIDを指定して本文を取得

検索・取得は読み取り専用です。このWindows forkでは、既存のノートIDを維持して本文の置換・追記・タイトル変更を行う `update_note` も利用できます。公開npmパッケージではなく、このローカルcheckoutで利用する機能です。

## 既存ノートの編集

**起動中の編集には、後述のMCP単独の内部API方式、またはComputer Use併用方式を使ってください。** `update_note` のDB直接編集だけでは、UpNoteのキャッシュや同期キューが更新されません。

1. `get_note` で内容と `version` を取得します。
2. `update_note` に `id`、取得した `version` を `expectedVersion` として渡し、`title` または `content` を指定します。`dryRun: true` で変更後のHTML・テキストを確認できます。プレビューでは書き込みもバックアップも行いません。
3. 通常はUpNoteを完全終了してから編集します。終了・同期でversionが変わった場合は、再取得して内容を確認します。
4. 編集後にUpNoteを開き、表示と他端末への同期を確認します。

`content` はタイトルを除いた本文です。形式は `contentFormat: "markdown"`（既定、Bun 1.4以上が必要）または `"text"`。`mode: "replace"`（既定）で本文置換、`mode: "append"` で既存HTMLを残して追記します。タイトルだけを変更する場合は、先頭のタイトル見出しが認識できるノートが対象です。

実際の編集前に書き込み予約を取得し、versionを再確認した対象ノートの行全体を `note.sqlite3` へ保存します。本文・HTML・各項目と参照情報を保持し、別のノートやテーブルは含めません。確定済みWALの変更も通常の読み取りに含まれます。バックアップを開き直して行の一致・整合性を検査し、ディスクへのフラッシュが成功してから編集します。バックアップ失敗時は編集しません。保存先はDB横の `MCP Backups/edit-…/note.sqlite3`、変更は `UPNOTE_BACKUPS_DIR` です。書き込み予約中は他のDB保存が一時的に待つ場合があります。

バックアップは編集ごとに別に保存され、自動削除しません。この変更で以前の全体バックアップを自動削除・変換することもありません。外部の画像・添付ファイル本体、別テーブルのノートブック・タグ定義や所属一覧、クラウド上の状態は含みません。**ノート単位の復旧資料であり、UpNoteのDBそのものと置き換えないでください。** 自動復元は行いません。[形式・検証結果と復旧時の注意](docs/note-backups.md)を参照してください。

画像・添付があるノートの本文置換と、新しい画像の追加には対応しません。既存本文を残す追記は可能です。ノートブック所属、タグ、リンク索引、添付情報、共有、ピン、ブックマークは更新しません。これらの管理はUpNote側で行ってください。Markdown置換では対応外の装飾が失われる可能性があります。

### UpNote起動中の編集（実験的）

個々の呼び出しで `allowWhileRunning: true` を指定すると、起動中も書き込めます。対象ノートが同期済み（`synced=1`）で、取得後の変更がないことが条件です。プロセス確認に失敗した場合は書き込みを拒否します。

**SQLiteのロックでは、UpNoteがメモリに保持している古い本文による後からの上書きを防げません。** 対象ノートをUpNote側で同時編集しないでください。別ウィンドウで開いている場合も同様です。書き込み後2秒間のDB再読み取りで上書きを検出した場合は `databaseVerification: "conflict"` を返します。その場合も `committed: true` なので、自動再試行せず、バックアップと現在の内容を確認してください。2秒より後の上書きは検出できません。DB内容が一致しても、アプリ表示やクラウド同期の完了は保証しません。

結果には `backupPath`、`committed`、`databaseVerification`、`cloudSync: "unverified"` を含みます。安定性を優先する場合は終了中に編集してください。確実な起動中編集には、アプリ内部の正式な編集APIか、アプリのエディターを操作する方式が必要です。サーバーによるUpNoteの強制終了・停止・再起動は行いません。

設計の参考: [bug-breeder/upnote-mcp](https://github.com/bug-breeder/upnote-mcp)。SQLite書き込みの起動中制限だけを解除しても、キャッシュの問題は解決しません。

### Windows実機確認（2026年11月14日）

UpNote 9.22.9で専用テストノートを作成し、新しく起動したMCPサーバー経由で起動中編集を実施しました。

- IDと作成日時は維持されました。編集前の自動バックアップは元のノート行全体と一致し、`integrity_check` は `ok` でした。
- 編集後約170秒時点でも、DBには変更後の本文が保持されていました。
- 開いたままのエディターは即時更新されませんでした。表示を切り替えてノートを再表示した後、アプリを終了せずに変更後の見出し・本文を画面で確認できました。
- 新しい別ウィンドウは当初古い本文を表示し、一覧プレビューも古いままでした。
- 最終確認時もDBの `synced=0` でした。クラウド・他端末への反映は確認できていません。

したがって、ローカルDBの更新と条件付きの本文再表示は実機確認済みですが、即時表示更新・同期完了を保証する機能ではありません。

`scripts/live-edit-check.ts` は通常の自動テストから分離した実機用スクリプトです。明示的な実行オプションに加え、専用のタイトル接頭辞 `MCP実機テスト `、本文の `BEFORE-LIVE-EDIT`、UpNote起動中・対象ノート同期済みを確認してから編集し、検証結果JSONと自動バックアップを残します。実行方法は英語READMEを参照してください。

### MCPだけで内部APIを直接呼ぶ編集（Windows）

`update_note_in_app` はローカルCDP接続からUpNote内部の `coreStore.updateNotes()` を呼び、メモリ上のノート・保存・同期キュー・エディターを更新します。Computer Use、キー入力、クリップボードは使いません。MCPからノート行や同期フラグを直接書き換えません。編集前の検査済みバックアップは必須です。

通常起動中のUpNoteには接続口がないため、**初回だけ通常終了して接続オプション付きで起動し直す必要があります**。次のランチャーは起動中のアプリがあれば停止し、強制終了や未保存入力の破棄は行いません。

```powershell
# 編集を保存してUpNoteを通常終了してから実行
powershell.exe -NoProfile -File .\scripts\start-upnote-bridge.ps1
```

既存のローカルMCP設定の環境変数へ `UPNOTE_CDP_URL=http://127.0.0.1:19330` を追加し、MCPに再接続します。`UPNOTE_DB` はアプリと同じDBを指す必要があります。以後の編集ではアプリの再起動は不要です。ポート変更はランチャーの `-Port`、Store版以外の配置は `-ExePath` で指定できます。

#### 普段のショートカット・Windows自動起動

2026年11月14日、ユーザーの指定により、デスクトップの **UpNote** とスタートメニューの **UpNote (MCP)** からCDP付きで開く設定を追加しました。既存のスタートアップ用ショートカットも同じ起動経路へ変更しています。Windowsログイン時はバックグラウンド起動し、通常用ショートカットでは既に起動しているUpNoteを表示します。

実体は `%LOCALAPPDATA%\UpNoteMcp\launch.vbs` と `launch.ps1` です。起動のたびに現在のStore版を解決するため、更新で `WindowsApps` 内のバージョン付きフォルダーが変わっても追従します。コンソール画面は表示しません。ソースは `scripts/upnote-default.vbs` と `scripts/start-upnote-default.ps1` にあります。

自動起動はWindowsのスタートアップショートカットへ一本化し、UpNote内蔵の自動起動はオフ、存在しない旧版を指す `electron.app.UpNote` のRun登録は除去しました。Windowsが自動生成するStore版のアプリ項目自体は変更していないため、スタートメニューでは **UpNote (MCP)** を選んでください。変更対象になるUpNoteのタスクバーピン留めはありませんでした。

元のショートカット・Run値・アプリ内蔵の自動起動フラグは `%LOCALAPPDATA%\UpNoteMcp\backups` の `before.json` とバックアップファイルに保存しています。現在の配置と検証結果は同じフォルダーの `installation.json`、起動ログは `launch.jsonl` に記録します。未保存入力・未同期ノートがないことを確認して通常終了し、スタートアップと同じショートカットからCDP付きで起動すること、その後のデスクトップ／スタートメニュー起動で既存プロセスを再利用することを実機確認しました。Windowsのログオフ・再ログイン自体は行っていません。

CDPはアプリと同じ権限を持ち、このポートへ接続できる他のローカルプロセスもアプリを操作できます。認証付きの公式アプリAPIではありません。ランチャーはlocalhost限定で起動し、取得できるOS待受情報を確認したうえで、CDPの `SystemInfo.getProcessInfo` によって起動したブラウザPIDと一致するか検査します。Windowsの待受一覧にこのポートが現れない環境では、その制約を表示し、PID照合を必須にします。外部公開・ポート転送はしないでください。接続口はUpNoteを終了するまで有効で、通常起動へ戻せば無効になります。別のアプリ起動時にもこの機能を使う場合はランチャーから起動してください。アプリ本体や自動起動設定の書き換えは行いません。

利用手順:

1. `get_upnote_bridge_status` と `get_note` で接続状態と最新の `version` を確認します。
2. `update_note_in_app` に `id`、`expectedVersion`、`title` / `content` を渡します。`contentFormat`、`mode`、`dryRun` も利用できます。`waitMs` は既定20秒、最大30秒です。
3. `state: "synced"` のときだけ、本文の一致・エディターDOMへの反映・今回の編集以後の同期応答を確認済みとします。他端末受信は別確認です。未完了・結果不明の場合はID付きの `get_upnote_bridge_status` で確認し、変更を自動再送しないでください。`get_note` の `sync` にも同期フラグ・同期時刻・revisionを返します。

**バージョン番号による制限はありません。内部APIとDB構造の互換性で判定します。** アプリの版番号とSQLiteのスキーマ番号は診断用に表示するだけです。必要な保存・画面選択・読み取りAPI、ロック／未保存状態のboolean型、ナビゲーション状態、ロックされたノートIDの集合、接続先DBを毎回確認します。状態が取得できない場合は「ロックされていない」とは扱わず停止します。対象ノートの実データについても、時刻・revision・同期フラグ・添付IDなどの型をDB側とアプリ側の両方で確認します。互換性がある同期関数／Promiseを返す関数の両方を扱い、画面選択後も編集条件を再確認します。

DBは、必要な `notes` 列と互換性のある文字列／数値型、ノートIDの一意性が維持されていれば利用できます。追加列や列順の変更、`VARCHAR` と `TEXT`、`INTEGER` と `DOUBLE` などの互換な型宣言、スキーマ番号の変更は許容します。必要列の欠落、扱えない型、必要列の生成列化、IDの一意性喪失、実データの型不整合はバックアップ・編集前に拒否します。スキーマは各呼び出し時とバックアップ直前に確認し、以前の成功結果を固定的に再利用しません。`get_upnote_bridge_status` と編集結果の `compatibility` に診断結果を返します。

従来のDBパス・アプリ／ノートのロック・ワークスペース・取得後の変更・メモリ状態の照合も維持しています。未保存入力や別ノートウィンドウがある場合は拒否します。画像・添付のある本文置換は対象外で、追記は既存本文を維持します。応答消失で適用結果が不明な場合は `applied: null` とバックアップ先を返します。名前や型が同じまま内部処理の意味が変わる更新までは事前検査だけでは保証できないため、編集前バックアップと、保存後の本文・画面・新しい同期応答の確認も引き続き必須です。失敗時の自動再送・自動復元は行いません。

2026年11月14日、まず未ログインの隔離プロファイルでバックアップ・ID維持・即時表示をMCP経由で確認しました。隔離試験は `awaiting_sync` / `unverified` を返し、同期完了とは扱っていません。

続いて、通常利用中のログイン済みUpNote 9.22.9を通常終了し、接続付きで起動して専用テストノートを検証しました。`update_note_in_app` のMCP呼び出しだけで、ID・作成日時を維持して本文と一覧プレビューが即時更新され、`state: "synced"` / `cloudSync: "app_acknowledged"` を確認しました。19:29:06.918の保存に対して19:29:10.544に新しい同期応答が記録され、所要時間は3.626秒でした。編集前バックアップは元のノート行と一致し、`integrity_check` は `ok`。日本語の見出し・太字・箇条書きもエディターDOMで確認しました。Computer Use、キー入力、クリップボード、ノート行や同期フラグの直接変更は使っていません。他端末での受信は未確認です。

互換性判定への変更後も同じ実機・専用ノートで再確認し、バックアップ・ID維持・画面更新と4.420秒後の新しい同期応答を確認しました。9.22.10や10.0.0などの将来の版番号でも、APIが同じなら許可することは模擬環境で検証しています。将来のUpNote本体を実際にインストールした試験ではありません。API欠落、状態・戻り値の型変更、DB非互換、処理中のスキーマ変更などを拒否するテストも追加しました。

`scripts/test-native-bridge.ts` は専用の `.cache/upnote-cdp-probe` だけを使う手動統合試験で、ログイン済みプロファイルは拒否します。通常の `bun test` では起動しません。

ログイン済み環境用の `scripts/live-native-edit-check.ts` は、`MCP実機テスト ` で始まる専用テストノートと明示的な実行オプションを要求し、MCP編集・バックアップ・DOM・同期応答の結果をJSONへ保存します。通常ノートには実行しないでください。`scripts/verify-upnote-cdp-owner.ts` はノート内容を読まずに接続先ブラウザPIDを照合します。

### 長文ノートの部分編集

`get_note_edit_context` で版番号・サイズ・同期状態・見出し一覧・検索箇所の前後・指定した節だけを取得し、`patch_note_in_app` へ変更指示を渡します。AIからノート全文を再送する必要はありません。サーバーが元のHTMLの位置に差分を適用し、アプリへの保存だけは全文更新します。未変更部分をMarkdown化・再シリアライズしないため、元のタグ・属性・書式を維持します。

対応操作:

- `replace_text`: 表示文字列の部分置換。太字などのインラインタグをまたぐ一致にも対応し、新しい文字は先頭の一致箇所の書式を引き継ぎます。置換文字列はHTMLとして解釈しません。段落・改行タグ・保護オブジェクトをまたぐ一致や、リンク先などの属性変更は対象外です。
- `replace_section`: 指定見出しの本文を、次の同じ階層以上の見出しまで置換します。下位の見出しも本文に含み、対象見出し自身のタグは残します。新しい本文はMarkdownまたはプレーンテキストです。
- `append_section`: 節末尾へ追記し、既存の節のHTMLを残します。
- `rename_heading`: 本文中の見出し名を変更します。ノートタイトルは対象外です。

最初に `get_note_edit_context` の `version` を取得し、`expectedVersion` として渡します。

```json
{
  "id": "既存ノートID",
  "expectedVersion": "get_note_edit_contextで取得したversion",
  "dryRun": true,
  "operations": [
    { "type": "replace_text", "find": "変更前の文言", "replacement": "変更後の文言", "expectedMatches": 1 },
    { "type": "replace_section", "section": { "heading": "次の作業", "level": 2 }, "content": "- 原稿を確認\n- 結果を送る", "contentFormat": "markdown" }
  ]
}
```

1回に1～100操作を渡せます。すべて**同じ元の版**を基準に位置を決め、重複する変更範囲は拒否します。途中の節削除で見出し番号がずれ、別の節を編集することを防ぎます。見出し名変更とその本文変更を組み合わせる場合も、両方とも元の見出し名を指定します。プレビュー後、同じ版のうちに `dryRun: false` で適用します。1バッチにつき1回のバックアップと保存を行い、変更件数・新しいversion・同期状態・バックアップ先だけを返します。

文字列が複数一致する場合は `occurrence` を明示するか、`all: true` と正確な `expectedMatches` を指定してください。見出しは名前と必要なら `level` / `occurrence`、または一覧の `index` で選択します。曖昧な対象は編集しません。標準の先頭タイトル見出しが認識できないノートや、HTMLコンテナーを不正にまたぐ節境界は拒否します。

画像・添付がノート内の別の箇所にあっても、その外側の文字列編集や節変更は可能です。ただし、画像・添付・保護オブジェクトを含む節全体の置換は拒否します。タグ、属性、コメント、保護された添付ラベル内などは文字列検索の対象外です。リンクの表示文字列を変えてもリンク先URLは変えません。対象の一部分だけを変えたい場合は、節全体の置換ではなく文字列置換を選んでください。

`get_note_edit_context` の一覧・検索は `limit`（既定20、最大100）と `offset` でページ送りできます。節本文は既定8000文字、`maxChars` 最大64000文字までで、`truncated` が付く場合は全文ではありません。途中で切れた抜粋を、その節の全文として再送しないでください。長すぎる見出し名は一覧で省略するため、その場合は `index` を使います。

バックアップ・全行versionの競合検知・内部API/DB互換性・未保存入力保護・画面反映・新しい同期応答は従来の内部API保存処理を共有します。部分編集では、保存後のHTMLが計画どおりかも完全一致で検査します。`htmlPreserved: true` と `state: "synced"` の両方が確認できた場合に成功とします。アプリによる予期しないHTML書き換えは、適用済みでも `conflict` にします。失敗時は小さなコンテキスト取得で状態を確認し、自動再送・DBの自動復元は行いません。他端末での受信は別確認です。

#### UpNote側の上限と長文の実機確認

[公式FAQ](https://help.getupnote.com/resources/upnote-premium/premium-faqs)では、HTML本文は約1MBが上限で、それ以上はFirebaseへ保存できないとされています。この実装は安全側に **HTMLのUTF-8サイズ100万バイト**を上限として、超過する保存・プレビューをバックアップ前に拒否します。文字数とは異なります。既に上限を超えたノートでも、読み取りや、節を短くして上限内に戻す操作は可能です。MCPの既定10MiB受信枠は変更していません。アプリへの保存要求は長文向けに30秒待ち、同期確認は別の上限時間で行います。

UpNote 9.22.9の専用ノートで、本文 **154407文字**、HTML 177050文字／465514バイトを検証しました。文字列と節をまとめた変更指示は389バイト、返却は3883バイトでした。未変更範囲のHTML一致、強調・太字・表の維持、ID・作成日時、バックアップ一致と整合性、古いversionの拒否を確認し、15.177秒後に新しい同期応答を得ました。最初の1088312バイトのテストノートは上限超過で同期せず、同じIDのまま節を短くして同期可能な状態へ修復しました。通常ノートは変更していません。

自動テストでは、多メガバイトHTML・8000件置換・HTML文字参照・絵文字・CRLF・曖昧な対象・重複変更・見出し番号のずれ・添付保護・バックアップ失敗・保存HTMLの不一致を検証しています。6MiBの一時ノートはMCPから小さく読み取れても保存は拒否し、80万バイト程度の一時ノートでは変更プレビューが小さく返ることを確認しました。この通信試験は模擬アプリを使い、UpNoteの上限を超えたクラウド同期を確認したものではありません。実機用スクリプト `scripts/live-partial-edit-check.ts` は専用ノート作成の明示オプションを必要とします。

### Codexから使うときの自動接続準備

常設ランチャーを使い、Codexの既存MCP設定で `UPNOTE_AUTO_START=1` を有効にしました。接続先は従来の `UPNOTE_CDP_URL`、起動用ファイルは `UPNOTE_AUTO_START_LAUNCHER` で指定します。未指定時は `%LOCALAPPDATA%\UpNoteMcp\launch.ps1` を使用します。

MCPはツールをすぐ公開してから、UpNoteの準備をバックグラウンドで開始します。UpNoteが終了していればCDP付きで起動し、内部のデータ読込みまで待ちます。`ensure_upnote_connection` で明示的な接続確認ができ、内部APIを使う操作も編集命令を送る前に接続を準備します。通信先は毎回取得するため、アプリ再起動後に古いWebSocketを使い続けません。

同一MCP内では起動処理を共有し、別チャットなどの複数MCP間ではWindowsのユーザー単位の起動ロックで二重起動を防ぎます。接続準備に失敗してもMCPは停止しません。DBも必要時に開くため、一時的にDBが見つからなくても後の要求で再確認できます。ローカルDBの検索・読み取りはアプリ側の準備とは別に利用できます。

自動で繰り返すのは接続・初期化の確認だけで、編集命令は自動再送しません。非互換API・別DB・ロック・別ノートウィンドウ・未保存編集などの保護も維持します。CDPなしで既に起動しているUpNoteは、未保存内容を保存して通常終了する必要があります。強制終了、ログイン・ロック解除の代行は行いません。PCやネットワークが使えない状態まで接続・同期を保証する機能ではありません。

現在のCodex登録ではMCP起動待ち30秒、ツール待ち90秒を設定しています。既に起動中のCodexへコード・設定を反映する際は今回だけMCP再接続が必要です。以後、通常の終了状態から使うたびに手動でランチャーを開く必要はありません。

保存済みのCodex登録そのものを使って実機検証しました。未保存入力・未同期ノートがないことを確認して通常終了後、2つのMCPを同時接続するとUpNoteが自動起動し、両方が接続準備完了になりました。本体プロセスは1つで、さらに別のMCP再接続と既存テストノートの読取りも成功しました。MCPの初期応答は約0.14～0.20秒で、アプリの準備待ちは非同期で進みました。この検証でノート編集は行っていません。

`scripts/verify-codex-connection.ts` は保存済み登録を検証し、結果をJSONへ保存します。自動テストでも、再度のアプリ終了からの復帰、同時起動、初期化待ち、一時的なDB欠落、結果不明の編集を再送しないことを確認しています。

### アプリ経由の編集（Windows・Computer Use併用、代替手段）

DBを直接書き換える代わりに、UpNoteのエディターへHTMLを貼り付け、アプリ自身の保存・同期処理を使います。**MCPだけでは画面入力まで自動実行できません。Computer Useなどの画面操作クライアントが必要です。**

1. `get_note` の最新 `version` を使って `prepare_app_note_edit` を呼びます。引数は `id`、`expectedVersion`、`title` / `content`、必要なら `contentFormat` / `mode` です。UpNote起動中・対象ノート同期済みが条件です。検査済みの編集前バックアップを作成し、日本語対応のHTML・テキストをクリップボードへ準備します。この段階でUpNoteのDB行は変更しません。
2. 画面操作クライアントが返却URLで対象ノートを開き、IDとタイトルを照合します。編集欄をクリックしてフォーカスと選択範囲を確認し、内容全体を選択してCtrl+Vで適用します。タイトルも貼り付けデータに含みます。新しいノートへの置換は行いません。
3. アプリの表示を確認し、返却された `ticket` で `complete_app_note_edit` を呼びます。確認待ちは既定15秒、1回最大30秒です。`awaiting_edit` / `awaiting_sync` は未完了であり、貼り付けを繰り返さず確認だけを再実行します。

`state: "synced"` は、ID・作成日時の維持、正規化したタイトルと本文の一致、`synced=1`、今回の編集以後の新しい `syncedAt` を確認した状態です。`cloudSync: "app_acknowledged"`、`otherDeviceVerified: false` を返します。これはUpNoteによるサーバー同期の応答記録に基づく確認で、他端末での受信は別途確認が必要です。装飾は画面でも検査してください。この経路でMCPが同期フラグを直接変更することはありません。

チケットは同じMCPプロセス内で10分間有効です。準備から完了までサーバーを再起動しないでください。Windowsのクリップボードは上書きされます。画面が表示され操作可能であることが必要です。別ウィンドウでの同時編集は避けてください。DBのversionでは未保存の画面入力は検出できません。画像・添付のあるノートは追記モードでも対象外です。失敗後に自動再貼り付け・DB復元は行いません。

### アプリ経由の実機確認（2026年11月14日）

UpNote 9.22.9で、DB直接編集後の手動同期・Ctrl+Sでは送信されないことと、アプリのエディターからの編集で同期されることを確認しました。新しいMCP準備・確認ツールとComputer Useによる貼り付けでは、次を確認しています。

- 同じID・作成日時のまま、日本語の見出し・太字・箇条書きが即座に画面へ反映され、一覧プレビューも更新されました。
- 自動バックアップが編集前のノート行全体と一致し、`integrity_check` は `ok` でした。
- 18:43:21.094の保存に対し18:43:25.301に同期応答が記録され、約4.2秒で `synced=1` になりました。画面にも新しい「同期済み」時刻が表示されました。他端末受信は未確認です。
- 初回のHTMLクリップボードで日本語の文字化けを検出したため、ANSI文字列から明示的なUTF-8バイト列に修正しました。バイト単位の位置情報をテストし、テストノートをアプリ経由で修復しています。修復前バックアップも保持しています。

再検証用の `scripts/live-app-edit-check.ts` はMCP経由で準備・同期確認を行い、途中の貼り付けは画面操作クライアントを待ちます。専用テストノートと明示オプションが必要で、通常の自動テストでは実行しません。詳細は英語READMEを参照してください。

## 前提

- `macOS` または `Windows 10/11`
- `bun >= 1.3.0`（`package.json` の要件）
- `UpNote` デスクトップアプリがインストール済み
- 既定のDBパス:

```text
# macOS
~/Library/Containers/com.getupnote.desktop/Data/Library/Application Support/UpNote/upnote.sqlite3

# Windows
%APPDATA%\UpNote\upnote.sqlite3
```

DBパスが異なる場合は `UPNOTE_DB` で上書きできます。

## セットアップ

```bash
bun install
```

## 起動

```bash
bun run start
```

開発時は監視付きで起動できます。

```bash
bun run dev
```

通常利用では公開パッケージを使うのが簡単です。

```bash
bunx @bellx2/upnote-mcp
```

`npx @bellx2/upnote-mcp` も使えますが、`bun:sqlite` など Bun 依存のため、実行環境には Bun が必要です。

## MCP Bundle（`.mcpb`）でのインストール

macOS 版 Claude Desktop では、`bunx` ではなく `.mcpb` からインストールすることもできます。

`.mcpb` は、スタンドアロンの MCP サーバーと `manifest.json` を含む zip アーカイブです。ブラウザ拡張のように、Claude Desktop からダブルクリックでインストールできます。

### ダウンロード

タグ付きリリースごとに `.mcpb` が [GitHub Releases](https://github.com/bellx2/upnote-mcp/releases) に添付されます。

ファイル名の例:

```text
upnote-mcp-0.2.7.mcpb
```

### Claude Desktop へのインストール

1. GitHub Releases から `.mcpb` をダウンロード
2. ファイルをダブルクリック
3. Claude Desktop のインストールダイアログに従う
4. 必要なら UpNote データベースのパスを設定（標準の UpNote デスクトップ版ならデフォルトのままで問題ありません）

バンドルには macOS 用バイナリが同梱されているため、この方法では Bun は不要です。

### ローカルでビルド

```bash
bun run build:mcpb
```

`dist/upnote-mcp.mcpb` が生成されます。

`v*` 形式のタグを push すると、GitHub Actions（`macos-latest`）でビルドされ、Release に自動添付されます。

## 環境変数

- `UPNOTE_DB`: `upnote.sqlite3` の絶対パス

例:

```bash
export UPNOTE_DB="$HOME/Library/Containers/com.getupnote.desktop/Data/Library/Application Support/UpNote/upnote.sqlite3"
```

Windows PowerShell の例:

```powershell
$env:UPNOTE_DB = "$env:APPDATA\UpNote\upnote.sqlite3"
```

## 権限

初回起動時に、MCP クライアント側でコマンド実行やローカルファイルアクセスの権限ダイアログが表示されることがあります。

これはこのサーバーが次を行うためで、正常な挙動です。

- `bun` で起動する
- ローカルの UpNote SQLite データベースを読む

この権限を拒否すると、ノート検索や本文取得は動作しません。許可後は、Cursor や Claude Desktop で MCP サーバーを再起動してください。

## MCP 設定例

### 公開パッケージ（Cursor / Claude Desktop）

#### Cursor

```json
{
  "mcpServers": {
    "upnote": {
      "command": "bunx",
      "args": ["@bellx2/upnote-mcp"]
    }
  }
}
```

#### Claude Desktop

##### 方法1: MCP Bundle（推奨）

[GitHub Releases](https://github.com/bellx2/upnote-mcp/releases) から `.mcpb` をダウンロードしてインストールします。JSON を手で編集する必要はありません。

##### 方法2: 公開パッケージ

```json
{
  "mcpServers": {
    "upnote": {
      "command": "bunx",
      "args": ["@bellx2/upnote-mcp"]
    }
  }
}
```

### ローカル開発用（Cursor）

```json
{
  "mcpServers": {
    "upnote": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/upnote-mcp/src/index.ts"],
      "env": {
        "UPNOTE_DB": "/Users/you/Library/Containers/com.getupnote.desktop/Data/Library/Application Support/UpNote/upnote.sqlite3"
      }
    }
  }
}
```

### WindowsのCodexへローカルforkを登録

`bun install` 後、公開npmパッケージではなく、このローカルcheckoutを登録します。Codexが対話シェルの`PATH`を継承しない場合は、Bunの絶対パスを指定します。

```powershell
codex mcp add upnote-local --env "UPNOTE_DB=$env:APPDATA\UpNote\upnote.sqlite3" -- "C:\Users\you\.bun\bin\bun.exe" run "C:\absolute\path\to\upnote-mcp\src\index.ts"
```

確認:

```powershell
codex mcp list
codex mcp get upnote-local
```

この設定はローカルソースを`bun run`で起動し、`bunx @bellx2/upnote-mcp`は使用しません。検索・取得はread-only、`update_note`だけはバックアップ付きの専用接続で書き込みます。`open_note`・`open_notebook`・`create_note`は登録済みの`upnote://` URL Scheme Handlerを使います。更新後はMCPサーバーに再接続・再起動して新しいツールを読み込んでください。

## ツール仕様

### `search_notes`

入力:

```json
{
  "query": "旅行",
  "limit": 5
}
```

### `get_note`

入力:

```json
{
  "id": "019fd239-a98a-742b-b75b-cee66e7aa830"
}
```

## 検証

```bash
bun run check
bun run test
bun run build:mcpb
```

全件は `scripts/run-tests.ts` でテストファイルごとに別プロセスで1回ずつ実行します。Bun 1.4.0/WindowsでVM・大容量HTML試験を同じプロセスにまとめるとネイティブクラッシュが発生したための隔離で、テストの省略・自動再試行はしていません。個別ファイルは `bun test ./src/ファイル.test.ts` で実行できます。
