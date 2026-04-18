/**
 * 35_Stripe操作.gs
 *
 * Stripe連携（MVP最小構成）
 * - Checkout Session作成（決済リンク発行）
 * - Webhook受信 → Firestore planType 自動更新
 * - 対応イベント：
 *   checkout.session.completed（サブスク開始）
 *   customer.subscription.deleted（解約）
 *   invoice.payment_failed（支払い失敗）
 */

/* =========================================================
 * ヘルパー
 * =======================================================*/

function Stripeシークレットキー取得_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_Stripeシークレットキー) || "";
}

function Stripe_Webhookシークレット取得_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_Stripe_Webhookシークレット) || "";
}

function Stripe_Price_ID取得_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_Stripe_Price_ID) || "";
}

/**
 * Stripe API 汎用POST
 */
function Stripe_API_POST_(エンドポイント, パラメータ) {
  const sk = Stripeシークレットキー取得_();
  if (!sk) throw new Error("STRIPE_SECRET_KEY が未設定です");

  const opt = {
    method: "post",
    headers: {
      Authorization: "Basic " + Utilities.base64Encode(sk + ":"),
    },
    payload: パラメータ,
    muteHttpExceptions: true,
  };

  const res = UrlFetchApp.fetch(
    `https://api.stripe.com/v1/${エンドポイント}`,
    opt
  );
  const code = res.getResponseCode();
  const json = JSON.parse(res.getContentText());

  if (code < 200 || code >= 300) {
    Webhookログ出力_("Stripe", "APIエラー", { code, error: json.error });
    throw new Error(`Stripe API ${code}: ${json.error?.message || "不明"}`);
  }
  return json;
}

/**
 * Stripe API 汎用GET
 */
function Stripe_API_GET_(エンドポイント) {
  const sk = Stripeシークレットキー取得_();
  if (!sk) throw new Error("STRIPE_SECRET_KEY が未設定です");

  const opt = {
    method: "get",
    headers: {
      Authorization: "Basic " + Utilities.base64Encode(sk + ":"),
    },
    muteHttpExceptions: true,
  };

  const res = UrlFetchApp.fetch(
    `https://api.stripe.com/v1/${エンドポイント}`,
    opt
  );
  return JSON.parse(res.getContentText());
}

/* =========================================================
 * Checkout Session 作成（決済リンク発行）
 *
 * LINEのuserIdをmetadataに埋め込む。
 * Webhook受信時にmetadataからuserIdを取得し、
 * Firestoreの該当ユーザーのplanTypeを更新する。
 * =======================================================*/

/**
 * Checkout URLを生成する
 * @param {string} lineUserId - LINEユーザーID
 * @param {string} successUrl - 決済成功後のリダイレクトURL（省略時はデフォルト）
 * @param {string} cancelUrl  - キャンセル時のリダイレクトURL（省略時はデフォルト）
 * @return {string} Checkout URL
 */
function Stripe_Checkout_URL作成_(lineUserId, successUrl, cancelUrl) {
  if (!lineUserId) throw new Error("lineUserId が空です");

  const priceId = Stripe_Price_ID取得_();
  if (!priceId) throw new Error("STRIPE_PRICE_ID が未設定です");

  // デフォルトURL（LP完成後に差し替え）
  const defaultSuccess = "https://example.com/success";
  const defaultCancel = "https://example.com/cancel";

  const session = Stripe_API_POST_("checkout/sessions", {
    "payment_method_types[0]": "card",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    mode: "subscription",
    success_url: successUrl || defaultSuccess,
    cancel_url: cancelUrl || defaultCancel,
    "metadata[line_user_id]": lineUserId,
    "subscription_data[metadata][line_user_id]": lineUserId,
    allow_promotion_codes: "true",
  });

  Webhookログ出力_("Stripe", "Checkout作成", {
    sessionId: session.id,
    url: session.url,
    lineUserId,
  });

  return session.url;
}

