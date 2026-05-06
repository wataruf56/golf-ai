/**
 * 10_Firestore操作.gs
 *
 * 【変更点（今回）】
 * - データセット項目_自由質問シグナル加算_ 内の、文法エラーになる不要行を削除
 * - sentAt は「未設定＝フィールド無し」方針（Firestore RESTの都合で空timestampを持たない）
 */

function FirestoreドキュメントURL作成_(プロジェクトID, コレクションID, ドキュメントID) {
  return `https://firestore.googleapis.com/v1/projects/${プロジェクトID}/databases/(default)/documents/${コレクションID}/${ドキュメントID}`;
}

function Firestore通信_(URL, メソッド, ボディ) {
  const トークン = ScriptApp.getOAuthToken();
  const opt = {
    method: メソッド,
    headers: { Authorization: `Bearer ${トークン}` },
    muteHttpExceptions: true,
  };
  if (ボディ) {
    opt.contentType = "application/json";
    opt.payload = JSON.stringify(ボディ);
  }
  const res = UrlFetchApp.fetch(URL, opt);
  const code = res.getResponseCode();
  const text = res.getContentText();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { code, text, json };
}

function FS文字列取得_(doc, key) {
  return doc?.fields?.[key]?.stringValue ?? "";
}
function FS整数取得_(doc, key) {
  const v = doc?.fields?.[key]?.integerValue;
  return v === undefined ? 0 : Number(v);
}
function FS真偽取得_(doc, key) {
  const v = doc?.fields?.[key]?.booleanValue;
  if (v === undefined) return false;
  return !!v;
}
function FS時刻取得ISO_(doc, key) {
  return doc?.fields?.[key]?.timestampValue ?? "";
}

function 月上限_プランから決定_(planType) {
  const p = String(planType || プラン種別_free);

  // 新方式：free / paid
  if (p === プラン種別_paid) return Paid_月上限;
  if (p === プラン種別_free) return Free_月上限;

  // 互換性維持：旧値（トライアル/subscribed）が残っている場合のフォールバック
  if (p === "トライアル") return Free_月上限;
  if (p === "subscribed") return Paid_月上限;

  // 不明値は安全側で free 扱い
  return Free_月上限;
}

/* =========================================================
 * user_state
 * =======================================================*/
function ユーザー状態_取得または作成_FS_(ユーザーID) {
  const URL = FirestoreドキュメントURL作成_(
    GCPプロジェクトID,
    Firestoreコレクション_ユーザー状態,
    ユーザーID
  );

  const now = new Date();
  const 月キー = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM");

  const get = Firestore通信_(URL, "get");
  if (get.code === 200 && get.json) {
    const 現在月 = FS文字列取得_(get.json, "monthlyKey");
    const planType = FS文字列取得_(get.json, "planType") || プラン種別_free;
    const limit = 月上限_プランから決定_(planType);

    if (現在月 && 現在月 !== 月キー) {
      ユーザー状態更新_FS_(ユーザーID, {
        monthlyKey: 月キー,
        monthlyVideoUsed: 0,
        monthlyVideoLimit: limit,
        state: ユーザー状態_待機,
      });
      return Firestore通信_(URL, "get").json;
    }

    const 現limit = FS整数取得_(get.json, "monthlyVideoLimit");
    if (現limit !== limit) {
      ユーザー状態更新_FS_(ユーザーID, { monthlyVideoLimit: limit });
      return Firestore通信_(URL, "get").json;
    }

    return get.json;
  }

  const 作成URL =
    `https://firestore.googleapis.com/v1/projects/${GCPプロジェクトID}/databases/(default)/documents/${Firestoreコレクション_ユーザー状態}?documentId=${encodeURIComponent(
      ユーザーID
    )}`;

  const 初期plan = プラン種別_free;
  const 初期limit = 月上限_プランから決定_(初期plan);

  const body = {
    fields: {
      userId: { stringValue: ユーザーID },

      state: { stringValue: ユーザー状態_待機 },
      pendingStep: { stringValue: ステップ_なし },
      actionMode: { stringValue: "" },
      messageMode: { stringValue: "" },
      currentVideoMessageId: { stringValue: "" },
      proVideoMessageId: { stringValue: "" },
      targetMessageIdForText: { stringValue: "" },

      userLevel: { stringValue: ユーザーレベル_未設定 },

      planType: { stringValue: 初期plan },
      monthlyKey: { stringValue: 月キー },
      monthlyVideoLimit: { integerValue: String(初期limit) },
      monthlyVideoUsed: { integerValue: "0" },
      ticketBalance: { integerValue: "0" },

      updatedAt: { timestampValue: now.toISOString() },
    },
  };

  Firestore通信_(作成URL, "post", body);
  return Firestore通信_(URL, "get").json;
}

