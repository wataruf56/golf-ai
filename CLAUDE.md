# ゴルフAI LINE連携システム — プロジェクトコンテキスト

## 1. プロジェクト概要

LINEでゴルフ動画を送ると、AIがスイングを解析しフィードバックを返すサービス。月額480円のマイクロコーチ。

- ターゲット: 初心者〜中級者（スコア100〜90台前後）
- ブランド名: **ゴルフのあいちゃん**
- LP: https://golf.shikumi-ya.com

## 2. アーキテクチャ

```
LINE Messaging API
    ↓ Webhook
GAS (Google Apps Script) — メインロジック
    ↓
Cloud Run (2サービス)
  ├── swing-analyzer: 動画→Gemini解析（生テキスト）
  └── text-answer: テキスト→Gemini整形（プロンプトで出力フォーマット制御）
    ↓
Firestore: ユーザー状態・動画・解析結果保存
GCS: 動画一時保存→解析後削除
Stripe: サブスク課金
```

- GCP Project: `golf-ai-line-app`
- Cloud Run swing-analyzer: `https://swing-analyzer-10213914862.asia-northeast1.run.app/analyze`
- Cloud Run text-answer: `https://text-answer-10213914862.asia-northeast1.run.app/answer`

## 3. ローカルフォルダ構成

```
ゴルフアプリ/
├── gas/          ← GASコード専用（clasp push対象）
├── lp/           ← LP・法務ページ（GitHub Pages公開のバックアップ）
├── richmenu/     ← リッチメニュー・LINEカード画像・puppeteer
├── CLAUDE.md     ← このファイル
└── .clasp.json   ← clasp設定（rootDir: "gas"）
```

### GASコード (`gas/` フォルダ)

GAS Project: `https://script.google.com/home/projects/1UUV_lA-8vY7z3STszRWa5b2nMyz7KCwA1X7VGU3NmF8oPxfoaSuE8_aK/edit`

| ファイル | 役割 |
|---|---|
| `00_設定.js` | 定数・設定（Script Propertiesに移行済み） |
| `10_Firestore操作.js` | DB CRUD (user_state, videos, dataset_items) |
| `20_LINE操作.js` | LINE Messaging API通信 |
| `30_GCS操作.js` | 動画のアップロード・削除 |
| `35_Stripe操作.js` | Stripe決済・Webhook処理 |
| `40_AI呼び出し（Cloud Run）.js` | Cloud Run 2サービス呼び出し |
| `50_WEBHOOK（doPost）.js` | メインWebhook処理、全モード分岐、自由質問 |
| `60_worker（自動解析）.js` | 非同期Worker：動画解析→AI→LINE返信 |
| `70_プロンプト.js` | AI用プロンプト一元管理 |
| `80_月次リセット.js` | 月次の無料枠リセット処理 |
| `90_WEBHOOKログ.js` | ログ出力ユーティリティ |
| `richmenu_image_data.js` | リッチメニュー画像データ |
| `無題.js` | テスト・実験用 |

### LP (`lp/` フォルダ)
- 公開先: GitHub Pages (`wataruf56/golf-ai-lp` リポジトリ) → `https://golf.shikumi-ya.com`
- ローカルの `lp/` は公開コンテンツのバックアップ（自動同期ではない）
- LP改修時は `golf-ai-lp` リポジトリを編集して `git push`

## 4. 解析モード（6種類）

ユーザーが動画を送る → 2ステップカードUI → モード選択 → AI解析

| # | モード | プロンプト公開関数 | 引数 |
|---|---|---|---|
| 1 | 自分解析（単体） | `プロンプト_自分解析_単体_(基本解析)` | Cloud Runの生解析テキスト |
| 2 | 自分解析（補足あり） | `プロンプト_自分解析補足あり_(基本解析, userMessage)` | +ユーザー補足メッセージ |
| 3 | 自分解析（質問） | `プロンプト_自分解析_質問_(基本解析, userMessage)` | +ユーザー質問 |
| 4 | 自分解析（注目） | `プロンプト_自分解析_注目_(基本解析, userMessage)` | +注目ポイント |
| 5 | プロ比較 | `プロンプト_比較_(プロ解析, 自分解析, userMessage)` | プロ+自分の解析 |
| 6 | プロ比較（質問） | `プロンプト_比較_質問_(プロ解析, 自分解析, userMessage)` | +質問 |
| 7 | プロ比較（注目） | `プロンプト_比較_注目_(プロ解析, 自分解析, userMessage)` | +注目 |
| 8 | 過去比較 | `プロンプト_過去比較_(過去解析, 今回解析, userMessage)` | 過去+今回の解析 |
| 9 | 過去比較（質問） | `プロンプト_過去比較_質問_(過去解析, 今回解析, userMessage)` | +質問 |
| 10 | 過去比較（注目） | `プロンプト_過去比較_注目_(過去解析, 今回解析, userMessage)` | +注目 |

## 5. プロンプト設計（現行版）