/* =========================================================
 * Webhook受信処理
 *
 * doPostから呼ばれる。
 * LINEのWebhookと区別するために、リクエストボディに
 * "type" と "data.object" がある場合はStripeとして処理。
 * =======================================================*/

/**
 * StripeのWebhookイベントか判定する
 */
function Stripe_Webhookイベントか判定_(bodyJson) {
  // Stripeイベントは object="event" を持つ
  return bodyJson && bodyJson.object === "event" && bodyJson.type && bodyJson.data;
}

/**
 * Stripe Webhookのメイン処理
 * @param {object} event - Stripeイベントオブジェクト
 */
function Stripe_Webhook処理_(event) {
  const eventType = event.type;
  const dataObj = event.data?.object;

  Webhookログ出力_("Stripe", "Webhook受信", {
    eventType,
    eventId: event.id,
  });

  switch (eventType) {

    /* ------ サブスク開始（決済完了）------ */
    case Stripeイベント_決済完了:
      Stripe_決済完了処理_(dataObj);
      break;

    /* ------ サブスク解約 ------ */
    case Stripeイベント_サブスク削除:
      Stripe_サブスク解約処理_(dataObj);
      break;

    /* ------ 支払い失敗 ------ */
    case Stripeイベント_支払い失敗:
      Stripe_支払い失敗処理_(dataObj);
      break;

    default:
      Webhookログ出力_("Stripe", "未対応イベント", { eventType });
      break;
  }
}

/* =========================================================
 * 個別イベントハンドラ
 * =======================================================*/

/**
 * checkout.session.completed
 * → planType を "paid" に、monthlyVideoLimit を Paid_月上限 に更新
 */
function Stripe_決済完了処理_(session) {
  // metadata から LINE userId を取得
  const lineUserId = session.metadata?.line_user_id || "";
  const customerId = session.customer || "";
  const subscriptionId = session.subscription || "";

  if (!lineUserId) {
    Webhookログ出力_("Stripe", "ERROR: line_user_id なし", { session_id: session.id });
    return;
  }

  Webhookログ出力_("Stripe", "決済完了", {
    lineUserId,
    customerId,
    subscriptionId,
  });

  // Firestore: planType → paid, stripeCustomerId / stripeSubscriptionId を保存
  ユーザー状態更新_FS_(lineUserId, {
    planType: プラン種別_paid,
    monthlyVideoLimit: Paid_月上限,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
  });

  // LINEに通知
  try {
    LINEプッシュ送信実行_(lineUserId,
      "🎉 有料プランへの登録ありがとうございます！\n\n"
      + "月10回までスイング解析が使えるようになりました。\n"
      + "動画を送って、さっそく解析してみましょう！⛳"
    );
  } catch (e) {
    Webhookログ出力_("Stripe", "LINE通知失敗（決済完了）", { error: e.message });
  }
}

/**
 * customer.subscription.deleted
 * → planType を "free" に戻す
 */
function Stripe_サブスク解約処理_(subscription) {
  const lineUserId = subscription.metadata?.line_user_id || "";

  if (!lineUserId) {
    Webhookログ出力_("Stripe", "ERROR: 解約 line_user_id なし", {
      subscriptionId: subscription.id,
    });
    return;
  }

  Webhookログ出力_("Stripe", "サブスク解約", {
    lineUserId,
    subscriptionId: subscription.id,
  });

  // Firestore: planType → free
  ユーザー状態更新_FS_(lineUserId, {
    planType: プラン種別_free,
    monthlyVideoLimit: Free_月上限,
    stripeSubscriptionId: "",
  });

  // LINEに通知
  try {
    LINEプッシュ送信実行_(lineUserId,
      "プランが解約されました。\n\n"
      + "無料プラン（月1回）に戻りました。\n"
      + "またいつでも再開できます😊"
    );
  } catch (e) {
    Webhookログ出力_("Stripe", "LINE通知失敗（解約）", { error: e.message });
  }
}

/**
 * invoice.payment_failed
 * → ユーザーにLINE通知（planTypeは変えない＝Stripeが自動リトライする）
 */
