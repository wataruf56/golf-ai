# ゴルフAIスイング分析 — golf-buddy-prototype（LIFF）統合仕様書

**目的**：本番運用中のスイング分析機能（LINE Bot `@885osksd`）と機能等価のものを `golf-buddy-prototype`（Vercel上のNext.js LIFF）に再現する。
**読み手**：LIFF側のClaude Codeセッション（実装担当）。
**作成元**：スイング分析側のClaude Codeセッション（インフラ担当）。
**最終更新**：2026-05-07。

---

## 0. 結論サマリ

- **既存のCloud Runサービス（`swing-analyzer`）はそのまま叩ける**。動画とプロンプトを受け取り、Geminiで分析しテキストを返すREST API。
- **LIFFバックエンドが「司令塔」**になる。クライアントから動画を受け取り、GCSへ保存し、Cloud Runを呼び、結果を自Firestoreに書き、ユーザーに通知する。
- **データの正は LIFF Firestore（`golf-buddy-prototype` Firebaseプロジェクト）**。Cloud Runは ステートレス（書き込みしない）。
- **動画ストレージは `gs://golf-ai-line-videos`（既存の `golf-ai-line-app` GCPプロジェクト）を再利用** が最短路。Vertex AI のサービスアカウントが既にこのバケットへの読み取り権を持っており、再構築不要。
- 分析結果テキストは **「━━━━━」区切り線で複数LINEメッセージに分割** して送ると本番と同じUXになる。
- 4つの分析モード：**自分解析 / プロ比較 / 過去比較 / 質問モード**。全て `swing-analyzer` の同じエンドポイント `/analyze` で完結。

---

## 1. アーキテクチャ全体像

```
[LIFF クライアント (Next.js, /swing/*)]
    │
    │ ① 動画選択／撮影
    │ ② Signed URL リクエスト ──────────────┐
    │                                          ↓
    │                     [LIFF API: /api/swing/upload-url]
    │                                          │
    │                              gcs-signer Cloud Run か
    │                              Firebase Admin SDK で
    │                              `gs://golf-ai-line-videos` への
    │                              v4 PUT 署名URLを発行
    │                                          │
    │ ③ Signed URL 受領 ←──────────────────┘
    │
    │ ④ ブラウザから直接 GCS に PUT（多くの場合 5〜30秒で完了）
    │
    │ ⑤ アップロード完了通知 → /api/swing/submit
    │                                          ↓
    │                     [LIFF API: /api/swing/submit]
    │                                          │
    │                              Firestore に
    │                              users/{uid}/swings/{swingId}
    │                              { status: "queued", videoGcsPath, mode, ... }
    │                              を作成
    │
    │ ⑥ クライアントは /swing/[id] に遷移、ポーリング or onSnapshot で監視
    │
    │     [Vercel Cron / Cloud Scheduler] が毎分
    │                  /api/swing/process を叩く
    │                                          │
    │                  Firestore から status="queued" を取得
    │                  ステータスを "analyzing" に更新
    │                                          │
    │                  Cloud Run swing-analyzer (POST /analyze) ──────────┐
    │                                                                       ↓
    │                                                            [Cloud Run swing-analyzer]
    │                                                            （既存サービス、変更不要）
    │                                                                       │
    │                                                            • GCSから動画DL
    │                                                            • Vertex AI Gemini呼び出し
    │                                                            • 整形済みテキスト返却
    │                                                                       │
    │                  ←─────────────────────────────────────────────────────┘
    │                  reviewText を保存
    │                  ステータス "done" に更新
    │                  通知用に lib/linePush で「分析完了したよ」メッセージ送信
    │                                          │
    │ ⑦ クライアント onSnapshot で完了検知 → 結果ページに表示
    │
    └ ⑧ /swing/[id] でテキスト分割表示（区切り線で複数カードに分けるUI推奨）
