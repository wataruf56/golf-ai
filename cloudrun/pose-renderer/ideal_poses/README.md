# 理想ポーズ JSON 配置場所

各フェーズの「理想スイング姿勢」を 33 ランドマーク座標として配置する。
ファイル名規則：`<phase_key>.json`

| ファイル | フェーズ |
|---|---|
| `address.json` | アドレス |
| `takeback.json` | テイクバック |
| `top.json` | トップ |
| `transition.json` | 切り返し |
| `impact.json` | インパクト |
| `followthrough.json` | フォロー |
| `finish.json` | フィニッシュ |

JSON フォーマット例（33 個・各要素は `[x, y, visibility]`、x/y は 0〜1 の正規化座標）：

```json
{
  "landmarks": [
    [0.50, 0.10, 0.99],
    ...（33個）
  ],
  "source": "YouTube: 〇〇プロのドライバースイング analysis frame N"
}
```

## 取得方法（推奨フロー）

YouTube 上のプロのスイング動画から、各フェーズに該当するフレームを 1 枚ずつ抽出し、
MediaPipe Pose を回して 33 ランドマークを保存する。

ローカルで一度だけ実行する想定の使い捨てスクリプト例：

```python
import cv2, json, mediapipe as mp
mp_pose = mp.solutions.pose
img = cv2.imread("frame_top.png")
with mp_pose.Pose(static_image_mode=True) as pose:
    res = pose.process(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
lms = [[lm.x, lm.y, lm.visibility] for lm in res.pose_landmarks.landmark]
with open("top.json", "w", encoding="utf-8") as f:
    json.dump({"landmarks": lms, "source": "..."}, f)
```

## 暫定運用

ファイルが無いフェーズについては比較画像で右側の「IDEAL」が空欄になる。
（コードは graceful degrade して左側「YOU」のみ表示）
