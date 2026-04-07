/**
 * 50_WEBHOOK（doPost）.gs
 *
 * 【変更点】
 * - ② 月上限判定：固定値ではなく user_state.monthlyVideoLimit を参照（0/nullの時だけ planType から算出）
 * - ③ pendingStep：SELF時の「比較_自分動画待ち」を廃止し「ステップ_自分動画待ち」に分離
 */

function doPost(e) {
  Webhookログ出力_("doPost", "開始", {});
  let replyToken = "";

  try {
    const raw = e?.postData?.contents || "";
    if (!raw) return OKレスポンス_();

    const body = JSON.parse(raw);

    /* =====================================================
     * Stripe Webhook 振り分け
     * Stripeイベントは object="event" を持つ
     * ===================================================*/
    if (Stripe_Webhookイベントか判定_(body)) {
      Stripe_Webhook処理_(body);
      return OKレスポンス_();
    }

    const events = body.events || [];

    for (const ev of events) {
      replyToken = ev.replyToken || "";
      const userId = ev.source?.userId || "";
      const eventType = ev.type || "";
      const msgType = ev.message?.type || "";
      const messageId = ev.message?.id || "";

      if (!userId || eventType !== "message") continue;

      const userStateDoc = ユーザー状態取得_FS_(userId);
      const 状態 = {
        pendingStep: FS文字列取得_(userStateDoc, "pendingStep"),
        actionMode: FS文字列取得_(userStateDoc, "actionMode"),
        messageMode: FS文字列取得_(userStateDoc, "messageMode"),
        currentVideoMessageId: FS文字列取得_(userStateDoc, "currentVideoMessageId"),
        proVideoMessageId: FS文字列取得_(userStateDoc, "proVideoMessageId"),
        prevVideoMessageId: FS文字列取得_(userStateDoc, "prevVideoMessageId"),
        targetMessageIdForText: FS文字列取得_(userStateDoc, "targetMessageIdForText"),
        userMessage: FS文字列取得_(userStateDoc, "userMessage"),

        // 課金・プラン
        planType: FS文字列取得_(userStateDoc, "planType") || プラン種別_free,
        stripeCustomerId: FS文字列取得_(userStateDoc, "stripeCustomerId") || "",
        monthlyVideoLimit: FS整数取得_(userStateDoc, "monthlyVideoLimit") || 0,
        monthlyVideoUsed: FS整数取得_(userStateDoc, "monthlyVideoUsed") || 0,
        ticketBalance: FS整数取得_(userStateDoc, "ticketBalance") || 0,

        // レベル
        userLevel: FS文字列取得_(userStateDoc, "userLevel") || ユーザーレベル_未設定,
      };

      /* =====================================================
       * テキスト
       * ===================================================*/
      if (msgType === "text") {
        const text = (ev.message.text || "").trim().replace(/＃/g, '#').replace(/＿/g, '_');
        Webhookログ出力_("doPost", "テキスト受信", { text });

        // ─── 応答メッセージ連携キーワード（doPostではスキップ） ───
        // リッチメニュー → テキスト送信 → 応答メッセージ側で処理するため、
        // Webhook側では何もせずスキップする
        const 応答メッセージ専用キーワード = [
          "#補足や質問", // メッセージモード選択カードを出すトリガー（応答メッセージ側）
          "使い方",      // リッチメニュー「使い方」→ 応答メッセージ側で返信
          "#使い方",
          "#問い合わせ",  // リッチメニュー「問い合わせ」→ 応答メッセージ側で返信
          "問い合わせ",
        ];
        if (応答メッセージ専用キーワード.includes(text)) {
          Webhookログ出力_("doPost", "応答メッセージ連携キーワード（スキップ）", { text });
          continue;
        }

        // レベル設定
        if (text.startsWith("#LEVEL")) {
          const lv = text.replace("#LEVEL", "").trim();
          if (lv === ユーザーレベル_初心者 || lv === ユーザーレベル_中級者 || lv === ユーザーレベル_上級者) {
            ユーザー状態更新_FS_(userId, { userLevel: lv });
            if (replyToken) LINE返信送信_(replyToken, `レベルを「${lv}」に設定しました。`);
          } else {
            if (replyToken) LINE返信送信_(replyToken, "指定できるレベル：初心者 / 中級者 / 上級者");
          }
          continue;
        }

        // プラン申込（Stripe Checkout）
        if (text === "#PLAN" || text === "#プラン") {
          // stripeCustomerIdがある有料プランの場合のみカスタマーポータルを表示
          // （stripeCustomerIdが空の場合は決済未完了とみなし、Checkoutリンクを返す）
          if (状態.planType === プラン種別_paid && 状態.stripeCustomerId) {
            const limit = 状態.monthlyVideoLimit || Paid_月上限;
            const used = 状態.monthlyVideoUsed || 0;
            const remaining = Math.max(0, limit - used);
            try {
              const portalUrl = Stripe_CustomerPortalSession作成_(userId);
              if (replyToken) LINE返信送信_(replyToken,
                "🌟 すでに有料プランにご加入中です。\n\n"
                + `今月の残り解析回数：${remaining}回（${used}/${limit}回使用済み）\n\n`
                + "解約・カード変更はこちら👇\n"
                + portalUrl
              );
            } catch (e) {
              Webhookログ出力_("doPost", "カスタマーポータル取得失敗", { error: e.message });
              if (replyToken) LINE返信送信_(replyToken,
                "🌟 すでに有料プランにご加入中です。\n\n"
                + `今月の残り解析回数：${remaining}回（${used}/${limit}回使用済み）\n\n`
                + "解約・変更はStripeのマイページからお願いします。"
              );
            }
            continue;
          }
          try {
            const checkoutUrl = Stripe_Checkout_URL作成_(userId);
            if (replyToken) LINE返信送信_(replyToken,
              "⛳ 有料プラン（月額480円・月10回解析）\n\n"
              + "以下のリンクからお申し込みください👇\n"
              + checkoutUrl
            );
          } catch (e) {
            Webhookログ出力_("doPost", "Stripe Checkout失敗", { error: e.message });
            if (replyToken) LINE返信送信_(replyToken, "決済ページの準備中です。しばらくお待ちください。");
          }
          continue;
        }

        // プラン状態確認
        if (text === "#STATUS" || text === "#ステータス" || text === "#マイページ") {
          const plan = 状態.planType || プラン種別_free;
          const limit = (状態.monthlyVideoLimit && 状態.monthlyVideoLimit > 0)
            ? 状態.monthlyVideoLimit
            : 月上限_プランから決定_(plan);
          const used = 状態.monthlyVideoUsed || 0;
          const remaining = Math.max(0, limit - used);
          const planLabel = plan === プラン種別_paid
            ? "🌟 有料プラン（月10回）"
            : "🆓 無料トライアル（1回限り）";
          const upgradeMsg = plan === プラン種別_free
            ? "\n\n📈 アップグレードは「#プラン」と送ってください"
            : "";
          if (replyToken) LINE返信送信_(replyToken,
            `📊 あなたのプラン状態\n\n${planLabel}\n`
            + `今月の使用：${used}回 / ${limit}回\n`
            + `残り：${remaining}回${upgradeMsg}`
          );
          continue;
        }

        // ════════════════════════════════════════════════
        // 問い合わせ（リッチメニュー3番目）
        // ════════════════════════════════════════════════
        if (text === "#問い合わせ" || text === "問い合わせ") {
          if (replyToken) LINE返信送信_(replyToken,
            "💬 お問い合わせ\n\n"
            + "ご質問やお困りのことがありましたら、\n下記の公式アカウントからお気軽にメッセージをお送りください。\n\n"
            + "👤 問い合わせ窓口：\n"
            + "（準備中です。もうしばらくお待ちください）"
          );
          Webhookログ出力_("doPost", "問い合わせ案内送信", {});
          continue;
        }

        // ヘルプ・使い方コマンド
        if (text === "#HELP" || text === "#ヘルプ" || text === "#へるぷ" || text === "#使い方" || text === "使い方") {
          const plan = 状態.planType || プラン種別_free;
          const planInfo = plan === プラン種別_paid
            ? "🌟 有料プラン加入中"
            : "🆓 無料トライアル（1回限り）";
          if (replyToken) LINE返信送信_(replyToken,
            "📖 使い方ガイド\n\n"
            + "【動画解析】\n"
            + "ゴルフスイング動画を送るだけ！\nAIが詳しく分析します。\n\n"
            + "【操作の流れ】\n"
            + "1. メニューの「解析」をタップ\n"
            + "2. 解析モードを選択\n"
            + "3. メッセージモードを選択\n"
            + "4. 動画を送信 → AI解析スタート！\n\n"
            + "💡 操作を最初からやり直したい場合は、\nメニューの「解析」をタップすれば\nいつでもリセットされます。\n\n"
            + "【コマンド一覧】\n"
            + "#ヘルプ → この案内を表示\n"
            + "#ステータス → プラン・残り回数確認\n"
            + "#プラン → プラン申込・確認\n\n"
            + `現在のプラン：${planInfo}`
          );
          continue;
        }

        // ════════════════════════════════════════════════
        // 解析メニュー（Step1 アクションモード選択カード）
        // ════════════════════════════════════════════════
        if (text === "#解析メニュー" || text === "解析メニュー") {
          // 状態リセット＋アクションモード選択カード送信
          ユーザー状態更新_FS_(userId, {
            pendingStep: ステップ_なし,
            actionMode: "",
            messageMode: "",
            userMessage: "",
            proVideoMessageId: "",
            prevVideoMessageId: "",
            targetMessageIdForText: "",
            state: ユーザー状態_待機,
          });
          if (replyToken) {
            LINE返信メッセージ送信_(replyToken, [アクションモード選択カード生成_()]);
          }
          Webhookログ出力_("doPost", "解析メニュー→状態リセット＋カード送信", {});
          continue;
        }

    // ════════════════════════════════════════════════
    // キャンセル（フロー中断→初期状態に戻る）
    // ════════════════════════════════════════════════
    if (text === "#キャンセル" || text === "#CANCEL") {
      ユーザー状態更新_FS_(userId, {
        pendingStep: ステップ_なし,
        actionMode: "",
        messageMode: "",
        userMessage: "",
        proVideoMessageId: "",
        prevVideoMessageId: "",
        targetMessageIdForText: "",
        state: ユーザー状態_待機,
      });
      if (replyToken) LINE返信送信_(replyToken,
        "操作をキャンセルしました🔄\n\n最初からやり直す場合は、下のメニューから「解析メニュー」をタップしてください。"
      );
      Webhookログ出力_("doPost", "キャンセル→初期状態リセット", {});
      continue;
    }

        // ════════════════════════════════════════════════
        // 解析モードコマンド（2段階カード選択フロー）
        // ════════════════════════════════════════════════
        if (text.startsWith("#AI")) {
          const cmd = AIコマンド解析_(text);
          if (!cmd.ok) {
            if (replyToken) LINE返信送信_(replyToken, "コマンド形式が正しくありません。");
            continue;
          }

          // ── Step1: アクションモード選択 ──
          if (cmd.type === "action") {
            // 質問モード：プロンプト入力 → 動画送信 → Worker解析
            if (cmd.actionMode === 動作モード_質問) {
              const 残りチェック = 動画解析_残り回数チェック_(状態);
              if (!残りチェック.ok) {
                if (replyToken) LINE返信送信_(replyToken, 残りチェック.message);
                continue;
              }
              ユーザー状態更新_FS_(userId, {
                pendingStep: ステップ_質問プロンプト入力待ち,
                actionMode: cmd.actionMode,
                messageMode: "",
                userMessage: "",
                proVideoMessageId: "",
                prevVideoMessageId: "",
                targetMessageIdForText: "",
                state: ユーザー状態_待機,
              });
              if (replyToken) LINE返信送信_(replyToken,
                "AIコーチに聞きたいことを自由に入力してください📝\n\n例：「ドライバーの飛距離を伸ばすには？」\n例：「左に曲がる原因を教えて」\n\n入力後、動画の送信に進みます🎥"
              );
              Webhookログ出力_("doPost", "質問モード選択→プロンプト入力待ち", {});
              continue;
            }

            const 残りチェック = 動画解析_残り回数チェック_(状態);
            if (!残りチェック.ok) {
              if (replyToken) LINE返信送信_(replyToken, 残りチェック.message);
              continue;
            }

            ユーザー状態更新_FS_(userId, {
              pendingStep: ステップ_メッセージモード選択待ち,
              actionMode: cmd.actionMode,
              messageMode: "",
              userMessage: "",
              proVideoMessageId: "",
              prevVideoMessageId: "",
              targetMessageIdForText: "",
              state: ユーザー状態_待機,
            });

            // doPostからメッセージモード選択カードを直接送信
            if (replyToken) {
              LINE返信メッセージ送信_(replyToken, [メッセージモード選択カード生成_()]);
            }
            Webhookログ出力_("doPost", "アクションモード選択完了→メッセージモード選択カード送信", { actionMode: cmd.actionMode });
            continue;
          }

          // ── Step2: メッセージモード選択 ──
          if (cmd.type === "message") {
            if (状態.pendingStep !== ステップ_メッセージモード選択待ち) {
              if (replyToken) LINE返信送信_(replyToken, "先に解析モードを選んでください。\n下のメニューから「解析メニュー」をタップしてください。");
              continue;
            }

            ユーザー状態更新_FS_(userId, { messageMode: cmd.messageMode });

            if (cmd.messageMode === メッセージモード_なし) {
              AIコマンド_動画待ちフロー開始_(userId, 状態.actionMode, replyToken);
              continue;
            }

            // テキストあり / 質問 / 注目 → テキスト入力を促す
            ユーザー状態更新_FS_(userId, { pendingStep: ステップ_追加テキスト入力待ち });

            if (replyToken) LINE返信送信_(replyToken,
              "質問や補足、見てほしいポイントなど\n自由にテキストで送ってください📝\n（送信後、動画の送信に進みます）"
            );
            continue;
          }

          // ── 旧フロー（後方互換） ──
          if (cmd.type === "legacy") {
            const 残りチェック = 動画解析_残り回数チェック_(状態);
            if (!残りチェック.ok) {
              if (replyToken) LINE返信送信_(replyToken, 残りチェック.message);
              continue;
            }

            const newMsgMode = cmd.messageMode === メッセージモード_補足あり ? メッセージモード_質啍 : メッセージモード_なし;
            ユーザー状態更新_FS_(userId, {
              actionMode: cmd.actionMode,
              messageMode: newMsgMode,
              userMessage: "",
              proVideoMessageId: "",
              prevVideoMessageId: "",
              targetMessageIdForText: "",
              state: ユーザー状態_待機,
            });

            if (newMsgMode !== メッセージモード_なし) {
              ユーザー状態更新_FS_(userId, { pendingStep: ステップ_追加テキスト入力待ち });
              if (replyToken) LINE返信送信_(replyToken,
                "質問や補足をテキストで送ってください📝\n（送信後、動画の送信に進みます）"
              );
            } else {
              AIコマンド_動画待ちフロー開始_(userId, cmd.actionMode, replyToken);
            }
            continue;
          }
        }

        // ── 質問モード：プロンプト入力 → userMessage保存 → 動画待ちへ ──
        if (状態.pendingStep === ステップ_質問プロンプト入力待ち) {
          ユーザー状態更新_FS_(userId, {
            userMessage: text,
            messageMode: メッセージモード_テキストあり,
          });
          AIコマンド_動画待ちフロー開始_(userId, 動作モード_質問, replyToken);
          Webhookログ出力_("doPost", "質問モード：プロンプト入力完了→動画待ち", { userMessage: text });
          continue;
        }

        // ── 追加テキスト入力待ち（質問/注目 の入力受付） ──
        if (状態.pendingStep === ステップ_追加テキスト入力待ち) {
          ユーザー状態更新_FS_(userId, { userMessage: text });
          AIコマンド_動画待ちフロー開始_(userId, 状態.actionMode, replyToken);
          continue;
        }

        // 補趵待ち（旧フロー：動画送信後の補足メッセージ）
        if (状態.pendingStep === ステップ_ユーザーメッセージ待ち) {
          const targetId = 状態.targetMessageIdForText || 状態.currentVideoMessageId;
          if (!targetId) continue;

          動画更新_FS_(targetId, {
            userMessage: { stringValue: text },
            analysisType: { stringValue: 解析種別_メッセージ付き },
            status: { stringValue: 動画ステータス_キュー },
          });

          ユーザー状態更新_FS_(userId, {
            pendingStep: ステップ_なし,
            targetMessageIdForText: "",
            state: ユーザー状態_待機,
          });

          LINEプッシュ送信実行_(userId, "OK！解析を開始します⏳");
          continue;
        }

        // 自由質問：直前のレビュー（＋P観察＋直近Q&A＋データセット候補）
        const 対象 = 自由質問_対象動画取得_詳細_(userId, 状態.currentVideoMessageId);
        if (!対象) {
          Webhookログ出力_("自由質問", "対象動画なし", { userId });
          continue;
        }

        const 設定 = レベル設定取得_(状態.userLevel);
        const 事例候補 = データセット_直近項目取得_FS_(Math.max(10, 設定.事例数 * 3));

        const prompt = 自由質問_最適化プロンプト生成_({
          userLevel: 状態.userLevel,
          settings: 設定,
          reviewText: 対象.reviewText,
          coachCheckText: 対象.coachCheckText,
          recentQA: 対象.recentQA,
          questionText: text,
          datasetDocs: 事例候補,
        });

        try {
          const answer = テキスト回答_AI_(userId, prompt, "自由質問", "");
          const out = 行数制限_整形_(answer, 設定.最大行数);
          LINEプッシュ送信実行_(userId, out);

          try {
            const r = 自由質問_履歴追記_(対象.messageId, text, out);
            Webhookログ出力_("自由質問", "freeQuestions 保存完了", { messageId: 対象.messageId, r });
          } catch (e) {
            Webhookログ出力_("自由質問", "freeQuestions 保存失敗", { messageId: 対象.messageId, err: String(e) });
          }

          try {
            データセット項目_自由質問シグナル加算_(対象.messageId);
          } catch (e) {}

        } catch (aiErr) {
          Webhookログ出力_("自由質問", "AI失敗", { err: String(aiErr) });
        }

        continue;
      }

      /* =====================================================
       * 動画
       * ===================================================*/
      if (msgType !== "video") continue;

      if (replyToken) LINE返信送信_(replyToken, "動画を受け取りました。確認中です⏳");

      // ★② 月上限判定：Firestore単一正（monthlyVideoLimit）
      const planType = 状態.planType || プラン種別_free;
      const 月上限 = (状態.monthlyVideoLimit && 状態.monthlyVideoLimit > 0)
        ? 状態.monthlyVideoLimit
        : 月上限_プランから決定_(planType); // フェイルセーフ

      const 月上限超過 = 状態.monthlyVideoUsed >= 月上限;
      const チケットあり = 状態.ticketBalance > 0;

      if (月上限超過 && !チケットあり) {
        let limitMsg = "今月の解析回数の上限に達しました。";
        if (月上限 === Paid_月上限) {
          limitMsg = "今月の解析回数（10本）を使い切りました。";
        } else if (月上限 === Free_月上限) {
          limitMsg = "無料トライアルの解析枠を使い切りました。\n\n📈 有料プランは「#プラン」と送ってください（月額480円・月10回）";
        }

        LINEプッシュ送信実行_(userId, limitMsg);
        Webhookログ出力_("課金", "上限超過で拒否", { userId, planType, used: 状態.monthlyVideoUsed, limit: 月上限, ticket: 状態.ticketBalance });
        continue;
      }

      const billingPlanSnapshot = 月上限超過 ? プラン種別_チケット : planType;

      const res = LINE動画コンテンツ取得_(messageId);
      Webhookログ出力_("doPost:動画", "LINE動画取得", { code: res?.code, hasBlob: !!res?.blob });

      if (!res || res.code !== 200 || !res.blob) {
        LINEプッシュ送信実行_(userId, "動画の取得に失敗しました。");
        continue;
      }

      let blob = res.blob;
      try { blob = 動画Blob正規化_(blob, messageId); } catch (e) { blob = res.blob; }

      const bytes = blob.getBytes();
      const sizeBytes = bytes.length;

      let seconds = 0;
      try {
        seconds = MP4再生時間秒数_(bytes);
      } catch (durErr) {
        seconds = 0;
        Webhookログ出力_("doPost:動画", "再生時間取得失敗（サイズ判定へ）", { err: String(durErr), sizeBytes });
      }

      if (seconds > 20) {
        LINEプッシュ送信実行_(userId, 動画長エラーメッセージ生成_(状態.pendingStep));
        Webhookログ出力_("doPost:動画", "動画長オーバーで破棄", { seconds, sizeBytes });
        continue;
      }

      if (seconds === 0) {
        const mb = sizeBytes / 1024 / 1024;
        if (mb > 10) {
          LINEプッシュ送信実行_(userId, 動画長エラーメッセージ生成_(状態.pendingStep));
          Webhookログ出力_("doPost:動画", "サイズ大のため長尺扱いで破棄", { mb, sizeBytes });
          continue;
        }
      }

      const objectName = `line/${userId}/${messageId}.mp4`;
      const upload = GCSアップロード_(blob, objectName);
      const gcsPath = `gs://${upload.bucket}/${upload.name}`;
      Webhookログ出力_("doPost:動画", "GCS保存完了", { gcsPath, sizeBytes, seconds });

      動画_受信として登録_FS_({ userId, messageId, gcsPath, sizeBytes });

      動画更新_FS_(messageId, {
        billingPlanSnapshot: { stringValue: billingPlanSnapshot },
      });

      // 過去比較：過去動画（1本目）
      if (状態.pendingStep === ステップ_過去比較_過去動画待ち) {
        動画更新_FS_(messageId, {
          role: { stringValue: 動画ロール_過去 },
          status: { stringValue: 動画ステータス_素材 },
        });

        ユーザー状態更新_FS_(userId, {
          prevVideoMessageId: messageId,
          pendingStep: ステップ_過去比較_今回動画待ち,
        });

        LINEプッシュ送信実行_(userId,
          "過去の動画OKです👍\n" +
          "次に【今回の動画】（アフター）を送ってください。"
        );
        continue;
      }

      // プロ動画（比較の最初）
      if (状態.pendingStep === ステップ_比較_プロ動画待ち) {
        動画更新_FS_(messageId, {
          role: { stringValue: 動画ロール_プロ },
          status: { stringValue: 動画ステータス_素材 },
        });

        ユーザー状態更新_FS_(userId, {
          proVideoMessageId: messageId,
          pendingStep: ステップ_比較_自分動画待ち,
        });

        LINEプッシュ送信実行_(userId,
          "プロ動画OKです。\n" +
          "このプロと同じクラブで振った自分の動画を送ってください。\n" +
          "（クラブのジャンルを揃えると解析精度が上がります）"
        );
        continue;
      }

      // 自分動画
      const videoFields = {
        role: { stringValue: 動画ロール_自分 },
      };

      // 比較：proGcsUriセット
      if (状態.actionMode === 動作モード_比較) {
        const proId = 状態.proVideoMessageId;
        if (!proId) {
          LINEプッシュ送信実行_(userId, "先にプロ動画を送ってください。");
          continue;
        }

        const proDoc = 動画ドキュメント取得_FS_(proId);
        const proGcs = FS文字列取得_(proDoc, "gcsPath");
        if (!proGcs) {
          LINEプッシュ送信実行_(userId, "プロ動画の参照に失敗しました。もう一度プロ動画からお願いします。");
          continue;
        }

        videoFields.analysisType = { stringValue: 解析種別_比較 };
        videoFields.proGcsUri = { stringValue: proGcs };
        videoFields.actionModeSnapshot = { stringValue: 動作モード_比較 };
      } else if (状態.actionMode === 動作モード_過去比較) {
        const prevId = 状態.prevVideoMessageId;
        if (!prevId) {
          LINEプッシュ送信実行_(userId, "先に過去の動画を送ってください。");
          continue;
        }

        const prevDoc = 動画ドキュメント取得_FS_(prevId);
        const prevGcs = FS文字列取得_(prevDoc, "gcsPath");
        if (!prevGcs) {
          LINEプッシュ送信実行_(userId, "過去動画の参照に失敗しました。もう一度やり直してください。");
          continue;
        }

        videoFields.analysisType = { stringValue: 解析種別_比較 };
        videoFields.actionModeSnapshot = { stringValue: 動作モード_過去比較 };
        videoFields.prevGcsUri = { stringValue: prevGcs };
      } else {
        videoFields.analysisType = { stringValue: 解析種別_即解析 };
        videoFields.actionModeSnapshot = { stringValue: 動作モード_自分解析 };
      }

      動画更新_FS_(messageId, videoFields);

      // メッセージモードを videos に保存（workerでプロンプト分岐に使用）
      if (状態.messageMode) {
        動画更新_FS_(messageId, {
          messageModeSnapshot: { stringValue: 状態.messageMode },
        });
      }

      // 新フローでは userMessage は動画送信前に取得済み。videos ドキュメントに保存する
      if (状態.userMessage) {
        動画更新_FS_(messageId, {
          userMessage: { stringValue: 状態.userMessage },
          analysisType: { stringValue: 解析種別_メッセージ付き },
        });
      }

      // 旧フロー互換：補足あり → 動画受信後にメッセージ入力
      if (状態.messageMode === メッセージモード_補足あり) {
        動画更新_FS_(messageId, { status: { stringValue: 動画ステータス_補足待ち } });
        ユーザー状態更新_FS_(userId, {
          pendingStep: ステップ_ユーザーメッセージ待ち,
          currentVideoMessageId: messageId,
          targetMessageIdForText: messageId,
        });

        LINEプッシュ送信実行_(userId, "動画OK。補足メッセージを送ってください。");
        continue;
      }

      動画更新_FS_(messageId, { status: { stringValue: 動画ステータス_キュー } });

      ユーザー状態更新_FS_(userId, {
        pendingStep: ステップ_なし,
        currentVideoMessageId: messageId,
        targetMessageIdForText: "",
      });

      LINEプッシュ送信実行_(userId, "動画OK。解析を開始します⏳");
    }

    return OKレスポンス_();
  } catch (err) {
    Webhookログ出力_("doPost", "例外", { err: String(err) });
    return OKレスポンス_();
  }
}

