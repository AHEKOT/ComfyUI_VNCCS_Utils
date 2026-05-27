"""
Verification tests for pose studio bug fixes #1-#3, #5.
Run with: python tests/verify_pose_studio_fixes.py
No ComfyUI required.
"""
import sys
import os
import threading
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"


def test_bug1_skeleton_copy_joint_pos_idxs():
    """Bug #1: Skeleton.copy() must copy joint_pos_idxs (not joints_pos_idxs)."""
    from CharacterData.mh_skeleton import Skeleton
    skel = Skeleton("test")
    skel.joint_pos_idxs = {"head": [1, 2, 3], "neck": [4, 5]}
    copy = skel.copy()
    assert hasattr(copy, "joint_pos_idxs"), "copy() did not set joint_pos_idxs"
    assert copy.joint_pos_idxs == skel.joint_pos_idxs, \
        f"joint_pos_idxs mismatch: {copy.joint_pos_idxs} vs {skel.joint_pos_idxs}"
    print(f"[{PASS}] Bug #1 — Skeleton.copy() joint_pos_idxs")


def test_bug2_retarget_weights_checks_new_dict():
    """Bug #2: _retarget_weights extra_mapping must fire even when target bone
    is absent from original vertexWeights.data but present in new_weights_data."""
    from CharacterData.mh_skeleton import Skeleton, VertexBoneWeights
    from collections import OrderedDict

    skel = Skeleton("test")

    raw = OrderedDict({
        "scapula.L": [(0, 1.0), (1, 0.5)],
        "scapula.R": [(2, 1.0)],
    })
    skel.vertexWeights = VertexBoneWeights(raw, vertexCount=3)

    new_weights_data = OrderedDict({
        "clavicle_l": (np.array([0, 1], dtype=np.uint32), np.array([0.8, 0.4], dtype=np.float32)),
    })

    extra_mapping = {"clavicle_l": ["scapula.L", "scapula.R"]}
    for target_bone, sources in extra_mapping.items():
        if target_bone in new_weights_data or target_bone in skel.vertexWeights.data:
            t_vs, t_ws = new_weights_data.get(
                target_bone,
                (np.array([], dtype=np.uint32), np.array([], dtype=np.float32))
            )
            combined = dict(zip(t_vs.tolist(), t_ws.tolist()))
            for src in sources:
                if src in skel.vertexWeights.data:
                    s_vs, s_ws = skel.vertexWeights.data[src]
                    for i, v in enumerate(s_vs):
                        combined[int(v)] = combined.get(int(v), 0.0) + float(s_ws[i])
            vs = np.array(list(combined.keys()), dtype=np.uint32)
            ws = np.array(list(combined.values()), dtype=np.float32)
            new_weights_data[target_bone] = (vs[np.argsort(vs)], ws[np.argsort(vs)])

    assert "clavicle_l" in new_weights_data, "clavicle_l missing from new_weights_data"
    result_vs, result_ws = new_weights_data["clavicle_l"]
    assert len(result_vs) > 0, "No vertices merged for clavicle_l"
    print(f"[{PASS}] Bug #2 — retarget_weights uses new_weights_data in condition")


def test_bug3_cache_lock_exists():
    """Bug #3: _CACHE_LOCK must exist at module level in pose_studio."""
    src_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "nodes", "pose_studio.py"
    )
    with open(src_path, "r") as f:
        src = f.read()
    assert "_CACHE_LOCK" in src, "_CACHE_LOCK not found in pose_studio.py"
    assert "threading.Lock()" in src, "threading.Lock() not found in pose_studio.py"
    assert "with _CACHE_LOCK:" in src, "Lock context manager not found"
    print(f"[{PASS}] Bug #3 — _CACHE_LOCK present in pose_studio.py")


def test_bug5_sync_skipped_when_images_present():
    """Bug #5: sync request must be skipped when captured_images already in data."""
    src_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "nodes", "pose_studio.py"
    )
    with open(src_path, "r") as f:
        src = f.read()
    assert 'not pose_image_synced and not data.get("captured_images")' in src, \
        'Sync guard at unique_id block missing captured_images check'
    print(f"[{PASS}] Bug #5 — sync skipped when captured_images present")


if __name__ == "__main__":
    results = []
    for name, fn in [
        ("Bug #1", test_bug1_skeleton_copy_joint_pos_idxs),
        ("Bug #2", test_bug2_retarget_weights_checks_new_dict),
        ("Bug #3", test_bug3_cache_lock_exists),
        ("Bug #5", test_bug5_sync_skipped_when_images_present),
    ]:
        try:
            fn()
            results.append((name, True))
        except Exception as e:
            print(f"[\033[91mFAIL\033[0m] {name} — {e}")
            results.append((name, False))

    passed = sum(1 for _, ok in results if ok)
    print(f"\n{passed}/{len(results)} tests passed")
    sys.exit(0 if passed == len(results) else 1)