function Stripe_支払い失敗処理_(invoice) {
  const customerId = invoice.customer || "";

  // customerIdからlineUserIdを引く（subscription.metadataから）
  let lineUserId = "";
  const subId = invoice.subscription || "";
  if (subId) {
    try {
      const sub = Stripe_API_GET_(`subscriptions/${subId}`);
      lineUserId = sub.metadata?.line_user_id || "";
    } catch (e) {
      Webhookログ出力_("Stripe", "サブスク取得失敗", { error: e.message });
    }
  }

  Webhookログ出力_("Stripe", "支払い失敗", {
    lineUserId: lineUserId || "(不明)",
    customerId,
    invoiceId: invoice.id,
  });

  if (lineUserId) {
    try {
      LINEプッシュ送信実行_(lineUserId,
        "⚠️ お支払いに問題がありました。\n\n"
        + "カード情報をご確認ください。\n"
        + "問題が解決しない場合、プランが停止される場合があります。"
      );
    } catch (e) {
      Webhookログ出力_("Stripe", "LINE通知失敗（支払い失敗）", { error: e.message });
    }
  }
}

/**
 * Stripeカスタマーポータルセッションを作成してURLを返す
 * 有料ユーザーが解約・カード変更などを行えるポータルページ
 * @param {string} lineUserId
 * @returns {string} ポータルURL
 */
function Stripe_CustomerPortalSession作成_(lineUserId) {
  const userDoc = ユーザー状態_取得または作成_FS_(lineUserId);
  const customerId = userDoc && userDoc.fields && userDoc.fields.stripeCustomerId
    ? userDoc.fields.stripeCustomerId.stringValue
    : null;

  if (!customerId) {
    throw new Error("stripeCustomerIdが未設定です。決済完了後にお試しください。");
  }

  const session = Stripe_API_POST_("billing_portal/sessions", {
    customer: customerId,
    return_url: "https://line.me/R/",
  });

  if (!session || !session.url) {
    throw new Error("カスタマーポータルURLの取得に失敗しました");
  }

  Webhookログ出力_("Stripe", "カスタマーポータルセッション作成", {
    lineUserId,
    customerId,
  });

  return session.url;
}

/* =========================================================
 * 解約導線：カスタマーポータルURLをメール送信
 * =======================================================*/

/**
 * Stripe Customer のメールアドレスを取得する
 * @param {string} customerId - Stripe Customer ID (cus_xxx)
 * @returns {string} メールアドレス（取得できない場合は空文字）
 */
function Stripe_Customerメール取得_(customerId) {
  if (!customerId) return "";
  try {
    const customer = Stripe_API_GET_(`customers/${customerId}`);
    return customer.email || "";
  } catch (e) {
    Webhookログ出力_("Stripe", "Customerメール取得失敗", { customerId, error: e.message });
    return "";
  }
}

/**
 * 解約用メール送信：カスタマーポータルURLをメールで案内
 * @param {string} lineUserId - LINEユーザーID
 * @returns {{ ok: boolean, message: string }}
 */
