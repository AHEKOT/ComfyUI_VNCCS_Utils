# VNCCS Pose Studio Usage Guide

The **VNCCS Pose Studio** (`VNCCS_Pose_Studio`) is a powerful interactive node that allows you to create, edit, save, and export 3D poses directly within ComfyUI. It serves as a visual interface for generating pose data (OpenPose/DensePose-like skeletons and depth maps) to control generative models or simply to visualize character placement.

## 1. Interface Overview

When you add the node, you will see a large 3D viewport and several control panels:

### Left Panel: Mesh & Character Settings
*   **Mesh Parameters**: Sliders to adjust the physical appearance of the 3D mannequin.
    *   **Age**: Affects body proportions (1-90).
    *   **Gender**: Blends between male (0) and female (1).
    *   **Weight/Muscle/Height**: Fine-tune body build.
    *   **Head Size**: Adjust head-to-body ratio.
*   **Gender Specifics**: Additional sliders appear based on the Gender setting (e.g., Breast Size for female, etc.).
*   **Reset Buttons**: Click the "↺" icon next to any slider to reset it to its default value.

### Middle: 3D Viewport
*   **Navigation**:
    *   **Left Click + Drag**: Rotate camera around model.
    *   **Right Click + Drag**: Pan camera.
    *   **Scroll Wheel**: Zoom in/out.
    *   **Middle Click**: Pan (alternative).
*   **Bone Selection**: Click on any yellow joint marker to select a bone. The selected bone turns cyan.
*   **Gizmo**: A rotation gizmo appears on the selected bone. Drag the colored rings (Red=X, Green=Y, Blue=Z) to rotate the limb.

### Right Panel: Camera & Export
*   **Dimensions**: Set the output image resolution (`Width` / `Height`).
*   **Camera Controls**:
    *   **Zoom**: Adjust camera distance/FOV.
    *   **Position X/Y**: Pan the camera frame relative to the model.
    *   **Re-center**: Quick button to reset camera offsets to (0,0).
*   **Background Color**: Choose the background color for the preview/render.

## 2. Pose Library

Click the **"📚 Library"** button (top-left of viewport) to open the Pose Library.

*   **Load Pose**: Click any pose card to apply it to your current mannequin.
*   **Save Pose**: Click the **"Save Current Pose"** button to save your current edits as a new library preset. You will be prompted to name it.
*   **Delete Pose**: Hover over a pose card and click the red **"✕"** icon to delete it.
*   **Import/Export**: Use the JSON buttons to backup or share your pose library.

## 3. Reference Image

You can load a 2D reference image into the 3D viewport to help with posing.
1.  Click **"Load Ref"** (top toolbar).
2.  Select an image file.
3.  The image appears as a semi-transparent plane in the background, aligned with the camera.

## 4. Multi-Pose Support (Tabs)

The node supports creating a **sequence** or **batch** of poses in a single node execution.
*   **Tabs**: At the top of the viewport, you see "Pose 1". Click **"+"** to add a new pose tab.
*   **Switching**: Click tabs to switch between different poses. Each tab has its own independent bone rotations.
*   **Copy/Paste**: Use the **"Copy"** and **"Paste"** buttons to transfer pose data between tabs.
*   **Batch Output**: When executed, the node will output a batch of images (one for each tab), which is useful for generating consistent characters in different poses or angles.

## 5. Outputs & Workflow Integration

The node outputs:
*   **IMAGE**: The rendered 3D viewport content as a tensor batch (RGB).
*   **MASK**: A mask of the character silhouette.
*   **POSE_DATA**: A specialized dictionary containing bone rotations, camera settings, and mesh parameters. This can be fed into other VNCCS nodes or saved.
*   **cnet_images**: (Optional) Can be used with ControlNet preprocessors if configured (e.g., Depth, OpenPose).

### Tips
*   **Sync**: Changing any slider or bone rotation immediately updates the underlying data.
*   **Undo/Redo**: Use the browser's context undo (or planned keyboard shortcuts) to revert accidental bone moves.
*   **Performance**: The 3D view is lightweight. If you have many tabs, generation time will scale linearly with the number of images rendered.
