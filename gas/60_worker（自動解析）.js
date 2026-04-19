/**
 * 60_worker（自動解析）.gs
 *
 * 【変更点】
 * - ④ 冪等性強化：
 *   ・解析開始時に analysisRunId を生成して保存
 *   ・analysisRunId が既にあれば「同一runの二重AI実行」を避ける（安全側にスキップ）
 *   ・sentAt があれば再送信しない
 *   ・課金確定は billingStatus=未消化（pending相当）の場合のみ実行
 * - ⑤ コメント修正：trial=月1 / subscribed=月10 に統一
 *
 * 方針：
 * - 「AI二重実行」と「二重送信」を強く抑止し、事故らない側に倒す
 * - analysisRunId が存在して reviewText が無いなど “矛盾状態” は 失敗に倒してログに残す（運用で復旧）
 */

/**
 * 実装：
 * - coachCheckText（P1〜P10観察）生成・保存
 * - 返信済み時点で dataset_items 保存
 * - 返信済み後に GCS動画削除（動画は残さない方針）
 * - trial（月1本）/ subscribed（月10本）を超えた分は ticketBalance を消費
 */

function 自動解析ワーカー() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000 * 20)) {
    Webhookログ出力_("ワーカー", "ロック中のためスキップ", {});
    return;
  }

  try {
    const 対象一覧 = 解析対象動画一覧_();

    // 処理対象がなかった時はスプレッドシートにログを書かない（毎分ワーカーでログが溜まるのを防ぐ）
    if (!対象一覧 || 対象一覧.length === 0) {
      return;
    }

    Webhookログ出力_("ワーカー", "開始", { max: ワーカー_最大件数_1回 });
    Webhookログ出力_("ワーカー", "対象抽出", {
      count: 対象一覧.length,
      ids: 対象一覧.map((x) => x.id),
      statuses: 対象一覧.map((x) => x.status),
      roles: 対象一覧.map((x) => x.role),
      types: 対象一覧.map((x) => x.analysisType),
    });

    for (const 対象 of 対象一覧) {
      try {
        if (対象.role === 動画ロール_プロ || 対象.role === 動画ロール_過去 || 対象.status === 動画ステータス_素材) {
          Webhookログ出力_("ワーカー", "素材のためスキップ", { id: 対象.id });
          continue;
        }

        for (let i = 0; i < 3; i++) {
          const 最新 = 安全に動画取得_(対象.id);
          if (!最新) break;

          const 進んだ = ステップ進行_(最新);
          if (!進んだ) break;
        }
      } catch (err) {
        Webhookログ出力_("ワーカー", "個別処理エラー", { id: 対象.id, err: String(err) });
        const 最新 = 安全に動画取得_(対象.id) || 対象;
        失敗として記録_(最新, err);
      }
    }

    Webhookログ出力_("ワーカー", "終了", {});
  } finally {
    lock.releaseLock();
  }
}

function 解析対象動画一覧_() {
  const docs = 動画_複数ステータス検索_FS_(
    [動画ステータス_受信, 動画ステータス_キュー, 動画ステータス_解析完了, 動画ステータス_失敗],
    ワーカー_最大件数_1回
  );

  return (docs || []).map((doc) => {
    const id = doc.name.split("/").pop();
    return {
      id: id,
      userId: FS文字列取得_(doc, "userId"),
      status: FS文字列取得_(doc, "status"),
      role: FS文字列取得_(doc, "role"),
      analysisType: FS文字列取得_(doc, "analysisType") || 解析種別_即解析,
      retryCount: FS整数取得_(doc, "retryCount"),
      lastTriedAt: FS時刻取得ISO_(doc, "lastTriedAt"),
      analysisRunId: FS文字列取得_(doc, "analysisRunId"),
      sentAt: FS時刻取得ISO_(doc, "sentAt"),
    };
  });
}