```

### 1-1. 重要な設計原則

| 原則 | 理由 |
|---|---|
| **Cloud Run は呼び出し側に書き込まない** | 責務分離。LIFFバックエンドだけがLIFF Firestoreを触る |
| **動画は GCS に直接アップロード**（バックエンド経由しない） | LIFF→Vercel間の20s制約・ペイロード制限を回避。LINE Botと同等以上の体感速度を実現するための鍵 |
| **swing-analyzer は冪等** | 同じ `gcsUri + prompt` を投げても同じ結果が返る前提。リトライ可能 |
| **LIFF Firestore が真実の源** | 履歴・状態・結果すべてLIFF側に集約 |

---

## 2. 認証戦略

### 2-1. 大前提：LINE userId は Provider 単位で発行される

- `golf-buddy-prototype` の LINE Login channel `2009973733` と、スイング分析機能で使う既存LINE Botは **同じLINE Provider** に置く必要がある。
- **同じProvider** → 同じ人の userId（`U....`）が両方で一致 → ユーザーレコード共有OK
- 別Providerだと、同じ人でも userId が変わるため、別途 アカウント紐付けテーブルが必要になる。

**TODO（読み手）**：LINE Developers Console で4チャネル全てを同じProvider配下に置いていることを確認すること。
- `2009973733`（LIFF login channel）
- `2009988613`（`@711xiyrs` Bot）
- 既存スイング分析Bot（`@885osksd`）
- 既存スイング分析Bot（ステージング `@038ugafj`）

### 2-2. LIFF のセッション = `gb_liff_session` cookie

既に存在する LIFF idToken検証 → HMAC署名Cookie の仕組みをそのまま使う。
スイング分析API（`/api/swing/*`）は `gb_liff_session` を要求し、`userId` を取り出す。

### 2-3. Cloud Run swing-analyzer 認証

- ヘッダ `x-shared-secret: <SHARED_SECRET>` 必須
- 値は Vercel 環境変数 `SWING_ANALYZER_SHARED_SECRET` に保存（後述）

---

## 3. Cloud Run API 仕様

### 3-1. swing-analyzer

- **本番URL**: `https://swing-analyzer-10213914862.asia-northeast1.run.app/analyze`
- **GCPプロジェクト**: `golf-ai-line-app`
- **リージョン**: `asia-northeast1`
- **使用モデル**: Vertex AI `gemini-2.5-flash`（環境変数で切替可）
- **認証**: `x-shared-secret` ヘッダー必須（値は別途共有）

#### 3-1-1. リクエスト（4モード共通の同じエンドポイント）

```
POST /analyze
Headers:
  Content-Type: application/json
  x-shared-secret: <SHARED_SECRET>

Body:
{
  "gcsUri": "gs://golf-ai-line-videos/<path>/<id>.mp4",   // 必須・1本目（自分動画 / プロ動画 / 過去動画）
  "gcsUri2": "gs://golf-ai-line-videos/<path>/<id>.mp4",  // 任意・2本目（プロ比較・過去比較のときだけ）
  "prompt": "あなたはPGA…(整形済みプロンプト全文)"        // 任意・指定するとこれを使ってGeminiに直接分析させる
}
```

#### 3-1-2. レスポンス

`prompt` あり（推奨・全4モードで使う）:
```json
{
  "ok": true,
  "model": "gemini-2.5-flash",
  "answerText": "💬 総合コメント\n...\n━━━━━━━━━━━━━━\n📊 フェーズ別評価\n..."
}
```

`prompt` なし（後方互換、観察メモを返すだけ。**LIFFでは使わない**）:
```json
{ "ok": true, "model": "...", "reviewText": "..." }
```

エラー:
```json
{ "ok": false, "error": "..." }
```
- `400`: `gcsUri required` / `invalid gcsUri format` / `video file is empty`
- `401`: `unauthorized`
- `500`: 内部エラー

#### 3-1-3. レスポンス時間の目安

- 単動画（自分解析・質問モード）: **30〜90秒**
- 2動画比較（プロ比較・過去比較）: **60〜120秒**
- → Vercel Serverless Function のデフォルト10秒タイムアウトを **超える**。必ず非同期処理（Cron + 状態ポーリング）にする。

#### 3-1-4. 動画制約

- フォーマット: **MP4**（mime: `video/mp4`）
- 長さ: **20秒以内**（既存LINE Botの仕様。長尺だとGemini側のコストが跳ね上がる）
- サイズ: 〜10MB目安（LINE側仕様だったが、GCS直アップなら緩和可能）
- 解像度: 標準（縦動画推奨）

### 3-2. （将来用）pose-renderer

棒人間オーバーレイ動画＋ユーザー vs 理想の比較画像を生成するサービス。**現在ステージング限定**。本仕様書のスコープからは外す（後段「未来の拡張」参照）。

### 3-3. text-answer

旧2段階パイプラインで使っていたが**廃止済み**。LIFFでは使わない。

---

## 4. GCSバケット設計

### 4-1. 推奨：既存バケットを再利用

`gs://golf-ai-line-videos`（GCPプロジェクト `golf-ai-line-app`）

- 既に Vertex AI のサービスアカウントが読み取り権限を持っている
- バケットは公開設定（`allUsers: storage.objectViewer`）
- LIFFバックエンドからこのバケットに直接書き込めばOK

### 4-2. オブジェクト命名規則

```
gs://golf-ai-line-videos/liff/<userId>/<swingId>.mp4
```

- `<userId>`: `U....` 形式（LINE userId）
- `<swingId>`: ULIDかUUID（Firestore docIdと同じ値を使う）

### 4-3. クロスプロジェクト書き込みのために必要な権限

LIFFバックエンドから `golf-ai-line-app` プロジェクトの GCS に書き込むには、サービスアカウント鍵が必要：

#### オプション A: 既存の `gas-gcs-writer` SA を再利用

- メールアドレス: `gas-gcs-writer@golf-ai-line-app.iam.gserviceaccount.com`
- 既に `gs://golf-ai-line-videos` に対し `storage.objectAdmin` 持ち
- Vercel環境変数に鍵JSONを置けば即使える
- **インフラ担当（こちら側）から鍵JSONを共有する**

#### オプション B: 新規SAを作る

- 名前: `liff-swing-uploader`
- 権限: `gs://golf-ai-line-videos` への `storage.objectAdmin`
- Vercel環境変数に鍵JSONを置く

→ **A が最速**。インフラ担当（こちら）が必要なら鍵を発行する。

### 4-4. Signed URL（PUT）の発行

LIFFバックエンドの `/api/swing/upload-url` で v4 Signed URL を発行：

```typescript
import { Storage } from "@google-cloud/storage";

const storage = new Storage({
  projectId: "golf-ai-line-app",
  credentials: JSON.parse(process.env.GCS_SA_KEY_JSON!),
});

const [url] = await storage
  .bucket("golf-ai-line-videos")
  .file(`liff/${userId}/${swingId}.mp4`)
  .getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 10 * 60 * 1000,        // 10分
    contentType: "video/mp4",
  });

return Response.json({ uploadUrl: url, gcsUri: `gs://golf-ai-line-videos/liff/${userId}/${swingId}.mp4` });
```

### 4-5. 動画削除ポリシー

本番LINE Botでは「分析完了→動画はGCSから削除」している（プライバシー保護）。LIFFでも同様にすること。

```typescript
await storage.bucket("golf-ai-line-videos").file(objectName).delete().catch(() => {});
```

`status: "done"` 更新時に削除する。`videoDeleted: true` フィールドを Firestore に立てて二重削除を防ぐ。

---

## 5. Firestore スキーマ（LIFF Firebase）

### 5-1. コレクション設計

ユーザーのサブコレクションとして格納：

```
users/{userId}/swings/{swingId}
```

- `userId`: LINE userId（`U....`）
- `swingId`: クライアント生成ULID or サーバー生成

### 5-2. ドキュメント構造

```typescript
type SwingDoc = {
  swingId: string;                      // ドキュメントID
  userId: string;                       // 重複保存（query便利のため）
  status: "queued" | "analyzing" | "done" | "failed";
  mode: "self" | "compare" | "past" | "question";
  videoGcsPath: string;                 // 自分動画 / 質問対象動画
  proGcsPath?: string;                  // プロ比較時のお手本動画
  prevGcsPath?: string;                 // 過去比較時の過去動画
  userMessage?: string;                 // ユーザーが入力したテキスト（補足/質問）
  reviewText?: string;                  // 分析結果（complete時）
  reviewTextChunks?: string[];          // 区切り線で分割済みのチャンク
  videoDeleted?: boolean;
  errorMessage?: string;                // failed時
  retryCount?: number;
  analysisRunId?: string;               // 冪等性キー
  createdAt: Timestamp;
  updatedAt: Timestamp;
  startedAnalyzingAt?: Timestamp;
  completedAt?: Timestamp;
};
```

### 5-3. インデックス

- `userId ASC, createdAt DESC` （ユーザーごとの履歴一覧）
- `status ASC, createdAt ASC` （Cron用キュー取得）

### 5-4. ルール（Firestore Security Rules）

クライアントSDK未使用ならルール厳しめでOK。Admin SDK経由のみ書き込み。

---

## 6. 4分析モードと完全プロンプト

すべてGAS本番環境（`gas/70_プロンプト.js`）から抽出した最新版。LIFFバックエンドで再現する。

### 6-1. モード別の判定パラメータ

| モード | mode | 動画本数 | 必須userMessage | swing-analyzer呼び出し |
|---|---|---|---|---|
| 自分解析（単体） | `"self"` | 1（自分） | 不要 | gcsUri=自分 |
| 自分解析（テキスト付） | `"self"` | 1（自分） | あり | gcsUri=自分 |
| プロ比較 | `"compare"` | 2（プロ→自分） | 任意 | gcsUri=プロ, gcsUri2=自分 |
| 過去比較 | `"past"` | 2（過去→今回） | 任意 | gcsUri=過去, gcsUri2=今回 |
| 質問モード | `"question"` | 1（自分） | 必須 | gcsUri=自分 |

### 6-2. 共通の内部定数

#### `_コーチ冒頭_`（全モード共通の人格定義）

```
あなたはPGAツアープロを指導するトップレベルのゴルフコーチだ。
温かく褒めるところはしっかり褒めつつ、直すべきところは具体的に的確に伝える。
「ここは本当にいいね！」「自信を持っていい」といったポジティブな声かけを積極的にする。
ただし嘘はつかない。良くない部分は「ここを直せばもっと良くなる」という前向きな言い方で伝える。
絵文字は適度に使う。

【言葉選びのルール（重要）】
・ゴルフ初心者〜中級者が読むことを前提に、できるだけ平易な日本語で書く。
・専門用語を使う場合は、必ずその場で簡単な説明を添える。
  例：「レイドオフ（トップでクラブが左を向きすぎる状態）」
  例：「キャスティング（手首の角度が早く解けること）」
・「インサイドに引きすぎ」ではなく「クラブを体の内側に引きすぎている」のように、動作を具体的に描写する。
```

#### `_用語集指示_`（全モードの末尾に付ける）

```
━━━━━━━━━━━━━━
📖 用語集
━━━━━━━━━━━━━━
上の解説文に出てきたゴルフ用語のうち、初心者が分からなそうなものを5〜10個ピックアップし、
「用語：一言説明」の形式で箇条書きする。
（例）
・アドレス：ボールを打つ前の構え
・テイクバック：クラブを後ろに引く動作
・インパクト：クラブがボールに当たる瞬間
※ 誰でも知っている超基本語（ゴルフ、ボール等）は除外。解説文中に実際に登場した用語だけ載せること。
```

### 6-3. 自分解析（単体）プロンプト

```
{_コーチ冒頭_}

【評価ルール】
以下の7フェーズそれぞれについて、具体的な評価を書く。
点数・スコア・数値評価は一切つけない。文章で評価する。

各フェーズには「良い点」と「直した方がいい点」をそれぞれ2〜3行で具体的に書く。
・良い点は「なぜ良いのか」「どんな効果があるのか」まで踏み込んで褒める。
・直した方がいい点は「現状どうなっているか」「それがなぜ問題か」「どうすれば良くなるか」を分かりやすく書く。
・本当に問題がないフェーズでも、「さらに良くするためのヒント」を1つ添える。「特段の問題なし」とだけ書くのは禁止。

【遵守事項】
・動画で確認できる内容を中心に評価する（見えないことは断定しない）
・推測しすぎない（不明な点は「映像からは判断が難しい」と書く）
・改善点は最大3つまで（優先順）
・「最優先で直す1つ」を明確に伝える
・出力はテンプレ外の説明を追加しない
・点数やスコアは絶対に出力しない

【出力フォーマット（この順番・この装飾で出力すること）】

💬 総合コメント
（3〜4行。まず良いところを認めてから、最大の課題を前向きに伝える）

━━━━━━━━━━━━━━

📊 フェーズ別評価

アドレス：
→ 良い点：（2〜3行。具体的に何が良くて、それがスイングにどう活きているか）
→ 直した方がいい点：（2〜3行。現状→なぜ問題か→どうすれば良くなるか）

テイクバック：
→ 良い点：（同上）
→ 直した方がいい点：（同上）

トップ：
→ 良い点：（同上）
→ 直した方がいい点：（同上）

切り返し：
→ 良い点：（同上）
→ 直した方がいい点：（同上）

インパクト：
→ 良い点：（同上）
→ 直した方がいい点：（同上）

フォロー：
→ 良い点：（同上）
→ 直した方がいい点：（同上）

フィニッシュ：
→ 良い点：（同上）
→ 直した方がいい点：（同上）

━━━━━━━━━━━━━━

🌟 良い点（最大3つ）
①（自信を持っていいポイントを具体的に）
②
③

━━━━━━━━━━━━━━

🔧 改善点TOP3（優先順）
①【最重要】（何が起きていて、直すとどう良くなるかを2〜3行で）
②
③

━━━━━━━━━━━━━━

🎯 最優先で直す1つ
「○○」を直そう！理由：○○。ここを変えるだけで○○が劇的に良くなる。

━━━━━━━━━━━━━━

🏋️ おすすめ練習
○○（やり方・回数・目安を具体的に）

{_用語集指示_}

---

添付されたスイング動画を直接分析し、評価ルールに従って各フェーズを評価してください。
```

### 6-4. 自分解析（テキスト付）プロンプト

冒頭〜出力フォーマットは「自分解析（単体）」と同じだが、出力フォーマットの先頭に下記を追加：

```
💬 補足への返答
（2〜3行でしっかり答える）

━━━━━━━━━━━━━━

💬 総合コメント
（3〜4行。まず良いところを認めてから、最大の課題を前向きに伝える）
（… 以下同じ ...）
```

末尾の `---` 以降を以下に差し替え：

```
---

【ユーザーからのメッセージ】
「{userMessage}」

上記のメッセージの内容に応じて柔軟に対応してください。
質問であれば回答を冒頭にまとめ、補足情報であれば考慮に入れ、注目ポイントであれば重点的に分析してください。
その上で、添付されたスイング動画を直接分析し、通常の解析フォーマットで出力してください。
```

【遵守事項】に「ユーザーが補足メッセージを送っている場合、回答の冒頭で2〜3行でしっかり返答する」を追加。

### 6-5. プロ比較プロンプト

```
{_コーチ冒頭_}

これからプロと一般ゴルファーの2つのスイング動画を渡す。
プロと比較して、一般ゴルファーのスイングを評価する。

【評価ルール】
以下の7フェーズそれぞれについて、プロとの違いを具体的に文章で評価する。
点数・スコア・数値評価は一切つけない。文章で評価する。

各フェーズでは「プロはこうしている」と「あなたはこうなっている」を対比して書く。
・「プロはこうしている」は、プロの動画から読み取れるお手本の動きを2〜3行で具体的に書く。
・「あなたはこうなっている」は、自分の動画から読み取れる現状を2〜3行で書く。プロと同じでできている部分は「ここはプロと同じでいい感じ！」と褒め、違いがある部分は「ここをこう変えるともっと良くなる」と前向きに伝える。
・本当にプロと同じレベルのフェーズでも、「さらに磨くためのヒント」を1つ添える。「特段の問題なし」とだけ書くのは禁止。

【遵守事項】
・動画で確認できる内容を中心に評価する
・推測しすぎない
・プロとの差が最も大きいポイントを明確にする
・出力はテンプレ外の説明を追加しない
・点数やスコアは絶対に出力しない

【出力フォーマット（この順番・この装飾で出力すること）】

💬 総合コメント
（3〜4行。まずプロに近い部分を認めてから、最大の差を前向きに伝える）

━━━━━━━━━━━━━━

📊 プロとの比較

アドレス：
→ プロはこうしている：（2〜3行。プロの動きのお手本）
→ あなたはこうなっている：（2〜3行。プロとの共通点は褒め、違いは前向きに指摘）

(... 7フェーズ繰り返し（テイクバック、トップ、切り返し、インパクト、フォロー、フィニッシュ）...)

━━━━━━━━━━━━━━

🔍 プロとの最大の差
（最も差が大きい1〜2フェーズを詳しく）

━━━━━━━━━━━━━━

🌟 良い点（プロに近いポイント・最大3つ）
①
②
③

━━━━━━━━━━━━━━

🔧 改善点TOP3（プロに近づくための優先順）
①【最重要】（何が起きていて、直すとどう良くなるかを2〜3行で）
②
③

━━━━━━━━━━━━━━

🎯 最優先で真似する1つ
「○○」を直そう！理由：○○。ここを変えるだけで○○が劇的に良くなる。

━━━━━━━━━━━━━━

🏋️ おすすめ練習
○○（やり方・回数・目安を具体的に）

{_用語集指示_}

---

添付された2本のスイング動画を直接分析してください。
1本目がプロのお手本、2本目が私のスイングです。
比較してください。

(userMessage がある場合は以下を追加)
【ユーザーからのメッセージ】
「{userMessage}」

上記のメッセージの内容に応じて柔軟に対応してください。
質問であれば回答を冒頭にまとめ、補足情報であれば考慮に入れ、注目ポイントであれば重点的に比較してください。
その上で、通常の比較フォーマットで出力してください。
```

userMessage ありの場合は出力フォーマットの先頭に `💬 補足への返答` セクションを追加。

### 6-6. 過去比較プロンプト

プロ比較とほぼ同構造、主な差分：

- 「プロ動画とユーザー動画」→「過去動画と今回動画」
- 「プロはこうしている／あなたはこうなっている」→「前回はこうだった／今回はこうなっている」
- 各フェーズに **【改善/悪化/変化なし】** の判定マークを付ける
- 出力フォーマット末尾に「⚠️ 悪化した点」「🔧 まだ残っている課題」セクション
- 末尾の指示：「1本目が過去の私のスイング、2本目が今回の私のスイングです。」

完全な内容は `gas/70_プロンプト.js` の `_プロンプト_過去比較_動画直接_ベース_()` を参照。**LIFF実装時はGASから1対1でコピー**してください（書き換えないこと）。

### 6-7. 質問モードプロンプト

**他モードと完全に別構造**。フェーズ別評価テンプレは含まない：

```
{_コーチ冒頭_}

ユーザーから添付されたスイング動画と質問が送られてきます。

【回答ルール】
・動画を直接見て、ユーザーの質問に丁寧かつ的確に回答する
・フェーズ別評価のフォーマットは使わない。質問に対する自由形式の回答にする
・動画で確認できる内容を中心にアドバイスする（見えないことは断定しない）
・改善のための具体的なアドバイスやドリルがあれば積極的に教える

【ユーザーからの質問】
{userMessage}

添付されたスイング動画を見た上で、上記の質問に回答してください。
```

### 6-8. プロンプトのソースコード

完全な実装は本リポジトリの `gas/70_プロンプト.js` にある。LIFFでは TypeScript 版に移植：

```
gas/70_プロンプト.js の以下の関数を移植
・_コーチ冒頭_ （定数）
・_用語集指示_ （定数）
・_プロンプト_自分解析_動画直接_ベース_()
・_プロンプト_自分解析_補足_動画直接_ベース_()
・_プロンプト_プロ比較_動画直接_ベース_()
・_プロンプト_プロ比較_補足_動画直接_ベース_()
・_プロンプト_過去比較_動画直接_ベース_()
・_プロンプト_過去比較_補足_動画直接_ベース_()
・プロンプト_自分解析_単体_動画直接_()
・プロンプト_自分解析_テキストあり_動画直接_(userMessage)
・プロンプト_比較_動画直接_(userMessage)
・プロンプト_過去比較_動画直接_(userMessage)
・プロンプト_質問モード_動画直接_(userPrompt)
```

→ LIFF側で `lib/swingPrompts.ts` として実装することを推奨。

---

## 7. メッセージ分割（LINE/UI共通の見せ方）

### 7-1. 区切り線でチャンク分割

`reviewText` には `━━━━━━━━━━━━━━`（▟ 連続3文字以上）が含まれる。これでテキストを分割すると、本番LINE Botと同じ「セクション単位の連続メッセージ」になる：

```typescript
function splitReviewByDivider(text: string): string[] {
  const splitRe = /\n*━{3,}\n*/g;
  return text
    .split(splitRe)
    .map(s => s.trim())
    .filter(s => s.length >= 10);
}
```

- 質問モードは区切り線が無いので分割されず1チャンクで返る（OK）
- 通常分析は **6〜7チャンク** になる：総合コメント / フェーズ別評価 / 良い点 / 改善点TOP3 / 最優先で直す1つ / おすすめ練習 / 用語集

### 7-2. UIでの見せ方（推奨）

LIFFの `/swing/[id]` ページでは、各チャンクを **アコーディオンカード** または **垂直スクロールのチャットバブル風** で表示：

- カード形式：見出し（💬総合コメント等）をタイトル、本文を折りたたみ可能
- バブル形式：チャットUIのような連続吹き出しでLINE体験に寄せる

### 7-3. LINE通知（プッシュ）

分析完了時に `lib/linePush.ts`（既存）を使って `@711xiyrs` Bot からプッシュ：

```typescript
await pushTo(userId, `スイング分析完了！\n結果はこちら👇\n${liffResultUrl}`);
```

`liffResultUrl` は `https://liff.line.me/<LIFF_ID>?to=/swing/<swingId>` のような短縮形がベスト。

