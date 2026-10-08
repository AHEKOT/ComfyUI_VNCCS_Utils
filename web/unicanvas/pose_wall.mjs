/**
 * The layers below a pose layer, stood up as a 2D wall inside the pose editor's 3D scene.
 *
 * The wall is fixed in world space and aligned with the pose layer's capture framing, so from
 * that framing it covers the canvas pixel for pixel, while a free inspection camera sees it as a
 * real object the mannequin stands in front of. Whatever the user does with the camera, the
 * mannequin keeps its place relative to the wall - and so in the saved image.
 */
import { POSE_BACKDROP_OFFSET_RADII, poseBackdropDistance } from "./pose_backdrop.mjs";

/**
 * Placement of the wall for a framing camera looking at `rect` (world px). `region` (world px,
 * containing the wall content) may be larger than the rect. Pure: returns numbers only.
 */
export function poseWallPlacement(THREE, { rect, region, framing, radius }) {
    const eye = new THREE.Vector3().fromArray(framing.position);
    const target = new THREE.Vector3().fromArray(framing.target);
    const camera = new THREE.PerspectiveCamera(framing.fov, rect.width / rect.height, 0.1, 1000);
    camera.position.copy(eye); camera.up.set(0, 1, 0); camera.lookAt(target); camera.updateMatrixWorld(true);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const distance = poseBackdropDistance(eye.distanceTo(target), radius, POSE_BACKDROP_OFFSET_RADII);
    // World units per canvas pixel on the wall, so the framing sees exactly the rect.
    const k = (2 * distance * Math.tan((framing.fov * Math.PI) / 360)) / Math.max(0.1, framing.zoom || 1) / rect.height;
    const dx = region.x + region.width / 2 - (rect.x + rect.width / 2);
    const dy = region.y + region.height / 2 - (rect.y + rect.height / 2);
    const center = eye.clone().addScaledVector(forward, distance).addScaledVector(right, dx * k).addScaledVector(up, -dy * k);
    return { center, quaternion: camera.quaternion.clone(), forward, distance,
        width: region.width * k, height: region.height * k };
}

export class UniCanvasPoseWall {
    constructor(THREE, scene) {
        this.THREE = THREE;
        this.scene = scene;
        this.texture = null;
        this.mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.01, side: THREE.DoubleSide, toneMapped: false }),
        );
        this.mesh.name = "VNCCS_UniCanvasPoseWall";
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = -900;
        this.normal = new THREE.Vector3(0, 0, -1);
        this.point = new THREE.Vector3();
        scene.add(this.mesh);
    }

    // `canvas` holds the layers below over `placement.region`; null hides the wall.
    update(canvas, placement) {
        const { mesh, THREE } = this;
        mesh.visible = Boolean(canvas && placement);
        if (!mesh.visible) return;
        if (this.texture?.image !== canvas) {
            this.texture?.dispose();
            this.texture = new THREE.CanvasTexture(canvas);
            this.texture.colorSpace = THREE.SRGBColorSpace;
            mesh.material.map = this.texture;
            mesh.material.needsUpdate = true;
        } else this.texture.needsUpdate = true;
        mesh.position.copy(placement.center);
        mesh.quaternion.copy(placement.quaternion);
        mesh.scale.set(placement.width, placement.height, 1);
        mesh.updateMatrixWorld(true);
        this.point.copy(placement.center);
        this.normal.copy(placement.forward);
    }

    // How far (world units) a sphere at `center` with `radius` reaches through the wall; 0 when in front.
    overflow(center, radius) {
        if (!this.mesh.visible) return 0;
        const excess = center.clone().sub(this.point).dot(this.normal) + radius;
        return excess > 1e-4 ? excess : 0;
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.texture?.dispose();
    }
}