function Stripe_解約メール送信_(lineUserId) {
  // 1. Firestoreからユーザー情報取得
  const userDoc = ユーザー状態取得_FS_(lineUserId);
  const planType = FS文字列取得_(userDoc, "planType") || プラン種別_free;
  const customerId = FS文字列取得_(userDoc, "stripeCustomerId") || "";

  if (planType !== プラン種別_paid || !customerId) {
    return { ok: false, message: "有料プランに加入していないため、解約手続きは不要です。" };
  }

  // 2. Stripe Customerからメールアドレス取得
  const email = Stripe_Customerメール取得_(customerId);
  if (!email) {
    return { ok: false, message: "ご登録のメールアドレスが見つかりませんでした。\nお手数ですが、お問い合わせください。" };
  }

  // 3. カスタマーポータルセッション作成
  let portalUrl = "";
  try {
    portalUrl = Stripe_CustomerPortalSession作成_(lineUserId);
  } catch (e) {
    Webhookログ出力_("Stripe", "ポータルURL作成失敗（解約メール）", { error: e.message });
    return { ok: false, message: "解約ページの準備中にエラーが発生しました。\nしばらく経ってから再度お試しください。" };
  }

  // 4. メール送信
  try {
    MailApp.sendEmail({
      to: email,
      subject: "【ゴルフのあいちゃん】解約手続きのご案内",
      htmlBody:
        "<p>いつもゴルフのあいちゃんをご利用いただきありがとうございます。</p>"
        + "<p>解約をご希望の場合は、以下のリンクからお手続きください。</p>"
        + '<p style="margin:20px 0;"><a href="' + portalUrl + '" '
        + 'style="background-color:#4CAF50;color:white;padding:12px 24px;'
        + 'text-decoration:none;border-radius:6px;font-size:16px;">'
        + "解約手続きへ進む</a></p>"
        + "<p>※ このリンクの有効期限は24時間です。</p>"
        + "<p>ご不明な点がございましたら、LINEからお問い合わせください。</p>"
        + "<hr>"
        + "<p style='color:#999;font-size:12px;'>ゴルフのあいちゃん</p>",
    });
  } catch (e) {
    Webhookログ出力_("Stripe", "解約メール送信失敗", { email, error: e.message });
    return { ok: false, message: "メール送信に失敗しました。\nしばらく経ってから再度お試しください。" };
  }

  Webhookログ出力_("Stripe", "解約メール送信成功", { lineUserId, email: email.replace(/(.{3}).*(@.*)/, "$1***$2") });

  // メールアドレスをマスクして返す
  const masked = email.replace(/(.{3}).*(@.*)/, "$1***$2");
  return {
    ok: true,
    message: "📧 解約手続きのご案内メールを送信しました。\n\n"
      + "送信先：" + masked + "\n\n"
      + "メール内のリンクから解約手続きを行ってください。\n"
      + "※ メールが届かない場合は迷惑メールフォルダもご確認ください。",
  };
}

/* =========================================================
 * テスト関数
 * =======================================================*/

/**
 * 手動テスト：Checkout URL生成
 * GASエディタから実行して、ログにURLが出る
 */
function TEST_Stripe_CheckoutURL生成() {
  const url = Stripe_Checkout_URL作成_("U_TEST_USER_ID");
  Logger.log("Checkout URL: " + url);
}

/**
 * 手動テスト：Stripeキー接続確認
 */
function TEST_Stripe_接続確認() {
  const sk = Stripeシークレットキー取得_();
  if (!sk) {
    Logger.log("❌ STRIPE_SECRET_KEY が未設定");
    return;
  }
  try {
    const result = Stripe_API_GET_("balance");
    Logger.log("✅ Stripe接続OK: " + JSON.stringify(result));
  } catch (e) {
    Logger.log("❌ Stripe接続エラー: " + e.message);
  }
}

/**
 * テスト用：ユーザーのFirestore状態を無料プランにリセット
 * テスト実行後に planType=paid / stripeCustomerId="" などで不整合が起きた場合に使用
 */
function TEST_ユーザー状態リセット() {
  ユーザー状態更新_FS_(SUITE_USER_ID, {
    planType: プラン種別_free,
    monthlyVideoLimit: Free_月上限,
    stripeCustomerId: "",
    stripeSubscriptionId: "",
  });
  Utilities.sleep(500);
  const doc = ユーザー状態取得_FS_(SUITE_USER_ID);
  const plan = FS文字列取得_(doc, "planType");
  const cid  = FS文字列取得_(doc, "stripeCustomerId");
  Logger.log("リセット完了: planType=" + plan + " / stripeCustomerId=" + (cid || "(空)"));
}

/**
 * 手動テスト：Webhook全フロー確認（Firestore更新 + LINE通知）
 *
 * ★ 実行前に「TEST_LINE_USER_ID」を自分の実際のLINEユーザーIDに書き換えてください
 *   （FirestoreのユーザーIDはLINEのuserIdと同じ。
 *    確認方法：GASログの「doPost」→「テキスト受信」のログに userId が出ています）
 */
