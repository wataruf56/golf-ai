/**
 * ステージング環境用：ログ記録スプレッドシートを自動作成する
 * GASエディタから1度だけ手動実行。出力されたIDを 00_設定.js の
 * WEBHOOKログ_スプレッドシートID に設定する。
 */
function createStagingLogSheet() {
  const ss = SpreadsheetApp.create("ゴルフAI_ステージング_ログ");
  ss.getActiveSheet().setName("WEBHOOK_LOG");
  ss.insertSheet("AI_PROMPT_LOG");
  ss.insertSheet("AI_解析結果_LOG");
  Logger.log("スプレッドシートID: " + ss.getId());
  Logger.log("URL: " + ss.getUrl());
}

/**
 * ★★★ この関数を1回だけ実行してください ★★★
 * 目的:
 *   1) 追加した OAuth スコープ（外部URL/GCS/Sheets/Firestore）を承認
 *   2) ステージング用 Script Properties を一括設定
 *   3) 疎通確認（LINE info, Firestore, Spreadsheet）
 *
 * 使い方:
 *   - 関数プルダウンで「ステージング初期化_実行」を選ぶ
 *   - 「実行」→ Google承認ダイアログで許可
 *   - 実行ログを確認（エラーがあれば末尾に表示される）
 */
function ステージング初期化_実行() {
  const sp = PropertiesService.getScriptProperties();

  // 1) Script Properties を設定（本番と同じ値を使うべきものは手動で別途上書き）
  const props = {
    DATASET_SALT: "staging-salt-2026",
    TEST_MODE: "false",
    // 注: 以下は本番と共通でよいもの。既に設定されていれば上書きしない。
    // CLOUDRUN_ANALYZE_SHARED_SECRET: "<本番から手動コピー>",
    // CLOUDRUN_TEXT_SHARED_SECRET:   "<本番から手動コピー>",
  };
  const current = sp.getProperties();
  const set = {};
  Object.keys(props).forEach(k => {
    if (!current[k]) { sp.setProperty(k, props[k]); set[k] = props[k]; }
  });
  Logger.log("Script Properties設定: " + JSON.stringify(set));
  Logger.log("既存値を保護（上書きしていない）: " + JSON.stringify(
    Object.keys(props).filter(k => current[k]).reduce((a, k) => (a[k] = "***既存***", a), {})
  ));

  // 2) OAuth 承認トリガー：各スコープを1回ずつ使う
  try {
    const token = sp.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
    if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が未設定です");
    const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/info", {
      headers: { "Authorization": "Bearer " + token },
      muteHttpExceptions: true,
    });
    Logger.log("LINE疎通OK: " + res.getContentText().slice(0, 200));
  } catch (e) {
    Logger.log("LINE疎通エラー: " + e);
  }

  // 3) Spreadsheet スコープ（ログ書き込みで使う）
  try {
    if (WEBHOOKログ_スプレッドシートID) {
      const ss = SpreadsheetApp.openById(WEBHOOKログ_スプレッドシートID);
      Logger.log("Spreadsheet疎通OK: " + ss.getName());
    } else {
      Logger.log("WEBHOOKログ_スプレッドシートID が空です（00_設定.jsで設定してください）");
    }
  } catch (e) {
    Logger.log("Spreadsheetエラー: " + e);
  }

  // 4) Datastore スコープ（Firestore APIで使うだけでは OAuth dispatch されないため
  //    ここでは触れない。初回の doPost 実行時に自動承認される想定）

  Logger.log("=== 初期化完了 ===");
  Logger.log("次: LINEアプリで「ゴルフのあいちゃん（テスト）」に「使い方」と送って動作確認してください。");
}

function TEST_LINEプッシュ() {
  const userId = "U41f8e33f0633a54365d38c8bc2b69517";
  LINEプッシュ送信実行_(userId, "TEST: Script Properties 経由で送信できました");
}

function TEST_テキスト回答() {
  const userId = "ダミーでもOK（空はNG）";
  const ans = テキスト回答_AI_(userId, "テストです。1行で返してください。");
  Logger.log(ans);
}

/**
 * リッチメニュー一括登録（画像はrichmenu_image_data.jsのBase64定数を使用）
 * GASエディタから手動実行する
 *
 * 処理: 1)リッチメニュー作成 → 2)画像アップロード → 3)デフォルト設定
 */
