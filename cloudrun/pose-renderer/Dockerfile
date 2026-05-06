FROM python:3.11-slim

# OpenCV / MediaPipe / ffmpeg に必要なネイティブライブラリ
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依存先にコピー（キャッシュ効かせる）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリ本体
COPY . .

ENV PORT=8080
EXPOSE 8080

# Cloud Run のリクエストを受ける
# threads=1 にすることで MediaPipe のグローバル状態の競合を避ける
CMD ["gunicorn", "-b", ":8080", "--workers", "1", "--threads", "1", "--timeout", "300", "main:app"]
