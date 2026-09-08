import * as THREE from "../../vendor/spark/three.module.js";

const finite = (value, fallback, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback));
export function terrainSettings(recipe = {}) {
    return {
        amplitude: finite(recipe.height_amplitude, 0, 0, 10000),
        frequency: finite(recipe.noise_frequency, 0.1, 0.00001, 100),
        seed: Math.trunc(finite(recipe.noise_seed, 1, 0, 2147483647)),
        octaves: Math.trunc(finite(recipe.noise_octaves, 4, 1, 8)),
    };
}

// Deterministic lattice value noise. Integer wrapping is part of generator v1.
function lattice(x, z, seed) {
    let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const smooth = value => value * value * (3 - 2 * value);
const mix = (a, b, t) => a + (b - a) * t;
function noise(x, z, seed) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const tx = smooth(x - ix), tz = smooth(z - iz);
    return mix(mix(lattice(ix, iz, seed), lattice(ix + 1, iz, seed), tx),
        mix(lattice(ix, iz + 1, seed), lattice(ix + 1, iz + 1, seed), tx), tz);
}

export function terrainHeight(x, z, recipe = {}) {
    return generatedHeight(x, z, terrainSettings(recipe), finite(recipe.extrusion, 0, 0, 100000));
}

function generatedHeight(x, z, { amplitude, frequency, seed, octaves }, base) {
    let sum = 0, weight = 1, total = 0, scale = frequency;
    for (let octave = 0; octave < octaves; octave++) {
        sum += noise(x * scale, z * scale, seed + octave) * weight;
        total += weight; weight *= 0.5; scale *= 2;
    }
    return base + amplitude * sum / total;
}

/** One bounded grid, row-major +Z. Closed skirt and base share top boundary positions. */
export function createTerrainHeightfield(recipe, metrics) {
    const { width, depth, segmentsX: nx, segmentsY: nz } = metrics;
    const settings = terrainSettings(recipe), base = finite(recipe.extrusion, 0, 0, 100000);
    const positions = [], uvs = [], indices = [];
    const add = (x, y, z, u, v) => {
        const index = positions.length / 3;
        positions.push(x, y, z); uvs.push(u, v); return index;
    };
    for (let z = 0; z <= nz; z++) for (let x = 0; x <= nx; x++) {
        const px = -width / 2 + x * width / nx, pz = -depth / 2 + z * depth / nz;
        add(px, generatedHeight(px, pz, settings, base), pz, x / nx, 1 - z / nz);
    }
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const a = z * (nx + 1) + x, b = a + 1, c = a + nx + 1, d = c + 1;
        indices.push(a, c, b, b, c, d);
    }
    // Clockwise viewed from above; duplicate side vertices to retain hard rims.
    const boundary = [];
    for (let x = 0; x <= nx; x++) boundary.push(x);
    for (let z = 1; z <= nz; z++) boundary.push(z * (nx + 1) + nx);
    for (let x = nx - 1; x >= 0; x--) boundary.push(nz * (nx + 1) + x);
    for (let z = nz - 1; z > 0; z--) boundary.push(z * (nx + 1));
    for (let i = 0; i < boundary.length; i++) {
        const a = boundary[i] * 3, b = boundary[(i + 1) % boundary.length] * 3;
        const va = add(positions[a], positions[a + 1], positions[a + 2], 0, 1);
        const vb = add(positions[b], positions[b + 1], positions[b + 2], 1, 1);
        const vc = add(positions[a], 0, positions[a + 2], 0, 0);
        const vd = add(positions[b], 0, positions[b + 2], 1, 0);
        indices.push(va, vb, vc, vb, vd, vc);
    }
    const a = add(-width / 2, 0, -depth / 2, 0, 0);
    const b = add(width / 2, 0, -depth / 2, 1, 0);
    const c = add(-width / 2, 0, depth / 2, 0, 1);
    const d = add(width / 2, 0, depth / 2, 1, 1);
    indices.push(a, b, c, b, d, c);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

/** Samples the rendered triangle (not the continuous noise) for placement parity. */
export function sampleTerrainSurface(x, z, recipe, metrics) {
    const { width, depth, segmentsX: nx, segmentsY: nz } = metrics;
    if (Math.abs(x) > width / 2 || Math.abs(z) > depth / 2) return null;
    const gx = (x / width + 0.5) * nx, gz = (z / depth + 0.5) * nz;
    const ix = Math.min(nx - 1, Math.floor(gx)), iz = Math.min(nz - 1, Math.floor(gz));
    const tx = gx - ix, tz = gz - iz;
    const height = (dx, dz) => terrainHeight(-width / 2 + (ix + dx) * width / nx, -depth / 2 + (iz + dz) * depth / nz, recipe);
    const a = height(0, 0), b = height(1, 0), c = height(0, 1), d = height(1, 1);
    return tx + tz <= 1 ? a + tx * (b - a) + tz * (c - a)
        : d + (1 - tz) * (b - d) + (1 - tx) * (c - d);
}
