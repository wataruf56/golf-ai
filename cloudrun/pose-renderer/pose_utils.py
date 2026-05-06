"""
MediaPipe Pose を用いた骨格抽出 + 棒人間描画ユーティリティ
"""
import os
import cv2
import json
import math
import numpy as np
import mediapipe as mp
from typing import List, Optional, Dict, Any, Tuple

mp_pose = mp.solutions.pose

# MediaPipe Pose の 33 点ランドマークの主要な接続ペア（棒人間の骨）
POSE_CONNECTIONS = [
    # 顔（最低限）
    (11, 12),  # 両肩
    # 上半身
    (11, 23), (12, 24), (23, 24),  # 肩〜腰の四角形
    # 左腕
    (11, 13), (13, 15),
    # 右腕
    (12, 14), (14, 16),
    # 左手の指先寄り（簡略）
    (15, 17), (15, 19), (15, 21),
    (16, 18), (16, 20), (16, 22),
    # 左脚
    (23, 25), (25, 27), (27, 29), (27, 31),
    # 右脚
    (24, 26), (26, 28), (28, 30), (28, 32),
]

# 描画色（BGR）
COLOR_BONE_USER = (60, 220, 80)       # ユーザー：明るい緑
COLOR_JOINT_USER = (255, 255, 255)    # 関節：白
COLOR_BONE_IDEAL = (90, 165, 255)     # 理想：オレンジっぽい青
COLOR_JOINT_IDEAL = (50, 200, 255)    # 理想の関節


def extract_pose_from_video(video_path: str, max_frames: Optional[int] = None) -> Tuple[List[Optional[np.ndarray]], Dict[str, Any]]:
    """
    動画から各フレームのポーズランドマーク（33点 × x,y,visibility）を抽出する。
    戻り値: (フレームごとのランドマーク配列のリスト, メタ情報 dict)
    ランドマークが検出できなかったフレームは None を入れる。
    座標は正規化済み（0〜1）。
    """
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    frames_landmarks: List[Optional[np.ndarray]] = []

    with mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,
        enable_segmentation=False,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    ) as pose:
        idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if max_frames is not None and idx >= max_frames:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            res = pose.process(rgb)
            if res.pose_landmarks:
                arr = np.zeros((33, 3), dtype=np.float32)
                for i, lm in enumerate(res.pose_landmarks.landmark):
                    arr[i] = (lm.x, lm.y, lm.visibility)
                frames_landmarks.append(arr)
            else:
                frames_landmarks.append(None)
            idx += 1

    cap.release()
    meta = {
        "fps": fps,
        "width": width,
        "height": height,
        "total_frames": total,
        "extracted_frames": len(frames_landmarks),
    }
    return frames_landmarks, meta


def draw_skeleton_overlay(
    frame: np.ndarray,
    landmarks: Optional[np.ndarray],
    bone_color=COLOR_BONE_USER,
    joint_color=COLOR_JOINT_USER,
    thickness: int = 4,
    radius: int = 5,
) -> np.ndarray:
    """元のフレームの上に棒人間を描画して返す"""
    if landmarks is None:
        return frame
    h, w = frame.shape[:2]
    out = frame.copy()
    # 骨
    for a, b in POSE_CONNECTIONS:
        if landmarks[a, 2] < 0.3 or landmarks[b, 2] < 0.3:
            continue
        pa = (int(landmarks[a, 0] * w), int(landmarks[a, 1] * h))
        pb = (int(landmarks[b, 0] * w), int(landmarks[b, 1] * h))
        cv2.line(out, pa, pb, bone_color, thickness, cv2.LINE_AA)
    # 関節
    for i in range(33):
        if landmarks[i, 2] < 0.3:
            continue
        p = (int(landmarks[i, 0] * w), int(landmarks[i, 1] * h))
        cv2.circle(out, p, radius, joint_color, -1, cv2.LINE_AA)
    return out


def render_overlay_video(
    in_video_path: str,
    out_video_path: str,
    frames_landmarks: List[Optional[np.ndarray]],
    fps: float,
) -> None:
    """元動画を再度開き、各フレームにオーバーレイした動画を出力する"""
    cap = cv2.VideoCapture(in_video_path)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # mp4v コーデック（Cloud Run の ffmpeg と互換）
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(out_video_path, fourcc, fps, (width, height))

    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        lm = frames_landmarks[idx] if idx < len(frames_landmarks) else None
        annotated = draw_skeleton_overlay(frame, lm)
        writer.write(annotated)
        idx += 1

    cap.release()
    writer.release()


# ======================================================================
# Phase 2: 「ユーザー vs 理想」比較画像
# ======================================================================

PHASE_FRAME_RATIO = {
    # 動画全体に対する代表フレームの位置（暫定。後で精度UP）
    "address":        0.05,
    "takeback":       0.20,
    "top":            0.35,
    "transition":     0.45,
    "impact":         0.60,
    "followthrough":  0.75,
    "finish":         0.95,
}


def pick_keyframe_index(num_frames: int, phase: str) -> int:
    ratio = PHASE_FRAME_RATIO.get(phase, 0.5)
    return max(0, min(num_frames - 1, int(num_frames * ratio)))


def normalize_skeleton(landmarks: np.ndarray) -> np.ndarray:
    """
    骨格を中央化＋スケール正規化する。
    肩中心を原点、肩〜腰の長さを 1.0 に揃える。
    """
    pts = landmarks[:, :2].copy()
    shoulder_center = (pts[11] + pts[12]) / 2
    hip_center = (pts[23] + pts[24]) / 2
    pts -= shoulder_center
    torso_len = np.linalg.norm(shoulder_center - hip_center)
    if torso_len < 1e-6:
        torso_len = 1.0
    pts /= torso_len
    out = landmarks.copy()
    out[:, :2] = pts
    return out