---

## 8. ワーカー（Cron）パターン

### 8-1. Vercel Cron の設定

`vercel.json`:

```json
{
  "crons": [
    { "path": "/api/swing/process", "schedule": "* * * * *" }
  ]
}
```

毎分実行。Vercel Cron は無料枠で月100回上限などあるので、運用ボリュームによっては Cloud Scheduler 等に切替検討。

### 8-2. ワーカー実装

`/api/swing/process/route.ts`:

```typescript
export async function GET(req: Request) {
  // Vercel Cron からの署名検証 (Vercel-Cron header)
  if (req.headers.get("user-agent")?.includes("vercel-cron") === false) {
    if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
      return new Response("forbidden", { status: 403 });
    }
  }
  
  // ロックを取る（多重実行防止）
  // Firestore の _locks/swingWorker でCAS的に
  
  // status: "queued" を最大3件取得
  // 各件を analyzing にしてから analyze 呼び出し
  // 成功/失敗を Firestore に書き戻す
  // LINE プッシュ通知
  
  return Response.json({ ok: true, processed });
}
```

### 8-3. 冪等性

- `analysisRunId` を発行してドキュメントに保存
- 既に `analysisRunId` があり `reviewText` も埋まっている → done に寄せる
- `analysisRunId` あるが `reviewText` 無い → 矛盾としてfailedに倒す（手動復旧）

