import json

class VNCCS_PositionControl:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 0-360 degrees, step 45. Using display="slider" forces the UI widget.
                "azimuth": ("INT", {"default": 0, "min": 0, "max": 360, "step": 45, "display": "slider", "tooltip": "Angle of the camera around the subject (0=Front, 90=Right, 180=Back)"}),
                # -30 to 60, step 30. Using display="slider" forces the UI widget.
                "elevation": ("INT", {"default": 0, "min": -30, "max": 60, "step": 30, "display": "slider", "tooltip": "Vertical angle of the camera (-30=Low, 0=Eye Level, 60=High)"}),
                "distance": (["close-up", "medium shot", "wide shot"], {"default": "medium shot"}),
                "include_trigger": ("BOOLEAN", {"default": True, "tooltip": "Include <sks> trigger word"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    CATEGORY = "VNCCS"
    FUNCTION = "generate_prompt"
    
    def generate_prompt(self, azimuth, elevation, distance, include_trigger):
        # Normalize azimuth to 0-359
        azimuth = int(azimuth) % 360
        
        # Define exact mapping based on Qwen-Image-Edit-2511-Multiple-Angles-LoRA documentation
        azimuth_map = {
             0: "front view",
            45: "front-right quarter view",
            90: "right side view",
           135: "back-right quarter view",
           180: "back view",
           225: "back-left quarter view",
           270: "left side view",
           315: "front-left quarter view"
        }
        
        # Find closest key (handling the step constraint, but robust to typed values)
        # Handle 360/0 wrap-around specialized check
        if azimuth > 337.5:
             closest_azimuth = 0
        else:
             closest_azimuth = min(azimuth_map.keys(), key=lambda x: abs(x - azimuth))
             
        az_str = azimuth_map[closest_azimuth]

        # Elevation Map
        elevation_map = {
            -30: "low-angle shot",
              0: "eye-level shot",
             30: "elevated shot",
             60: "high-angle shot"
        }
        
        closest_elevation = min(elevation_map.keys(), key=lambda x: abs(x - elevation))
        el_str = elevation_map[closest_elevation]
        
        # Build Prompt
        parts = []
        if include_trigger:
            parts.append("<sks>")
            
        parts.append(az_str)
        parts.append(el_str)
        parts.append(distance)
        
        return (" ".join(parts),)


class VNCCS_VisualPositionControl(VNCCS_PositionControl):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # The JS widget submits a JSON string here.
                # format: {"azimuth": 0, "elevation": 0, "distance": "medium shot", "include_trigger": true}
                "camera_data": ("STRING", {"default": "{}", "hidden": True}), 
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    CATEGORY = "VNCCS"
    FUNCTION = "generate_prompt_from_json"

    def generate_prompt_from_json(self, camera_data):
        try:
            data = json.loads(camera_data)
        except json.JSONDecodeError:
            # Fallback defaults
            data = {"azimuth": 0, "elevation": 0, "distance": "medium shot", "include_trigger": True}
        
        return self.generate_prompt(
            data.get("azimuth", 0), 
            data.get("elevation", 0), 
            data.get("distance", "medium shot"), 
            data.get("include_trigger", True)
        )
