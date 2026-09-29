/** Torso-anchored framing for pose layers: the camera aims at the trunk, never at the head or a raised hand. */
// Limb joints are deliberately not listed: they sit at shoulder height and would drag the anchor upward.
const TORSO_BONE_PATTERN = /(pelvis|hips|spine|chest)/i;
const EXCLUDED_BONE_PATTERN = /(head|neck)/i;

function worldPoint(viewer, bone) {
    const v = viewer.THREE ? new viewer.THREE.Vector3() : { x: 0, y: 0, z: 0 };
    bone.getWorldPosition(v);
    return v;
}

function headNeckWorldY(viewer) {
    for (const [name, bone] of Object.entries(viewer?.bones || {})) {
        if (EXCLUDED_BONE_PATTERN.test(name) && typeof bone?.getWorldPosition === "function") return worldPoint(viewer, bone).y;
    }
    return null;
}

export function computeTorsoAnchor(viewer) {
    const points = Object.entries(viewer?.bones || {})
        .filter(([name, bone]) => TORSO_BONE_PATTERN.test(name) && !EXCLUDED_BONE_PATTERN.test(name) && typeof bone?.getWorldPosition === "function")
        .map(([, bone]) => { const p = worldPoint(viewer, bone); return { x: p.x, y: p.y, z: p.z }; });
    if (!points.length) {
        // No torso bones: centre of the mesh box cut off at the head, so an exotic rig cannot re-centre on the head.
        const c = viewer?.meshCenter;
        if (!c) return null;
        const headY = headNeckWorldY(viewer);
        const box = viewer.skinnedMesh?.geometry?.boundingBox;
        if (headY === null || !Number.isFinite(box?.min?.y) || !Number.isFinite(box?.max?.y)) return { x: c.x, y: c.y, z: c.z };
        return { x: c.x, y: (box.min.y + Math.min(box.max.y, headY)) / 2, z: c.z };
    }
    const sum = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: a.z + p.z }), { x: 0, y: 0, z: 0 });
    return { x: sum.x / points.length, y: sum.y / points.length, z: sum.z / points.length };
}

// Aim the orbit target at the torso, keeping the current viewing direction.
export function applyTorsoFraming(viewer) {
    const anchor = computeTorsoAnchor(viewer);
    if (!anchor || !viewer.orbit || !viewer.THREE) return null;
    viewer.sceneCameraTarget = new viewer.THREE.Vector3(anchor.x, anchor.y, anchor.z);
    viewer.orbit.target.copy(viewer.sceneCameraTarget);
    const dir = viewer.camera.position.clone().sub(viewer.orbit.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    // 45 matches Pose Studio's updateCaptureCamera distance.
    viewer.camera.position.copy(viewer.orbit.target).add(dir.normalize().multiplyScalar(45));
    viewer.orbit.update();
    return anchor;
}
