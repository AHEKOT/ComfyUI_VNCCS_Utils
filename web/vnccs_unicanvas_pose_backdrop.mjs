/**
 * Flat 2D backdrop and depth limit for the embedded UniCanvas pose editor.
 *
 * A pose layer ends up as a 2D image composited over the layers below it, so the
 * embedded Pose Studio shows only the mannequin under a free camera: no skydome,
 * grid or capture frame, and the layers below stay visible through the transparent
 * viewport. Those layers act as a flat backdrop - a camera-facing plane with no
 * depth that always fills the view just behind the mannequin. The mannequin can be
 * brought closer to the camera (a stronger perspective / FOV effect) but never
 * pushed behind that plane.
 *
 * The plane only writes depth: its pixels are the 2D layers already drawn under the
 * viewport, so drawing them again in WebGL would double them under the pose layer's
 * opacity and blend mode.
 */

// How far behind the orbit target the backdrop sits, in multiples of the character radius.
export const POSE_BACKDROP_OFFSET_RADII = 1.25;
// Fallback character radius (Pose Studio world units) before a mesh is measured.
const FALLBACK_RADIUS = 10;

/**
 * Distance from the camera to the backdrop plane: the orbit target distance plus an
 * offset behind the target, so orbiting and dollying keep the plane behind the mannequin.
 */
export function poseBackdropDistance(cameraToTarget, characterRadius, offsetRadii = POSE_BACKDROP_OFFSET_RADII) {
  const radius = Number.isFinite(characterRadius) && characterRadius > 0 ? characterRadius : FALLBACK_RADIUS;
  return Math.max(1e-3, Number(cameraToTarget) || 0) + radius * offsetRadii;
}

/** Plane size that exactly fills a perspective frustum at `distance`. */
export function poseBackdropSize(distance, fovDegrees, aspect, zoom = 1) {
  const height = (2 * distance * Math.tan(((Number(fovDegrees) || 45) * Math.PI) / 360)) / Math.max(0.1, Number(zoom) || 1);
  return { width: height * (Number(aspect) || 1), height };
}

/**
 * How far a character must move toward the camera so its far edge stays in front of
 * the backdrop. `depth` is the camera-space distance of the character center along the
 * view direction; returns 0 when it already fits (moving closer is always allowed).
 */
export function poseBackdropOverflow(depth, radius, backdropDistance) {
  const excess = Number(depth) + Math.max(0, Number(radius) || 0) - Number(backdropDistance);
  return Number.isFinite(excess) && excess > 1e-4 ? excess : 0;
}