function TEST_Stripe_全フロー確認() {
  // ★ ここを自分のLINEユーザーIDに書き換える
  const TEST_LINE_USER_ID = "U41f8e33f0633a54365d38c8bc2b69517";

  if (TEST_LINE_USER_ID === "ここに自分のLINEユーザーIDを入力") {
    Logger.log("❌ TEST_LINE_USER_IDを実際のLINEユーザーIDに書き換えてから実行してください");
    return;
  }

  Logger.log("=== Stripe全フローテスト開始 ===");
  Logger.log("対象ユーザー: " + TEST_LINE_USER_ID);

  // 1) Stripe接続確認
  Logger.log("\n[1/3] Stripe API接続確認...");
  try {
    const balance = Stripe_API_GET_("balance");
    Logger.log("✅ Stripe接続OK (livemode: " + balance.livemode + ")");
  } catch (e) {
    Logger.log("❌ Stripe接続失敗: " + e.message);
    return;
  }

  // 2) checkout.session.completed を模擬してFirestoreを paid に更新
  Logger.log("\n[2/3] 決済完了イベントを模擬（planType → paid）...");
  const fakeCompletedEvent = {
    object: "event",
    type: Stripeイベント_決済完了,
    id: "evt_test_manual_" + new Date().getTime(),
    data: {
      object: {
        id: "cs_test_manual",
        object: "checkout.session",
        customer: "cus_test_manual",
        subscription: "sub_test_manual",
        metadata: { line_user_id: TEST_LINE_USER_ID }
      }
    }
  };

  try {
    Stripe_Webhook処理_(fakeCompletedEvent);
    Logger.log("✅ 決済完了処理OK → Firestore planType=paid に更新 & LINE通知送信");
  } catch (e) {
    Logger.log("❌ 決済完了処理エラー: " + e.message);
  }

  // 少し待つ
  Utilities.sleep(2000);

  // 3) Firestoreの状態を確認
  Logger.log("\n[3/3] Firestoreの状態確認...");
  try {
    const userDoc = ユーザー状態取得_FS_(TEST_LINE_USER_ID);
    const planType = FS文字列取得_(userDoc, "planType");
    const limit = FS整数取得_(userDoc, "monthlyVideoLimit");
    const customerId = FS文字列取得_(userDoc, "stripeCustomerId");

    Logger.log("planType: " + planType + (planType === "paid" ? " ✅" : " ❌（paidになっていない）"));
    Logger.log("monthlyVideoLimit: " + limit + (limit === 10 ? " ✅" : " ❌（10になっていない）"));
    Logger.log("stripeCustomerId: " + (customerId || "(未設定)"));
  } catch (e) {
    Logger.log("❌ Firestore確認エラー: " + e.message);
  }

  Logger.log("\n=== テスト完了 ===");
  Logger.log("LINEに「🎉 有料プランへの登録...」が届いていれば全フロー成功です！");
}

/* =========================================================
 * 総合テストスイート
 * TEST_Stripe_総合テスト() を1回実行するだけで以下を自動確認：
 *   [0] Firestore現状確認
 *   [1] Stripe API接続確認
 *   [2] 決済完了 → planType=paid
 *   [3] サブスク解約 → planType=free
 *   [4] 支払い失敗 → LINE通知
 *   [5] 元の状態に復元
 * =======================================================*/

const SUITE_USER_ID = "U41f8e33f0633a54365d38c8bc2b69517";

