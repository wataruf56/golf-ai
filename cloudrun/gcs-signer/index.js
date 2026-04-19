import express from "express";
import { Storage } from "@google-cloud/storage";

const app = express();
app.use(express.json());

const storage = new Storage();
const BUCKET = process.env.BUCKET_NAME;
const SIGN_EXPIRES_SECONDS = Number(process.env.SIGN_EXPIRES_SECONDS || 900);
const SHARED_SECRET = process.env.SHARED_SECRET;

app.post("/sign", async (req, res) => {
  try {
    const secret = req.header("x-shared-secret");
    if (!SHARED_SECRET || secret !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { objectPath } = req.body;
    if (!objectPath) {
      return res.status(400).json({ ok: false, error: "objectPath required" });
    }

    const file = storage.bucket(BUCKET).file(objectPath);

    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + SIGN_EXPIRES_SECONDS * 1000,
    });

    return res.json({ ok: true, signedUrl: url, expiresSeconds: SIGN_EXPIRES_SECONDS });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`listening ${port}`));
