import * as THREE from "../vendor/spark/three.module.js";

function intersectsXZ(left, right, tolerance = 1e-5) {
    return left.max.x > right.min.x + tolerance
        && left.min.x < right.max.x - tolerance
        && left.max.z > right.min.z + tolerance
        && left.min.z < right.max.z - tolerance;
}

function proxyBounds(entry) {
    const proxy = entry?.data?.collision_proxy || {};
    if (proxy.mode === "off") return null;
    entry.mesh?.updateMatrixWorld?.(true);
    if (proxy.mode === "box" && Array.isArray(proxy.center) && Array.isArray(proxy.size)) {
        const center = new THREE.Vector3().fromArray(proxy.center);
        const half = new THREE.Vector3().fromArray(proxy.size).multiplyScalar(0.5);
        return new THREE.Box3(center.clone().sub(half), center.clone().add(half))
            .applyMatrix4(entry.mesh.matrixWorld);
    }
    if (entry?.localBounds && entry?.mesh?.matrixWorld) {
        return entry.localBounds.clone().applyMatrix4(entry.mesh.matrixWorld);
    }
    return null;
}

export function solveDropToSurface({
    entries,
    selectedIds,
    floorElevations = [0],
    clearance = 0.001,
} = {}) {
    const selected = new Set(selectedIds || []);
    const selectedBounds = new THREE.Box3();
    for (const [objectId, entry] of entries || []) {
        if (!selected.has(objectId)) continue;
        const bounds = proxyBounds(entry);
        if (bounds) selectedBounds.union(bounds);
    }
    if (selectedBounds.isEmpty()) return null;
    const validFloors = floorElevations.filter(Number.isFinite);
    let supportY = validFloors.length ? Math.max(...validFloors) : 0;
    const selectedCenterY = (selectedBounds.min.y + selectedBounds.max.y) * 0.5;
    for (const [objectId, entry] of entries || []) {
        if (selected.has(objectId) || entry?.mesh?.visible === false) continue;
        if (entry?.data?.collision_proxy?.supports_objects === false) continue;
        const bounds = proxyBounds(entry);
        if (!bounds || bounds.isEmpty() || !intersectsXZ(selectedBounds, bounds)) continue;
        const supportCenterY = (bounds.min.y + bounds.max.y) * 0.5;
        const belowOrPenetratingFromBelow = bounds.max.y <= selectedBounds.min.y + clearance
            || bounds.min.y <= selectedBounds.min.y + clearance
            || supportCenterY < selectedCenterY;
        if (belowOrPenetratingFromBelow) {
            supportY = Math.max(supportY, bounds.max.y);
        }
    }
    const deltaY = supportY - selectedBounds.min.y + Math.max(0, Number(clearance) || 0);
    if (!Number.isFinite(deltaY)) return null;
    return {
        deltaY,
        supportY,
        sourceBottomY: selectedBounds.min.y,
        bounds: selectedBounds,
    };
}