function ステップ進行_(動画) {
  if (動画.status === 動画ステータス_受信) {
    動画更新_FS_(動画.id, {
      status: { stringValue: 動画ステータス_キュー },
      error: { stringValue: "" },
      lastTriedAt: { timestampValue: new Date().toISOString() },
    });
    return true;
  }

  if (動画.status === 動画ステータス_キュー) {
    解析フェーズ実行_(動画.id);
    return true;
  }

  if (動画.status === 動画ステータス_解析完了) {
    送信フェーズ実行_(動画.id);
    return true;
  }

  if (動画.status === 動画ステータス_失敗) {
    if (!再試行して良いか_(動画)) return false;

    動画更新_FS_(動画.id, {
      status: { stringValue: 動画ステータス_キュー },
      error: { stringValue: "" },
      lastTriedAt: { timestampValue: new Date().toISOString() },
    });
    return true;
  }

  return false;
}

/* =========================================================
 * 解析フェーズ
 * =======================================================*/
function 解析RunId生成_() {
  const rand = Utilities.getUuid();
  return "run_" + rand;
}

function 解析フェーズ実行_(messageId) {
  const v = 動画取得_FS_(messageId);

  // ④-2 既に analysisRunId がある場合は二重AI実行を避ける（安全側）
  // ただし reviewText が既にあるなら、解析完了扱いに寄せる
  if (v.analysisRunId) {
    if (v.reviewText && String(v.reviewText).trim()) {
      Webhookログ出力_("ワーカー", "analysisRunId既存＋reviewあり：解析完了へ寄せる", { id: v.id, runId: v.analysisRunId });
      動画更新_FS_(v.id, {
        status: { stringValue: 動画ステータス_解析完了 },
        error: { stringValue: "" },
        lastTriedAt: { timestampValue: new Date().toISOString() },
      });
      return;
    }
    // runIdだけあってreviewが無いのは矛盾（事故）。AI再実行はしない方針なので失敗に倒す。
    throw new Error("analysisRunId が既に存在しますが reviewText がありません（冪等性保護でAI再実行しません）");
  }

  const runId = 解析RunId生成_();

  // ④-1 解析開始時に analysisRunId を確定（以降の二重実行を抑止）
  動画更新_FS_(v.id, {
    analysisRunId: { stringValue: runId },
    status: { stringValue: 動画ステータス_解析中 },
    error: { stringValue: "" },
    lastTriedAt: { timestampValue: new Date().toISOString() },
  });

  // テストモード：AIは呼ばず stub で解析完了まで進める
  if (テストモード有効か_()) {
    解析フェーズ_テストモード実行_(v);
    return;
  }

  const 種別 = v.analysisType || 解析種別_即解析;
  const 自分GCS = v.gcsPath;
  const プロGCS = v.proGcsUri;
  const モード = v.actionModeSnapshot || "";
  const メッセージモード = v.messageModeSnapshot || "";

  let reviewText = "";

  // ====================================================================
  // 【改修】全モード swing-analyzer 1回呼び出しで完結
  // - 動画 + プロンプトをまとめて Gemini に渡し、整形済み回答を直接受け取る
  // - text-answer 呼び出しは廃止
  // ====================================================================

  // プロ比較モード（プロ動画 vs 自分動画）
  if (モード === 動作モード_比較) {
    if (!プロGCS) throw new Error("比較：proGcsUri が空です");
    if (!自分GCS) throw new Error("比較：gcsPath（自分動画）が空です");

    const promptText = プロンプト_比較_動画直接_(v.userMessage || "");
    const label = v.userMessage ? "プロ比較_テキストあり_動画直接" : "プロ比較_動画直接";
    try {
      AIプロンプトログ出力_(String(v.id || ""), String(v.userId || ""), String(promptText), label);
    } catch (e) {}
    reviewText = 動画解析_Gemini_2本_(プロGCS, 自分GCS, promptText);

  // 過去比較モード（過去動画 vs 今回動画）
  } else if (モード === 動作モード_過去比較) {
    if (!自分GCS) throw new Error("過去比較：gcsPath（今回動画）が空です");
    const 過去GCS = v.prevGcsUri;
    if (!過去GCS) throw new Error("過去比較：prevGcsUri（過去動画）が空です");

    const promptText = プロンプト_過去比較_動画直接_(v.userMessage || "");
    const label = v.userMessage ? "過去比較_テキストあり_動画直接" : "過去比較_動画直接";
    try {
      AIプロンプトログ出力_(String(v.id || ""), String(v.userId || ""), String(promptText), label);
    } catch (e) {}
    reviewText = 動画解析_Gemini_2本_(過去GCS, 自分GCS, promptText);

  } else if (モード === 動作モード_質問) {
    if (!自分GCS) throw new Error("質問モード：gcsPath（自分動画）が空です");

    const promptText = プロンプト_質問モード_動画直接_(v.userMessage || "");
    try {
      AIプロンプトログ出力_(String(v.id || ""), String(v.userId || ""), String(promptText), "質問モード_動画直接");
    } catch (e) {}
    reviewText = 動画解析_Gemini_(自分GCS, promptText);

  } else {
    if (!自分GCS) throw new Error("自分解析：gcsPath（自分動画）が空です");

    let promptText, label;
    if (v.userMessage) {
      promptText = プロンプト_自分解析_テキストあり_動画直接_(v.userMessage);
      label = "自分解析_テキストあり_動画直接";
    } else {
      promptText = プロンプト_自分解析_単体_動画直接_();
      label = "自分解析_動画直接";
    }
    try {
      AIプロンプトログ出力_(String(v.id || ""), String(v.userId || ""), String(promptText), label);
    } catch (e) {}
    reviewText = 動画解析_Gemini_(自分GCS, promptText);
  }

  if (!reviewText || String(reviewText).trim() === "") throw new Error("reviewText が空です");

  // v2: P1〜P10コーチ観察は一旦スキップ（API代節約。将来L2で復活予定）
  // const coachCheckText = コーチ観察P1toP10_生成_(v.userId, reviewText);
  const coachCheckText = "";

  動画更新_FS_(v.id, {
    status: { stringValue: 動画ステータス_解析完了 },
    reviewText: { stringValue: String(reviewText) },
    coachCheckText: { stringValue: String(coachCheckText || "") },
    error: { stringValue: "" },
    lastTriedAt: { timestampValue: new Date().toISOString() },
  });

  // テスト用：AIの返答（解析結果）を主キー付きで別シートに記録（プロンプトログと紐付け可能）
  try {
    解析結果ログ出力_(v.id, String(reviewText), String(coachCheckText || ""));
  } catch (e) {}
}

