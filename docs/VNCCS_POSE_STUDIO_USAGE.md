# VNCCS Pose Studio Usage Guide

The **VNCCS Pose Studio** is a professional 3D posing environment integrated directly into ComfyUI. It allows you to manipulate 3D characters, set up photographic lighting, and manage a library of poses for high-quality control signals.

## 1. Professional 3-Column Layout

The studio is organized into three distinct areas to maximize efficiency:

### Left Sidebar: Configuration & Precision
*   **Mesh Settings**: Adjust the mannequin's physical attributes including Age, Gender (blending), Weight, Muscle, and Height.
*   **Model Rotation**: Static sliders to rotate the entire character (X, Y, Z) without moving the camera.
*   **Camera Settings**: 
    *   **Dimensions**: Set output image resolution.
    *   **Zoom**: Control focal length/distance.
    *   **Camera Radar**: A 2D top-down view to orbit the camera around the mannequin with pixel-perfect precision.
*   **Export Settings**: Control how images are sent to ComfyUI (List or Grid mode) and set the global Background Color.

### Center: Interaction & Stage Management
*   **Viewport**: The main interaction area. Click joints to select bones and use the 3D Gizmo for rotation. **Undo/Redo** support is fully integrated.
*   **Multi-Pose Tabs**: Create sequences or batches of poses by adding tabs (+). Each tab is an independent pose state.
*   **Action Bar**: 
    *   **Undo/Redo (↩/↪)**: Step back/forward through bone movements.
    *   **Reset (↺)**: Clear the current pose.
    *   **Preview (👁)**: Snap the viewport to match the final output frame exactly (orange frame).
    *   **Copy/Paste (📋)**: Transfer complex poses between tabs in one click.
*   **Studio Footer**:
    *   **Background (🖼️)**: Load a reference image to trace poses accurately.
    *   **Import/Export (📥/📤)**: Batch save or load poses via JSON.
    *   **Settings (⚙️)**: Access advanced debug modes and automation toggles.

### Right Sidebar: Library & Environment
*   **📚 Pose Library Gallery**: A large button that launches the full-screen modal browser.
*   **Prompt Section**: A multiline, auto-expanding text box to describe scene details. Use it to add character descriptions or background info that will be combined with the lighting prompt.
*   **Scene Lighting**: Static, always-accessible controls for your lighting rig.
    *   **Ambient**: Global shadow-fill light.
    *   **Directional**: Parallel sun-like light.
    *   **Point Lights**: Localized bulbs. Use the **2D Radars** to position them in 3D space and the **Radius** slider to control their influence area.
    *   **Reset Lighting (↺)**: Revert to default studio lights.

## 2. Dynamic Pose Gallery

The Pose Library uses a **Modal Gallery** interface to keep the workspace focused.
*   Launch it via the button at the top of the right sidebar.
*   Browse, Load, or Delete poses in a full-screen grid.
*   **Save Current**: Save your current creative state directly into the library from the gallery footer.

## 3. Advanced Tips
*   **Auto-Lighting**: When enabled in settings, the studio will automatically calculate lighting positions based on your ComfyUI prompt to match your desired scene.
*   **Camera Frame**: The orange rectangle in the viewport represents the final render boundaries. 
*   **Skeleton Interaction**: Click the same joint multiple times to cycle through overlapping bones if necessary.