export class UniCanvasPoseBackdrop {
  constructor(editor) {
    this.editor = editor;
    this.viewer = editor.studio.viewer;
    this.THREE = this.viewer.THREE;
    this.bounds = null;
    this.clamping = false;
    this.suppressClamp = false;
    const THREE = this.THREE;
    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      // Depth only: occludes whatever would sit behind the backdrop without painting it.
      new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }),
    );
    this.plane.name = "VNCCS_UniCanvasPoseBackdrop";
    this.plane.frustumCulled = false;
    this.plane.renderOrder = -1000;
    const camera = this.viewer.camera;
    if (!camera.parent) this.viewer.scene.add(camera);
    camera.add(this.plane);
    this.renderer = this.viewer.renderer;
    this.originalRender = this.renderer.render;
    const backdrop = this;
    this.renderer.render = function (scene, renderCamera, ...rest) {
      backdrop.beforeRender(renderCamera);
      return backdrop.originalRender.call(this, scene, renderCamera, ...rest);
    };
  }

  // Only the mannequin: the skydome sphere, grid and capture frame would cover the layers below.
  hideEnvironment() {
    const viewer = this.viewer;
    if (viewer.directionalSkydome) viewer.directionalSkydome.visible = false;
    if (viewer.gridHelper) viewer.gridHelper.visible = false;
    if (viewer.captureFrame) viewer.captureFrame.visible = false;
    if (viewer.refPlane) viewer.refPlane.visible = false;
    if (viewer.scene.background) viewer.scene.background = null;
  }

  characterMeshes() {
    const meshes = [];
    if (this.viewer.skinnedMesh) meshes.push({ mesh: this.viewer.skinnedMesh, active: true });
    for (const [id, entry] of this.viewer.passiveCharacters?.entries?.() || []) {
      if (entry?.mesh?.visible !== false && entry?.mesh) meshes.push({ mesh: entry.mesh, id });
    }
    return meshes;
  }

  // Bounding sphere of the active rig, stored unscaled and relative to the mesh origin so a
  // per-frame clamp needs no vertex walk.
  measure() {
    const THREE = this.THREE;
    const mesh = this.viewer.skinnedMesh;
    if (!mesh) return null;
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) return null;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const scale = Math.max(1e-3, mesh.scale.x || 1);
    const origin = mesh.getWorldPosition(new THREE.Vector3());
    return {
      radius: Math.max(1e-3, sphere.radius / scale),
      offset: sphere.center.clone().sub(origin).divideScalar(scale),
    };
  }

  beforeRender(renderCamera) {
    this.hideEnvironment();
    const viewer = this.viewer;
    const camera = viewer.camera;
    // Captures of the layer pixels must hold only the mannequin; the plane writes no color anyway,
    // but keeping it out of foreign cameras avoids stray depth.
    this.plane.visible = renderCamera === camera;
    if (renderCamera !== camera || !viewer.orbit) return;
    const distance = this.updatePlane();
    // suppressClamp: the editor borrows the live camera for a stored-framing capture. That
    // temporary camera move must never translate a character - only real character drags
    // may be clamped (camera moves settle the plane behind the deepest character instead).
    if (!this.suppressClamp) this.clampCharacters(distance);
  }

  // Places the plane for the current camera and returns its distance.
  updatePlane() {
    const viewer = this.viewer;
    const camera = viewer.camera;
    if (!this.bounds && viewer.skinnedMesh) this.bounds = this.measure();
    // Scaling the character (Pose Studio Zoom) moves the backdrop with it; only moving the
    // character away from the camera runs into the limit.
    const scale = Math.max(1e-3, viewer.skinnedMesh?.scale?.x || 1);
    const radius = (this.bounds?.radius || FALLBACK_RADIUS) * scale;
    const base = poseBackdropDistance(camera.position.distanceTo(viewer.orbit.target), radius);
    // Orbiting or dollying is a camera move, never a character move: when the camera changed,
    // the backdrop settles behind the deepest character instead of pushing anyone.
    camera.updateMatrixWorld(true);
    const cameraKey = [...camera.matrixWorld.elements, camera.fov, camera.zoom, camera.aspect].join(",");
    if (cameraKey !== this.cameraKey) {
      this.cameraKey = cameraKey;
      const deepest = Math.max(-Infinity, ...this.measureCharacters().map((item) => item.farEdge));
      this.extra = Number.isFinite(deepest) ? Math.max(0, deepest - base) : 0;
    }
    const distance = base + (this.extra || 0);
    const size = poseBackdropSize(distance, camera.fov, camera.aspect, camera.zoom);
    this.plane.position.set(0, 0, -distance);
    this.plane.scale.set(size.width, size.height, 1);
    this.plane.updateMatrixWorld(true);
    this.distance = distance;
    return distance;
  }

  // Camera-space depth of each character's bounding-sphere center and far edge.
  measureCharacters() {
    const THREE = this.THREE;
    const camera = this.viewer.camera;
    const forward = camera.getWorldDirection(new THREE.Vector3());
    return this.characterMeshes().map((entry) => {
      const scale = Math.max(1e-3, entry.mesh.scale.x || 1);
      const radius = (this.bounds?.radius || FALLBACK_RADIUS) * scale;
      const center = entry.mesh.getWorldPosition(new THREE.Vector3());
      if (this.bounds) center.addScaledVector(this.bounds.offset, scale);
      const depth = center.sub(camera.position).dot(forward);
      return { ...entry, depth, radius, farEdge: depth + radius, forward };
    });
  }

  clampCharacters(distance) {
    if (this.clamping) return;
    for (const { mesh, active, id, depth, radius, forward } of this.measureCharacters()) {
      const excess = poseBackdropOverflow(depth, radius, distance);
      if (!excess) continue;
      const shift = forward.clone().multiplyScalar(-excess);
      this.clamping = true;
      try {
        if (active) this.moveActiveCharacter(shift);
        else this.movePassiveCharacter(mesh, id, shift);
      } finally {
        this.clamping = false;
      }
    }
  }

  // Write the clamp back through Pose Studio's own character transform so it persists.
  moveActiveCharacter(shift) {
    const studio = this.editor.studio;
    const character = studio.getActiveCharacter?.();
    const transform = character?.transform;
    if (!transform) {
      this.viewer.skinnedMesh.position.add(shift);
      this.viewer.skinnedMesh.updateMatrixWorld(true);
      return;
    }
    transform.x = (Number(transform.x) || 0) + shift.x;
    transform.y = (Number(transform.y) || 0) + shift.y;
    transform.z = (Number(transform.z) || 0) + shift.z;
    // Applies the transform to the mesh directly; the render in progress already sees it.
    this.viewer.setActiveCharacterAppearance?.({ transform: { ...transform } });
    this.editor.scheduleBackdropSync?.();
  }

  movePassiveCharacter(mesh, id, shift) {
    const studio = this.editor.studio;
    const character = studio.characters?.find?.((item) => String(item.id) === String(id));
    if (character?.transform) {
      character.transform.x = (Number(character.transform.x) || 0) + shift.x;
      character.transform.y = (Number(character.transform.y) || 0) + shift.y;
      character.transform.z = (Number(character.transform.z) || 0) + shift.z;
    }
    mesh.position.add(shift);
    mesh.updateMatrixWorld(true);
    this.editor.scheduleBackdropSync?.();
  }

  // Read-only snapshot for tests: backdrop distance and each character's far-edge depth.
  describe() {
    const characters = this.measureCharacters().map(({ active, depth, radius, farEdge }) => ({
      active: Boolean(active), depth, radius, farEdge,
    }));
    // The plane for the current camera, not the last rendered frame.
    const distance = this.viewer.orbit ? this.updatePlane() : null;
    return { distance, characters };
  }

  // A new mesh (character or morph change) needs fresh bounds.
  invalidate() {
    this.bounds = null;
    this.cameraKey = null;
  }

  dispose() {
    if (this.renderer && this.originalRender) this.renderer.render = this.originalRender;
    this.plane.parent?.remove(this.plane);
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.renderer = null;
    this.originalRender = null;
  }
}
