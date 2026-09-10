import test from "node:test";
import assert from "node:assert/strict";
import { PanoramaOrbitControl, orbitPoint, orbitDrag, drawPanoramaOrbit } from "../web/vnccs_unicanvas_panorama_orbit.mjs";
import { normalizePanorama } from "../web/vnccs_unicanvas_panorama.mjs";

const camera = extra => normalizePanorama({ projection: "equirectangular", width: 4096, height: 2048, ...extra });
class OrbitCanvas {
  constructor(scale = 1) {
    this.scale = scale; this.events = {}; this.style = {}; this.attributes = {}; this.captured = new Set();
    this.frames = 0;
    this.ctx = { clearRect: () => this.frames++, beginPath() {}, moveTo() {}, lineTo() {}, arc() {},
      stroke() {}, fill() {}, fillText() {}, setTransform() {}, createRadialGradient: () => ({ addColorStop() {} }) };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  getContext() { return this.ctx; }
  getBoundingClientRect() { return { left: 10, top: 20, width: 270 * this.scale, height: 144 * this.scale }; }
  focus() {}
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); this.fire("lostpointercapture", { pointerId: id }); }
  fire(name, values = {}) {
    const event = { button: 0, pointerId: 1, deltaY: 0, deltaMode: 0, preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; }, ...values };
    for (const fn of this.events[name] || []) fn(event);
    return event;
  }
  point(x, y) {
    return { clientX: 10 + this.scale * (135 + x * 144 * .31), clientY: 20 + this.scale * (72 + y * 144 * .31) };
  }
}
function setup(extra = {}, scale = 1) {
  const canvas = new OrbitCanvas(scale), calls = [];
  const doc = { settings: camera(extra), beginCamera() { calls.push("begin"); return true; },
    setCamera(settings) { this.settings = settings; calls.push({ ...settings }); }, endCamera() { calls.push("end"); } };
  const control = new PanoramaOrbitControl(canvas);
  control.update(doc);
  return { control, canvas, doc, calls };
}

test("sphere drag updates both axes and visual orientation before release", () => {
  const { control, canvas, doc, calls } = setup();
  const initialFrames = canvas.frames;
  canvas.fire("pointerdown", canvas.point(0, 0));
  assert.equal(canvas.captured.has(1), true);
  canvas.fire("pointermove", canvas.point(.2, -.1));
  assert.ok(Math.abs(doc.settings.yaw + 28) < 1e-8);
  assert.ok(Math.abs(doc.settings.pitch + 14) < 1e-8);
  assert.ok(canvas.frames > initialFrames);
  assert.equal(calls.includes("end"), false);
  canvas.fire("pointermove", canvas.point(.4, -.2));
  assert.equal(calls.filter(c => c === "begin").length, 1);
  assert.ok(Math.abs(doc.settings.yaw + 56) < 1e-8);
  canvas.fire("pointerup");
  assert.equal(calls.filter(c => c === "end").length, 1);
  assert.equal(canvas.captured.size, 0);
  control.dispose();
});

test("outer ring controls roll continuously through its angular seam", () => {
  const { control, canvas, doc, calls } = setup();
  canvas.fire("pointerdown", canvas.point(0, -1.38));
  canvas.fire("pointermove", canvas.point(1.38, 0));
  assert.equal(doc.settings.roll, 90);
  assert.equal(doc.settings.yaw, 0); assert.equal(doc.settings.pitch, 0);
  canvas.fire("pointermove", canvas.point(0, 1.38));
  assert.equal(doc.settings.roll, -180);
  canvas.fire("pointermove", canvas.point(-1.38, 0));
  assert.equal(doc.settings.roll, -90);
  canvas.fire("pointermove", canvas.point(0, -1.38));
  assert.equal(doc.settings.roll, 0);
  assert.equal(calls.includes("end"), false);
  canvas.fire("pointerup"); control.dispose();
});

test("pointer coordinates remain consistent under node UI zoom", () => {
  for (const scale of [.75, 1, 2]) {
    const { control, canvas, doc } = setup({}, scale);
    canvas.fire("pointerdown", canvas.point(0, 0));
    canvas.fire("pointermove", canvas.point(.25, .1));
    assert.ok(Math.abs(doc.settings.yaw + 35) < 1e-8);
    assert.ok(Math.abs(doc.settings.pitch - 14) < 1e-8);
    control.dispose();
  }
});

