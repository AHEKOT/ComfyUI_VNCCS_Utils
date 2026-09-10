// Equirectangular document storage and a perspective editing window.
export const PANORAMA_MAX_PIXELS = 8192 * 4096;
export const isPanoramaCandidate = (width, height) => height > 0 && width / height >= 1.9;

export function normalizePanorama(value) {
  if (!value) return null;
  if (value.projection !== "equirectangular") throw new Error("Unsupported panorama projection");
  const width = Math.round(Number(value.width)), height = Math.round(Number(value.height));
  if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= PANORAMA_MAX_PIXELS)) {
    throw new Error("Panorama dimensions are too large or invalid");
  }
  const finite = (n, fallback) => Number.isFinite(Number(n)) ? Number(n) : fallback;
  return {
    projection: "equirectangular", width, height, baseLayerId: String(value.baseLayerId || ""),
    contentRevision: Math.max(0, Math.floor(finite(value.contentRevision, 0))),
    yaw: ((finite(value.yaw, 0) + 180) % 360 + 360) % 360 - 180,
    pitch: Math.max(-90, Math.min(90, finite(value.pitch, 0))),
    roll: ((finite(value.roll, 0) + 180) % 360 + 360) % 360 - 180,
    fov: Math.max(25, Math.min(120, finite(value.fov, 90))),
  };
}

// These reference mappings also define the convention used by the GPU shaders.
export function viewToSphere(u, v, camera) {
  const yaw = camera.yaw * Math.PI / 180, pitch = camera.pitch * Math.PI / 180;
  const t = Math.tan(camera.fov * Math.PI / 360);
  const roll = (camera.roll || 0) * Math.PI / 180;
  const sx = (2 * u - 1) * t, sy = (1 - 2 * v) * t;
  const x = Math.cos(roll) * sx - Math.sin(roll) * sy;
  const y = Math.sin(roll) * sx + Math.cos(roll) * sy;
  const yp = Math.cos(pitch) * y + Math.sin(pitch);
  const zp = Math.cos(pitch) - Math.sin(pitch) * y;
  const wx = Math.cos(yaw) * x + Math.sin(yaw) * zp;
  const wz = Math.cos(yaw) * zp - Math.sin(yaw) * x;
  return { u: ((Math.atan2(wx, wz) / (2 * Math.PI) + 0.5) % 1 + 1) % 1,
    v: 0.5 - Math.atan2(yp, Math.hypot(wx, wz)) / Math.PI };
}

export function sphereToView(u, v, camera) {
  const longitude = (u - 0.5) * 2 * Math.PI - camera.yaw * Math.PI / 180;
  const latitude = (0.5 - v) * Math.PI, pitch = camera.pitch * Math.PI / 180;
  const x = Math.sin(longitude) * Math.cos(latitude);
  const y = Math.sin(latitude), z = Math.cos(longitude) * Math.cos(latitude);
  const cy = Math.cos(pitch) * y - Math.sin(pitch) * z;
  const cz = Math.sin(pitch) * y + Math.cos(pitch) * z;
  if (cz <= 0) return null;
  const t = Math.tan(camera.fov * Math.PI / 360);
  const roll = (camera.roll || 0) * Math.PI / 180;
  const sx = Math.cos(roll) * x + Math.sin(roll) * cy;
  const sy = -Math.sin(roll) * x + Math.cos(roll) * cy;
  const a = (sx / cz / t + 1) / 2, b = (1 - sy / cz / t) / 2;
  return a >= 0 && a < 1 && b >= 0 && b < 1 ? { u: a, v: b } : null;
}

// Bound retained pixel history as well as gesture count for large panoramas.
export function trimPanoramaHistory(undo, redo, budget = 384 * 1024 * 1024) {
  const measure = () => {
    const seen = new Set();
    const visit = value => {
      if (!value || typeof value !== "object" || seen.has(value)) return 0;
      seen.add(value);
      if (typeof value.getContext === "function") return value.width * value.height * 4;
      if (Array.isArray(value)) return value.reduce((sum, item) => sum + visit(item), 0);
      return ["canvas", "panoramaCanvas", "hiresCanvas", "_panoramaBefore", "layers", "layer", "before", "after", "stagingItems", "sourceCanvas"].reduce((sum, key) => sum + visit(value[key]), 0);
    };
    return visit(undo) + visit(redo);
  };
  while (measure() > budget) {
    if (undo.length > 1) undo.shift();
    else if (redo.length > 1) redo.shift();
    else break;
  }
}

function canvas(width, height) {
  const result = document.createElement("canvas");
  result.width = width; result.height = height;
  return result;
}

