"""Internal SAM3D Body bridge used by VNCCS Pose Studio.

This package vendors only the image-to-pose inference path needed by Pose
Studio. It intentionally does not register the original SAM3DBody ComfyUI
nodes and does not use comfy-env.
"""

from .pose_import import process_image_to_pose_json

__all__ = ["process_image_to_pose_json"]
