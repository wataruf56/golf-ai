# LIFF側Claude へ渡すスタータープロンプト

下記をそのままコピーして LIFF 側のClaude Codeセッションに貼り付けてください。

---

# 依頼：ゴルフAIスイング分析機能を `golf-buddy-prototype` に統合してください

別Claudeセッションで開発中の「ゴルフAIスイング分析（LINE Bot `@885osksd`）」を、このLIFFアプリ（Next.js + Vercel）に**機能等価で**統合します。

## 必読資料

仕様書を別リポジトリに用意しました。**まず冒頭の「結論サマリ」と「アーキテクチャ全体像」だけ読んで概要を掴んでください**。詳細は実装中に随時参照すればOKです。

仕様書ファイル：
- ローカル: `C:/Users/da_is/OneDrive/Desktop/開発/ゴルフアプリ/docs/swing-analysis-integration-spec.md`
- GitHub: `https://github.com/wataruf56/golf-ai/blob/master/docs/swing-analysis-integration-spec.md`

このリポジトリには参考実装が大量にあるので、必要に応じて読みに行ってください：
- `gas/70_プロンプト.js`（4モードのプロンプト全文）
- `gas/60_worker（自動解析）.js`（ワーカー実装の参考）
- `gas/40_AI呼び出し（Cloud Run）.js`（Cloud Run呼び出し方）

## 実装スコープ（仕様書 セクション10 より）

### UIファイル
```
app/swing/page.tsx                      // 履歴一覧
app/swing/new/page.tsx                  // 新規分析（モード選択→動画選択）
app/swing/[id]/page.tsx                 // 結果ページ（リアルタイム監視）
components/swing/ModeSelector.tsx
components/swing/VideoUploader.tsx
components/swing/ReviewChunks.tsx
components/swing/StatusBadge.tsx
```

### APIファイル
```
app/api/swing/upload-url/route.ts       // POST: GCS Signed URL
app/api/swing/submit/route.ts           // POST: アップ完了→queue
app/api/swing/list/route.ts             // GET:  自分の履歴
app/api/swing/[id]/route.ts             // GET:  個別取得
app/api/swing/process/route.ts          // GET (Cron): キュー消化
```

### ライブラリ
```
lib/swingPrompts.ts                     // 4モードのプロンプト関数（GASから移植）
lib/swingAnalyzer.ts                    // Cloud Run呼び出し
lib/swingFirestore.ts                   // Firestore I/O
lib/swingGcs.ts                         // GCS Signed URL+削除
lib/swingSplitter.ts                    // 区切り線分割
types/swing.ts
```

## 4つの分析モード

| モード | mode値 | 動画 | userMessage | 説明 |
|---|---|---|---|---|
| 自分解析 | `"self"` | 1本 | 任意 | 7フェーズ評価＋改善点TOP3 |
| プロ比較 | `"compare"` | 2本（プロ→自分） | 任意 | プロとの違いを対比 |
| 過去比較 | `"past"` | 2本（過去→今回） | 任意 | 改善/悪化判定付き |
| 質問モード | `"question"` | 1本 | **必須** | フェーズ別評価なし、自由回答 |

## 重要な設計判断

1. **データの正は LIFF Firestore**。Cloud Runは書き込み禁止（呼ぶだけ）。
2. **動画は `gs://golf-ai-line-videos`（既存・別プロジェクト）に直接アップロード**。LIFFバックエンドはSigned URL払い出しだけ。クライアントから直接GCS PUT。
3. **swing-analyzer は1〜2分かかる** → Vercel Functionsで直叩きできない。**Vercel Cron** で `/api/swing/process` を毎分実行 → キュー消化。
4. **完了通知は既存の `lib/linePush.ts`** で `@711xiyrs` Bot から送信 → LIFF結果ページへ誘導。

## 環境変数（Vercelに追加）

仕様書セクション11参照。最低限：

```
SWING_ANALYZER_URL=<別途共有>
SWING_ANALYZER_SHARED_SECRET=<別途共有>
GCS_PROJECT_ID=golf-ai-line-app
GCS_BUCKET=golf-ai-line-videos
GCS_SA_KEY_JSON=<別途共有>
CRON_SECRET=<新規ランダム>
```

## インフラ担当（別Claudeセッション）への質問・依頼事項

実装中に以下が不足したら、ユーザー（Wataru）に「インフラ担当に〇〇聞いて」と依頼してください。インフラ側Claudeが回答・対応します：

- GCSサービスアカウント鍵JSONの中身
- SHARED_SECRETの正確な値（仕様書には記載済み・確認用）
- LINE Provider が4チャネルで一致しているかの確認結果
- Vertex AIクォータ
- 既存ユーザーデータ移行の要否
- 失敗時の枠（課金）扱い

## 進め方の提案

1. **まず仕様書セクション 0/1/3/5/6 を読む**（30分）
2. **ファイル骨格を全部作る**（中身は空でもOK、まずは構造を立ち上げる）
3. **lib/swingPrompts.ts を gas/70_プロンプト.js から移植**（一番時間がかかる）
4. **upload-url + submit + process の3エンドポイント**で end-to-end が通るところまで
5. **UIをLIFFの既存パターン（store, linePush, etc.）に合わせて実装**
6. **テスト：仕様書セクション12のチェックリスト**

## 制約・確認

- 既存LIFFアプリのUI/UX (Tailwind / カスタムstore) に違和感なく溶け込ませてください
- LIFF idTokenベースのセッション (`gb_liff_session`) を踏襲
- スタイリングは既存ページ（`/home`, `/round/[id]` 等）のトーンに合わせる
- 不明な点はインフラ担当に聞く前に**仕様書を全文検索**してから

---

## 着手前に確認したいこと（ユーザーに返答する形で）

1. **LINE Provider** が4チャネル（`2009973733` / `2009988613` / 既存スイングBot 2本）で同一になっているか確認結果
2. **タブバー追加 vs マイページ内導線** どちらでスイング機能を露出するか
3. **動画上限**（20秒/10MB）でOKか、緩和したいか
4. **既存ユーザーデータ移行**：必要 / 不要

これらを Wataru さんに聞いて、回答を得てから実装着手してください。