function ユーザー状態取得_FS_(ユーザーID) {
  return ユーザー状態_取得または作成_FS_(ユーザーID);
}

function ユーザー状態更新_FS_(ユーザーID, data) {
  const URL = FirestoreドキュメントURL作成_(
    GCPプロジェクトID,
    Firestoreコレクション_ユーザー状態,
    ユーザーID
  );

  const fields = {};
  Object.keys(data || {}).forEach((k) => {
    const v = data[k];
    if (typeof v === "number") fields[k] = { integerValue: String(v) };
    else if (typeof v === "boolean") fields[k] = { booleanValue: !!v };
    else fields[k] = { stringValue: String(v) };
  });
  fields.updatedAt = { timestampValue: new Date().toISOString() };

  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");

  Firestore通信_(`${URL}?${mask}`, "patch", { fields });
}

/* =========================================================
 * videos
 * =======================================================*/
function 動画ドキュメントURL作成_(メッセージID) {
  return FirestoreドキュメントURL作成_(
    GCPプロジェクトID,
    Firestoreコレクション_動画,
    メッセージID
  );
}

function 動画更新_FS_(メッセージID, フィールドObj) {
  const URL = 動画ドキュメントURL作成_(メッセージID);
  const fields = { ...フィールドObj, updatedAt: { timestampValue: new Date().toISOString() } };

  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");

  Firestore通信_(`${URL}?${mask}`, "patch", { fields });
}

function 動画ドキュメント取得_FS_(メッセージID) {
  const URL = 動画ドキュメントURL作成_(メッセージID);
  const res = Firestore通信_(URL, "get");
  if (res.code !== 200 || !res.json) throw new Error(`動画取得失敗: ${res.code}`);
  return res.json;
}

/* =========================================================
 * 不足関数群：正式実装
 * =======================================================*/

function 動画_受信として登録_FS_(p) {
  const userId = String(p?.userId || "");
  const messageId = String(p?.messageId || "");
  const gcsPath = String(p?.gcsPath || "");
  const sizeBytes = Number(p?.sizeBytes || 0);

  if (!userId || !messageId) throw new Error("動画_受信として登録_FS_: userId/messageId が必須です");

  const 作成URL =
    `https://firestore.googleapis.com/v1/projects/${GCPプロジェクトID}/databases/(default)/documents/${Firestoreコレクション_動画}?documentId=${encodeURIComponent(
      messageId
    )}`;

  const nowIso = new Date().toISOString();

  const body = {
    fields: {
      userId: { stringValue: userId },
      messageId: { stringValue: messageId },

      status: { stringValue: 動画ステータス_受信 },
      role: { stringValue: "" },
      analysisType: { stringValue: "" },

      gcsPath: { stringValue: gcsPath },
      proGcsUri: { stringValue: "" },

      sizeBytes: { integerValue: String(sizeBytes) },

      analysisRunId: { stringValue: "" },
      // sentAt は未設定時はフィールド自体を作らない（空timestampは避ける）

      billingStatus: { stringValue: 課金消化状態_未消化 },
      billingPlanSnapshot: { stringValue: "" },

      retryCount: { integerValue: "0" },
      error: { stringValue: "" },
      lastTriedAt: { timestampValue: nowIso },

      videoDeleted: { booleanValue: false },

      createdAt: { timestampValue: nowIso },
      updatedAt: { timestampValue: nowIso },
    },
  };

  const res = Firestore通信_(作成URL, "post", body);
  return { code: res.code, text: res.text };
}