---

## 9. LINE通知の活用

LIFF側の `lib/linePush.ts` を流用。本仕様で必要な通知：

- **分析完了通知**：`@711xiyrs` から「スイング分析完了！」+ 結果ページへのLIFFリンク
- **失敗通知**：「分析に失敗しました。もう一度お試しください」
- **エラー再試行**：最大2回までリトライ、超えたら失敗通知

通知文面例：

```
スイング分析が完了しました⛳️

📊 結果はこちら：
https://liff.line.me/2009973733-P5UdNex9?to=/swing/{swingId}
```

---

## 10. 実装ファイル一覧

LIFFリポジトリに作るべきファイル：

### 10-1. UI

```
app/swing/page.tsx                      // 履歴一覧
app/swing/new/page.tsx                  // 新規分析開始（モード選択 → 動画選択）
app/swing/[id]/page.tsx                 // 結果ページ（リアルタイム監視）
app/swing/[id]/loading.tsx              // 解析中UI
components/swing/ModeSelector.tsx       // 4モード選択カード
components/swing/VideoUploader.tsx      // 動画選択+アップロード+進捗
components/swing/ReviewChunks.tsx       // 区切り線で分割表示
components/swing/StatusBadge.tsx        // queued/analyzing/done/failed
```

### 10-2. API

