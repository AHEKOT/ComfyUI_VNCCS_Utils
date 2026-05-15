# VNCCS Internal SAM3D Bridge

This directory vendors the SAM3D Body image-to-pose inference path used by
VNCCS Pose Studio.

It intentionally excludes the external ComfyUI node registration layer,
`comfy_env` bootstrap, web editors, Blender exporters, workflow examples, and
platform-specific wheels. The original license files copied from
`ComfyUI-SAM3DBody_utills/docs/licenses` are kept in `licenses/`.
