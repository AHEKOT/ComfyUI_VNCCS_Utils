# Slimy_PoseStudio — 開発状況

## 方針変更履歴

| 時期 | 廃止 | 理由 |
|------|------|------|
| ～2026-04 | RTMW3D (rtmlib) | 3D精度が悪い |
| 2026-05初 | MeTRAbs | インストール依存地獄 |
| 2026-05-03 | HMR2.0 Windows直接実行 | Windows embedded Python で動かない |
| 2026-05-03現在 | **HMR2.0 via WSL2** | ✅ 採用中 |

---

## 現在の構成

### Pythonノード

| ファイル | クラス | 表示名 | 状態 |
|---------|--------|--------|------|
| `nodes/hmr2_pose.py` | `VNCCS_HMR2Pose` | `Slimy_HMR2Pose` | ✅ 完成 |
| `nodes/pose_studio.py` | `VNCCS_PoseStudio` | `Slimy_PoseStudio` | ✅ GUI調整完了 |
| `nodes/rtmw_pose.py` | `VNCCS_RTMWPose` | `Slimy_RTMWPose` | 廃止予定 |
| `nodes/metrabs_pose.py` | `VNCCS_MeTRAbs3DPose` | `Slimy_MeTRAbs3DPose` | 廃止予定 |
| `api/hand_pose_library.py` | - | - | ✅ 新規追加 |

### JSファイル

| ファイル | 役割 | 状態 |
|---------|------|------|
| `web/hmr2_detect.js` | テキストエリア・JSONダウンロードボタン | ✅ 実装済み |
| `web/vnccs_pose_studio.js` | PoseStudio UI | ✅ GUI調整完了 |
| `web/vnccs_pose_studio_core.js` | PoseStudio 3Dコア | ✅ IK/FK調整完了 |

---

## WSL2環境（2026-05-03構築済み）

- **ディストリビューション**: Ubuntu
- **ユーザー**: nori
- **conda環境**: 4dhumans (Python 3.10)
- **推論スクリプト**: `~/hmr2_infer.py`
- **4D-Humans**: `~/4D-Humans/`
- **モデルキャッシュ**: `~/.cache/4DHumans/`
- **SMPL**: `~/.cache/4DHumans/data/smpl/SMPL_NEUTRAL.pkl`

### WSL2の自動起動について
Windows起動時にWSL2が自動起動するため、手動でWSL2を起動してからComfyUIを起動する必要はない（現状では自動で動作している）。

---

## JSON出力仕様（2026-05-03確定）

### キーポイント定義
`pred_keypoints_3d` / `pred_keypoints_2d` はOpenPose Body 25点順（smpl_to_openpose準拠）で出力される。

```python
JOINT_NAMES = [
    "nose",             # 0
    "neck",             # 1
    "right_shoulder",   # 2
    "right_elbow",      # 3
    "right_wrist",      # 4
    "left_shoulder",    # 5
    "left_elbow",       # 6
    "left_wrist",       # 7
    "pelvis",           # 8
    "right_hip",        # 9
    "right_knee",       # 10
    "right_ankle",      # 11
    "left_hip",         # 12
    "left_knee",        # 13
    "left_ankle",       # 14
    "right_eye",        # 15
    "left_eye",         # 16
    "right_ear",        # 17
    "left_ear",         # 18
    "left_big_toe",     # 19
    "left_small_toe",   # 20
    "left_heel",        # 21
    "right_big_toe",    # 22
    "right_small_toe",  # 23
    "right_heel",       # 24
]
```

HMR2の実際の出力は44点（25点 + extra 19点）だが、先頭25点のみ使用。

### JSON構造
```json
{
  "version": "hmr2_3d_v1",
  "source_image_size": [W, H],
  "people": [
    {
      "person_id": 0,
      "bbox_norm": [x1, y1, x2, y2],
      "keypoints_3d": {"nose": [x,y,z], ...},
      "keypoints_2d_norm": {"nose": [nx, ny], ...}
    }
  ]
}
```

### 2D座標変換式
```python
crop_left = cx - box_size / 2.0
crop_top  = cy - box_size / 2.0
px = crop_left + box_size * (nx + 0.5)
py = crop_top  + box_size * (ny + 0.5)
joints2d_norm01[name] = [px / W, py / H]
```
変換式は正しい。画像外の値（>1.0）はHMR2が画像外に推定した関節で正常。

---

## PoseStudio GUI 完成済み機能（2026-05）

### IK/FK操作
- 通常ドラッグ → IK移動
- Ctrl/Shift ドラッグ → FK回転（トラックボール）
- 肩（upperarm）ドラッグ → clavicle IK（腕全体が平行移動）
- 肘/膝ドラッグ → ポールターゲット的動作（手足エフェクター固定）
- 指ボーン → ギズモなしでトラックボール回転
- Root ボーン → translate ギズモ（移動のみ）
- spine ボーン → 個別FK回転（neck/headは連動しない）

### UI
- フルスクリーンボタン（右ペイン上部）
- Mirror セクション：R▶L / R◀L / T-Pose / IK⇔FK / bone ツール（Get/Move/Reset）
- Hand Pose Library（右ペイン常駐）：サムネイル2列、L/Both/R適用、Save、削除
- ホバー時に対象の手をハイライト（シアン）＋赤い半透過球体
- Load JSON 時：SMPL Ref H / Shoulder Y オフセット調整スライダー

### Hand Pose Library
- 保存先：`HandPoseLibrary/` （プラグインルート直下）
- 1ポーズ = `name.json` + `name.png`（現在のビューをキャプチャ）
- 新しいものが上に表示（更新日時降順）
- 自動ユニーク名生成（`hand_001`, `hand_002`...）
- 既存名と重複時は自動リネーム（`name_02`...）
- データ形式：quaternion `[x, y, z, w]`（左右ミラー対応済み）
- API：`__init__.py` で `api/hand_pose_library.py` を登録

---

## 残課題

### WSL2 / conda 環境依存の解消
- 現状：HMR2.0 は WSL2 + Ubuntu + conda（4dhumans）環境が必要
- 目標：Windows ネイティブまたはより移植しやすい環境での動作
- 課題：SMPL モデルは学術ライセンスで再配布不可、4D-Humans も研究用ライセンス
- 別マシン移植時は `conda env export > environment.yml` を活用

---

## NG方針（リセット防止）

- RTMW3D / rtmlib の3D機能を再採用しない
- MeTRAbs を再採用しない
- detectron2 を依存に追加しない
- HMR2.0 を Windows embedded Python で直接動かそうとしない
- ComfyUI-MotionDiff は開発終了済みで採用しない
- GVHMR（ComfyUI-MotionCapture）は動画前提で採用しない
- **joint indexとJOINT_NAMESを疑うこと。名前と実際の座標が一致しているか必ず画像でプロットして確認すること**
- **デバッグは必ずWSL2でPythonを実行して画像にプロットして確認すること**