```
app/api/swing/upload-url/route.ts       // POST: Signed URL払い出し
app/api/swing/submit/route.ts           // POST: 動画アップ完了→queueに登録
app/api/swing/list/route.ts             // GET: 自分の履歴
app/api/swing/[id]/route.ts             // GET: 個別取得（ポーリング用）
app/api/swing/process/route.ts          // GET (Cron): キュー消化ワーカー
```

### 10-3. ライブラリ

```
lib/swingPrompts.ts                     // 4モードのプロンプト関数
lib/swingAnalyzer.ts                    // Cloud Run swing-analyzer 呼び出しラッパー
lib/swingFirestore.ts                   // Firestore 読み書きヘルパー
lib/swingGcs.ts                         // GCS Signed URL払い出し+削除
lib/swingSplitter.ts                    // 区切り線分割
```

### 10-4. 型定義

```
types/swing.ts                          // SwingDoc, SwingMode, etc.
```

---

## 11. 環境変数（Vercel に追加）

```
# Cloud Run（既存）
SWING_ANALYZER_URL=https://swing-analyzer-10213914862.asia-northeast1.run.app/analyze
SWING_ANALYZER_SHARED_SECRET=analyze_20251229_wataru_k8P3mZ

# GCS（クロスプロジェクト）
GCS_PROJECT_ID=golf-ai-line-app
GCS_BUCKET=golf-ai-line-videos
GCS_SA_KEY_JSON={"type":"service_account",...}
  # ↑ JSON文字列としてVercelに登録。
  # 既存の gas-gcs-writer SA か、新規作成。インフラ担当から共有。

# Cron 認証
CRON_SECRET=<ランダム文字列>

# 動画上限
MAX_VIDEO_SECONDS=20
MAX_VIDEO_BYTES=10485760  # 10MB

# LIFF（既存・確認）
LIFF_ID=2009973733-P5UdNex9
```