/**
 * テストモード用：6モードを判定し、送る予定だったプロンプトとテスト用返答をログに記録する。
 * AIは呼ばず stub で解析完了にする。以降の送信・課金確定・dataset・GCS削除は通常どおり。
 */
function 解析フェーズ_テストモード実行_(v) {
  const 種別 = v.analysisType || 解析種別_即解析;
  const モード = v.actionModeSnapshot || "";
  const メッセージモード = v.messageModeSnapshot || "";

  // 【改修】動画直接版プロンプトを使用（解析テキスト中間表現は廃止）
  let label = "自分解析_動画直接";
  let promptText = プロンプト_自分解析_単体_動画直接_();

  if (モード === 動作モード_比較) {
    label = v.userMessage ? "プロ比較_テキストあり_動画直接" : "プロ比較_動画直接";
    promptText = プロンプト_比較_動画直接_(v.userMessage || "");
  } else if (モード === 動作モード_過去比較) {
    label = v.userMessage ? "過去比較_テキストあり_動画直接" : "過去比較_動画直接";
    promptText = プロンプト_過去比較_動画直接_(v.userMessage || "");
  } else if (モード === 動作モード_質問) {
    label = "質問モード_動画直接";
    promptText = プロンプト_質問モード_動画直接_(v.userMessage || "");
  } else if (v.userMessage) {
    label = "自分解析_テキストあり_動画直接";
    promptText = プロンプト_自分解析_テキストあり_動画直接_(v.userMessage);
  } else {
    label = "自分解析_動画直接";
    promptText = プロンプト_自分解析_単体_動画直接_();
  }

  try {
    AIプロンプトログ出力_(v.id, v.userId || "", promptText, label, true);
  } catch (e) {}

  const stubReview = "[テスト用・" + label + "] 解析はスキップしました。";
  const stubCoach = "P1〜P10: テスト用のためスキップ";

  動画更新_FS_(v.id, {
    status: { stringValue: 動画ステータス_解析完了 },
    reviewText: { stringValue: stubReview },
    coachCheckText: { stringValue: stubCoach },
    error: { stringValue: "" },
    lastTriedAt: { timestampValue: new Date().toISOString() },
  });
  try {
    解析結果ログ出力_(v.id, stubReview, stubCoach, true);
  } catch (e) {}
  Webhookログ出力_("ワーカー", "テストモード：解析スキップ", { id: v.id, label });
}