function OKレスポンス_() {
  return ContentService.createTextOutput("OK");
}

/**
 * アクションモード＋メッセージモード確定後に、動画待ちフローを開始する。
 * アクションモードに応じた pendingStep を設定し、ユーザーに案内メッセージを送信する。
 */
function AIコマンド_動画待ちフロー開始_(userId, actionMode, replyToken) {
  // Firestore から最新のユーザー状態を取得（messageMode, userMessage が反映済み）
  const doc = ユーザー状態取得_FS_(userId);
  const messageMode = FS文字列取得_(doc, "messageMode") || メッセージモード_なし;
  const userMessage = FS文字列取得_(doc, "userMessage") || "";

  const アクションラベル =
    actionMode === 動作モード_自分解析 ? "AI解析" :
    actionMode === 動作モード_比較 ? "AIプロ比較" :
    actionMode === 動作モード_過去比較 ? "AI過去比較" :
    actionMode === 動作モード_質問 ? "AI質問" : actionMode;

  const メッセージラベル =
    messageMode === メッセージモード_なし ? "追加テキストなし" :
    messageMode === メッセージモード_質問 ? "追加テキスト：質問あり" :
    messageMode === メッセージモード_注目 ? "追加テキスト：注目ポイントあり" : messageMode;

  if (actionMode === 動作モード_自分解析 || actionMode === 動作モード_質問) {
    ユーザー状態更新_FS_(userId, {
      pendingStep: ステップ_自分動画待ち,
      state: ユーザー状態_待機,
    });

    if (replyToken) LINE返信送信_(replyToken,
      `⛳ 設定完了！\n\n📌 モード：${アクションラベル}\n📝 ${メッセージラベル}` +
      (userMessage ? `\n💬 「${userMessage}」` : "") +
      "\n\nスイング動画を送ってください🎥"
    );
    return;
  }

  if (actionMode === 動作モード_過去比較) {
    ユーザー状態更新_FS_(userId, {
      pendingStep: ステップ_過去比較_過去動画待ち,
      prevVideoMessageId: "",
      state: ユーザー状態_待機,
    });

    if (replyToken) LINE返信送信_(replyToken,
      `⛳ 設定完了！\n\n📌 モード：${アクションラベル}\n📝 ${メッセージラベル}` +
      (userMessage ? `\n💬 「${userMessage}」` : "") +
      "\n\nこの設定で比較します－\n\nまず【過去の動画】（ビフォー）を送ってください。\n\n次に【今回の動画】（アフター）を送ってもらいます。"
    );
    return;
  }

  if (actionMode === 動作モード_比較) {
    ユーザー状態更新_FS_(userId, {
      pendingStep: ステップ_比較_プロ動画待ち,
      proVideoMessageId: "",
      state: ユーザー状態_待機,
    });

    if (replyToken) LINE返信送信_(replyToken,
      `⛳ 設定完了、\n\n📌 モード：${アクションラベル}\n❍ ${メッセージラベル}` +
      (userMessage ? `\n💬 「${userMessage}」` : "") +
      "\n\nこの設定で比較します。\nまず【プロ動画】を送ってください🎥\n（次に自分の動画を送ってもらいます）"
    );
    return;
  }
}

