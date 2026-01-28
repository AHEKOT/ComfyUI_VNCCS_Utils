# Version 0.4.2
## Fixes: Pose Studio Layout Stability
*   **Eliminated Resize Loop**: Refactored the `onResize` handler to stop modifying container dimensions manually. The layout now fills the node naturally, preventing infinite growth and fluctuations while remaining perfectly synced with the Three.js viewport.
*   **Performance (Resize Debouncing)**: Implemented debouncing for layout updates. The interface no longer flickers when resizing the node or moving the ComfyUI board.
*   **Cleaned Event Handling**: Removed redundant `setTimeout` chains that were repeatedly re-triggering size calculations.
*   **Firefox Compatibility**: Resolved multiple issues with the vertical light height (Y-HGT) slider in Firefox:
    *   Added required `orient="vertical"` attribute.
    *   Updated CSS with `writing-mode: vertical-lr` for correct vertical orientation.
    *   Applied `direction: rtl` to fix the inverted value direction (ensuring Min is at the bottom).

# Version 0.4.1
## Fixes & Optimizations: VNCCS Pose Studio
*   **Performance (Lazy Loading)**: The Pose Library now loads significantly faster. Full pose data is fetched only when needed (e.g., for randomization), while the gallery displays lightweight metadata.
*   **Memory Leak Fix (Three.js)**: Fixed a memory leak involving joint markers. Geometries and materials are now properly shared and disposed of, preventing gradual performance degradation.
*   **Input Offset (High-DPI Screens)**: Resolved an issue where mouse clicks were offset on 4K monitors with system scaling enabled. Replaced non-standard `zoom` CSS with `transform: scale()`.
*   **UI Lag Fix**: Debounced the data sync mechanism during slider and radar interactions. Dragging controls is now buttery smooth (60fps) while maintaining data integrity.
*   **Auto-Healing Backend**: The node now automatically detects if the 3D engine is uninitialized (e.g., after a server restart) and reloads the model before processing requests, preventing "stale cache" errors.
*   **Grid Mode Output**: Fixed `OUTPUT_IS_LIST` behavior for Grid Mode. It now correctly returns a list containing a single grid image tensor, resolving compatibility with preview nodes.
*   **Clean Prompts (Grid Mode)**: Grid Mode now generates a single, clean prompt (based on the first pose) instead of concatenating prompts from all grid cells.

## Improvements: Model Manager
*   **Smart Throttling**: Implemented a 5-minute local cache for `model_updater.json` checks. This eliminates excessive HEAD requests to Hugging Face during frequent workflow executions.
*   **Dependencies**: Added `requests` (was missing) and removed `color-matcher` (unused).

## New Features: Pose Studio Refinements
*   **Keep Original Lighting Mode**: New toggle to skip synthetic lighting in the 3D viewer, providing a clean white render while suppressing AI lighting prompts.
*   **Dynamic Prompt Overrides**: When "Keep Original Lighting" is ON, instructions like "Copy how the lighting falls..." are automatically replaced with "**Keep original lighting and colors.**"
*   **Debug Mode Enhancements**: 
    *   **Keep Manual Lighting**: Option to preserve custom lighting during randomized debug renders.
    *   **Accurate Portrait Mode**: Refined camera math for consistent upper-body framing in synthetic datasets.
*   **Natural Language Descriptions**: Refactored lighting prompts to be more descriptive (e.g., "character illuminated by...") for better SDXL/FLUX integration.

## Stability & Performance
*   **Initialization Fix**: Added a robust lighting failsafe to prevent the "black silhouette" bug on node load.
*   **UI Resizing**: Fixed a precision issue in aspect ratio calculation that caused vertical/horizontal stretching of the viewport.
*   **Library Stability**: Fixed a crash in the Pose Library grid when attempting to refresh without an open modal.
*   **Skeleton Sync**: Corrected handling of retargeted vertex weights for Game Engine configurations.

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
