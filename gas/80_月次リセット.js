/**
 * 80_月次リセット.gs
 *
 * 毎月1日 00:00 JST に全ユーザーの月次解析カウントをリセットする。
 *
 * 【設定方法】
 * GASエディタで TEST_月次リセット手動実行() を一度実行して動作確認後、
 * 月次リセットトリガーを設定_() を実行してトリガーを登録する。
 *
 * 【トリガー構成】
 * 関数: 月次リセット実行_()
 * タイプ: 時間主導型 → 月間タイマー → 毎月1日
 */

/**
 * 月次リセットのメイン処理
 * 全 user_state ドキュメントの monthlyVideoUsed を 0 にリセットし
 * monthlyKey を今月に更新する
 */
function 月次リセット実行_() {
  const now = new Date();
  const 月キー = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM");

  Logger.log(`月次リセット開始: ${月キー}`);

  // 全ユーザードキュメントをクエリ
  const ユーザー一覧 = 全ユーザー一覧取得_FS_();

  if (!ユーザー一覧 || ユーザー一覧.length === 0) {
    Logger.log("リセット対象ユーザーなし");
    return;
  }

  let 成功数 = 0;
  let スキップ数 = 0;
  let エラー数 = 0;

  for (const userDoc of ユーザー一覧) {
    try {
      const lineUserId = userDoc?.document?.name?.split("/").pop();
      if (!lineUserId) {
        スキップ数++;
        continue;
      }

      // 無料ユーザーはリセットしない（生涯1回のため）
      const planType = userDoc?.document?.fields?.planType?.stringValue || "free";
      if (planType === "free") {
        スキップ数++;
        continue;
      }

      const 既存月キー = userDoc?.document?.fields?.monthlyKey?.stringValue || "";
      if (既存月キー === 月キー) {
        // 今月既にリセット済み（または当月初回）
        スキップ数++;
        continue;
      }

      // monthlyVideoUsed を 0 にリセット、monthlyKey を今月に更新（有料ユーザーのみ）
      ユーザー状態更新_FS_(lineUserId, {
        monthlyKey: 月キー,
        monthlyVideoUsed: 0,
      });

      成功数++;
    } catch (e) {
      エラー数++;
      Logger.log(`リセットエラー (${userDoc?.document?.name}): ${e.message}`);
    }
  }

  const サマリー = `月次リセット完了: 成功=${成功数}, スキップ=${スキップ数}, エラー=${エラー数}`;
  Logger.log(サマリー);

  // Webhookログに記録
  try {
    Webhookログ出力_("月次リセット", "完了", {
      月キー,
      成功数,
      スキップ数,
      エラー数,
    });
  } catch (e) {
    Logger.log("Webhookログ出力エラー: " + e.message);
  }
}

/**
 * Firestore の user_state コレクションから全ドキュメントを取得する
 * @returns {Array} Firestore runQuery の結果配列
 */
function 全ユーザー一覧取得_FS_() {
  const URL = `https://firestore.googleapis.com/v1/projects/${GCPプロジェクトID}/databases/(default)/documents:runQuery`;

  const body = {
    structuredQuery: {
      from: [{ collectionId: Firestoreコレクション_ユーザー状態 }],
      select: {
        fields: [
          { fieldPath: "monthlyKey" },
          { fieldPath: "monthlyVideoUsed" },
          { fieldPath: "planType" },
        ],
      },
      // 全件取得（上限 500 件）
      limit: 500,
    },
  };

  const result = Firestore通信_(URL, "POST", body);

  if (result.code !== 200) {
    throw new Error(`Firestore クエリ失敗 (${result.code}): ${result.text}`);
  }

  // runQuery は [{document: {...}}, ...] または [{readTime: "..."}] を返す
  const rows = result.json || [];
  return rows.filter(r => r.document);
}

/* =========================================================
 * トリガー設定
 * =======================================================*/

/**
 * 月次リセットの時間トリガーを登録する（一度だけ実行すればOK）
 * 毎月1日 00:00〜01:00 JST に実行
 */
function 月次リセットトリガーを設定_() {
  // 既存の同名トリガーを削除してから再登録（重複防止）
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === "月次リセット実行_") {
      ScriptApp.deleteTrigger(t);
      Logger.log("既存トリガーを削除しました");
    }
  }

  ScriptApp.newTrigger("月次リセット実行_")
    .timeBased()
    .onMonthDay(1)
    .atHour(0)
    .inTimezone("Asia/Tokyo")
    .create();

  Logger.log("✅ 月次リセットトリガーを登録しました（毎月1日 00:00 JST）");
}

/**
 * 登録済みトリガーを一覧表示
 */
function 月次リセットトリガー確認_() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log("登録済みトリガーなし");
    return;
  }
  for (const t of triggers) {
    Logger.log(`関数: ${t.getHandlerFunction()} / タイプ: ${t.getEventType()}`);
  }
}

/* =========================================================
 * テスト関数
 * =======================================================*/

/**
 * 手動テスト：月次リセットを即時実行
 * （月キーを一時的に偽の値にしないと全員スキップされるため、
 *   テスト用ユーザーで確認する場合は Firestore 上の monthlyKey を直接変更してから実行）
 */
function TEST_月次リセット手動実行() {
  Logger.log("=== 月次リセット 手動テスト開始 ===");
  月次リセット実行_();
  Logger.log("=== 完了 ===");
}

/**
 * 手動テスト：ユーザー一覧取得の確認
 */
function TEST_全ユーザー一覧確認() {
  try {
    const users = 全ユーザー一覧取得_FS_();
    Logger.log(`取得件数: ${users.length}`);
    if (users.length > 0) {
      Logger.log("先頭ユーザー: " + JSON.stringify(users[0]));
    }
  } catch (e) {
    Logger.log("❌ エラー: " + e.message);
  }
}
