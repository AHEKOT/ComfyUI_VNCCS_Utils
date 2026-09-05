import { terrainSettings, createTerrainHeightfield } from "./terrain_heightfield.mjs";
import * as THREE from "../../vendor/spark/three.module.js";

export const PARAMETRIC_PARTS = Object.freeze({
    box: { label: "Box", width: 2, height: 2, depth: 2 },
    sphere: { label: "Sphere / ellipsoid", width: 2, height: 2, depth: 2 },
    cylinder: { label: "Cylinder / column", width: 1, height: 3, depth: 1 },
    cone: { label: "Cone", width: 2, height: 3, depth: 2 },
    ramp: { label: "Ramp", width: 2, height: 1, depth: 4 },
    stairs: { label: "Stairs", width: 1.2, height: 3, depth: 4, steps: 12 },
    gable_roof: { label: "Gable roof", width: 6, height: 2, depth: 8 },
});
export const PRIMITIVE_KINDS = Object.freeze(["image", "plane", "terrain", ...Object.keys(PARAMETRIC_PARTS)]);
export function primitiveLabel(kind) {
    return PARAMETRIC_PARTS[kind]?.label || { image: "Image plane", plane: "Plane", terrain: "Terrain" }[kind] || "Primitive";
}

function bounded(value, fallback, min, max) {
    const number = Number(value);
    return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
}

export function parametricMetrics(primitive = {}) {
    return {
        ...terrainSettings(primitive),
        kind: PRIMITIVE_KINDS.includes(primitive.kind) ? primitive.kind : "plane",
        width: bounded(primitive.width, 2, 0.001, 100000),
        height: bounded(primitive.height, 2, 0.001, 100000),
        depth: bounded(primitive.depth, 2, 0.001, 100000),
        extrusion: bounded(primitive.extrusion, 0, 0, 100000),
        segmentsX: Math.trunc(bounded(primitive.segments?.[0], 1, 1, 128)),
        segmentsY: Math.trunc(bounded(primitive.segments?.[1], 1, 1, 128)),
        steps: Math.trunc(bounded(primitive.steps, 12, 1, 256)),
        radialSegments: Math.trunc(bounded(primitive.radial_segments, 32, 8, 128)),
    };
}

/** Closed cross section extruded in Z, with its base at Y=0. */
function extrudeProfile(points, depth) {
    const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, steps: 1, bevelEnabled: false, curveSegments: 1 });
    geometry.translate(0, 0, -depth / 2);
    return geometry;
}

/** Recipes retain physical dimensions; imported-model normalization is never applied. */
export function createParametricGeometry(primitive) {
    const { kind, width, height, depth, steps, radialSegments } = parametricMetrics(primitive);
    let geometry;
    if (kind === "terrain" && terrainSettings(primitive).amplitude > 0) {
        return createTerrainHeightfield(primitive, parametricMetrics(primitive));
    }
    if (kind === "box") {
        geometry = new THREE.BoxGeometry(width, height, depth);
        geometry.translate(0, height / 2, 0);
    } else if (kind === "sphere") {
        geometry = new THREE.SphereGeometry(0.5, radialSegments, Math.max(8, Math.ceil(radialSegments / 2)));
        geometry.scale(width, height, depth);
        geometry.translate(0, height / 2, 0);
    } else if (kind === "cylinder" || kind === "cone") {
        geometry = new THREE.CylinderGeometry(kind === "cone" ? 0 : 0.5, 0.5, height, radialSegments);
        geometry.scale(width, 1, depth);
        geometry.translate(0, height / 2, 0);
    } else if (kind === "gable_roof") {
        geometry = extrudeProfile([[-width / 2, 0], [width / 2, 0], [0, height]], depth);
    } else if (kind === "ramp" || kind === "stairs") {
        // Profile runs along local Z after rotation. A single closed stair solid
        // avoids overlapping blocks, internal faces and ambiguous surface hits.
        const points = [[-depth / 2, 0], [depth / 2, 0], [depth / 2, height]];
        if (kind === "ramp") points.push([-depth / 2, 0]);
        else for (let index = steps - 1; index >= 0; index--) {
            points.push([-depth / 2 + index * depth / steps, (index + 1) * height / steps]);
            points.push([-depth / 2 + index * depth / steps, index * height / steps]);
        }
        geometry = extrudeProfile(points, width);
        geometry.rotateY(-Math.PI / 2);
    } else return null;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}