---

## 12. テストプラン

### 12-1. 単体テスト

- `splitReviewByDivider()`: チャンク分割が正しいか
- `buildPrompt()`: 4モードで期待のプロンプトが組み立てられるか
- `validateGcsUri()`: 不正URI弾けるか

### 12-2. 結合テスト

1. **動画アップロード**: 5MBの.mp4を選んで Signed URL → GCS PUT 成功
2. **キュー登録**: submit でドキュメント `status:"queued"` ができる
3. **ワーカー実行**: Cron 走らせて → analyzing → done への遷移
4. **結果表示**: `/swing/[id]` でテキスト分割表示
5. **通知**: LINEプッシュが届く
6. **動画削除**: 完了後にGCSから消える
7. **失敗ケース**: 不正URI / 短すぎ動画 / Geminiエラー で failed になる

### 12-3. モード別動作確認

- `self`: 動画1本送って回答が届く
- `self` (with userMessage): 「飛距離を伸ばしたい」+動画 → 補足返答付き
- `compare`: プロ動画+自分動画 → 比較結果
- `past`: 過去動画+今回動画 → 改善/悪化判定付き
- `question`: 自由質問+動画 → フェーズ別評価無しの自由回答

---

## 13. 既知の落とし穴

1. **Vercel Function timeout**：Pro契約で最大60秒。swing-analyzer は1〜2分かかるので、**Cron + ポーリング** で非同期化必須。直叩きはダメ。