const VERTEX = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv = vec2(position.x * .5 + .5, .5 - position.y * .5); gl_Position = vec4(position, 0., 1.); }`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D sphereImage;
uniform sampler2D beforeImage;
uniform sampler2D afterImage;
uniform vec3 camera;
uniform float cameraRoll;
uniform bool commitEdit;
const float PI = 3.141592653589793;
vec2 toSphere(vec2 p) {
  vec3 d = vec3((2. * p.x - 1.) * camera.z, (1. - 2. * p.y) * camera.z, 1.);
  d.xy = mat2(cos(cameraRoll), sin(cameraRoll), -sin(cameraRoll), cos(cameraRoll)) * d.xy;
  d.yz = mat2(cos(camera.y), -sin(camera.y), sin(camera.y), cos(camera.y)) * d.yz;
  d.xz = mat2(cos(camera.x), -sin(camera.x), sin(camera.x), cos(camera.x)) * d.xz;
  return vec2(fract(atan(d.x, d.z) / (2. * PI) + .5), .5 - atan(d.y, length(d.xz)) / PI);
}
void main() {
  if (!commitEdit) { color = texture(sphereImage, toSphere(uv)); return; }
  color = texture(sphereImage, uv);
  float lon = (uv.x - .5) * 2. * PI - camera.x;
  float lat = (.5 - uv.y) * PI;
  vec3 d = vec3(sin(lon) * cos(lat), sin(lat), cos(lon) * cos(lat));
  d.yz = mat2(cos(camera.y), sin(camera.y), -sin(camera.y), cos(camera.y)) * d.yz;
  if (d.z <= 0.) return;
  d.xy = mat2(cos(cameraRoll), -sin(cameraRoll), sin(cameraRoll), cos(cameraRoll)) * d.xy;
  vec2 p = vec2(d.x / d.z / camera.z * .5 + .5, .5 - d.y / d.z / camera.z * .5);
  if (any(lessThan(p, vec2(0.))) || any(greaterThanEqual(p, vec2(1.)))) return;
  // Compare exact editing pixels, including alpha, so erasure is preserved and
  // navigation never resamples untouched pixels of the full-resolution source.
  ivec2 size = textureSize(afterImage, 0);
  ivec2 pixel = clamp(ivec2(p * vec2(size)), ivec2(0), size - 1);
  vec4 a = texelFetch(beforeImage, pixel, 0), b = texelFetch(afterImage, pixel, 0);
  if (any(greaterThan(abs(a - b), vec4(.5 / 255.)))) color = texture(afterImage, p);
}`;

