import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EMPTY_CROP,
  TRANSFORM_MODE_LABELS,
  applyHomography,
  cropQuadFromHandle,
  distortQuadCorner,
  dragMeshSurface,
  evaluateMesh,
  flipMesh,
  flipQuad,
  frameHandlePoints,
  hitTransform,
  homographyBetweenQuads,
  homographyFromUnitSquare,
  meshCornersToQuad,
  meshFromQuad,
  moveMeshPoint,
  perspectiveQuadCorner,
  quadCenter,
  quadPointToUv,
  rectToQuad,
  rotateQuad,
  rotateQuad3d,
  scaleQuadFromHandle,
  skewQuadEdge,
  snapAngle,
  transformDraftBounds,
  translateQuad,
} from "../web/unicanvas/transform.mjs";
import { pickRenderLodScale } from "../web/unicanvas/render_lod.mjs";

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
const nearPoint = (p, q, eps = 1e-6) => { near(p.x, q.x, eps); near(p.y, q.y, eps); };
const RECT = { x: 100, y: 50, width: 200, height: 100 };

test("homography maps the unit square onto any quad and inverts back", () => {
  const quad = { nw: { x: 10, y: 20 }, ne: { x: 300, y: 5 }, se: { x: 260, y: 240 }, sw: { x: 40, y: 200 } };
  const h = homographyFromUnitSquare(quad);
  nearPoint(applyHomography(h, 0, 0), quad.nw);
  nearPoint(applyHomography(h, 1, 0), quad.ne);
  nearPoint(applyHomography(h, 1, 1), quad.se);
  nearPoint(applyHomography(h, 0, 1), quad.sw);
  const uv = quadPointToUv(quad, applyHomography(h, 0.3, 0.7));
  near(uv.x, 0.3); near(uv.y, 0.7);
  const between = homographyBetweenQuads(rectToQuad(RECT), quad);
  nearPoint(applyHomography(between, RECT.x + RECT.width, RECT.y + RECT.height), quad.se);
});

test("scale from a corner keeps the opposite corner; Shift keeps the ratio; Alt scales from the center", () => {
  const quad = rectToQuad(RECT);
  const plain = scaleQuadFromHandle(quad, "se", { x: 400, y: 300 }, { width: 200, height: 100 });
  nearPoint(plain.nw, quad.nw);
  nearPoint(plain.se, { x: 400, y: 300 });
  const ratio = scaleQuadFromHandle(quad, "se", { x: 500, y: 160 }, { width: 200, height: 100, keepRatio: true });
  near((ratio.se.x - ratio.nw.x) / (ratio.se.y - ratio.nw.y), 2);
  const centered = scaleQuadFromHandle(quad, "e", { x: 350, y: 100 }, { width: 200, height: 100, fromCenter: true });
  nearPoint(quadCenter(centered), quadCenter(quad));
  near(centered.ne.x - centered.nw.x, 300);
});

test("scale follows a rotated frame's own axes", () => {
  const rotated = rotateQuad(rectToQuad(RECT), quadCenter(rectToQuad(RECT)), Math.PI / 2);
  // After a 90 degree turn the frame's "e" edge points down: dragging it further down widens the image.
  const wider = scaleQuadFromHandle(rotated, "e", { x: 200, y: 300 }, { width: 200, height: 100 });
  near(Math.hypot(wider.ne.x - wider.nw.x, wider.ne.y - wider.nw.y), 300, 1e-4);
  near(Math.hypot(wider.sw.x - wider.nw.x, wider.sw.y - wider.nw.y), 100, 1e-4);
});

test("rotate, snap, move, flip", () => {
  const quad = rectToQuad(RECT);
  const center = quadCenter(quad);
  const turned = rotateQuad(quad, center, Math.PI);
  nearPoint(turned.nw, quad.se);
  near(snapAngle(0.27), Math.PI / 12);
  nearPoint(translateQuad(quad, 5, -5).ne, { x: 305, y: 45 });
  nearPoint(flipQuad(quad, "horizontal").nw, quad.ne);
  nearPoint(flipQuad(quad, "vertical").nw, quad.sw);
});

test("skew slides an edge along itself; distort and perspective move corners", () => {
  const quad = rectToQuad(RECT);
  const skewed = skewQuadEdge(quad, "n", { x: 40, y: 30 });
  nearPoint(skewed.nw, { x: 140, y: 50 });
  nearPoint(skewed.ne, { x: 340, y: 50 });
  nearPoint(skewed.sw, quad.sw);
  const symmetric = skewQuadEdge(quad, "n", { x: 40, y: 0 }, { symmetric: true });
  nearPoint(symmetric.sw, { x: 60, y: 150 });
  nearPoint(distortQuadCorner(quad, "se", { x: 1, y: 2 }).se, { x: 1, y: 2 });
  const persp = perspectiveQuadCorner(quad, "nw", { x: 30, y: 4 });
  nearPoint(persp.nw, { x: 130, y: 50 });
  nearPoint(persp.ne, { x: 270, y: 50 });
  nearPoint(persp.sw, quad.sw);
});

test("3D rotation shrinks the far side and keeps the center", () => {
  const quad = rectToQuad(RECT);
  const tilted = rotateQuad3d(quad, 0, 40);
  const left = Math.hypot(tilted.sw.x - tilted.nw.x, tilted.sw.y - tilted.nw.y);
  const right = Math.hypot(tilted.se.x - tilted.ne.x, tilted.se.y - tilted.ne.y);
  assert.ok(Math.abs(left - right) > 5, "one vertical edge must recede");
  assert.ok(tilted.ne.x - tilted.nw.x < 200, "the card gets narrower when turned");
  nearPoint(rotateQuad3d(quad, 0, 0).ne, quad.ne);
  const center = quadCenter(tilted);
  near(center.y, 100, 1e-6);
});

