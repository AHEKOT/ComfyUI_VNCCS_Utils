# Version 0.4.0
## New Features: VNCCS Pose Studio
The **VNCCS Pose Studio** is a major addition to the utility suite, offering a fully interactive 3D character posing environment directly inside ComfyUI.
*   **Interactive 3D Viewport**: Real-time WebGL-based bone manipulation (FK) with gizmo controls.
*   **Customizable Mannequin**: Parametric body sliders (Age, Gender, Weight, Muscle, Height, etc.) to match your character's physique.
*   **Pose Library**: Built-in system to **Save**, **Load**, and **Delete** your custom poses. Includes a starter set of poses (T-Pose, etc.).
*   **Multi-Pose Tabs**: Create and manage multiple poses in a single node instance. Generates batch image outputs for consistent character workflows.
*   **Camera Control**: Fine-tune framing with Zoom and Pan (X/Y) controls. All camera changes sync instantly across all pose tabs.
*   **Reference Image**: Load a background 2D image to trace or reference poses easily.
*   **Smart UI**: 
    *   Collapsible sections for cleaner workspace.
    *   **Reset Buttons (↺)** on all sliders to quickly revert to defaults.
    *   Auto-scaling UI that adapts to node resizing.
    *   Context-sensitive help (Tooltip-like behavior).

## Improvements
*   **Dependencies**: Added `kornia` and `color-matcher` to requirements for broader compatibility with vision tasks.
*   **Stability**: Fixed layout issues with "Delete" modal and button alignment in the web widget.
*   **Performance**: Optimized 3D rendering and texture management for lower VRAM overhead when using the Pose Studio.


# Version 0.3.1
## Changed:
### VNCCS QWEN Detailer
- **Drift Fix Logic**: Completely refactored `distortion_fix`. It now **only** controls square padding/cropping. The previously coupled logic that disabled VL tokens has been removed; the model now *always* sees vision tokens.
- **Color Match Tuning**: Reduced default `color_match_strength` from 1.0 to **0.8** to prevent over-brightening of shadows.
- **Padding Color**: Changed padding fill color from black to **white** (value 1.0) when squaring images.
- **Color Correction Migration**: Switched from `color-matcher` to **Kornia** for faster, GPU-accelerated color transfer.
- **Default Method**:  The default `color_match_method` is now `kornia_reinhard`.
- **Dependencies**: Removed `color-matcher` from requirements. Added `kornia`.

### Fixed
- **Kornia Import**: Fixed possible `ImportError` for `histogram_matching` on older Kornia versions (wrapped in try-except).

### Deprecated / Temporary
- **Legacy Compatibility Layer**: Added a transient frontend/backend fix to support legacy workflows using removed methods (e.g., `mkl`).
    - *Note: This auto-replacement logic (JS auto-fix on load + Backend auto-fix on execution) is temporary and will be removed in a future update. Users are encouraged to save their workflows with the new settings.*