export class PanoramaRenderer {
  constructor() {
    this.canvas = canvas(1, 1);
    const gl = this.gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("Panorama mode requires WebGL 2");
    this.textures = new Map();
    const shaders = [];
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
        const shader = gl.createShader(type);
        shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      }
      this.program = gl.createProgram();
      for (const shader of shaders) gl.attachShader(this.program, shader);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    } finally { for (const shader of shaders) gl.deleteShader(shader); }
    gl.useProgram(this.program);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, "position");
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.locations = Object.fromEntries(["sphereImage", "beforeImage", "afterImage", "camera", "cameraRoll", "commitEdit"].map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  }

  invalidate(source) { const entry = this.textures.get(source); if (entry) entry.dirty = true; }

  texture(source, unit, wrap = false) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    let entry = this.textures.get(source);
    if (!entry) {
      entry = { texture: gl.createTexture(), dirty: true };
      this.textures.set(source, entry);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (entry.dirty) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("The GPU could not allocate the panorama texture");
      entry.dirty = false;
    }
  }

  render(source, camera, width, height, before = null, after = null) {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error("Panorama GPU context lost. Save the workflow and reload the editor.");
    if (Math.max(width, height, source.width, source.height) > this.limit) throw new Error(`Panorama exceeds the GPU limit (${this.limit}px)`);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    this.texture(source, 0, true);
    this.texture(before || source, 1);
    this.texture(after || source, 2);
    // The same texture may be used by all units for preview; restore wrapping.
    this.texture(source, 0, true);
    gl.uniform1i(this.locations.sphereImage, 0);
    gl.uniform1i(this.locations.beforeImage, 1);
    gl.uniform1i(this.locations.afterImage, 2);
    gl.uniform1i(this.locations.commitEdit, Boolean(before));
    gl.uniform1f(this.locations.cameraRoll, (camera.roll || 0) * Math.PI / 180);
    gl.uniform3f(this.locations.camera, camera.yaw * Math.PI / 180, camera.pitch * Math.PI / 180, Math.tan(camera.fov * Math.PI / 360));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("The GPU could not render the panorama");
    return this.canvas;
  }

  retain(sources) {
    const keep = new Set(sources);
    for (const [source, entry] of this.textures) if (!keep.has(source)) {
      this.gl.deleteTexture(entry.texture); this.textures.delete(source);
    }
  }

  dispose() {
    this.retain([]);
    this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export class PanoramaDocument {
  constructor(widget, settings) {
    this.widget = widget;
    this.settings = normalizePanorama(settings);
    this.renderer = new PanoramaRenderer();
    if (Math.max(this.settings.width, this.settings.height) > this.renderer.limit) {
      this.renderer.dispose();
      throw new Error(`Panorama exceeds the GPU limit (${this.renderer.limit}px)`);
    }
    this.revision = 0;
    this.pendingCamera = null;
    this.frame = null;
  }

  ensureLayer(layer) {
    if (!layer.panoramaCanvas) layer.panoramaCanvas = canvas(this.settings.width, this.settings.height);
    return layer.panoramaCanvas;
  }

  captureView(layer) {
    const w = this.widget;
    return w.cloneCanvasCrop(layer.canvas, { x: w.bbox.x - w.origin.x, y: w.bbox.y - w.origin.y, width: w.bbox.width, height: w.bbox.height });
  }

  commitLayer(layer) {
    const w = this.widget;
    this.ensureLayer(layer);
    if (!layer._panoramaDirty && layer._panoramaBefore) return;
    const before = layer._panoramaBefore || canvas(w.bbox.width, w.bbox.height);
    const after = this.captureView(layer);
    const rendered = this.renderer.render(layer.panoramaCanvas, this.settings, this.settings.width, this.settings.height, before, after);
    const ctx = layer.panoramaCanvas.getContext("2d");
    ctx.clearRect(0, 0, this.settings.width, this.settings.height);
    ctx.drawImage(rendered, 0, 0);
    this.renderer.invalidate(layer.panoramaCanvas);
    layer._panoramaBefore = after;
    layer._panoramaDirty = false;
    layer.hiresCanvas = null; layer.hiresRect = null;
    this.settings.contentRevision++;
  }

  commit() {
    this.flushCamera();
    for (const layer of this.widget.layers) this.commitLayer(layer);
    this.pruneTextures();
  }

  projectLayer(layer, preview = false) {
    const w = this.widget;
    this.ensureLayer(layer);
    const side = preview ? Math.min(384, w.bbox.width) : w.bbox.width;
    const projected = this.renderer.render(layer.panoramaCanvas, this.settings, side, side);
    const ctx = layer.canvas.getContext("2d");
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    ctx.drawImage(projected, w.bbox.x - w.origin.x, w.bbox.y - w.origin.y, w.bbox.width, w.bbox.height);
    w.invalidateLayerCaches(layer);
    layer._panoramaDirty = false;
    if (!preview) layer._panoramaBefore = this.captureView(layer);
  }

  project(preview = false) {
    for (const layer of this.widget.layers) this.projectLayer(layer, preview);
    this.pruneTextures();
  }

  pruneTextures() {
    this.renderer.retain([...this.widget.layers.flatMap(layer => [layer.panoramaCanvas, layer._panoramaBefore]), ...this.widget.stagingItems.map(item => item.panoramaCanvas)]);
  }

  canRotate() {
    const w = this.widget;
    if (w._isRestoring || w.transformDraft || (w.isPointerDown && w.pointerMode !== "panorama")) {
      w.setStatus("Finish the current edit before rotating the panorama", true); return false;
    }
    return true;
  }

  beginCamera() {
    if (!this.canRotate()) return false;
    this.commit();
    // SAM requests are tied to a view revision. Late responses are ignored.
    this.revision++;
    this.widget.clearSamPrompt();
    this.widget.lastDrawPointByTool = { brush: null, eraser: null, mask: null };
    return true;
  }

  setCamera(value, preview = true) {
    this.pendingCamera = normalizePanorama({ ...this.settings, ...value });
    this.widget.updatePanoramaControls(this.pendingCamera);
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const previous = this.settings;
      try {
        this.settings = this.pendingCamera; this.pendingCamera = null;
        this.project(preview);
        this.widget.requestRender();
      } catch (error) {
        this.settings = previous;
        this.widget.updatePanoramaControls(previous);
        this.widget.setStatus(`Panorama view failed: ${error.message || error}`, true);
      }
    });
  }

  flushCamera() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.pendingCamera) { this.settings = this.pendingCamera; this.pendingCamera = null; this.project(); }
  }

  endCamera() {
    this.flushCamera();
    this.project();
    this.widget.requestRender();
    this.widget.syncLightStateToWidget();
    this.widget.scheduleFullSync();
  }

  surfaceFromView(view, camera = this.settings) {
    const out = canvas(this.settings.width, this.settings.height);
    const blank = canvas(view.width, view.height);
    const rendered = this.renderer.render(out, camera, out.width, out.height, blank, view);
    out.getContext("2d").drawImage(rendered, 0, 0);
    this.renderer.invalidate(out);
    return out;
  }

  composite(type = "raster") {
    this.commit();
    const out = canvas(this.settings.width, this.settings.height), ctx = out.getContext("2d");
    for (const layer of [...this.widget.layers].reverse()) {
      if (!layer.visible || layer.type !== type) continue;
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blendMode || "source-over";
      ctx.drawImage(this.ensureLayer(layer), 0, 0);
    }
    return out;
  }

  dispose() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.renderer.dispose();
  }
}
