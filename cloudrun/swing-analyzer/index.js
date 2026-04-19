import express from "express";
import { VertexAI } from "@google-cloud/vertexai";
import { Storage } from "@google-cloud/storage";

const app = express();
// 動画2本 + プロンプトを受けるためペイロード上限を拡張
app.use(express.json({ limit: "64mb" }));

const PROJECT_ID = process.env.PROJECT_ID;
const LOCATION = process.env.LOCATION || "asia-northeast1";
//const MODEL = process.env.MODEL || "gemini-2.5-flash";
const MODEL = process.env.MODEL || "gemini-3.0-pro";
const SHARED_SECRET = process.env.SHARED_SECRET || "";

app.get("/", (req, res) => res.status(200).send("ok"));

function parseGsUri(gsUri) {
  // gs://bucket/path/to/file.mp4
  const m = /^gs:\/\/([^\/]+)\/(.+)$/.exec(gsUri || "");
  if (!m) return null;
  return { bucket: m[1], name: m[2] };
}

// GCS から動画をダウンロードし base64 + contentType を返す
async function fetchVideoAsInlineData(storage, gsUri) {
  const parsed = parseGsUri(gsUri);
  if (!parsed) {
    throw new Error("invalid gcsUri format (expected gs://bucket/object): " + gsUri);
  }
  const file = storage.bucket(parsed.bucket).file(parsed.name);

  // メタデータから contentType を拾う（無ければ video/mp4）
  const [meta] = await file.getMetadata().catch(() => [null]);
  const contentType = (meta && meta.contentType) ? String(meta.contentType) : "video/mp4";

  const [buf] = await file.download(); // Buffer
  if (!buf || buf.length === 0) {
    throw new Error("video file is empty: " + gsUri);
  }

  const videoB64 = buf.toString("base64");
  return { mimeType: contentType, data: videoB64 };
}

app.post("/analyze", async (req, res) => {
  try {
    const secret = req.header("x-shared-secret") || "";
    if (!SHARED_SECRET || secret !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { gcsUri, gcsUri2, prompt: userPrompt } = req.body || {};
    if (!gcsUri) {
      return res.status(400).json({ ok: false, error: "gcsUri required" });
    }

    const storage = new Storage();

    // --- 1) GCS から動画（1本目、必要なら2本目）を base64 化 ---
    const video1 = await fetchVideoAsInlineData(storage, gcsUri);

    let video2 = null;
    if (gcsUri2) {
      video2 = await fetchVideoAsInlineData(storage, gcsUri2);
    }

    // --- 2) プロンプトの決定 ---
    // promptが未指定 → 従来互換：固定プロンプトで観察メモを取得して reviewText を返す
    // promptが指定    → ユーザープロンプトで解析してそのまま answerText を返す
    const hasUserPrompt = typeof userPrompt === "string" && userPrompt.trim() !== "";

    const promptText = hasUserPrompt
      ? String(userPrompt)
      : (
          "あなたはプロのゴルフコーチです。目的：スイング動画から改善点を具体的に提示する。\\n" +
          "観点：\\n1. テークバック\\n2. トップ\\n3. 切り返し\\n4. ダウンスイング\\n5. インパクト\\n6. フォロー\\n" +
          "出力形式：\\n- 改善点3つ（理由つき）\\n- ドリル2つ\\n- NG例\\n" +
          "文体：短く、断定しすぎない、コーチ口調"
        );

    // --- 3) Vertex AI 呼び出し ---
    const vertexAI = new VertexAI({ project: PROJECT_ID, location: LOCATION });
    const genModel = vertexAI.getGenerativeModel({ model: MODEL });

    // ※ parts は「動画 → （動画2）→ テキスト」で統一（安定）
    const parts = [
      { inlineData: { mimeType: video1.mimeType, data: video1.data } },
    ];
    if (video2) {
      parts.push({ inlineData: { mimeType: video2.mimeType, data: video2.data } });
    }
    parts.push({ text: promptText });

    const request = {
      contents: [
        {
          role: "user",
          parts: parts,
        },
      ],
    };

    const result = await genModel.generateContent(request);
    const resp = await result.response;

    const text =
      resp?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "";

    const trimmed = text.trim();

    // promptあり → answerText、なし → reviewText（後方互換）
    if (hasUserPrompt) {
      return res.json({ ok: true, model: MODEL, answerText: trimmed });
    }
    return res.json({ ok: true, model: MODEL, reviewText: trimmed });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`listening ${port}`));