/**
 * #AI コマンド時に、動画解析の残り回数があるか確認する。
 * @param {object} 状態 - user_state から取り出した planType, monthlyVideoLimit, monthlyVideoUsed, ticketBalance
 * @returns {{ ok: boolean, message?: string }} 残りあれば ok: true。超過時は ok: false と message。
 */
function 動画解析_残り回数チェック_(状態) {
  const planType = 状態.planType || プラン種別_free;
  const 月上限 = (状態.monthlyVideoLimit && 状態.monthlyVideoLimit > 0)
    ? 状態.monthlyVideoLimit
    : 月上限_プランから決定_(planType);
  const 月上限超過 = 状態.monthlyVideoUsed >= 月上限;
  const チケットあり = 状態.ticketBalance > 0;

  if (月上限超過 && !チケットあり) {
    let message;
    if (月上限 === Paid_月上限) {
      message = "今月の解析回数（10本）を使い切りました。\n\n来月1日にリセットされます。";
    } else {
      message = "無料トライアルの解析枠を使い切りました。\n\n📈 もっと解析したい方は有料プランへ！\n「#プラン」と送ってください（月額480円・月10回）";
    }
    return { ok: false, message };
  }
  return { ok: true };
}

/* =========================================================
 * コマンド解析（2段階カード選択フロー対応）
 *
 * ■ アクションモード選択（Step1）:
 *   #AI_解析 / #AI_プロ比較 / #AI_過去比較
 *   → { ok:true, type:"action", actionMode:"自分"|"比較"|"過去比較" }
 *
 * ■ メッセージモード選択（Step2）:
 *   #AI_追加テキストなし / #AI_追加テキスト質問 / #AI_追加テキスト注目
 *   → { ok:true, type:"message", messageMode:"なし"|"質問"|"注目" }
 *
 * ■ 旧3パーツ形式（後方互換）:
 *   #AI SELF NOW / #AI COMPARE WITH_MESSAGE 等
 *   → { ok:true, type:"legacy", actionMode, messageMode }
 * =======================================================*/
