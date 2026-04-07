/**
 * 00_設定.gs
 *
 * 【変更点】
 * - ①セキュリティ：LINEトークン/Cloud Run共有シークレット/匿名化ソルトを直書き廃止（Script Propertiesへ移行）
 * - 00_設定.gs は「キー名定数」だけを保持（値は持たない）
 * - ③pendingStep：SELF用に「ステップ_自分動画待ち」を新設
 */

/* =============================
 * Script Properties キー名
 * ============================= */
const PROP_LINEチャネルアクセストークン = "LINE_CHANNEL_ACCESS_TOKEN";
const PROP_解析サービス共有シークレット = "CLOUDRUN_ANALYZE_SHARED_SECRET";
const PROP_テキスト回答サービス共有シークレット = "CLOUDRUN_TEXT_SHARED_SECRET";
const PROP_匿名化ソルト = "DATASET_SALT";
const PROP_テストモード = "TEST_MODE";
const PROP_Stripeシークレットキー = "STRIPE_SECRET_KEY";
const PROP_Stripe_Webhookシークレット = "STRIPE_WEBHOOK_SECRET";
const PROP_Stripe_Price_ID = "STRIPE_PRICE_ID";

/* テストモード（Script Property TEST_MODE=true で有効） */
const テストモード_返信文 = "今回のテスト用だけで解析しました。";

/* GCP */
const GCPプロジェクトID = "golf-ai-line-app";
const GCSバケット名 = "golf-ai-line-videos";

const Firestoreコレクション_ユーザー状態 = "user_state";
const Firestoreコレクション_動画 = "videos";

/* データセット */
const Firestoreコレクション_データセット項目 = "dataset_items";
const Firestoreコレクション_データセットユーザー = "dataset_users";
const データセットID_既定 = "golf_ai_v1";

/* Cloud Run */
const 解析サービスURL =
  "https://swing-analyzer-10213914862.asia-northeast1.run.app/analyze";
const テキスト回答サービスURL =
  "https://text-answer-10213914862.asia-northeast1.run.app/answer";

/* Worker */
const ワーカー_最大件数_1回 = 3;
const 最大リトライ回数 = 2;

/* user_state.state */
const ユーザー状態_待機 = "待機";
const ユーザー状態_解析中 = "解析中";

/* user_state.pendingStep */
const ステップ_なし = "";
const ステップ_ユーザーメッセージ待ち = "補足メッセージ待ち";
const ステップ_比較_プロ動画待ち = "比較:プロ動画待ち";
const ステップ_比較_自分動画待ち = "比較:自分動画待ち";
const ステップ_自分動画待ち = "自分:動画待ち"; // SELF専用
const ステップ_過去比較_過去動画待ち = "過去比較:過去動画待ち";
const ステップ_過去比較_今回動画待ち = "過去比較:今回動画待ち";
const ステップ_メッセージモード選択待ち = "メッセージモード選択待ち"; // アクションモード選択後→メッセージモード選択前
const ステップ_追加テキスト入力待ち = "追加テキスト入力待ち"; // 質問/注目選択後→テキスト入力前
const ステップ_質問プロンプト入力待ち = "質問:プロンプト入力待ち"; // 質問モード：ユーザープロンプト入力待ち
const ステップ_質問動画待ち = "質問:動画待ち"; // 質問モード：プロンプト入力後→動画待ち

/* モード */
const 動作モード_自分解析 = "自分";
const 動作モード_比較 = "比較";
const 動作モード_過去比較 = "過去比較";
const 動作モード_質問 = "質問";

const メッセージモード_すぐ解析 = "すぐ";
const メッセージモード_補足あり = "補足あり";
/* 新メッセージモード（カード選択型フロー） */
const メッセージモード_なし = "なし";
const メッセージモード_質問 = "質問";    // 後方互換のため残す
const メッセージモード_注目 = "注目";    // 後方互換のため残す
const メッセージモード_テキストあり = "テキストあり";

/* videos.status */
const 動画ステータス_受信 = "受信";
const 動画ステータス_補足待ち = "補足待ち"; // 補足あり時：動画受信後・ユーザーが補足メッセージを送るまでワーカーに拾われない
const 動画ステータス_キュー = "キュー";
const 動画ステータス_解析中 = "解析中";
const 動画ステータス_解析完了 = "解析完了";
const 動画ステータス_レビュー送信済み = "返信済み";
const 動画ステータス_失敗 = "失敗";
const 動画ステータス_素材 = "素材";

/* videos.role */
const 動画ロール_自分 = "自分";
const 動画ロール_プロ = "プロ";
const 動画ロール_過去 = "過去";

/* videos.analysisType */
const 解析種別_即解析 = "即解析";
const 解析種別_メッセージ付き = "補足あり";
const 解析種別_比較 = "比較";

/* 課金（free / paid + ticket） */
const プラン種別_free = "free";
const プラン種別_paid = "paid";
const プラン種別_チケット = "チケット";

const Free_月上限 = 1;  // free: 生涯1回（月次リセット対象外）
const Paid_月上限 = 10; // paid: 月10回

const 課金消化状態_未消化 = "未消化"; // pending相当
const 課金消化状態_消化済み = "消化済み";

/* レベル */
const ユーザーレベル_未設定 = "未設定";
const ユーザーレベル_初心者 = "初心者";
const ユーザーレベル_中級者 = "中級者";
const ユーザーレベル_上級者 = "上級者";

/* Stripe */
const Stripeイベント_決済完了 = "checkout.session.completed";
const Stripeイベント_サブスク削除 = "customer.subscription.deleted";
const Stripeイベント_支払い失敗 = "invoice.payment_failed";

/* ログ */
const WEBHOOKログ_スプレッドシートID =
  "19toHukjHdfqJ7pk_1ScwT8wBkdvgNjvZgxjYncXK_qY";
const WEBHOOKログ_シート名 = "WEBHOOK_LOG";
/** 【テスト用】AIプロンプトログ：AIに送っているプロンプトだけを記録。主キーで解析結果ログとマッチ。 */
const AIプロンプトログ_シート名 = "AI_PROMPT_LOG";
/** 【テスト用】AI解析結果ログ：そのプロンプトから返ってきたものを記録。主キーでプロンプトログとマッチ。 */
const AI解析結果ログ_シート名 = "AI_解析結果_LOG";
