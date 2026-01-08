# ComfyUI VNCCS Utils

A collection of utility nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) specifically designed for advanced camera control and prompt generation. These nodes are optimized for use with multi-angle LoRAs like **Qwen-Image-Edit-2511-Multiple-Angles**.

## 🚀 Features

### 1. VNCCS Visual Camera Control
A node featuring a custom graphical user interface for intuitive camera positioning.

*   **Interactive Canvas**: Click and drag to set the **Azimuth** (rotation) and **Distance** (zoom levels).
*   **Elevation Slider**: Vertical bar on the right to adjust the shot height (-30° to 60°).
*   **Trigger Toggle**: Click the status indicator in the bottom-right to toggle the `<sks>` trigger word (Green = Active, Red = Post-processed prompt only).

### 2. VNCCS Position Control
A standard node variant using traditional ComfyUI sliders and dropdowns. Best for automation or when connecting external primitives.

---

## 🛠 Parameters Reference

| Parameter | Values | Description |
| :--- | :--- | :--- |
| **Azimuth** | 0° to 315° (45° steps) | Horizontal rotation (0°=Front, 90°=Right, 180°=Back) |
| **Elevation** | -30°, 0°, 30°, 60° | Vertical angle (Low-angle to High-angle) |
| **Distance** | Close-up, Medium, Wide | Shot composition size |
| **Trigger** | Boolean | Toggle for the `<sks>` activation token |

---

## 📦 Installation

1. Navigate to your ComfyUI custom nodes directory:
   ```bash
   cd ComfyUI/custom_nodes
   ```
2. Clone this repository:
   ```bash
   git clone https://github.com/your-username/ComfyUI_VNCCS_Utils
   ```
3. Restart ComfyUI.

## 💡 Usage

These nodes output a formatted `STRING`. Use this output as an input for a **CLIP Text Encode** node or concatenate it with your main prompt using a string joiner. The generated tokens (e.g., `front-right quarter view`, `elevated shot`) are compatible with most modern multi-angle dataset standards.
