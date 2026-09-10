import { normalizePanorama } from "./vnccs_unicanvas_panorama.mjs";

const RAD = Math.PI / 180;
const AXES = [
  { label: "X", color: "#ff8fa3", vector: [1, 0, 0] },
  { label: "Y", color: "#91d4b0", vector: [0, 1, 0] },
  { label: "Z", color: "#b8a9e8", vector: [0, 0, 1] },
];

// World axes viewed from the panorama camera; +Z points into the scene.
export function orbitPoint([x, y, z], camera) {
  const yaw = camera.yaw * RAD, pitch = camera.pitch * RAD, roll = (camera.roll || 0) * RAD;
  const cx = Math.cos(yaw) * x - Math.sin(yaw) * z;
  const cz = Math.sin(yaw) * x + Math.cos(yaw) * z;
  const cy = Math.cos(pitch) * y - Math.sin(pitch) * cz;
  return { x: Math.cos(roll) * cx + Math.sin(roll) * cy,
    y: -Math.sin(roll) * cx + Math.cos(roll) * cy,
    z: Math.sin(pitch) * y + Math.cos(pitch) * cz };
}

export function orbitDrag(camera, dx, dy) {
  const roll = (camera.roll || 0) * RAD;
  return { yaw: camera.yaw - (dx * Math.cos(roll) - dy * Math.sin(roll)) * 140,
    pitch: camera.pitch + (dy * Math.cos(roll) + dx * Math.sin(roll)) * 140 };
}

export function drawPanoramaOrbit(ctx, width, height, camera, active = null) {
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2, cy = height / 2, radius = Math.min(width, height) * .31;
  const outer = radius * 1.38;
  ctx.lineCap = "round";
  const line = (points, color, thickness, alpha = 1) => {
    ctx.beginPath();
    points.forEach((p, i) => ctx[i ? "lineTo" : "moveTo"](cx + p.x * radius, cy - p.y * radius));
    ctx.strokeStyle = color; ctx.lineWidth = thickness; ctx.globalAlpha = alpha; ctx.stroke();
  };
  const circle = (r, color, thickness) => {
    ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = color; ctx.lineWidth = thickness; ctx.stroke();
  };
  const fill = ctx.createRadialGradient(cx - radius * .35, cy - radius * .4, 0, cx, cy, radius);
  fill.addColorStop(0, "#30283e"); fill.addColorStop(1, "#11101b");
  ctx.globalAlpha = 1; ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
  circle(radius, "#51465f", 1);
  // Far segments are muted; front segments stay bright for a readable orientation.
  for (const front of [false, true]) {
    for (let axis = 0; axis < 3; axis++) {
      let segment = [];
      for (let step = 0; step < 96; step++) {
        const points = [step, step + 1].map(i => {
          const a = i / 96 * Math.PI * 2, v = [0, 0, 0];
          v[(axis + 1) % 3] = Math.cos(a); v[(axis + 2) % 3] = Math.sin(a);
          return orbitPoint(v, camera);
        });
        if ((points[0].z + points[1].z < 0) === front) {
          if (!segment.length) segment.push(points[0]);
          segment.push(points[1]);
        } else if (segment.length) {
          line(segment, AXES[axis].color, front ? 1.5 : 1, front ? .7 : .15);
          segment = [];
        }
      }
      if (segment.length) line(segment, AXES[axis].color, front ? 1.5 : 1, front ? .7 : .15);
    }
  }
  // Outer ring is the horizon/roll handle. The highlighted arc also reflects FOV.
  circle(outer, active === "roll" ? "#b8a9e8" : "#665873", active === "roll" ? 2 : 1.5);
  const angle = (camera.roll || 0) * RAD - Math.PI / 2;
  for (let i = 0; i < 24; i++) {
    const a = i * Math.PI / 12;
    line([{ x: Math.cos(a) * 1.38, y: Math.sin(a) * 1.38 },
      { x: Math.cos(a) * (i % 6 === 0 ? 1.25 : 1.32), y: Math.sin(a) * (i % 6 === 0 ? 1.25 : 1.32) }], "#665873", 1, .8);
  }
  ctx.globalAlpha = 1; ctx.beginPath();
  ctx.arc(cx, cy, outer, angle - camera.fov * RAD / 2, angle + camera.fov * RAD / 2);
  ctx.strokeStyle = "#ff8fa3"; ctx.lineWidth = 3; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = "#ff8fa3"; ctx.fill();
  for (const axis of AXES.map(axis => ({ ...axis, point: orbitPoint(axis.vector, camera) })).sort((a, b) => b.point.z - a.point.z)) {
    const p = axis.point;
    line([{ x: 0, y: 0 }, p], axis.color, 1.5, p.z > 0 ? .45 : .95);
    const x = cx + p.x * radius, y = cy - p.y * radius;
    ctx.globalAlpha = 1; ctx.fillStyle = "#171320"; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = axis.color; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = axis.color; ctx.font = "600 10px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(axis.label, x, y + .5);
  }
  ctx.globalAlpha = 1;
}