function コーチ観察P1toP10_生成_(userId, reviewText) {
  const promptText = プロンプト_コーチ観察P1toP10_(reviewText);
  const out = テキスト回答_AI_(userId, promptText, "コーチ観察", undefined);
  return String(out || "").trim();
}

/* =========================================================
 * 送信フェーズ
 * =======================================================*/
function 送信フェーズ実行_(messageId) {
  const v = 動画取得_FS_(messageId);

  // ④-3 sentAt があれば再送信しない（冪等性）
  if (v.sentAt) {
    Webhookログ出力_("送信", "sentAt既存のため再送スキップ", { videoId: v.id, sentAt: v.sentAt });
    // 状態だけは揃える（返信済みに寄せる）
    動画更新_FS_(v.id, {
      status: { stringValue: 動画ステータス_レビュー送信済み },
      error: { stringValue: "" },
      lastTriedAt: { timestampValue: new Date().toISOString() },
    });
    return;
  }

  const text = String(v.reviewText || "").trim();
  if (!text) throw new Error("reviewText がありません");

  // 現在の課金状態（pending相当は 未消化）
  const doc = 動画ドキュメント取得_FS_(v.id);
  const 現在の課金状態 = FS文字列取得_(doc, "billingStatus") || 課金消化状態_未消化;
  const 申告プラン = FS文字列取得_(doc, "billingPlanSnapshot") || プラン種別_free;

  // テストモード時はユーザーにはテスト用メッセージだけ返す（内部処理は通常どおり）
  const sendText = テストモード有効か_()
    ? LINE送信用整形_(テストモード_返信文)
    : LINE送信用整形_(text);

  // 送信（sentAt付与）
  LINEプッシュ送信実行_(v.userId, sendText);
  const nowIso = new Date().toISOString();

  動画更新_FS_(v.id, {
    status: { stringValue: 動画ステータス_レビュー送信済み },
    error: { stringValue: "" },
    lastTriedAt: { timestampValue: nowIso },
    sentAt: { timestampValue: nowIso }, // ★追加
    billingStatus: { stringValue: 課金消化状態_消化済み },
  });

  ユーザー状態更新_FS_(v.userId, {
    state: ユーザー状態_待機,
    pendingStep: ステップ_なし,
    currentVideoMessageId: v.id,
    targetMessageIdForText: "",
  });

  // ④-4 課金確定は billingStatus が pending（未消化）の場合のみ実行
  if (現在の課金状態 === 課金消化状態_未消化) {
    const userDoc = ユーザー状態取得_FS_(v.userId);
    const limit = FS整数取得_(userDoc, "monthlyVideoLimit") || 10;
    const used = FS整数取得_(userDoc, "monthlyVideoUsed") || 0;
    const ticket = FS整数取得_(userDoc, "ticketBalance") || 0;

    if (申告プラン === "クーポン") {
      const couponRem = FS整数取得_(userDoc, "couponRemaining") || 0;
      if (couponRem > 0) {
        ユーザー状態更新_FS_(v.userId, { couponRemaining: couponRem - 1 });
        Webhookログ出力_("課金", "クーポン消費", { userId: v.userId, before: couponRem, after: couponRem - 1, videoId: v.id });
      } else {
        Webhookログ出力_("課金", "クーポン残数不足（想定外）", { userId: v.userId, videoId: v.id });
      }
    } else if (申告プラン === プラン種別_チケット) {
      if (ticket > 0) {
        ユーザー状態更新_FS_(v.userId, { ticketBalance: ticket - 1 });
        Webhookログ出力_("課金", "チケット消費", { userId: v.userId, before: ticket, after: ticket - 1, videoId: v.id });
      } else {
        Webhookログ出力_("課金", "チケット不足（想定外）", { userId: v.userId, videoId: v.id });
      }
    } else {
      if (used < limit) {
        ユーザー状態更新_FS_(v.userId, { monthlyVideoUsed: used + 1 });
        Webhookログ出力_("課金", "月利用回数を加算", { userId: v.userId, before: used, after: used + 1, videoId: v.id });
      } else if (ticket > 0) {
        ユーザー状態更新_FS_(v.userId, { ticketBalance: ticket - 1 });
        Webhookログ出力_("課金", "月超過のためチケット消費（保険）", { userId: v.userId, before: ticket, after: ticket - 1, videoId: v.id });
      }
    }
  } else {
    Webhookログ出力_("課金", "billingStatusが未消化ではないため課金確定スキップ", { videoId: v.id, billingStatus: 現在の課金状態 });
  }

  // v2: dataset_items保存は一旦スキップ（将来L2で復活予定）
  // try {
  //   const r = データセット項目_動画から作成_(v.id);
  //   Webhookログ出力_("データセット", "dataset_items 保存", { videoId: v.id, result: r });
  // } catch (dsErr) {
  //   Webhookログ出力_("データセット", "dataset_items 保存失敗", { videoId: v.id, err: String(dsErr) });
  // }

  try {
    if (!v.videoDeleted && v.gcsPath) {
      const del = GCS削除_(v.gcsPath);
      Webhookログ出力_("動画削除", "GCS削除", { videoId: v.id, gcsPath: v.gcsPath, result: del });

      // プロ比較のプロ動画GCSも削除
      if (v.proGcsUri) {
        try { GCS削除_(v.proGcsUri); } catch (e) {}
      }
      // 過去比較の過去動画GCSも削除
      if (v.prevGcsUri) {
        try { GCS削除_(v.prevGcsUri); } catch (e) {}
      }

      動画更新_FS_(v.id, {
        gcsPath: { stringValue: "" },
        proGcsUri: { stringValue: "" },
        prevGcsUri: { stringValue: "" },
        videoDeleted: { booleanValue: true },
      });
    }
  } catch (delErr) {
    Webhookログ出力_("動画削除", "削除失敗", { videoId: v.id, err: String(delErr) });
  }
}