test("wheel zoom and keyboard rotation update before gesture completion", () => {
  const { control, canvas, doc, calls } = setup();
  const event = canvas.fire("wheel", { deltaY: -50 });
  assert.equal(doc.settings.fov, 86); assert.equal(event.prevented, true);
  assert.equal(calls.includes("end"), false);
  canvas.fire("wheel", { deltaY: -100 });
  assert.equal(doc.settings.fov, 78); assert.equal(calls.filter(c => c === "begin").length, 1);
  control.finish();
  for (const [key, field, expected] of [["ArrowRight", "yaw", 5], ["ArrowUp", "pitch", 5], ["e", "roll", 5]]) {
    canvas.fire("keydown", { key }); assert.equal(doc.settings[field], expected);
    canvas.fire("keyup", { key });
  }
  canvas.fire("keydown", { key: "q", shiftKey: true }); assert.equal(doc.settings.roll, 4);
  canvas.fire("keyup", { key: "q" });
  control.dispose();
});

test("camera bounds and rolled drag directions agree with the current horizon", () => {
  const { control, canvas, doc } = setup({ pitch: 85, fov: 26, roll: 90 });
  const delta = orbitDrag(doc.settings, .1, 0);
  assert.ok(Math.abs(delta.yaw) < 1e-8); assert.ok(delta.pitch > 85);
  canvas.fire("pointerdown", canvas.point(0, 0)); canvas.fire("pointermove", canvas.point(.2, 0));
  assert.equal(doc.settings.pitch, 90); canvas.fire("pointerup");
  canvas.fire("wheel", { deltaY: -1000 }); assert.equal(doc.settings.fov, 25);
  control.dispose();
});

test("pointer cancel commits once and disposal clears capture and deferred work", () => {
  const { control, canvas, calls } = setup();
  canvas.fire("pointerdown", canvas.point(0, 0)); canvas.fire("pointermove", canvas.point(.1, .1));
  canvas.fire("pointercancel"); canvas.fire("pointerup");
  assert.equal(calls.filter(c => c === "end").length, 1);
  canvas.fire("wheel", { deltaY: 5 });
  assert.notEqual(control.timer, null);
  control.dispose();
  assert.equal(control.timer, null); assert.equal(control.document, null); assert.equal(control.abort.signal.aborted, true);
  const count = calls.length;
  canvas.fire("pointerdown", canvas.point(0, 0)); canvas.fire("wheel", { deltaY: 20 });
  assert.equal(calls.length, count);
});

test("replacement documents cannot receive movement from an old drag", () => {
  const { control, canvas, calls } = setup();
  canvas.fire("pointerdown", canvas.point(0, 0));
  const replacement = { settings: camera({ yaw: 80 }), setCamera() { assert.fail("stale drag"); } };
  control.update(replacement);
  canvas.fire("pointermove", canvas.point(.5, .5));
  assert.equal(control.gesture, null); assert.equal(canvas.captured.size, 0);
  assert.equal(calls.length, 1);
  control.update(null); assert.equal(canvas.tabIndex, -1); control.dispose();
});

test("blocked canvas edits do not start an orbit gesture", () => {
  const { control, canvas, doc, calls } = setup();
  doc.beginCamera = () => false;
  canvas.fire("pointerdown", canvas.point(0, 0)); canvas.fire("wheel", { deltaY: 5 });
  assert.equal(control.gesture, null); assert.equal(calls.length, 0);
  control.dispose();
});

test("axis drawing is finite at poles and reflects the saved roll", () => {
  const canvas = new OrbitCanvas();
  const points = [];
  for (const name of ["moveTo", "lineTo", "arc"]) canvas.ctx[name] = (...values) => points.push(...values);
  for (const pitch of [-90, 0, 90]) for (const roll of [-180, -90, 0, 45, 90]) drawPanoramaOrbit(canvas.ctx, 270, 144, camera({ pitch, roll }));
  assert.ok(points.length > 100); assert.ok(points.every(Number.isFinite));
  const x = orbitPoint([1, 0, 0], camera({ roll: 90 }));
  assert.ok(Math.abs(x.x) < 1e-8); assert.equal(x.y, -1);
});