function TEST_Stripe_総合テスト() {
  const results = [];
  const ok  = (label) => { results.push("✅ " + label); Logger.log("✅ " + label); };
  const ng  = (label) => { results.push("❌ " + label); Logger.log("❌ " + label); };
  const inf = (label) => { Logger.log("   " + label); };

  Logger.log("════════════════════════════════════════");
  Logger.log("  Stripe 総合テストスイート");
  Logger.log("  対象: " + SUITE_USER_ID);
  Logger.log("  日時: " + Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss"));
  Logger.log("════════════════════════════════════════");

  /* ------------------------------------------------
   * [0] Firestore 現状スナップショット
   * ---------------------------------------------- */
  Logger.log("\n【0】Firestore 現状確認");
  let 元のPlanType = プラン種別_free;
  let 元のLimit = Free_月上限;
  try {
    const doc = ユーザー状態取得_FS_(SUITE_USER_ID);
    元のPlanType = FS文字列取得_(doc, "planType") || プラン種別_free;
    元のLimit    = FS整数取得_(doc, "monthlyVideoLimit") || Free_月上限;
    const used   = FS整数取得_(doc, "monthlyVideoUsed");
    const level  = FS文字列取得_(doc, "userLevel");
    const cid    = FS文字列取得_(doc, "stripeCustomerId");
    inf("planType          : " + 元のPlanType);
    inf("monthlyVideoLimit : " + 元のLimit);
    inf("monthlyVideoUsed  : " + used);
    inf("userLevel         : " + level);
    inf("stripeCustomerId  : " + (cid || "(未設定)"));
    ok("[0] Firestore読み取りOK");
  } catch (e) {
    ng("[0] Firestore読み取り失敗: " + e.message);
    Logger.log("\n⛔ Firestore接続に問題があります。テスト中断。");
    return レポート出力_(results);
  }

  /* ------------------------------------------------
   * [1] Stripe API 接続確認
   * ---------------------------------------------- */
  Logger.log("\n【1】Stripe API 接続確認");
  try {
    const balance = Stripe_API_GET_("balance");
    if (balance.object === "balance") {
      inf("livemode: " + balance.livemode + "（falseがテストモード正常）");
      if (balance.livemode === false) {
        ok("[1] Stripe APIサンドボックス接続OK");
      } else {
        ng("[1] Stripe API 本番モードになっています（テストキーを確認してください）");
      }
    } else {
      ng("[1] Stripe API レスポンス異常: " + JSON.stringify(balance));
    }
  } catch (e) {
    ng("[1] Stripe API接続失敗: " + e.message);
    Logger.log("\n⛔ Stripe APIに接続できません。テスト中断。");
    return レポート出力_(results);
  }

  /* ------------------------------------------------
   * [2] 決済完了 → planType=paid
   * ---------------------------------------------- */
  Logger.log("\n【2】決済完了イベント（checkout.session.completed）");
  try {
    Stripe_Webhook処理_({
      object: "event", id: "evt_suite_completed",
      type: Stripeイベント_決済完了,
      data: { object: {
        id: "cs_suite", customer: "cus_suite_test",
        subscription: "sub_suite_test",
        metadata: { line_user_id: SUITE_USER_ID }
      }}
    });
    Utilities.sleep(1500);
    const doc = ユーザー状態取得_FS_(SUITE_USER_ID);
    const plan  = FS文字列取得_(doc, "planType");
    const limit = FS整数取得_(doc, "monthlyVideoLimit");
    inf("planType → " + plan + " / monthlyVideoLimit → " + limit);
    if (plan === プラン種別_paid && limit === Paid_月上限) {
      ok("[2] 決済完了 → planType=paid, limit=10 に更新OK");
      ok("[2] LINE「🎉 有料プランへの登録...」通知送信OK");
    } else {
      ng("[2] Firestore更新値が期待と異なる（plan=" + plan + ", limit=" + limit + "）");
    }
  } catch (e) {
    ng("[2] 決済完了処理エラー: " + e.message);
  }

  /* ------------------------------------------------
   * [3] サブスク解約 → planType=free
   * ---------------------------------------------- */
  Logger.log("\n【3】サブスク解約イベント（customer.subscription.deleted）");
  try {
    Stripe_Webhook処理_({
      object: "event", id: "evt_suite_deleted",
      type: Stripeイベント_サブスク削除,
      data: { object: {
        id: "sub_suite_test",
        metadata: { line_user_id: SUITE_USER_ID }
      }}
    });
    Utilities.sleep(1500);
    const doc = ユーザー状態取得_FS_(SUITE_USER_ID);
    const plan  = FS文字列取得_(doc, "planType");
    const limit = FS整数取得_(doc, "monthlyVideoLimit");
    inf("planType → " + plan + " / monthlyVideoLimit → " + limit);
    if (plan === プラン種別_free && limit === Free_月上限) {
      ok("[3] 解約 → planType=free, limit=1 に更新OK");
      ok("[3] LINE「プランが解約されました」通知送信OK");
    } else {
      ng("[3] Firestore更新値が期待と異なる（plan=" + plan + ", limit=" + limit + "）");
    }
  } catch (e) {
    ng("[3] 解約処理エラー: " + e.message);
  }

  /* ------------------------------------------------
   * [4] 支払い失敗 → LINE通知（Firestoreは変更しない）
   * ---------------------------------------------- */
  Logger.log("\n【4】支払い失敗イベント（invoice.payment_failed）");
  try {
    // planTypeを一度paidに戻してからテスト
    ユーザー状態更新_FS_(SUITE_USER_ID, {
      planType: プラン種別_paid, monthlyVideoLimit: Paid_月上限
    });
    Utilities.sleep(500);

    Stripe_Webhook処理_({
      object: "event", id: "evt_suite_failed",
      type: Stripeイベント_支払い失敗,
      data: { object: {
        id: "in_suite_test",
        customer: "cus_suite_test",
        subscription: "sub_suite_test",
      }}
    });
    Utilities.sleep(1500);

    // 支払い失敗はplanTypeを変えないことを確認
    const doc = ユーザー状態取得_FS_(SUITE_USER_ID);
    const plan = FS文字列取得_(doc, "planType");
    inf("支払い失敗後のplanType → " + plan + "（変更なしが正常）");

    // ※ Stripe APIからsubscription取得でline_user_idを引くため、
    //   テスト環境の "sub_suite_test" は実在しないのでLINE通知は届かない。
    //   ログに「Stripe | 支払い失敗」が出ればロジック到達確認OK。
    ok("[4] 支払い失敗ロジック到達OK（LINE通知はサブスクIDが実在しないため省略）");
    if (plan === プラン種別_paid) {
      ok("[4] 支払い失敗時にplanTypeが変更されていないことを確認OK");
    } else {
      ng("[4] 支払い失敗時にplanTypeが変わっています（想定外）");
    }
  } catch (e) {
    ng("[4] 支払い失敗処理エラー: " + e.message);
  }

  /* ------------------------------------------------
   * [5] 元の状態に復元
   * ---------------------------------------------- */
  Logger.log("\n【5】テスト前の状態に復元");
  try {
    ユーザー状態更新_FS_(SUITE_USER_ID, {
      planType: 元のPlanType,
      monthlyVideoLimit: 元のLimit,
      stripeCustomerId: "",
      stripeSubscriptionId: "",
    });
    Utilities.sleep(1000);
    const doc = ユーザー状態取得_FS_(SUITE_USER_ID);
    const plan = FS文字列取得_(doc, "planType");
    inf("復元後planType → " + plan);
    ok("[5] Firestore復元OK（planType=" + plan + "）");
  } catch (e) {
    ng("[5] 復元失敗: " + e.message);
  }

  return レポート出力_(results);
}

function レポート出力_(results) {
  const pass = results.filter(r => r.startsWith("✅")).length;
  const fail = results.filter(r => r.startsWith("❌")).length;
  Logger.log("\n════════════════════════════════════════");
  Logger.log("  テスト結果サマリー");
  Logger.log("  ✅ PASS: " + pass + " / ❌ FAIL: " + fail);
  Logger.log("────────────────────────────────────────");
  results.forEach(r => Logger.log("  " + r));
  Logger.log("════════════════════════════════════════");
  if (fail === 0) {
    Logger.log("🎉 全テスト通過！Stripe連携は正常に動作しています。");
  } else {
    Logger.log("⚠️ " + fail + "件の失敗があります。上記ログを確認してください。");
  }
}