export class PanoramaOrbitControl {
  constructor(canvas) {
    this.canvas = canvas;
    this.document = null;
    this.gesture = null;
    this.timer = null;
    this.disposed = false;
    this.abort = new AbortController();
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "group");
    canvas.setAttribute("aria-label", "Panorama orientation. Drag the sphere to look around; drag the outer ring to roll. Scroll to zoom. Arrow keys rotate, Q and E roll, plus and minus zoom.");
    const on = (name, fn, options = {}) => canvas.addEventListener(name, fn, { ...options, signal: this.abort.signal });
    on("pointerdown", event => this.pointerDown(event));
    on("pointermove", event => this.pointerMove(event));
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) on(name, event => {
      if (this.gesture?.pointerId === event.pointerId) this.finish();
    });
    on("wheel", event => this.wheel(event), { passive: false });
    on("keydown", event => this.keyDown(event));
    on("keyup", event => {
      if (this.gesture?.kind === "keyboard") { event.stopPropagation(); this.finish(); }
    });
    on("blur", () => this.finish());
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.render());
      this.observer.observe(canvas);
    }
  }

  update(document, settings = document?.pendingCamera || document?.settings) {
    if (this.disposed) return;
    if (document !== this.document) this.cancel();
    this.document = document || null;
    this.settings = settings ? normalizePanorama(settings) : null;
    this.canvas.tabIndex = document ? 0 : -1;
    if (settings) this.render();
  }

  point(event) {
    const rect = this.canvas.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) * .31;
    return { x: (event.clientX - rect.left - rect.width / 2) / radius,
      y: (event.clientY - rect.top - rect.height / 2) / radius };
  }

  begin(kind) {
    if (this.disposed || !this.document) return false;
    if (this.gesture?.kind === kind) return true;
    this.finish();
    if (!this.document.beginCamera()) return false;
    this.settings = { ...(this.document.pendingCamera || this.document.settings) };
    this.gesture = { kind };
    return true;
  }

  change(value) {
    this.settings = normalizePanorama({ ...this.settings, ...value });
    this.document.setCamera(this.settings);
    this.render();
  }

  pointerDown(event) {
    if (event.button !== 0 || this.disposed || this.gesture?.pointerId !== undefined) return;
    const p = this.point(event), distance = Math.hypot(p.x, p.y);
    if (distance > 1.65 || !this.begin(distance > 1.08 ? "roll" : "orbit")) return;
    event.preventDefault(); event.stopPropagation();
    this.canvas.focus({ preventScroll: true });
    this.gesture = { ...this.gesture, pointerId: event.pointerId, start: p, camera: { ...this.settings },
      lastAngle: Math.atan2(p.y, p.x), angle: 0 };
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = "grabbing";
    this.render();
  }

  pointerMove(event) {
    const gesture = this.gesture;
    if (this.disposed || !gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const p = this.point(event);
    if (gesture.kind === "roll") {
      const angle = Math.atan2(p.y, p.x);
      gesture.angle += Math.atan2(Math.sin(angle - gesture.lastAngle), Math.cos(angle - gesture.lastAngle));
      gesture.lastAngle = angle;
      this.change({ roll: gesture.camera.roll + gesture.angle / RAD });
    } else {
      this.change(orbitDrag(gesture.camera, p.x - gesture.start.x, p.y - gesture.start.y));
    }
  }

  wheel(event) {
    if (this.disposed || this.gesture?.pointerId !== undefined || !this.begin("wheel")) return;
    event.preventDefault(); event.stopPropagation();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 144 : 1);
    this.change({ fov: this.settings.fov + Math.max(-20, Math.min(20, delta * .08)) });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish(), 160);
  }

  keyDown(event) {
    if (this.disposed || this.gesture?.pointerId !== undefined) return;
    const step = event.shiftKey ? 1 : 5;
    const delta = { ArrowLeft: ["yaw", -step], ArrowRight: ["yaw", step], ArrowUp: ["pitch", step], ArrowDown: ["pitch", -step],
      q: ["roll", -step], e: ["roll", step], Q: ["roll", -step], E: ["roll", step], "+": ["fov", -step], "=": ["fov", -step], "-": ["fov", step] }[event.key];
    if (!delta || !this.begin("keyboard")) return;
    event.preventDefault(); event.stopPropagation();
    this.change({ [delta[0]]: this.settings[delta[0]] + delta[1] });
  }

  cancel() {
    clearTimeout(this.timer); this.timer = null;
    const pointerId = this.gesture?.pointerId;
    this.gesture = null;
    if (pointerId !== undefined && this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    this.canvas.style.cursor = "grab";
  }

  finish() {
    const active = this.gesture;
    this.cancel();
    if (active && !this.disposed) this.document?.endCamera();
    this.render();
  }

  render() {
    if (this.disposed || !this.settings) return;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPanoramaOrbit(ctx, rect.width, rect.height, this.settings, this.gesture?.kind);
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.abort.abort();
    this.observer?.disconnect();
    this.document = null;
    this.settings = null;
  }
}
