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
