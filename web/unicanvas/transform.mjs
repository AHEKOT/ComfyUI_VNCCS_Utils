/**
 * VNCCS UniCanvas - Photoshop-style Free Transform math.
 *
 * A transform keeps the layer's ORIGINAL pixels (a source rectangle of width x height) and a
 * frame: four world-space corners (quad) and, once Warp was used, a 4x4 bicubic Bezier control
 * mesh. Every gesture edits the frame from the frame captured at gesture start, so repeated
 * edits never resample the pixels; they are resampled once, on Apply.
 *
 * Pure functions only (no DOM): the widget in vnccs_unicanvas.js owns pointers, rendering and
 * history and calls into this module.
 */

export const QUAD_KEYS = ["nw", "ne", "se", "sw"];
export const TRANSFORM_MODES = ["free", "crop", "skew", "distort", "perspective", "warp"];
export const TRANSFORM_MODE_LABELS = {
  free: "Free transform",
  crop: "Crop",
  skew: "Skew",
  distort: "Distort",
  perspective: "Perspective",
  warp: "Warp",
};
const CORNER_UV = { nw: [0, 0], ne: [1, 0], se: [1, 1], sw: [0, 1] };
const EDGE_CORNERS = { n: ["nw", "ne"], e: ["ne", "se"], s: ["sw", "se"], w: ["nw", "sw"] };
const OPPOSITE_EDGE = { n: "s", s: "n", e: "w", w: "e" };

export function normalizeTransformMode(mode) {
  return TRANSFORM_MODES.includes(mode) ? mode : "free";
}

export function isCornerHandle(handle) {
  return QUAD_KEYS.includes(handle);
}

export function isEdgeHandle(handle) {
  return Object.prototype.hasOwnProperty.call(EDGE_CORNERS, handle);
}

export function cloneQuad(quad) {
  return quad ? Object.fromEntries(QUAD_KEYS.map((key) => [key, { x: quad[key].x, y: quad[key].y }])) : null;
}

export function rectToQuad(rect) {
  return {
    nw: { x: rect.x, y: rect.y },
    ne: { x: rect.x + rect.width, y: rect.y },
    se: { x: rect.x + rect.width, y: rect.y + rect.height },
    sw: { x: rect.x, y: rect.y + rect.height },
  };
}

export function boundsOfPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function quadCenter(quad) {
  // Center of the frame = the image of the source center (diagonal intersection for any quad).
  const h = homographyFromUnitSquare(quad);
  return h ? applyHomography(h, 0.5, 0.5) : averagePoint(QUAD_KEYS.map((key) => quad[key]));
}

function averagePoint(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

// ---------------------------------------------------------------------------
// Homography (unit square -> quad), exact for perspective
// ---------------------------------------------------------------------------

/** 3x3 projective map taking (0,0),(1,0),(1,1),(0,1) to quad.nw, ne, se, sw. */
export function homographyFromUnitSquare(quad) {
  const { nw: p0, ne: p1, se: p2, sw: p3 } = quad;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return [p1.x - p0.x, p2.x - p1.x, p0.x, p1.y - p0.y, p2.y - p1.y, p0.y, 0, 0, 1];
  }
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-12) return null;
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

export function applyHomography(m, u, v) {
  const w = m[6] * u + m[7] * v + m[8];
  const iw = Math.abs(w) < 1e-12 ? 1e12 : 1 / w;
  return { x: (m[0] * u + m[1] * v + m[2]) * iw, y: (m[3] * u + m[4] * v + m[5]) * iw };
}

export function invertHomography(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}

function multiplyHomography(m, n) {
  const r = new Array(9);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      r[row * 3 + col] = m[row * 3] * n[col] + m[row * 3 + 1] * n[3 + col] + m[row * 3 + 2] * n[6 + col];
    }
  }
  return r;
}

/** Projective map taking quad `from` onto quad `to` (used to carry a warp mesh along). */
export function homographyBetweenQuads(from, to) {
  const a = homographyFromUnitSquare(from);
  const b = homographyFromUnitSquare(to);
  const aInv = a && invertHomography(a);
  return aInv && b ? multiplyHomography(b, aInv) : null;
}

/** Frame-local (u,v) of a world point, u/v = 0..1 across the source rectangle. */
export function quadPointToUv(quad, point) {
  const h = homographyFromUnitSquare(quad);
  const inv = h && invertHomography(h);
  return inv ? applyHomography(inv, point.x, point.y) : null;
}

export function mapQuad(quad, fn) {
  return Object.fromEntries(QUAD_KEYS.map((key) => [key, fn(quad[key], key)]));
}