test("warp mesh: identity from the frame, corner drags carry handles, surface drag hits the target", () => {
  const quad = rectToQuad(RECT);
  const mesh = meshFromQuad(quad);
  nearPoint(evaluateMesh(mesh, 0.25, 0.5), { x: 150, y: 100 });
  const moved = moveMeshPoint(mesh, 0, { x: -10, y: -10 });
  nearPoint(moved[1], { x: mesh[1].x - 10, y: mesh[1].y - 10 });
  nearPoint(meshCornersToQuad(moved).nw, { x: 90, y: 40 });
  const dragged = dragMeshSurface(mesh, 0.5, 0.5, { x: 20, y: -15 });
  nearPoint(evaluateMesh(dragged, 0.5, 0.5), { x: 220, y: 85 }, 1e-6);
  nearPoint(flipMesh(mesh, "horizontal")[0], mesh[3]);
  const bounds = transformDraftBounds({ quad: meshCornersToQuad(dragged), mesh: dragged });
  assert.ok(bounds.width >= 200 - 1e-6 && bounds.height >= 100 - 1e-6);
});

test("hit testing: handles, inside moves, just outside rotates, warp grabs mesh points", () => {
  const draft = { quad: rectToQuad(RECT) };
  const options = { threshold: 8, rotateOffset: 30, mode: "free" };
  assert.deepEqual(hitTransform(draft, { x: 300, y: 150 }, options), { kind: "handle", handle: "se" });
  assert.deepEqual(hitTransform(draft, { x: 200, y: 50 }, options), { kind: "handle", handle: "n" });
  assert.deepEqual(hitTransform(draft, { x: 200, y: 100 }, options), { kind: "move" });
  assert.deepEqual(hitTransform(draft, { x: 200, y: 20 }, options), { kind: "rotate" });
  assert.deepEqual(hitTransform(draft, { x: 320, y: 170 }, options), { kind: "rotate" });
  assert.equal(hitTransform(draft, { x: 900, y: 900 }, options), null);
  const rotate = frameHandlePoints(draft.quad, 30).find((item) => item.handle === "rotate");
  nearPoint(rotate, { x: 200, y: 20 });
  assert.deepEqual(hitTransform(draft, { x: 100, y: 50 }, { ...options, mode: "warp" }), { kind: "mesh-point", index: 0 });
  assert.equal(hitTransform(draft, { x: 200, y: 100 }, { ...options, mode: "warp" }).kind, "mesh-surface");
});

test("the widget renders drafts through the transform module and keeps the original pixels", async () => {
  const source = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/unicanvas\/transform\.mjs/);
  assert.match(source, /sampleTransformGrid\(draft,/);
  assert.doesNotMatch(source, /createTransformSourceFromDraft/, "gestures must not re-rasterize the draft");
});

test("inactive layers never render from a LOD copy smaller than the screen needs", () => {
  assert.equal(pickRenderLodScale(2.25), 1, "zoomed in: full resolution");
  assert.equal(pickRenderLodScale(1), 1);
  assert.equal(pickRenderLodScale(0.6), 1, "more than the largest level needs full resolution");
  assert.equal(pickRenderLodScale(0.5), 0.5);
  assert.equal(pickRenderLodScale(0.4), 0.5, "never below the target");
  assert.equal(pickRenderLodScale(0.2), 0.25);
  assert.equal(pickRenderLodScale(0.01), 0.0625);
});

test("crop trims a side, keeps the pixel scale and can be dragged back out", () => {
  const full = { width: 200, height: 100 };
  const quad = rectToQuad(RECT);
  const trimmed = cropQuadFromHandle(quad, "w", { x: 150, y: 100 }, { full, crop: EMPTY_CROP });
  near(trimmed.crop.left, 50);
  nearPoint(trimmed.quad.nw, { x: 150, y: 50 });
  nearPoint(trimmed.quad.se, quad.se);
  // Grabbing the new edge and moving it back to the old one restores the full image.
  const restored = cropQuadFromHandle(trimmed.quad, "w", { x: 100, y: 100 }, { full, crop: trimmed.crop });
  near(restored.crop.left, 0);
  nearPoint(restored.quad.nw, quad.nw);
  // Dragging further out cannot exceed the image, and a crop never collapses the frame.
  const outward = cropQuadFromHandle(trimmed.quad, "w", { x: 0, y: 100 }, { full, crop: trimmed.crop });
  near(outward.crop.left, 0);
  const collapsed = cropQuadFromHandle(quad, "e", { x: 0, y: 100 }, { full, crop: EMPTY_CROP });
  assert.ok(collapsed.crop.right <= full.width - 1);
});

test("crop works along the frame's own axes and on corners", () => {
  const full = { width: 100, height: 100 };
  const rotated = rotateQuad(rectToQuad({ x: 0, y: 0, width: 100, height: 100 }), { x: 50, y: 50 }, Math.PI / 2);
  // After a 90° turn the frame's "top" edge faces right; pulling it inward trims the image top.
  const { crop } = cropQuadFromHandle(rotated, "n", { x: 70, y: 50 }, { full, crop: EMPTY_CROP });
  assert.ok(crop.top > 0 && crop.left === 0 && crop.bottom === 0);
  const corner = cropQuadFromHandle(rectToQuad({ x: 0, y: 0, width: 100, height: 100 }), "se", { x: 60, y: 80 }, { full, crop: EMPTY_CROP });
  near(corner.crop.right, 40);
  near(corner.crop.bottom, 20);
});

test("Crop is an offered transform mode", () => {
  assert.equal(TRANSFORM_MODE_LABELS.crop, "Crop");
});
