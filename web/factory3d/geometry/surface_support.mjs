import * as THREE from "../../vendor/spark/three.module.js";

function clip(polygon, axis, boundary, keepGreater) {
    const output = [];
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const insideA = keepGreater ? a[axis] >= boundary : a[axis] <= boundary;
        const insideB = keepGreater ? b[axis] >= boundary : b[axis] <= boundary;
        if (insideA) output.push(a);
        if (insideA !== insideB) output.push(a.clone().lerp(b, (boundary - a[axis]) / (b[axis] - a[axis])));
    }
    return output;
}

/** Highest actual triangle point inside a world XZ footprint, including its edges. */
export function meshSupportHeight(mesh, footprint) {
    const geometry = mesh?.geometry, positions = geometry?.attributes?.position;
    if (!positions) return null;
    mesh.updateWorldMatrix(true, false);
    const index = geometry.index;
    const count = index ? index.count : positions.count;
    let highest = -Infinity;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const normal = new THREE.Vector3(), edge = new THREE.Vector3();
    for (let i = 0; i + 2 < count; i += 3) {
        a.fromBufferAttribute(positions, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(positions, index ? index.getX(i + 1) : i + 1).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(positions, index ? index.getX(i + 2) : i + 2).applyMatrix4(mesh.matrixWorld);
        if (Math.max(a.x, b.x, c.x) < footprint.min.x || Math.min(a.x, b.x, c.x) > footprint.max.x
            || Math.max(a.z, b.z, c.z) < footprint.min.z || Math.min(a.z, b.z, c.z) > footprint.max.z) continue;
        normal.subVectors(b, a).cross(edge.subVectors(c, a));
        // Downward and vertical faces are not supporting surfaces.
        if (normal.y <= 1e-12) continue;
        let polygon = [a, b, c];
        for (const [axis, boundary, greater] of [["x", footprint.min.x, true], ["x", footprint.max.x, false], ["z", footprint.min.z, true], ["z", footprint.max.z, false]]) {
            polygon = clip(polygon, axis, boundary, greater);
            if (!polygon.length) break;
        }
        for (const point of polygon) highest = Math.max(highest, point.y);
    }
    return Number.isFinite(highest) ? highest : null;
}
