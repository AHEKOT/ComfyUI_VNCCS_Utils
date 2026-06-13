# VNCCS UniCanvas InvokeAI Parity Audit

Scope: frontend canvas behavior already implemented in `web/vnccs_unicanvas.js`.
Excluded: backend generation graph/model execution.

## InvokeAI Source Map

- Stage/pan/zoom: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/konva/CanvasStageModule.ts`
- BBox: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/konva/CanvasTool/CanvasBboxToolModule.ts`
- Staging overlay: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/konva/CanvasStagingAreaModule.ts`
- Staging accept: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/components/StagingArea/context.tsx`
- PSD export: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/hooks/useExportCanvasToPSD.ts`
- Layer preview: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/components/common/CanvasEntityPreviewImage.tsx`
- Raster layer adapter: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/konva/CanvasEntity/CanvasEntityAdapterRasterLayer.ts`
- Brush tool: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/konva/CanvasTool/CanvasBrushToolModule.ts`
- Eraser tool: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/konva/CanvasTool/CanvasEraserToolModule.ts`
- Shape tool: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/konva/CanvasTool/CanvasShapeToolModule.ts`
- Lasso tool: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/konva/CanvasTool/CanvasLassoToolModule.ts`
- Object renderers: `InvokeAI/invokeai/frontend/web/src/features/controlLayers/konva/CanvasObject/*`

## Parity Fixes Applied

- Stage zoom now uses InvokeAI constants and behavior:
  - min scale `0.1`
  - max scale `20`
  - scale factor `0.999`
  - snap points `[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5]`
  - snap tolerance `0.02`
  - ctrl/meta + middle mouse vertical zoom drag using 240 px per doubling
- Fit bbox now uses InvokeAI padding `48` and max fit scale `1`.
- BBox move now snaps to 64 px by default and 8 px with ctrl/meta.
- BBox resize now uses 64 px default grid, 8 px ctrl/meta fine grid, shift aspect preservation, alt centered scaling.
- Staging final image now renders from bbox top-left using physical output dimensions, matching `CanvasStagingAreaModule` for final `imageName` outputs.
- Accept staging keeps InvokeAI's scale-and-center-into-bbox behavior.
- PSD export follows InvokeAI's `useExportCanvasToPSD` structure:
  - visible raster layers only
  - total visible rect from visible layer content bounds
  - per-layer cropped canvas
  - layer bounds relative to visible rect
  - opacity mapped to 0-255
  - `ag-psd.writePsd`
- Layer preview now renders actual alpha-cropped layer contents with checkerboard background.
- Lasso now targets an inpaint mask layer, not arbitrary active raster layer.
- Brush/eraser/mask now support shift straight-line drawing from the last draw point.

## Remaining Non-Parity

These are structural differences, not small styling gaps.

- InvokeAI stores canvas content as entities with object arrays:
  - `CanvasRasterLayerState.objects`
  - `CanvasImageState`
  - `CanvasBrushLineState`
  - `CanvasEraserLineState`
  - `CanvasRectState`
  - `CanvasOvalState`
  - `CanvasPolygonState`
  - `CanvasLassoState`
- Current UniCanvas rasterizes edits directly into `HTMLCanvasElement` layer bitmaps.
- InvokeAI tools draw into `CanvasEntityBufferObjectRenderer` first, then commit buffer objects into entity state.
- Current UniCanvas tools mutate the layer canvas immediately.
- InvokeAI layer transform, object transform, filter cache, opacity, blend mode, locked transparency, adjustments, and object-level history are not represented in the current state model.
- InvokeAI shape tool supports rect, oval, polygon, freehand polygon, start-point close indicators, polygon angle snapping, session suspension during temporary tool switching, drag translation, and object buffer commit.
- Current UniCanvas has only rasterized rectangle and lasso/freehand fill behavior.
- InvokeAI lasso has polygon/freehand modes, contour simplification, start-point hover close, angle snapping, and writes `CanvasLassoState` into inpaint mask objects.
- Current UniCanvas writes a filled polygon directly into a mask bitmap.
- InvokeAI brush/eraser supports pressure sensitivity, per-tool widths, buffer commit, clipping, locked transparency with `source-atop`, and object history.
- Current UniCanvas uses one brush size slider and immediate canvas strokes.
- InvokeAI staging state supports multiple queue items/images, progress images, auto-switch modes, show/hide staged image, discard selected/all, and toolbar navigation.
- Current UniCanvas supports one staged result only.

## Conclusion

The current widget cannot satisfy "works exactly like InvokeAI code" while staying as a plain-canvas immediate-raster editor.
Full parity requires replacing the current layer/tool internals with an InvokeAI-style entity/object/buffer architecture, then mapping rendering onto either Konva or an equivalent object renderer.