def draw_skeleton_on_canvas(
    canvas: np.ndarray,
    landmarks: np.ndarray,
    cx: int,
    cy: int,
    scale: float,
    bone_color,
    joint_color,
    thickness: int = 4,
    radius: int = 5,
):
    """正規化済みランドマークを (cx, cy) を肩中心としてキャンバスに描く"""
    pts = []
    for i in range(33):
        x = int(cx + landmarks[i, 0] * scale)
        y = int(cy + landmarks[i, 1] * scale)
        pts.append((x, y, landmarks[i, 2]))
    for a, b in POSE_CONNECTIONS:
        if pts[a][2] < 0.3 or pts[b][2] < 0.3:
            continue
        cv2.line(canvas, (pts[a][0], pts[a][1]), (pts[b][0], pts[b][1]),
                 bone_color, thickness, cv2.LINE_AA)
    for i in range(33):
        if pts[i][2] < 0.3:
            continue
        cv2.circle(canvas, (pts[i][0], pts[i][1]), radius, joint_color, -1, cv2.LINE_AA)


def render_compare_image(
    user_frame_bgr: np.ndarray,
    user_landmarks: np.ndarray,
    ideal_landmarks: Optional[np.ndarray],
    out_path: str,
    phase_label_jp: str = "",
):
    """
    左：ユーザーの実際フレーム + 棒人間
    右：同じスケールで「理想」棒人間
    の横並びPNGを書き出す。
    ideal_landmarks が None の場合は左だけ。
    """
    h, w = user_frame_bgr.shape[:2]
    panel_h = h
    panel_w = w
    # 横並びキャンバス
    if ideal_landmarks is not None:
        canvas = np.full((panel_h + 60, panel_w * 2 + 20, 3), 245, dtype=np.uint8)
    else:
        canvas = np.full((panel_h + 60, panel_w, 3), 245, dtype=np.uint8)

    # 左：ユーザー（元フレーム + skeleton）
    left = draw_skeleton_overlay(user_frame_bgr, user_landmarks)
    canvas[60:60 + panel_h, 0:panel_w] = left

    if ideal_landmarks is not None:
        # 右：理想のシルエット（ユーザーの肩中心と同位置に重ねる）
        right_canvas = np.full((panel_h, panel_w, 3), 30, dtype=np.uint8)
        # スケール基準＝torso長を画面の30%に設定
        scale = panel_h * 0.30
        cx = panel_w // 2
        cy = panel_h // 2 - int(panel_h * 0.05)
        norm_ideal = normalize_skeleton(ideal_landmarks)
        draw_skeleton_on_canvas(
            right_canvas, norm_ideal, cx, cy, scale,
            COLOR_BONE_IDEAL, COLOR_JOINT_IDEAL, thickness=5, radius=6
        )
        canvas[60:60 + panel_h, panel_w + 20:panel_w * 2 + 20] = right_canvas

    # 上部にラベル
    label_left = f"YOU {phase_label_jp}"
    label_right = f"IDEAL {phase_label_jp}"
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(canvas, label_left, (20, 40), font, 1.0, (60, 60, 60), 2, cv2.LINE_AA)
    if ideal_landmarks is not None:
        cv2.putText(canvas, label_right, (panel_w + 40, 40), font, 1.0, (60, 60, 60), 2, cv2.LINE_AA)

    cv2.imwrite(out_path, canvas)


# ======================================================================
# 解析テキストから「最優先で直す1つ」のフェーズを抽出
# ======================================================================

PHASE_KEYWORDS_JP = {
    "address":        ["アドレス"],
    "takeback":       ["テイクバック", "テークバック"],
    "top":            ["トップ"],
    "transition":     ["切り返し", "切返し"],
    "impact":         ["インパクト"],
    "followthrough":  ["フォロー", "フォロースルー"],
    "finish":         ["フィニッシュ"],
}

PHASE_LABEL_JP = {
    "address":        "アドレス",
    "takeback":       "テイクバック",
    "top":            "トップ",
    "transition":     "切り返し",
    "impact":         "インパクト",
    "followthrough":  "フォロー",
    "finish":         "フィニッシュ",
}


def detect_priority_phase(review_text: str) -> Optional[str]:
    """
    レビューの「🎯 最優先で直す1つ」セクションからフェーズキーを取り出す。
    無ければレビュー全体から最も言及の多いフェーズを返す。
    """
    text = review_text or ""
    # まず「最優先で直す1つ」セクションを優先的に探す
    section = None
    for marker in ["🎯 最優先で直す1つ", "最優先で直す1つ", "🎯 次に直す1つ", "次に直す1つ", "🎯 最優先で真似する1つ", "最優先で真似する1つ"]:
        if marker in text:
            section = text.split(marker, 1)[1][:400]
            break

    target_text = section if section else text
    # キーワードマッチでカウント
    counts = {k: 0 for k in PHASE_KEYWORDS_JP}
    for k, kws in PHASE_KEYWORDS_JP.items():
        for kw in kws:
            counts[k] += target_text.count(kw)
    best = max(counts.items(), key=lambda x: x[1])
    if best[1] == 0:
        # 全文でも見つからなければ None
        return None
    return best[0]