// ---------------------------------------------------------------------------
// Warp mesh (4x4 bicubic Bezier patch, row-major: index = row * 4 + col)
// ---------------------------------------------------------------------------

export function meshFromQuad(quad) {
  const h = homographyFromUnitSquare(quad);
  const mesh = [];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      mesh.push(h ? applyHomography(h, col / 3, row / 3) : { x: 0, y: 0 });
    }
  }
  return mesh;
}

export function meshCornersToQuad(mesh) {
  return { nw: { ...mesh[0] }, ne: { ...mesh[3] }, se: { ...mesh[15] }, sw: { ...mesh[12] } };
}

function bernstein(t) {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

export function evaluateMesh(mesh, u, v) {
  const bu = bernstein(u), bv = bernstein(v);
  let x = 0, y = 0;
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const w = bv[row] * bu[col];
      x += mesh[row * 4 + col].x * w;
      y += mesh[row * 4 + col].y * w;
    }
  }
  return { x, y };
}

/**
 * Warp by dragging the surface: the least-change control-point displacement that moves the
 * surface point at (u,v) by exactly `delta` (Photoshop's "drag inside the warp grid").
 */
export function dragMeshSurface(mesh, u, v, delta) {
  const bu = bernstein(u), bv = bernstein(v);
  const weights = [];
  let norm = 0;
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const w = bv[row] * bu[col];
      weights.push(w);
      norm += w * w;
    }
  }
  if (norm < 1e-12) return mesh.map((p) => ({ ...p }));
  return mesh.map((p, index) => ({ x: p.x + delta.x * weights[index] / norm, y: p.y + delta.y * weights[index] / norm }));
}

/** Move one control point; a corner carries its two tangent handles along (as in Photoshop). */
export function moveMeshPoint(mesh, index, delta) {
  const next = mesh.map((p) => ({ ...p }));
  const move = (i) => { next[i] = { x: mesh[i].x + delta.x, y: mesh[i].y + delta.y }; };
  move(index);
  const attached = { 0: [1, 4], 3: [2, 7], 12: [8, 13], 15: [11, 14] }[index] || [];
  attached.forEach(move);
  return next;
}