function 失敗として記録_(動画, err) {
  const 次回 = Number(動画.retryCount || 0) + 1;

  動画更新_FS_(動画.id, {
    status: { stringValue: 動画ステータス_失敗 },
    retryCount: { integerValue: String(次回) },
    error: { stringValue: String(err) },
    lastTriedAt: { timestampValue: new Date().toISOString() },
  });

  if (動画.userId) ユーザー状態更新_FS_(動画.userId, { state: ユーザー状態_待機 });

  Webhookログ出力_("ワーカー", "失敗として記録", { id: 動画.id, retryCount: 次回, err: String(err) });

  // 最大リトライ超過 → ユーザーに失敗通知（利用回数は未消費であることを伝える）
  if (次回 >= 最大リトライ回数 && 動画.userId) {
    try {
      LINEプッシュ送信実行_(動画.userId,
        "⚠️ 動画の解析に失敗しました\n\n"
        + "申し訳ありません。送信いただいた動画の解析中にエラーが発生しました。\n\n"
        + "💡 利用回数は消費されていませんのでご安心ください。\n\n"
        + "お手数ですが、もう一度動画を送り直してみてください。\n"
        + "改善しない場合は「問い合わせ」からご連絡ください。"
      );
      Webhookログ出力_("ワーカー", "失敗通知をユーザーに送信", { userId: 動画.userId, videoId: 動画.id });
    } catch (notifyErr) {
      Webhookログ出力_("ワーカー", "失敗通知の送信に失敗", { userId: 動画.userId, err: String(notifyErr) });
    }
  }
}

function 再試行して良いか_(動画) {
  const 回数 = Number(動画.retryCount || 0);
  if (回数 >= 最大リトライ回数) return false;

  const last = 動画.lastTriedAt ? Date.parse(動画.lastTriedAt) : 0;
  const now = Date.now();

  const waitMs = 5 * 60 * 1000;
  if (last && now - last < waitMs) return false;

  return true;
}

function LINE送信用整形_(txt) {
  let out = String(txt || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (out.length > 4800) out = out.slice(0, 4800) + "\n…（長いので続きは短く聞いてね）";
  return out;
}

function 安全に動画取得_(messageId) {
  try { return 動画取得_FS_(messageId); } catch (e) { return null; }
}
