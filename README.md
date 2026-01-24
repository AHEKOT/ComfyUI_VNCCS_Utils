# ComfyUI VNCCS Utils

A collection of utility nodes from the [VNCCS](https://github.com/AHEKOT/ComfyUI_VNCCS) project that are useful not only for the project's primary goals but also for everyday ComfyUI workflows.

## **If you find my project useful, please consider supporting it! I work on it completely on my own, and your support will allow me to continue maintaining it and adding even more cool features!**

<a href="https://www.buymeacoffee.com/MIUProject" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## Main Nodes

### 1. VNCCS Visual Camera Control
**[Example Workflow](workflows/VNCCS_Utils%20Visual%20camera%20control%20node%20for%20Qwen-Image-Edit-2511-Multiple-Angles%20LoRa.json)**

An interactive node with a visual widget for controlling camera position. This is the primary node for intuitive angle control.
These node is specifically designed for advanced camera control and prompt generation, optimized for multi-angle LoRAs like **Qwen-Image-Edit-2511-Multiple-Angles**.

*   **Visual Widget**: Allows mouse-based selection of azimuth (rotation around the subject) and distance (rings).
*   **Elevation Slider**: A vertical bar on the right for selecting the elevation angle (-30° to 60°).
*   **Trigger Word**: A square indicator in the bottom-right corner toggles the presence of the <sks> trigger in the prompt (green for ON, red for OFF).

### 2. VNCCS QWEN Detailer
**[Example Workflow](workflows/VNCCS_Utils%20QwenDetailer_ChangeEmotion.json)**

A powerful detailing node that leverages QWEN-Image-Edit2511 model to enhance detected regions (faces, hands, objects). It goes beyond standard detailers by using visual understanding to guide the enhancement process.

*   **Smart Cropping**: Automatically squares crops and handles padding for optimal model input.
*   **Vision-Guided Enhancement**: Uses QWEN-generated instructions or user prompts to guide the detailing.
*   **Drift Fix**: Includes mechanisms to prevent the enhanced region from drifting too far from the original composition.
*   **Quality of Life**: Built-in color matching, Poisson blending (seam fix), and versatile upscaling options.
*   **Inpainting Mode**: specialized mode for mask-based editing or filling black areas.
*   **Inputs**: Requires standard model/clip/vae plus a BBOX_DETECTOR (like YOLO).
*   **Options**: Supports QWEN-Image-Edit2511 specific optimizations (`distortion_fix`, `qwen_2511` mode).

### 3. VNCCS Model Manager & Selector
**[Example Workflow](workflows/VNCCS_Utils%20Model%20Loader%20ShowCase.json)**

A robust system for managing and selecting models (LoRAs, Checkpoints) directly within ComfyUI, with support for Civitai and HuggingFace.

#### VNCCS Model Manager
This node acts as the backend for the system. It connects to a HuggingFace repository containing a `model_updater.json` configuration file, which defines the available models and their download sources.
*   **Repo ID**: Specify the HuggingFace repository ID.
*   **Downloads**: Handles downloading models in the background with queue support.
*   **Civitai Support**: Supports API Key authentication for restricted Civitai models.

👉 **[Configuration Guide: How to create your own model repo](docs/MODEL_MANAGER_GUIDE.md)**

#### VNCCS Model Selector
The companion node for selecting models. It provides a rich Graphical User Interface.
*   **Visual Card UI**: Displays the selected model's name, version, installed status, and description in a clean card format.
*   **Smart Search**: Clicking the card opens a modal with a searchable list of all available models in the repository.
*   **Status Indicators**: Shows clear indicators for "Installed", "Update Available", "Missing", or "Downloading".
*   **One-Click Install/Update**: Allows downloading or updating models directly from the list.
*   **Universal Connection**: Outputs a standard relative path string that is **fully compatible with standard ComfyUI nodes**. You can connect it directly!

👉 **[Usage Guide: How to use Selector with Standard Loaders](docs/MODEL_SELECTOR_USAGE.md)**

### 4. VNCCS BBox Extractor
A helper node to simply extract and visualize the crops. Useful when you need extract bbox detected regions but don't want to run whole facedetailer.

### 5. VNCCS Pose Studio
A professional 3D posing and lighting environment running entirely within a ComfyUI node.

*   **3-Column Interface**: Structured workflow with Parameters (Left), Viewport (Center), and Lighting/Library (Right).
*   **Interactive Viewport**: Sophisticated bone manipulation with gizmos and **Undo/Redo** functionality.
*   **Advanced Environment Lighting**: Ambient, Directional, and **Point Lights** with interactive 2D radars and radius control.
*   **Modal Pose Gallery**: A clean, full-screen gallery to manage and load saved poses without cluttering the UI.
*   **Multi-Pose Tabs**: System for creating batch outputs or sequences within a single node.
*   **Precision Framing**: Integrated camera radar and Zoom controls with a clean viewport frame visualization.
*   **Tracing Support**: Load background reference images for precise character alignment.



👉 **[Detailed Usage Guide](docs/VNCCS_POSE_STUDIO_USAGE.md)**

## Installation

1. Copy the ComfyUI_VNCCS_Utils folder into your ComfyUI custom_nodes directory.
2. Restart ComfyUI.

## Usage
The node outputs a string (Prompt) that should be connected to your CLIP Text Encode or used for concatenation with other prompt parts. It's ideally suited for LoRAs trained on multi-angle datasets.
