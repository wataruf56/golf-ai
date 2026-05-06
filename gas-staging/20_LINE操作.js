/**
 * 20_LINE操作.gs
 *
 * 【変更点】
 * - LINEチャネルアクセストークンをコード直書きから廃止
 * - Script Properties（PROP_LINEチャネルアクセストークン）から取得して利用するよう変更
 */

const LINE_API_BASE_URL = "https://api.line.me/v2/bot";
const LINE_DATA_API_BASE_URL = "https://api-data.line.me/v2/bot";

/**
 * Script Properties から LINEチャネルアクセストークンを取得
 */
function LINEチャネルアクセストークン取得_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(PROP_LINEチャネルアクセストークン) || "";
  return String(token);
}

function LINE_API_POST_(url, payloadObj) {
  const token = LINEチャネルアクセストークン取得_();

  const opt = {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    headers: {
      Authorization: "Bearer " + token,
    },
    payload: JSON.stringify(payloadObj || {}),
  };

  const res = UrlFetchApp.fetch(url, opt);
  return {
    code: res.getResponseCode(),
    text: res.getContentText(),
  };
}

function LINE返信送信_(replyToken, text) {
  if (!replyToken) return;
  if (!text) text = "";

  const url = LINE_API_BASE_URL + "/message/reply";
  const payload = {
    replyToken: String(replyToken),
    messages: [{ type: "text", text: String(text) }],
  };

  const res = LINE_API_POST_(url, payload);
  Webhookログ出力_("LINE返信", "送信", { code: res.code });
}

/**
 * Flex Message等、任意のmessages配列をreplyTokenで返信する
 * @param {string} replyToken
 * @param {Array} messages - LINE Messaging API の messages 配列
 */
function LINE返信メッセージ送信_(replyToken, messages) {
  if (!replyToken) return;
  if (!messages || !messages.length) return;

  const url = LINE_API_BASE_URL + "/message/reply";
  const payload = {
    replyToken: String(replyToken),
    messages: messages,
  };

  const res = LINE_API_POST_(url, payload);
  if (res.code !== 200) {
    Webhookログ出力_("LINE返信(メッセージ)", "失敗", { code: res.code, body: String(res.text).slice(0, 300) });
  } else {
    Webhookログ出力_("LINE返信(メッセージ)", "送信OK", { code: res.code });
  }
}

function LINEプッシュ送信実行_(userId, text) {
  if (!userId) return;
  if (!text) text = "";

  const url = LINE_API_BASE_URL + "/message/push";
  const payload = {
    to: String(userId),
    messages: [{ type: "text", text: String(text) }],
  };

  const res = LINE_API_POST_(url, payload);
  Webhookログ出力_("LINEプッシュ", "送信", { code: res.code });
}

/**
 * 複数のテキストを連続してpushする（LINEに複数メッセージとして届く）
 * LINEの push は1回のAPIコールで最大5メッセージまで。6通以上は自動で分割送信する。
 * @param {string} userId
 * @param {string[]} texts - テキスト配列（空要素は除外される）
 */
function LINEプッシュ複数送信実行_(userId, texts) {
  if (!userId) return;
  const filtered = (texts || []).map(s => String(s || "").trim()).filter(s => s.length > 0);
  if (!filtered.length) return;

  const url = LINE_API_BASE_URL + "/message/push";
  // 5通ずつのチャンクに分ける（LINE API の messages 配列上限）
  const CHUNK = 5;
  for (let i = 0; i < filtered.length; i += CHUNK) {
    const chunk = filtered.slice(i, i + CHUNK);
    const payload = {
      to: String(userId),
      messages: chunk.map(t => ({ type: "text", text: t })),
    };
    const res = LINE_API_POST_(url, payload);
    Webhookログ出力_("LINEプッシュ複数", "送信", {
      code: res.code,
      count: chunk.length,
      chunkIndex: Math.floor(i / CHUNK),
    });
    if (res.code !== 200) {
      Webhookログ出力_("LINEプッシュ複数", "失敗", { code: res.code, body: String(res.text).slice(0, 300) });
    }
  }
}

/**
 * 任意のメッセージオブジェクト配列を pushする（テキスト/画像/動画 混在可）
 * 5通ずつチャンク分割して送信する。
 * messages 例:
 *   [{ type:"text", text:"..." },
 *    { type:"image", originalContentUrl:"https://...", previewImageUrl:"https://..." },
 *    { type:"video", originalContentUrl:"https://...", previewImageUrl:"https://..." }]
 */
function LINEプッシュ_メッセージ配列送信_(userId, messages) {
  if (!userId) return;
  const arr = (messages || []).filter(m => m && m.type);
  if (!arr.length) return;
  const url = LINE_API_BASE_URL + "/message/push";
  const CHUNK = 5;
  for (let i = 0; i < arr.length; i += CHUNK) {
    const chunk = arr.slice(i, i + CHUNK);
    const payload = { to: String(userId), messages: chunk };
    const res = LINE_API_POST_(url, payload);
    Webhookログ出力_("LINEプッシュ(混在)", "送信", {
      code: res.code, count: chunk.length, chunkIndex: Math.floor(i / CHUNK),
    });
    if (res.code !== 200) {
      Webhookログ出力_("LINEプッシュ(混在)", "失敗", { code: res.code, body: String(res.text).slice(0, 300) });
    }
  }
}

function LINE動画コンテンツ取得_(messageId) {
  if (!messageId) return { code: 400, blob: null };

  const token = LINEチャネルアクセストークン取得_();
  const url =
    LINE_DATA_API_BASE_URL +
    "/message/" +
    encodeURIComponent(messageId) +
    "/content";

  const opt = {
    method: "get",
    muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + token },
  };

  const res = UrlFetchApp.fetch(url, opt);
  const code = res.getResponseCode();

  if (code === 200) return { code: 200, blob: res.getBlob() };

  Webhookログ出力_("LINE動画取得", "失敗", { code: code, messageId: String(messageId) });
  return { code: code, blob: null };
}