/** Nearest surface (u,v) to a world point, by sampling the patch (good enough for grabbing). */
export function meshPointToUv(mesh, point, samples = 24) {
  let best = null, bestDistance = Infinity;
  for (let j = 0; j <= samples; j += 1) {
    for (let i = 0; i <= samples; i += 1) {
      const u = i / samples, v = j / samples;
      const p = evaluateMesh(mesh, u, v);
      const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
      if (d < bestDistance) { bestDistance = d; best = { u, v }; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The mapping a draft renders with: source (u,v) -> world
// ---------------------------------------------------------------------------

export function transformMapper(draft) {
  if (draft?.mesh) return (u, v) => evaluateMesh(draft.mesh, u, v);
  const h = draft?.quad && homographyFromUnitSquare(draft.quad);
  return h ? (u, v) => applyHomography(h, u, v) : null;
}

/** Grid of world points [row][col] for (segments+1)^2 samples of the mapping. */
export function sampleTransformGrid(draft, segments) {
  const map = transformMapper(draft);
  if (!map) return null;
  const grid = [];
  for (let row = 0; row <= segments; row += 1) {
    const line = [];
    for (let col = 0; col <= segments; col += 1) line.push(map(col / segments, row / segments));
    grid.push(line);
  }
  return grid;
}

export function transformDraftBounds(draft, segments = 16) {
  if (draft?.mesh) {
    const grid = sampleTransformGrid(draft, segments);
    return grid ? boundsOfPoints(grid.flat()) : null;
  }
  return draft?.quad ? boundsOfPoints(QUAD_KEYS.map((key) => draft.quad[key])) : null;
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

/** Frame handles in world space: corners, edge midpoints and the rotate knob above the top edge. */
export function frameHandlePoints(quad, rotateOffset) {
  const h = homographyFromUnitSquare(quad);
  const at = (u, v) => (h ? applyHomography(h, u, v) : averagePoint([quad.nw, quad.se]));
  const points = [
    { handle: "nw", ...quad.nw },
    { handle: "n", ...at(0.5, 0) },
    { handle: "ne", ...quad.ne },
    { handle: "e", ...at(1, 0.5) },
    { handle: "se", ...quad.se },
    { handle: "s", ...at(0.5, 1) },
    { handle: "sw", ...quad.sw },
    { handle: "w", ...at(0, 0.5) },
  ];
  const top = points[1];
  const center = at(0.5, 0.5);
  let nx = top.x - center.x, ny = top.y - center.y;
  const len = Math.hypot(nx, ny);
  if (len < 1e-6) { nx = 0; ny = -1; } else { nx /= len; ny /= len; }
  points.push({ handle: "rotate", x: top.x + nx * rotateOffset, y: top.y + ny * rotateOffset, anchor: { x: top.x, y: top.y } });
  return points;
}

export function pointInQuad(quad, point) {
  const uv = quadPointToUv(quad, point);
  return Boolean(uv && uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1);
}

/**
 * What a pointer-down at `point` grabs, Photoshop style: a handle, the inside (move / warp
 * surface), or the outside (rotate). `threshold` is in world units.
 */
export function hitTransform(draft, point, { threshold, rotateOffset, mode }) {
  if (!draft?.quad) return null;
  if (mode === "warp") {
    const mesh = draft.mesh || meshFromQuad(draft.quad);
    let best = null, bestDistance = Infinity;
    mesh.forEach((p, index) => {
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d <= threshold && d < bestDistance) { best = index; bestDistance = d; }
    });
    if (best !== null) return { kind: "mesh-point", index: best };
    const uv = meshPointToUv(mesh, point);
    const surface = uv && evaluateMesh(mesh, uv.u, uv.v);
    if (surface && Math.hypot(surface.x - point.x, surface.y - point.y) <= threshold * 1.5) return { kind: "mesh-surface", u: uv.u, v: uv.v };
    return null;
  }
  let best = null, bestDistance = Infinity;
  for (const item of frameHandlePoints(draft.quad, rotateOffset)) {
    const limit = item.handle === "rotate" ? threshold * 1.5 : threshold;
    const d = Math.hypot(item.x - point.x, item.y - point.y);
    if (d <= limit && d < bestDistance) { best = item.handle; bestDistance = d; }
  }
  if (best === "rotate") return { kind: "rotate" };
  if (best) return { kind: "handle", handle: best };
  if (pointInQuad(draft.quad, point)) return { kind: "move" };
  // Outside the frame but near it: rotate (Photoshop's curved-arrow zone).
  const bounds = boundsOfPoints(QUAD_KEYS.map((key) => draft.quad[key]));
  const reach = threshold * 4;
  if (bounds && point.x >= bounds.x - reach && point.x <= bounds.x + bounds.width + reach
    && point.y >= bounds.y - reach && point.y <= bounds.y + bounds.height + reach) return { kind: "rotate" };
  return null;
}

// ---------------------------------------------------------------------------
// Gestures: each takes the frame captured at gesture start and returns the new quad
// ---------------------------------------------------------------------------

export function translateQuad(quad, dx, dy) {
  return mapQuad(quad, (p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function rotateQuad(quad, center, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return mapQuad(quad, (p) => {
    const dx = p.x - center.x, dy = p.y - center.y;
    return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
  });
}

export function snapAngle(angle, stepDegrees = 15) {
  const step = stepDegrees * Math.PI / 180;
  return Math.round(angle / step) * step;
}

/**
 * Scale from a corner or edge handle in the frame's own coordinates, so a rotated, skewed or
 * perspective frame scales along its own axes. Works in source-pixel units so "keep ratio"
 * keeps the image's aspect. `fromCenter` = Alt, `keepRatio` = Shift xor the Keep ratio option.
 */
export function scaleQuadFromHandle(quad, handle, point, { width, height, keepRatio = false, fromCenter = false }) {
  const h = homographyFromUnitSquare(quad);
  const inv = h && invertHomography(h);
  if (!inv) return cloneQuad(quad);
  const uv = applyHomography(inv, point.x, point.y);
  const W = Math.max(1e-6, width), H = Math.max(1e-6, height);
  let left = 0, top = 0, right = W, bottom = H;
  const px = uv.x * W, py = uv.y * H;
  const moveX = handle.includes("w") ? "left" : handle.includes("e") ? "right" : null;
  const moveY = handle.includes("n") ? "top" : handle.includes("s") ? "bottom" : null;
  if (moveX === "left") left = px; else if (moveX === "right") right = px;
  if (moveY === "top") top = py; else if (moveY === "bottom") bottom = py;
  if (fromCenter) {
    if (moveX === "left") right = W - left; else if (moveX === "right") left = W - right;
    if (moveY === "top") bottom = H - top; else if (moveY === "bottom") top = H - bottom;
  }
  if (keepRatio) {
    let sx = (right - left) / W, sy = (bottom - top) / H;
    if (!moveY) sy = Math.abs(sx) * Math.sign(sy || 1);
    else if (!moveX) sx = Math.abs(sy) * Math.sign(sx || 1);
    else if (Math.abs(sx) > Math.abs(sy)) sy = Math.abs(sx) * Math.sign(sy || 1);
    else sx = Math.abs(sy) * Math.sign(sx || 1);
    const nw = sx * W, nh = sy * H;
    if (fromCenter || !moveX) { const cx = (left + right) / 2; left = cx - nw / 2; right = cx + nw / 2; }
    else if (moveX === "left") left = right - nw; else right = left + nw;
    if (fromCenter || !moveY) { const cy = (top + bottom) / 2; top = cy - nh / 2; bottom = cy + nh / 2; }
    else if (moveY === "top") top = bottom - nh; else bottom = top + nh;
  }
  // Never collapse the frame to zero (a flip through the opposite side is allowed).
  const minSpan = 1e-3;
  if (Math.abs(right - left) < minSpan * W) right = left + minSpan * W * (right >= left ? 1 : -1);
  if (Math.abs(bottom - top) < minSpan * H) bottom = top + minSpan * H * (bottom >= top ? 1 : -1);
  const at = (x, y) => applyHomography(h, x / W, y / H);
  return { nw: at(left, top), ne: at(right, top), se: at(right, bottom), sw: at(left, bottom) };
}

export const EMPTY_CROP = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });

/**
 * Crop: dragging an edge or corner handle trims that side of the image; dragging it back out
 * restores the trimmed pixels (down to the full image). `crop` is the trim already applied, in
 * pixels of the FULL image (`full` = its width/height); `quad` frames the currently visible part.
 * Pixels keep their scale: only the frame edges move, along the frame's own axes.
 * Returns { crop, quad }.
 */
export function cropQuadFromHandle(quad, handle, point, { full, crop = EMPTY_CROP }) {
  const h = homographyFromUnitSquare(quad);
  const inv = h && invertHomography(h);
  if (!inv) return { crop: { ...crop }, quad: cloneQuad(quad) };
  const W = Math.max(1, full.width - crop.left - crop.right);
  const H = Math.max(1, full.height - crop.top - crop.bottom);
  const uv = applyHomography(inv, point.x, point.y);
  const px = uv.x * W, py = uv.y * H;
  const next = { ...crop };
  if (handle.includes("w")) next.left = Math.min(Math.max(0, crop.left + px), full.width - crop.right - 1);
  if (handle.includes("e")) next.right = Math.min(Math.max(0, crop.right + (W - px)), full.width - crop.left - 1);
  if (handle.includes("n")) next.top = Math.min(Math.max(0, crop.top + py), full.height - crop.bottom - 1);
  if (handle.includes("s")) next.bottom = Math.min(Math.max(0, crop.bottom + (H - py)), full.height - crop.top - 1);
  const left = next.left - crop.left, top = next.top - crop.top;
  const right = W - (next.right - crop.right), bottom = H - (next.bottom - crop.bottom);
  const at = (x, y) => applyHomography(h, x / W, y / H);
  return { crop: next, quad: { nw: at(left, top), ne: at(right, top), se: at(right, bottom), sw: at(left, bottom) } };
}

/** Distort: the grabbed corner goes exactly where the pointer is. */
export function distortQuadCorner(quad, corner, point) {
  const next = cloneQuad(quad);
  next[corner] = { x: point.x, y: point.y };
  return next;
}

/**
 * Skew from an edge: the edge slides along its own direction (the opposite edge stays, or
 * slides the other way with `symmetric`).
 */
export function skewQuadEdge(quad, edge, delta, { symmetric = false } = {}) {
  const [a, b] = EDGE_CORNERS[edge];
  const dir = { x: quad[b].x - quad[a].x, y: quad[b].y - quad[a].y };
  const len = Math.hypot(dir.x, dir.y) || 1;
  const t = (delta.x * dir.x + delta.y * dir.y) / len;
  const move = { x: dir.x / len * t, y: dir.y / len * t };
  const next = cloneQuad(quad);
  for (const key of [a, b]) next[key] = { x: quad[key].x + move.x, y: quad[key].y + move.y };
  if (symmetric) {
    for (const key of EDGE_CORNERS[OPPOSITE_EDGE[edge]]) next[key] = { x: quad[key].x - move.x, y: quad[key].y - move.y };
  }
  return next;
}

/** Skew from a corner (Skew mode): the corner slides along whichever of its edges the drag follows. */
export function skewQuadCorner(quad, corner, delta) {
  const edges = Object.entries(EDGE_CORNERS).filter(([, keys]) => keys.includes(corner));
  let best = null;
  for (const [edge, [a, b]] of edges) {
    const dir = { x: quad[b].x - quad[a].x, y: quad[b].y - quad[a].y };
    const len = Math.hypot(dir.x, dir.y) || 1;
    const t = (delta.x * dir.x + delta.y * dir.y) / len;
    if (!best || Math.abs(t) > Math.abs(best.t)) best = { edge, t, dir: { x: dir.x / len, y: dir.y / len } };
  }
  const next = cloneQuad(quad);
  next[corner] = { x: quad[corner].x + best.dir.x * best.t, y: quad[corner].y + best.dir.y * best.t };
  return next;
}

/**
 * Perspective: the grabbed corner slides along the edge the drag follows and its partner on that
 * edge mirrors it, so the frame stays a symmetric trapezoid (Photoshop's Perspective).
 */
export function perspectiveQuadCorner(quad, corner, delta) {
  const edges = Object.entries(EDGE_CORNERS).filter(([, keys]) => keys.includes(corner));
  let best = null;
  for (const [edge, [a, b]] of edges) {
    const dir = { x: quad[b].x - quad[a].x, y: quad[b].y - quad[a].y };
    const len = Math.hypot(dir.x, dir.y) || 1;
    const t = (delta.x * dir.x + delta.y * dir.y) / len;
    if (!best || Math.abs(t) > Math.abs(best.t)) best = { edge, t, dir: { x: dir.x / len, y: dir.y / len } };
  }
  const [a, b] = EDGE_CORNERS[best.edge];
  const partner = a === corner ? b : a;
  const next = cloneQuad(quad);
  next[corner] = { x: quad[corner].x + best.dir.x * best.t, y: quad[corner].y + best.dir.y * best.t };
  next[partner] = { x: quad[partner].x - best.dir.x * best.t, y: quad[partner].y - best.dir.y * best.t };
  return next;
}

export function flipQuad(quad, axis) {
  return axis === "horizontal"
    ? { nw: { ...quad.ne }, ne: { ...quad.nw }, se: { ...quad.sw }, sw: { ...quad.se } }
    : { nw: { ...quad.sw }, ne: { ...quad.se }, se: { ...quad.ne }, sw: { ...quad.nw } };
}

/** Flip the warp mesh together with its frame (mirrors the columns or the rows). */
export function flipMesh(mesh, axis) {
  const next = [];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const r = axis === "vertical" ? 3 - row : row;
      const c = axis === "horizontal" ? 3 - col : col;
      next.push({ ...mesh[r * 4 + c] });
    }
  }
  return next;
}

/**
 * 3D rotation: the frame is a flat card rotated around its own center by `tiltX` (around the
 * horizontal axis, top away from the viewer for positive values) and `tiltY` (around the vertical
 * axis) in degrees, then projected with a camera `focal` world units away. The card's axes are
 * the frame's own axes, so an already rotated frame tilts around its own edges.
 */
export function rotateQuad3d(quad, tiltXDegrees, tiltYDegrees, focal = null) {
  const center = quadCenter(quad);
  const ux = { x: (quad.ne.x - quad.nw.x + quad.se.x - quad.sw.x) / 2, y: (quad.ne.y - quad.nw.y + quad.se.y - quad.sw.y) / 2 };
  const uy = { x: (quad.sw.x - quad.nw.x + quad.se.x - quad.ne.x) / 2, y: (quad.sw.y - quad.nw.y + quad.se.y - quad.ne.y) / 2 };
  const lenX = Math.hypot(ux.x, ux.y) || 1, lenY = Math.hypot(uy.x, uy.y) || 1;
  const ex = { x: ux.x / lenX, y: ux.y / lenX }, ey = { x: uy.x / lenY, y: uy.y / lenY };
  const f = focal || Math.max(lenX, lenY) * 2.2;
  const ax = tiltXDegrees * Math.PI / 180, ay = tiltYDegrees * Math.PI / 180;
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
  return mapQuad(quad, (p) => {
    const dx = p.x - center.x, dy = p.y - center.y;
    // Local card coordinates (a along the frame's x axis, b along its y axis), z = 0.
    let a = dx * ex.x + dy * ex.y, b = dx * ey.x + dy * ey.y, z = 0;
    // Around the card's horizontal axis, then its vertical axis.
    const b1 = b * cx - z * sx, z1 = b * sx + z * cx;
    const a2 = a * cy + z1 * sy, z2 = -a * sy + z1 * cy;
    a = a2; b = b1; z = z2;
    const scale = f / Math.max(f * 0.05, f + z);
    return { x: center.x + (a * ex.x + b * ey.x) * scale, y: center.y + (a * ex.y + b * ey.y) * scale };
  });
}
