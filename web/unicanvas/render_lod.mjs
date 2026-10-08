// Render LOD levels for large inactive layers (a downscaled copy drawn instead of the full canvas).
export const RENDER_LOD_LEVELS = [0.5, 0.25, 0.125, 0.0625];

// The LOD copy must never have fewer pixels than the screen needs: pick the smallest level at or
// above the target scale, and full resolution once the target exceeds the largest level. (Picking
// the first level below the target drew every inactive layer at half resolution when zoomed in.)
export function pickRenderLodScale(targetScale) {
  const target = Number(targetScale);
  if (!Number.isFinite(target) || target > RENDER_LOD_LEVELS[0]) return 1;
  let best = RENDER_LOD_LEVELS[0];
  for (const scale of RENDER_LOD_LEVELS) {
    if (scale >= target) best = scale;
  }
  return best;
}