function リッチメニュー登録_3カラム() {
  const TOKEN = PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_ACCESS_TOKEN");

  // --- Step 1: リッチメニュー作成 ---
  const menuBody = {
    size: { width: 2500, height: 843 },
    selected: true,
    name: "メインメニュー v4",
    chatBarText: "メニュー",
    areas: [
      {
        bounds: { x: 0, y: 0, width: 913, height: 843 },
        action: { type: "message", text: "解析メニュー" }
      },
      {
        bounds: { x: 913, y: 0, width: 794, height: 843 },
        action: { type: "message", text: "使い方" }
      },
      {
        bounds: { x: 1707, y: 0, width: 793, height: 843 },
        action: { type: "uri", uri: "https://lin.ee/5MkA79c" }
      }
    ]
  };

  const createRes = UrlFetchApp.fetch("https://api.line.me/v2/bot/richmenu", {
    method: "post",
    headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
    payload: JSON.stringify(menuBody),
    muteHttpExceptions: true
  });
  Logger.log("Create: " + createRes.getContentText());
  const richMenuId = JSON.parse(createRes.getContentText()).richMenuId;
  if (!richMenuId) { Logger.log("ERROR: richMenuId取得失敗"); return; }
  Logger.log("richMenuId: " + richMenuId);

  // --- Step 2: 画像アップロード（richmenu_image_data.js の RICHMENU_IMAGE_B64 定数を使用）---
  const imageBytes = Utilities.base64Decode(RICHMENU_IMAGE_B64);
  const uploadRes = UrlFetchApp.fetch(
    "https://api-data.line.me/v2/bot/richmenu/" + richMenuId + "/content",
    {
      method: "post",
      headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "image/png" },
      payload: imageBytes,
      muteHttpExceptions: true
    }
  );
  Logger.log("Upload: " + uploadRes.getContentText());

  // --- Step 3: 全ユーザーのデフォルトに設定 ---
  const defaultRes = UrlFetchApp.fetch(
    "https://api.line.me/v2/bot/user/all/richmenu/" + richMenuId,
    {
      method: "post",
      headers: { "Authorization": "Bearer " + TOKEN },
      muteHttpExceptions: true
    }
  );
  Logger.log("SetDefault: " + defaultRes.getContentText());
  Logger.log("✅ リッチメニュー登録完了！ richMenuId: " + richMenuId);
}

/**
 * API経由で作成されたリッチメニューをすべて削除する
 * LINE管理画面でリッチメニューを作り直す前に実行すること
 */
function リッチメニュー全削除_API() {
  const TOKEN = PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_ACCESS_TOKEN");

  // 1. 既存のリッチメニュー一覧を取得
  const listRes = UrlFetchApp.fetch("https://api.line.me/v2/bot/richmenu/list", {
    method: "get",
    headers: { "Authorization": "Bearer " + TOKEN },
    muteHttpExceptions: true
  });
  Logger.log("一覧取得: " + listRes.getContentText().slice(0, 500));

  const menus = JSON.parse(listRes.getContentText()).richmenus || [];
  Logger.log("リッチメニュー数: " + menus.length);

  if (menus.length === 0) {
    Logger.log("削除対象なし");
    return;
  }

  // 2. デフォルト設定を解除
  const cancelRes = UrlFetchApp.fetch("https://api.line.me/v2/bot/user/all/richmenu", {
    method: "delete",
    headers: { "Authorization": "Bearer " + TOKEN },
    muteHttpExceptions: true
  });
  Logger.log("デフォルト解除: " + cancelRes.getResponseCode());

  // 3. 各リッチメニューを削除
  for (var i = 0; i < menus.length; i++) {
    var id = menus[i].richMenuId;
    var delRes = UrlFetchApp.fetch("https://api.line.me/v2/bot/richmenu/" + id, {
      method: "delete",
      headers: { "Authorization": "Bearer " + TOKEN },
      muteHttpExceptions: true
    });
    Logger.log("削除 " + id + ": " + delRes.getResponseCode());
  }

  Logger.log("✅ 全リッチメニュー削除完了。LINE管理画面から新しく作成してください。");
}

function TEST_runQuery_動画キュー取得() {
  const URL = `https://firestore.googleapis.com/v1/projects/${GCPプロジェクトID}/databases/(default)/documents:runQuery`;

  const body = {
    structuredQuery: {
      from: [{ collectionId: Firestoreコレクション_動画 }],
      where: {
        fieldFilter: {
          field: { fieldPath: "status" },
          op: "EQUAL",
          value: { stringValue: 動画ステータス_キュー },
        },
      },
      limit: 3,
    },
  };

  const res = Firestore通信_(URL, "post", body);
  Logger.log("code=" + res.code);
  Logger.log("text(head500)=" + String(res.text || "").slice(0, 500));
  Logger.log("json=" + JSON.stringify(res.json));
}