### 基本方針
- **モードごと完全独立プロンプト**: 共有Systemプロンプトは廃止（`プロンプト_システム_固定_()` は空文字を返す）
- 各公開関数が「1本の完全なプロンプト文字列」を返す
- 口調: ストレートに厳しく（お世辞なし）。絵文字は適度に使う

### 評価方式
- **文章による評価のみ**（点数・スコア・数値評価・バー表記は廃止済み）
- プロンプト内で「点数やスコアは絶対に出力しない」と明示的に指示している
- ~~旧v2にあったバー表記（██████░░░░）やPGA基準の採点は完全削除済み~~

### フォーマット装飾
- 区切り線: `━━━━━━━━━━━━━━`
- セクション絵文字: 💬📊🌟🔧🎯🏋️

### 7フェーズ
アドレス / テイクバック / トップ / 切り返し / インパクト / フォロー / フィニッシュ

## 6. v2での変更（60_worker）

`60_worker（自動解析）.js` に2箇所の変更：

1. **L256付近**: P1〜P10コーチ観察をスキップ（API代節約。将来L2で復活予定）
```javascript
// const coachCheckText = コーチ観察P1toP10_生成_(v.userId, reviewText);
const coachCheckText = "";
```

2. **L425付近**: dataset_items保存をスキップ（将来L2で復活予定）
```javascript
// try {
//   const r = データセット項目_動画から作成_(v.id);
//   ...
// }
```

## 7. AI処理パイプライン（2段階）

```
動画送信
  ↓
[Stage 1] Cloud Run swing-analyzer
  Gemini に動画を渡して raw テキスト取得
  ↓ (基本解析テキスト)
[Stage 2] Cloud Run text-answer
  GAS側でプロンプト(70_プロンプト.js)を組み立て → Geminiに投げる → 整形済み回答
  ↓
LINE返信
```

関数の流れ:
```
40_AI: テキスト回答_AI_(userId, promptText, ラベル, 主キー)
  → Cloud Run text-answer へ POST
  → レスポンスのテキストを返す
```

## 8. GASデプロイについて

### 正の方向（ソースオブトゥルース）
- **GAS（ウェブ）が常に正**
- 改修後は必ず `clasp pull` でローカルにも同期し、ローカルを最新に保つ

### デプロイ手順
1. ローカルで `.js` ファイルを編集
2. `clasp push --force` でGASに反映
3. `clasp deploy --deploymentId <ID>` でウェブアプリを更新
4. 改修がGAS側で直接行われた場合は `clasp pull` でローカルに同期

### clasp設定
- clasp v3.2.0 インストール済み
- `.clasp.json` の scriptId: `1UUV_lA-8vY7z3STszRWa5b2nMyz7KCwA1X7VGU3NmF8oPxfoaSuE8_aK`
- デプロイID: `AKfycbwQlDqhbTWgYrRjnMziTLkaJdF1Ja4G2PoaVS7Ubz_cdgh0HmWL24J-Flm1YgiKPRcLkQ`

### 注意
- GASエディタのMonaco直接編集は禁止（clasp経由で管理する）
- GASエディタの `.gs` は `clasp push` で自動的に `.js` から変換される

## 9. 未完了タスク

### 9-A. GASデプロイ ✅ 完了（2026-04-04）
`clasp push --force` で全16ファイルをGASに反映済み。v112としてデプロイ完了。
GAS（ウェブ）とローカルが完全一致していることを `clasp pull` + diff で確認済み。

### 9-B. L2（RAG）設計 — 自由質問機能の強化
ユーザーの発言: 「L2が自由質問だと分かっていなかったので、自由質問のところまでをちゃんとやりたい」

現状の自由質問（`プロンプト_自由質問_(p)`）は動いているが、ナレッジDB（RAG）を導入して回答品質を上げたい。

検討項目:
- 何のデータを蓄積するか（過去の全解析結果？コーチ観察？会話ログ？）
- どう検索するか（Firestore全文検索 or 外部ベクトルDB）
- プロンプトにどれだけコンテキストを含めるか

### AI学習レベルの整理
- **L1（プロンプトエンジニアリング）**: v2プロンプトで対応済み ✅
- **L2（RAG + ナレッジDB）**: 自由質問で過去データ参照 ← **次にやる**
- **L3（ファインチューニング）**: 将来的な話

## 10. その他の重要情報

### Stripe
- Stripe Webhook: GAS `doPost` で処理
- サブスク: 月額480円（月10回解析）
- 無料トライアル: 生涯1回のみ
- `35_Stripe操作.js` で決済・解約・ステータス管理

### LINEリッチメニュー
- 2500x1686px / 2500x843px のリッチメニュー画像あり
- カードフロー: 動画送信 → モード選択カード → メッセージ入力カード → 解析

### 後方互換
- `プロンプト_結合_(systemText, userText)`: 旧API。v2では不要だが関数は残している
- `プロンプト_ユーザー_自分解析_()` 等の旧関数: v2では使わないが残している