function AIコマンド解析_(text) {
  var t = String(text || "").trim().replace(/[\s\u3000\uFF3F]+/g, "_");
  t = t.replace(/^#AI(?!_)/, "#AI_");
  const tUpper = t.toUpperCase();

  // ── 新フロー：メッセージモード選択（#AI_追加テキスト〇〇） ──
  if (t.startsWith("#AI_追加テキスト")) {
    const suffix = t.replace("#AI_追加テキスト", "").trim();
    if (suffix === "なし") return { ok: true, type: "message", messageMode: メッセージモード_なし };
    if (suffix === "あり") return { ok: true, type: "message", messageMode: メッセージモード_テキストあり };
    if (suffix === "質問") return { ok: true, type: "message", messageMode: メッセージモード_質問 };  // 後方互換
    if (suffix === "注目") return { ok: true, type: "message", messageMode: メッセージモード_注目 };  // 後方互換
    return { ok: false };
  }

  // ── 新フロー：アクションモード選択（#AI_解析 / #AI_プロ比較 / #AI_過去比較） ──
  if (t === "#AI_解析")     return { ok: true, type: "action", actionMode: 動作モード_自分解析 };
  if (t === "#AI_プロ比較") return { ok: true, type: "action", actionMode: 動作モード_比較 };
  if (t === "#AI_過去比較") return { ok: true, type: "action", actionMode: 動作モード_過去比較 };
  if (t === "#AI_質問")     return { ok: true, type: "action", actionMode: 動作モード_質問 };

  // ── 旧フロー：3パーツ形式（後方互換） ──
  const parts = tUpper.split(/_+/);
  if (parts.length >= 3 && parts[0] === "#AI") {
    const action = parts[1];
    const mode = parts[2];
    const actionMode =
      action === "SELF" ? 動作モード_自分解析 :
      action === "COMPARE" ? 動作モード_比較 :
      action === "PREV" ? 動作モード_過去比較 : "";
    const messageMode =
      mode === "NOW" ? メッセージモード_すぐ解析 :
      mode === "WITH_MESSAGE" ? メッセージモード_補足あり : "";
    if (actionMode && messageMode) return { ok: true, type: "legacy", actionMode, messageMode };
  }

  return { ok: false };
}

/* =========================================================
 * アクションモード選択カード（Flex Message）生成
 * リッチメニュー「解析メニュー」タップ時にdoPostから送信するカード
 * =======================================================*/
/**
 * 動画長さエラー時のメッセージを pendingStep に応じて生成
 */
function 動画長エラーメッセージ生成_(pendingStep) {
  var base = "動画は20秒以内で送ってください⛳\nスイング1回分（20秒以内）の動画のみ受け付けています。\n\n";
  if (pendingStep === ステップ_比較_プロ動画待ち) {
    return base + "もう一度【プロの動画】を送ってください🎥";
  }
  if (pendingStep === ステップ_過去比較_過去動画待ち) {
    return base + "もう一度【過去の動画】（ビフォー）を送ってください🎥";
  }
  if (pendingStep === ステップ_過去比較_今回動画待ち) {
    return base + "もう一度【今回の動画】（アフター）を送ってください🎥";
  }
  if (pendingStep === ステップ_比較_自分動画待ち) {
    return base + "もう一度【自分の動画】を送ってください🎥";
  }
  return base + "もう一度動画を送ってください🎥";
}

function アクションモード選択カード生成_() {
  var items = [
    { title: "質問", desc: "動画＋質問を送って\n自由にAIコーチに聞く", color: "#9C27B0", icon: "https://cdn-icons-png.flaticon.com/128/1828/1828884.png", img: "https://images.unsplash.com/photo-1587174486073-ae5e5cff23aa?w=400", cmd: "#AI_質問" },
    { title: "AI解析", desc: "AIがあなたのスイングを\n詳しく分析します", color: "#4CAF50", icon: "https://cdn-icons-png.flaticon.com/128/4712/4712109.png", img: "https://images.unsplash.com/photo-1587174486073-ae5e5cff23aa?w=400", cmd: "#AI_解析" },
    { title: "プロ比較", desc: "プロのスイングと比較して\n改善点を発見します", color: "#2196F3", icon: "https://cdn-icons-png.flaticon.com/128/3135/3135810.png", img: "https://images.unsplash.com/photo-1535131749006-b7f58c99034b?w=400", cmd: "#AI_プロ比較" },
    { title: "過去比較", desc: "過去の自分と比較して\n成長を確認します", color: "#FF9800", icon: "https://cdn-icons-png.flaticon.com/128/2088/2088617.png", img: "https://images.unsplash.com/photo-1592919505780-303950717480?w=400", cmd: "#AI_過去比較" }
  ];
  var bubbles = items.map(function(it) {
    return {
      type: "bubble", size: "kilo",
      hero: { type: "image", url: it.img, size: "full", aspectRatio: "16:9", aspectMode: "cover" },
      body: {
        type: "box", layout: "vertical",
        contents: [
          { type: "box", layout: "horizontal", contents: [
            { type: "image", url: it.icon, size: "xxs", aspectMode: "fit", flex: 0 },
            { type: "text", text: it.title, weight: "bold", size: "lg", margin: "md", color: "#333333" }
          ]},
          { type: "text", text: it.desc, size: "sm", wrap: true, color: "#888888", margin: "md" }
        ]
      },
      footer: {
        type: "box", layout: "vertical",
        contents: [{ type: "button", action: { type: "message", label: it.title, text: it.cmd }, style: "primary", color: it.color }],
        paddingAll: "8px"
      }
    };
  });
  return {
    type: "flex", altText: "解析モードを選んでください",
    contents: { type: "carousel", contents: bubbles }
  };
}
function メッセージモード選択カード生成_() {
  var items = [
    { title: "テキストなし", desc: "動画だけですぐに\n解析を開始します", color: "#4CAF50", label: "テキストなし", cmd: "#AI_追加テキストなし" },
    { title: "テキストを追加", desc: "質問や補足、見てほしい\nポイントを添えて解析", color: "#2196F3", label: "テキストを追加", cmd: "#AI_追加テキストあり" }
  ];
  var bubbles = items.map(function(it) {
    return {
      type: "bubble", size: "kilo",
      header: {
        type: "box", layout: "vertical",
        contents: [{ type: "text", text: it.title, weight: "bold", size: "lg", align: "center", color: "#FFFFFF" }],
        backgroundColor: "#2C2C2C", paddingAll: "15px"
      },
      body: {
        type: "box", layout: "vertical",
        contents: [
          { type: "text", text: it.desc, size: "sm", align: "center", wrap: true, color: "#555555" }
        ],
        paddingAll: "15px"
      },
      footer: {
        type: "box", layout: "vertical",
        contents: [{ type: "button", action: { type: "message", label: it.label, text: it.cmd }, style: "primary", color: it.color }],
        paddingAll: "10px"
      }
    };
  });
  return {
    type: "flex", altText: "メッセージの有無を選んでください",
    contents: { type: "carousel", contents: bubbles }
  };
}
function 自由質問_対象動画取得_詳細_(userId, currentMessageId) {
  try {
    if (currentMessageId) {
      const doc = 動画ドキュメント取得_FS_(currentMessageId);
      const st = FS文字列取得_(doc, "status");
      const review = FS文字列取得_(doc, "reviewText");
      if (st === 動画ステータス_レビュー送信済み && review) {
        return {
          messageId: currentMessageId,
          reviewText: review,
          coachCheckText: FS文字列取得_(doc, "coachCheckText"),
          recentQA: 直近QA抽出_(doc, 3),
        };
      }
    }
  } catch (e) {}

  const URL = `https://firestore.googleapis.com/v1/projects/${GCPプロジェクトID}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: Firestoreコレクション_動画 }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath: "userId" }, op: "EQUAL", value: { stringValue: String(userId) } } },
            { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: 動画ステータス_レビュー送信済み } } },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: "updatedAt" }, direction: "DESCENDING" }],
      limit: 1,
    },
  };

  const res = Firestore通信_(URL, "post", body);
  const doc = (res.json || [])[0]?.document;
  if (!doc) return null;

  const id = doc.name.split("/").pop();
  const review = FS文字列取得_(doc, "reviewText");
  if (!review) return null;

  return {
    messageId: id,
    reviewText: review,
    coachCheckText: FS文字列取得_(doc, "coachCheckText"),
    recentQA: 直近QA抽出_(doc, 3),
  };
}

function 直近QA抽出_(videoDoc, n) {
  const values = videoDoc?.fields?.freeQuestions?.arrayValue?.values || [];
  if (!values.length) return "";

  const tail = values.slice(-Math.max(1, n));
  const lines = [];

  tail.forEach((v, idx) => {
    const q = v?.mapValue?.fields?.question?.stringValue || "";
    const a = v?.mapValue?.fields?.answer?.stringValue || "";
    if (q || a) {
      lines.push(`Q${idx + 1}: ${q}`);
      lines.push(`A${idx + 1}: ${a}`);
    }
  });

  return lines.join("\n").trim();
}

function 自由質問_履歴追記_(messageId, question, answer) {
  const beforeDoc = 動画ドキュメント取得_FS_(messageId);
  const before = beforeDoc?.fields?.freeQuestions?.arrayValue?.values || [];
  const beforeCount = before.length;

  Webhookログ出力_("自由質問", "freeQuestions 追記開始", { messageId, beforeCount });

  const nowIso = new Date().toISOString();
  const newItem = {
    mapValue: {
      fields: {
        question: { stringValue: String(question || "") },
        answer: { stringValue: String(answer || "") },
        askedAt: { timestampValue: nowIso },
      },
    },
  };

  const next = before.concat([newItem]).slice(-30);

  動画更新_FS_(messageId, {
    freeQuestions: { arrayValue: { values: next } },
  });

  const afterDoc = 動画ドキュメント取得_FS_(messageId);
  const after = afterDoc?.fields?.freeQuestions?.arrayValue?.values || [];
  const afterCount = after.length;

  Webhookログ出力_("自由質問", "freeQuestions 追記結果", { messageId, beforeCount, afterCount });

  return { beforeCount, afterCount };
}

/* =========================================================
 * 自由質問：プロンプト生成（70_プロンプトに委譲）
 * =======================================================*/
function 自由質問_最適化プロンプト生成_(p) {
  return プロンプト_自由質問_(p);
}

function 行数制限_整形_(text, maxLines) {
  var t = String(text || "").replace(/\r\n/g, "\n").trim();
  // #AI の直後にアンダースコアがなければ補完（例: #AI解析 → #AI_解析）
  t = t.replace(/^#AI(?!_)/, "#AI_");
  const lines = t.split("\n").map(s => s.trim()).filter(Boolean);
  const out = lines.slice(0, Math.max(1, maxLines || 6)).join("\n");
  if (out.length > 900) return out.slice(0, 900);
  return out;
}

/* =========================================================
 * 動画Blob正規化（現時は素通し）
 * =======================================================*/
function 動画Blob正規化_(blob, messageId) {
  return blob;
}

function MP4再生時間秒数_(bytes) {
  if (!bytes || !bytes.length) throw new Error("MP4 bytes が空です");

  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  const readU32 = (p) =>
    ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;

  const readU64 = (p) => {
    const hi = readU32(p);
    const lo = readU32(p + 4);
    return hi * 4294967296 + lo;
  };

  const readStr4 = (p) =>
    String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);

  const findAtom = (start, end, target) => {
    let p = start;
    while (p + 8 <= end) {
      let size = readU32(p);
      const type = readStr4(p + 4);
      let header = 8;

      if (size === 1) { size = readU64(p + 8); header = 16; }
      else if (size === 0) { size = end - p; }

      if (size < header) break;
      if (type === target) return { pos: p, size, header };
      p += size;
    }
    return null;
  };

  const moov = findAtom(0, u8.length, "moov");
  if (!moov) throw new Error("moov が見つかりません");

  const moovStart = moov.pos + moov.header;
  const moovEnd = moov.pos + moov.size;

  const mvhd = findAtom(moovStart, moovEnd, "mvhd");
  if (!mvhd) throw new Error("mvhd が見つかりません");

  const mvhdStart = mvhd.pos + mvhd.header;
  const version = u8[mvhdStart];

  if (version === 0) {
    const timescale = readU32(mvhdStart + 12);
    const duration = readU32(mvhdStart + 16);
    if (!timescale) throw new Error("timescale=0");
    return duration / timescale;
  }
  if (version === 1) {
    const timescale = readU32(mvhdStart + 20);
    const duration = readU64(mvhdStart + 24);
    if (!timescale) throw new Error("timescale=0");
    return duration / timescale;
  }
  throw new Error("mvhd version 未対応: " + version);
}

/* =========================================================
 * テスト関数：AIコマンド解析_の動作確認
 * GASエディタから直接実行して結果をログで確認できる
 * =======================================================*/
function test_AIcmd() {
  var cases = [
    "#AI_解析",
    "#AI解析",
    "#AI_プロ比較",
    "#AIプロ比較",
    "#AI_過去比較",
    "#AI過去比較",
    "#AI_追加テキストなし",
    "#AI_追加テキスト質問",
    "#AI_SELF_NOW",
  ];
  cases.forEach(function(input) {
    var result = AIコマンド解析_(input);
    Logger.log("input: [" + input + "] => " + JSON.stringify(result));
  });
}