2. **GCS Public Access Prevention**：新規バケットを作るとデフォルトで有効。`gs://golf-ai-line-videos` は既に解除済み。

3. **OAuthスコープ**：LIFF backend が Firebase Admin SDK を使う場合、サービスアカウント鍵で認証するのでOAuthスコープは不要。

4. **動画コーデック**：iOS Safari からは `.mov` でアップロードされる場合あり。`<input accept="video/*">` で受けて、サーバー側で mime type 確認。MOVは Vertex AI Geminiで読めないことがあるので、可能なら client側で MP4 に変換するか、はじいた方が安全。

5. **LINE Provider 同一性**：再掲だが userId を共通化するため絶対条件。

6. **Cron の実行タイミング**：Vercel Cron はベストエフォート。即時性が必要なら、submit時に直接 `/api/swing/process` を fire-and-forget で叩くのもアリ。

7. **同時実行**：複数の swing が同時にキューにあると Cron が一度に処理しようとする。Cloud Run 側のメモリ・タイムアウトで詰まる可能性あり。`limit 3` 程度に絞ること。

8. **失敗時の課金/枠扱い**：本番LINE Botでは「失敗したら枠を消費しない」ロジックあり。LIFFでも同様にすること。

9. **動画サイズ vs Vertex AI上限**：Geminiは動画1本あたり〜30秒程度が安定範囲。20秒以下に抑える。