function 動画取得_FS_(messageId) {
  const doc = 動画ドキュメント取得_FS_(messageId);
  const id = doc.name.split("/").pop();

  return {
    id,
    userId: FS文字列取得_(doc, "userId"),
    messageId: FS文字列取得_(doc, "messageId") || id,

    status: FS文字列取得_(doc, "status"),
    role: FS文字列取得_(doc, "role"),
    analysisType: FS文字列取得_(doc, "analysisType") || 解析種別_即解析,

    gcsPath: FS文字列取得_(doc, "gcsPath"),
    proGcsUri: FS文字列取得_(doc, "proGcsUri"),
    prevGcsUri: FS文字列取得_(doc, "prevGcsUri"),

    userMessage: FS文字列取得_(doc, "userMessage"),
    reviewText: FS文字列取得_(doc, "reviewText"),
    coachCheckText: FS文字列取得_(doc, "coachCheckText"),
    actionModeSnapshot: FS文字列取得_(doc, "actionModeSnapshot"),
    messageModeSnapshot: FS文字列取得_(doc, "messageModeSnapshot"),

    analysisRunId: FS文字列取得_(doc, "analysisRunId"),
    sentAt: FS時刻取得ISO_(doc, "sentAt"),

    billingPlanSnapshot: FS文字列取得_(doc, "billingPlanSnapshot"),
    billingStatus: FS文字列取得_(doc, "billingStatus"),

    videoDeleted: FS真偽取得_(doc, "videoDeleted"),

    // ポーズ描画（pose-renderer）の生成物
    poseVideoUrl: FS文字列取得_(doc, "poseVideoUrl"),
    poseCompareUrl: FS文字列取得_(doc, "poseCompareUrl"),
    posePriorityPhase: FS文字列取得_(doc, "posePriorityPhase"),

    retryCount: FS整数取得_(doc, "retryCount"),
    lastTriedAt: FS時刻取得ISO_(doc, "lastTriedAt"),
    error: FS文字列取得_(doc, "error"),
  };
}

/**
 * videos: 複数ステータス検索（worker用）
 * - Firestoreの複合インデックス不足で落ちやすいので、orderByは付けない
 * - 並び替えはクライアント側（GAS側）で updatedAt を見て行う
 * - 失敗時はログに残して「0件に見える事故」を防ぐ
 */
function 動画_複数ステータス検索_FS_(statuses, limit) {
  const st = (statuses || []).map(String).filter(Boolean);
  const lim = Math.max(1, Number(limit || 10));

  const URL = `https://firestore.googleapis.com/v1/projects/${GCPプロジェクトID}/databases/(default)/documents:runQuery`;

  const statusFilter =
    st.length === 1
      ? { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: st[0] } } }
      : {
          fieldFilter: {
            field: { fieldPath: "status" },
            op: "IN",
            value: {
              arrayValue: { values: st.map((x) => ({ stringValue: x })) },
            },
          },
        };

  // ★orderBy を付けない（複合インデックス依存を避ける）
  const body = {
    structuredQuery: {
      from: [{ collectionId: Firestoreコレクション_動画 }],
      where: statusFilter,
      limit: lim,
    },
  };

  const res = Firestore通信_(URL, "post", body);

  // ★失敗を0件扱いにしない（事故防止）
  if (res.code !== 200) {
    Webhookログ出力_("Firestore", "runQuery失敗（動画_複数ステータス検索_FS_）", {
      code: res.code,
      bodyHead: String(res.text || "").slice(0, 300),
      statuses: st,
      limit: lim,
    });
    return [];
  }

  const arr = res.json || [];
  const docs = arr.map((x) => x.document).filter(Boolean);

  // ★GAS側で updatedAt っぽい時刻で並べ替え（無ければ最後）
  docs.sort((a, b) => {
    const ta = a?.fields?.updatedAt?.timestampValue ? Date.parse(a.fields.updatedAt.timestampValue) : 0;
    const tb = b?.fields?.updatedAt?.timestampValue ? Date.parse(b.fields.updatedAt.timestampValue) : 0;
    return ta - tb;
  });

  return docs;
}

/**
 * 同一 userId の videos のうち status=返信済み の直近1件を取得
 * - sentAt があれば sentAt 優先
 * - 無ければ createdAt を使用
 */
function 動画_直近返信済み1件取得_FS_(userId) {
  const uid = String(userId || "");
  if (!uid) return null;

  const URL = `https://firestore.googleapis.com/v1/projects/${GCPプロジェクトID}/databases/(default)/documents:runQuery`;

  const body = {
    structuredQuery: {
      from: [{ collectionId: Firestoreコレクション_動画 }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "userId" },
                op: "EQUAL",
                value: { stringValue: uid },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: "status" },
                op: "EQUAL",
                value: { stringValue: 動画ステータス_レビュー送信済み },
              },
            },
          ],
        },
      },
      limit: 20,
    },
  };

  const res = Firestore通信_(URL, "post", body);
  if (res.code !== 200 || !res.json) return null;

  const docs = (res.json || [])
    .map((x) => x.document)
    .filter(Boolean);

  if (!docs.length) return null;

  let best = null;
  let bestTs = 0;

  docs.forEach((doc) => {
    const sentAt = doc?.fields?.sentAt?.timestampValue || "";
    const createdAt = doc?.fields?.createdAt?.timestampValue || "";
    const tsStr = sentAt || createdAt;
    if (!tsStr) return;
    const ts = Date.parse(tsStr);
    if (!isNaN(ts) && ts > bestTs) {
      bestTs = ts;
      best = doc;
    }
  });

  return best;
}


