from .nodes.vnccs_nodes import VNCCS_PositionControl, VNCCS_VisualPositionControl

NODE_CLASS_MAPPINGS = {
    "VNCCS_PositionControl": VNCCS_PositionControl,
    "VNCCS_VisualPositionControl": VNCCS_VisualPositionControl,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_PositionControl": "VNCCS Position Control",
    "VNCCS_VisualPositionControl": "VNCCS Visual Camera Control",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
