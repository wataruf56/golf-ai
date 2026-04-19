import express from "express";
import { VertexAI } from "@google-cloud/vertexai";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PROJECT_ID = process.env.PROJECT_ID;
const LOCATION = process.env.LOCATION || "asia-northeast1";
// ★まず確実に動くモデルにする（gemini-2.0系が使えない環境があるため）
const MODEL = process.env.MODEL || "gemini-1.5-flash-002";

const SHARED_SECRET = process.env.SHARED_SECRET || "";

app.get("/", (req, res) => res.status(200).send("ok"));

app.post("/answer", async (req, res) => {
  try {
    const secret = req.header("x-shared-secret") || "";
    if (!SHARED_SECRET || secret !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "text required" });

    const vertexAI = new VertexAI({ project: PROJECT_ID, location: LOCATION });
    const genModel = vertexAI.getGenerativeModel({ model: MODEL });

    const prompt =
      "あなたはゴルフコーチです。ユーザーの質問に短く具体的に答えてください。\n" +
      "・結論→理由→具体例 の順\n" +
      "・200〜400文字\n\n" +
      "質問: " + text;

    const request = { contents: [{ role: "user", parts: [{ text: prompt }] }] };

    const result = await genModel.generateContent(request);
    const resp = await result.response;

    const out = resp?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return res.json({ ok: true, model: MODEL, answerText: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`listening ${port}`));