function データセット_直近項目取得_FS_(limit) {
  const lim = Math.max(1, Number(limit || 10));
  const URL = `https://firestore.googleapis.com/v1/projects/${GCPプロジェクトID}/databases/(default)/documents:runQuery`;

  const body = {
    structuredQuery: {
      from: [{ collectionId: Firestoreコレクション_データセット項目 }],
      where: {
        fieldFilter: {
          field: { fieldPath: "datasetId" },
          op: "EQUAL",
          value: { stringValue: データセットID_既定 },
        },
      },
      orderBy: [{ field: { fieldPath: "updatedAt" }, direction: "DESCENDING" }],
      limit: lim,
    },
  };

  const res = Firestore通信_(URL, "post", body);
  const arr = res.json || [];
  return arr.map((x) => x.document).filter(Boolean);
}

function ScriptProp取得_(key) {
  return PropertiesService.getScriptProperties().getProperty(String(key || "")) || "";
}

/** テストモード時はAIを呼ばず stub で同じフローを通す。Script Property TEST_MODE = true または 1 で有効。 */
function テストモード有効か_() {
  const v = ScriptProp取得_(PROP_テストモード);
  return v === "true" || v === "1";
}

function SHA256_HEX_(s) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(s || ""),
    Utilities.Charset.UTF_8
  );
  return bytes.map((b) => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
}

function データセット項目_自由質問シグナル加算_(sourceVideoMessageId) {
  const vid = String(sourceVideoMessageId || "");
  if (!vid) return;

  const URL = `https://firestore.googleapis.com/v1/projects/${GCPプロジェクトID}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: Firestoreコレクション_データセット項目 }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath: "datasetId" }, op: "EQUAL", value: { stringValue: データセットID_既定 } } },
            { fieldFilter: { field: { fieldPath: "sourceVideoMessageId" }, op: "EQUAL", value: { stringValue: vid } } },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: "updatedAt" }, direction: "DESCENDING" }],
      limit: 1,
    },
  };

  const res = Firestore通信_(URL, "post", body);
  const doc = (res.json || [])[0]?.document;
  if (!doc) return;

  const docId = doc.name.split("/").pop();
  const current = FS整数取得_(doc, "freeQuestionSignalCount") || 0;

  const itemUrl = FirestoreドキュメントURL作成_(GCPプロジェクトID, Firestoreコレクション_データセット項目, docId);

  const fields = {
    freeQuestionSignalCount: { integerValue: String(current + 1) },
    updatedAt: { timestampValue: new Date().toISOString() },
  };

  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");

  Firestore通信_(`${itemUrl}?${mask}`, "patch", { fields });
}

function データセット項目_動画から作成_(videoMessageId) {
  const v = 動画取得_FS_(videoMessageId);
  if (!v || !v.id) throw new Error("データセット項目_動画から作成_: videoが取得できません");

  const reviewText = String(v.reviewText || "").trim();
  if (!reviewText) throw new Error("データセット項目_動画から作成_: reviewText が空です");

  const coachCheckText = String(v.coachCheckText || "").trim();

  const salt = ScriptProp取得_(PROP_匿名化ソルト);
  if (!salt) throw new Error("データセット項目_動画から作成_: DATASET_SALT が未設定です（Script Properties）");

  const anonUserId = SHA256_HEX_(String(v.userId || "") + salt);

  const 作成URL =
    `https://firestore.googleapis.com/v1/projects/${GCPプロジェクトID}/databases/(default)/documents/${Firestoreコレクション_データセット項目}`;

  const nowIso = new Date().toISOString();
  const body = {
    fields: {
      datasetId: { stringValue: データセットID_既定 },
      anonUserId: { stringValue: anonUserId },

      sourceVideoMessageId: { stringValue: String(v.id) },

      "解析結果テキスト": { stringValue: reviewText },
      "コーチ観察テキスト": { stringValue: coachCheckText },

      freeQuestionSignalCount: { integerValue: "0" },

      createdAt: { timestampValue: nowIso },
      updatedAt: { timestampValue: nowIso },
    },
  };

  const res = Firestore通信_(作成URL, "post", body);
  return { code: res.code, text: res.text };
}
