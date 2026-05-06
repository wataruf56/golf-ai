"""
pose-renderer Cloud Run service

エンドポイント:
  POST /render
    body: { gcsUri: "gs://.../in.mp4", reviewText?: string, outputBucket?: string }
    動作:
      1. GCS から動画をダウンロード
      2. MediaPipe で全フレームの骨格抽出
      3. ユーザー骨格オーバーレイ動画を生成し GCS にアップロード
      4. reviewText から「最優先で直す1つ」のフェーズを推定
      5. そのフェーズの代表フレームで「ユーザー vs 理想」比較画像を生成
      6. 各 URL（公開）を JSON で返す
"""
import os
import io
import json
import time
import uuid
import tempfile
import logging

import numpy as np
from flask import Flask, request, jsonify
from google.cloud import storage

from pose_utils import (
    extract_pose_from_video,
    render_overlay_video,
    render_compare_image,
    detect_priority_phase,
    pick_keyframe_index,
    PHASE_LABEL_JP,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("pose-renderer")

app = Flask(__name__)

SHARED_SECRET = os.environ.get("SHARED_SECRET", "")
DEFAULT_OUTPUT_BUCKET = os.environ.get("OUTPUT_BUCKET", "golf-ai-line-videos-staging")
IDEAL_POSES_DIR = os.path.join(os.path.dirname(__file__), "ideal_poses")

storage_client = storage.Client()


def _parse_gcs_uri(uri: str):
    if not uri.startswith("gs://"):
        return None
    rest = uri[5:]
    parts = rest.split("/", 1)
    if len(parts) != 2:
        return None
    return parts[0], parts[1]


def _download_blob(gcs_uri: str, dest_path: str):
    bk = _parse_gcs_uri(gcs_uri)
    if not bk:
        raise ValueError(f"invalid gcsUri: {gcs_uri}")
    bucket_name, blob_name = bk
    bucket = storage_client.bucket(bucket_name)
    blob = bucket.blob(blob_name)
    blob.download_to_filename(dest_path)


def _upload_blob(local_path: str, bucket_name: str, blob_name: str, content_type: str):
    bucket = storage_client.bucket(bucket_name)
    blob = bucket.blob(blob_name)
    blob.upload_from_filename(local_path, content_type=content_type)
    # 公開URLとして返す（バケットがpublic設定の場合に有効）
    return f"https://storage.googleapis.com/{bucket_name}/{blob_name}"


def _load_ideal_pose(phase_key: str):
    """
    ideal_poses/<phase>.json があれば読み込んで np.array (33,3) を返す。
    無ければ None。
    JSON フォーマット例:
      {"landmarks": [[x, y, vis], ...33個]}
    """
    path = os.path.join(IDEAL_POSES_DIR, f"{phase_key}.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        arr = np.array(data["landmarks"], dtype=np.float32)
        if arr.shape != (33, 3):
            return None
        return arr
    except Exception as e:
        log.warning("failed to load ideal pose %s: %s", phase_key, e)
        return None


@app.get("/")
def health():
    return ("ok", 200)


@app.post("/render")
def render():
    t0 = time.time()
    secret = request.headers.get("x-shared-secret", "")
    if SHARED_SECRET and secret != SHARED_SECRET:
        return jsonify({"ok": False, "error": "unauthorized"}), 401

    body = request.get_json(silent=True) or {}
    gcs_uri = body.get("gcsUri")
    if not gcs_uri:
        return jsonify({"ok": False, "error": "gcsUri required"}), 400

    review_text = body.get("reviewText", "") or ""
    output_bucket = body.get("outputBucket") or DEFAULT_OUTPUT_BUCKET

    job_id = uuid.uuid4().hex[:12]
    log.info("render start job=%s gcsUri=%s", job_id, gcs_uri)

    with tempfile.TemporaryDirectory() as tmp:
        in_path = os.path.join(tmp, "in.mp4")
        out_video_path = os.path.join(tmp, "overlay.mp4")
        out_image_path = os.path.join(tmp, "compare.png")

        # 1) ダウンロード
        try:
            _download_blob(gcs_uri, in_path)
        except Exception as e:
            log.exception("download failed")
            return jsonify({"ok": False, "error": f"download: {e}"}), 500

        # 2) ポーズ抽出
        try:
            frames_landmarks, meta = extract_pose_from_video(in_path)
        except Exception as e:
            log.exception("pose extraction failed")
            return jsonify({"ok": False, "error": f"pose: {e}"}), 500
        log.info("pose extracted job=%s frames=%d fps=%s", job_id, meta["extracted_frames"], meta["fps"])

        # 3) オーバーレイ動画
        try:
            render_overlay_video(in_path, out_video_path, frames_landmarks, meta["fps"])
        except Exception as e:
            log.exception("overlay video failed")
            return jsonify({"ok": False, "error": f"render: {e}"}), 500

        # アップロード
        video_blob_name = f"pose-overlay/{job_id}.mp4"
        try:
            video_url = _upload_blob(out_video_path, output_bucket, video_blob_name, "video/mp4")
        except Exception as e:
            log.exception("upload video failed")
            return jsonify({"ok": False, "error": f"upload video: {e}"}), 500

        # 4) Phase 2: 比較画像
        compare_url = None
        priority_phase = None
        try:
            priority_phase = detect_priority_phase(review_text)
            if priority_phase:
                # ユーザーの代表フレームを取り出す
                idx = pick_keyframe_index(meta["extracted_frames"], priority_phase)
                # 該当フレームの landmarks
                user_lm = frames_landmarks[idx]
                # 該当フレーム画像を取り出す
                import cv2
                cap = cv2.VideoCapture(in_path)
                cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
                ret, user_frame = cap.read()
                cap.release()
                if ret and user_lm is not None:
                    ideal_lm = _load_ideal_pose(priority_phase)
                    render_compare_image(
                        user_frame_bgr=user_frame,
                        user_landmarks=user_lm,
                        ideal_landmarks=ideal_lm,
                        out_path=out_image_path,
                        phase_label_jp=PHASE_LABEL_JP.get(priority_phase, ""),
                    )
                    image_blob_name = f"pose-compare/{job_id}.png"
                    compare_url = _upload_blob(out_image_path, output_bucket, image_blob_name, "image/png")
        except Exception as e:
            log.exception("compare image failed (non-fatal)")
            compare_url = None

        elapsed = round(time.time() - t0, 2)
        log.info("render done job=%s elapsed=%ss video=%s compare=%s",
                 job_id, elapsed, video_url, compare_url)

        return jsonify({
            "ok": True,
            "jobId": job_id,
            "videoUrl": video_url,
            "compareImageUrl": compare_url,
            "priorityPhase": priority_phase,
            "elapsedSec": elapsed,
            "frames": meta["extracted_frames"],
        })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