---

## 14. 未来の拡張（スコープ外）

以下はまだステージング限定または未着手。LIFF統合の **第2段階** として後で組み込み：

- **棒人間オーバーレイ動画**：`pose-renderer` Cloud Run（MediaPipe Pose）
- **理想ポーズとの比較画像**：同上
- **Stripe課金統合**：月10回 / 480円
- **クーポン機能**

---

## 15. インフラ担当（こちら）への依頼事項

LIFF実装側がブロックされたら以下をインフラ担当（金井側Claudeセッション）に依頼：

1. **GCSサービスアカウント鍵の発行・共有**
   - `gas-gcs-writer@golf-ai-line-app.iam.gserviceaccount.com` の鍵JSON
   - または新規SA `liff-swing-uploader` の鍵JSON
2. **swing-analyzer 本番リビジョンの確認**：URL/SHARED_SECRET 共有済み
3. **Vertex AI クォータ確認**：Gemini 2.5 Flash の同時実行枠
4. **LINE Provider 確認**：4チャネル全て同一Provider配下か
5. **過去ユーザーデータの移行**：既存LINE Bot利用者の履歴をLIFF Firestoreに移行する場合の方針

---

## 16. 移行・運用方針

### 16-1. 既存LINE Botとの並行運用

- 既存 `@885osksd` (本番) は当面そのまま稼働
- LIFFリリース後も双方を選択肢として残す
- ある時期で LIFF 中心に切替、 LINE Bot は縮退

### 16-2. データ移行

既存LINE Botの分析履歴は本番 GCP プロジェクト `golf-ai-line-app` の Firestore `videos` コレクションにある。
LIFF Firestore（別プロジェクト）に移行する場合：

- 一度きりのジョブで `gcloud firestore export` → `gcloud firestore import`（プロジェクト跨ぎ）
- 全データ移行は不要なら、新規分析だけLIFF側で取り、過去履歴は既存システムに置きっぱなし
- ユーザー視点では「過去のはLINE、これからのはアプリ」と案内

### 16-3. リリース順序

1. LIFFで `/swing` PoC をクローズドβで自分（Wataru）が試す
2. 数人のテスター追加
3. 既存LINE Bot利用者にLIFF導線を告知
4. LIFFを正式リリース、LINE Botは縮退案内

---

## 17. 完成チェックリスト

LIFF実装完了の判定基準：

- [ ] LIFFから動画アップロード → 結果が届く
- [ ] 4モード全てで動作する
- [ ] 区切り線でチャンク分割表示される
- [ ] 分析完了時にLINE通知が届く
- [ ] 動画は完了後GCSから削除される
- [ ] 失敗時は再試行され、最終的にfailedとして表示される
- [ ] 履歴一覧で過去の分析が見れる
- [ ] LIFFアプリ内のセッション認証で `userId` を取り出して保存している
- [ ] Vercel Cronがちゃんと毎分動いている
- [ ] 既存LIFFアプリのUI/UX設計に違和感なく溶け込んでいる

---

## 付録A. swing-analyzer 動作確認用 curl

```bash
SECRET="analyze_20251229_wataru_k8P3mZ"
URL="https://swing-analyzer-10213914862.asia-northeast1.run.app/analyze"

# ヘルスチェック
curl -s "${URL%/analyze}/"

# 質問モード（既存テスト用動画を使う）
curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "x-shared-secret: $SECRET" \
  -d '{
    "gcsUri": "gs://golf-ai-line-videos/<test-path>.mp4",
    "prompt": "（質問モードプロンプト全文）"
  }'
```

## 付録B. ファイル参照（gas/）

LIFF実装の参考になる既存コード（このリポジトリ内）：

- `gas/40_AI呼び出し（Cloud Run）.js`：Cloud Run 呼び出し方
- `gas/60_worker（自動解析）.js`：ワーカー / 冪等性 / 失敗ハンドリング
- `gas/70_プロンプト.js`：4モードのプロンプト全文
- `gas/50_WEBHOOK（doPost）.js`：モード分岐 / userMessage処理 / リッチメニュー連携

## 付録C. 既存スイング分析側のリポジトリ位置

- ローカル: `C:/Users/da_is/OneDrive/Desktop/開発/ゴルフアプリ`
- GitHub: `wataruf56/golf-ai`
- 仕様書本ファイル: `docs/swing-analysis-integration-spec.md`
