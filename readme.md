*** 消防団員に送られるメールをgmailで受信してLINEに流す物です。以下、READMEからプログラムまで全て無料geminiに書かせました ***

# Gmail 災害情報 LINE 通知（Messaging API 版 / 二重通知対策版

Gmail で受信した災害情報メールのうち、指定した条件（対象地域・分団など）に一致する「発生」メールのみを抽出し、LINE Messaging API を通じて LINE グループへ自動通知する Google Apps Script（GAS）です。

二重通知を防ぐため、`LockService` による排他制御、Gmail メッセージ ID ごとの状態管理、LINE Messaging API の `X-Line-Retry-Key`（および HTTP 409 ヘッダー確認）を組み合わせています。

## ファイル構成

| ファイル名 | 役割 |
| :--- | :--- |
| `Code.js` | メインのメール検索・判定・二重通知対策・LINE 通知処理 |
| `debug.js` | 検索クエリと抽出パターンの動作確認用デバッグスクリプト |
| `appsscript.json` | GAS プロジェクトのマニフェスト設定 |

## セットアップ手順

### 1. GAS プロジェクトの作成
1. [Google Apps Script](https://script.google.com/) で新しいプロジェクトを作成します。
2. `Code.js` と `debug.js` の内容を貼り付けます（GAS エディタ上では `Code.gs`・`debug.gs` として作成されます）。
3. 「プロジェクトの設定」から「`appsscript.json` マニフェスト ファイルをエディタで表示する」を有効にし、`appsscript.json` の内容を反映します。

### 2. スクリプト プロパティの設定
認証情報や固有のメールアドレスをコードに直接書かず、GAS エディタの **「プロジェクトの設定」>「スクリプト プロパティ」** に以下を登録してください。

| プロパティ名 | 必須 | 説明 | 設定例 |
| :--- | :---: | :--- | :--- |
| `LINE_ACCESS_TOKEN` | 必須 | LINE Developers で発行したチャネルアクセストークン | `your_channel_access_token` |
| `LINE_GROUP_ID` | 必須 | 通知先の LINE グループ ID | `C0123456789abcdef...` |
| `SEARCH_QUERY` | 必須 | 検索対象の Gmail クエリ（重複防止のため `-is:starred` を含める） | `-is:starred newer_than:3d from:disaster-ml@example.jp` |
| `TARGET_PATTERN` | 任意 | 本文の絞り込みに使う正規表現（未設定時は検索結果すべてを対象） | `第[1-9１-９]分団` |
| `CORPS_LABEL` | 任意 | 通知メッセージのヘッダーに表示する名称（デフォルト: `対象エリア`） | `第X分団` |
| `DEBUG_SEARCH_QUERY` | 任意 | `debugCheck()` 実行時に使う検索クエリ（未設定時は `SEARCH_QUERY` を使用） | `newer_than:3d from:disaster-ml@example.jp` |

### 3. 初回実行（本番開始時刻の登録）
1. トリガーを設定する前に、エディタ上部の関数選択で **`setGoLiveNow`** を選択して 1 回だけ手動実行します（実行時刻以前の古いメールが誤通知されるのを防ぎます）。
2. 続いて `mainFunction` を 1 回手動実行し、エラーが出ないこと（および Gmail ラベル `LINE災害通知_送信済`・`LINE災害通知_要確認` が作成されること）を確認します。

### 4. トリガーの設定
1. GAS エディタ左メニューの「トリガー（時計アイコン）」を開きます。
2. 「トリガーを追加」から以下を設定します。
   - 実行する関数: `mainFunction`
   - イベントのソース: `時間主導型`
   - 時間ベースのトリガーのタイプ: `分ベースのタイマー`（`1分おき` 推奨）

## 注意事項
- チャネルアクセストークンや LINE グループ ID などの機密情報は、絶対にコード内へハードコードしたまま GitHub へプッシュしないでください。
- もし誤って実値を含めた状態で一度でもコミット・プッシュしてしまった場合は、Git の履歴削除だけでなく LINE Developers コンソールからチャネルアクセストークンを再発行してください。
