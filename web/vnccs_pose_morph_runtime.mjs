export const POSE_STUDIO_MAKEHUMAN_ASSET_URL = new URL(
    "./assets/pose_studio_makehuman.v2.bin.gz",
    import.meta.url,
);

const MAGIC = "VNMHJS02";

function readAscii(bytes, start, length) {
    let text = "";
    for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[start + i]);
    return text;
}

async function decompressIfNeeded(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer;
    if (typeof DecompressionStream === "undefined") {
        throw new Error("This browser does not support gzip DecompressionStream required by Pose Studio.");
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
}

function typedView(Type, buffer, dataOffset, descriptor) {
    if (!descriptor || !Number.isInteger(descriptor.offset) || !Number.isInteger(descriptor.length)) {
        return new Type(0);
    }
    return new Type(buffer, dataOffset + descriptor.offset, descriptor.length);
}

export function parseMorphPack(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 12 || readAscii(bytes, 0, 8) !== MAGIC) {
        throw new Error("Invalid Pose Studio MakeHuman asset header.");
    }
    const view = new DataView(buffer);
    const headerLength = view.getUint32(8, true);
    if (headerLength <= 0 || 12 + headerLength > bytes.length) {
        throw new Error("Invalid Pose Studio MakeHuman asset metadata length.");
    }
    const headerText = new TextDecoder().decode(bytes.subarray(12, 12 + headerLength));
    const header = JSON.parse(headerText);
    if (header.version !== 2) throw new Error(`Unsupported MakeHuman asset version: ${header.version}`);
    const dataOffset = 12 + headerLength + ((4 - ((12 + headerLength) % 4)) % 4);

    const targets = (header.targets || []).map((target) => ({
        factorValues: Array.isArray(target.factor_values) ? target.factor_values : [],
        count: target.count,
        indices: typedView(Uint32Array, buffer, dataOffset, target.indices),
        deltas: typedView(Float32Array, buffer, dataOffset, target.deltas),
    }));
    const joints = {};
    for (const [name, indices] of Object.entries(header.joints || {})) {
        joints[name] = Uint32Array.from(indices);
    }
    const landmarkJoints = {};
    for (const [name, indices] of Object.entries(header.landmark_joints || {})) {
        landmarkJoints[name] = Uint32Array.from(indices);
    }
    const landmarkGroups = {};
    for (const [name, descriptor] of Object.entries(header.landmark_groups || {})) {
        landmarkGroups[name] = typedView(Uint32Array, buffer, dataOffset, descriptor);
    }

    return {
        buffer,
        vertexCount: header.vertex_count,
        baseVertices: typedView(Float32Array, buffer, dataOffset, header.base_vertices),
        uvs: typedView(Float32Array, buffer, dataOffset, header.uvs),
        baseIndices: typedView(Uint32Array, buffer, dataOffset, header.base_indices),
        genitalIndices: typedView(Uint32Array, buffer, dataOffset, header.genital_indices),
        skinIndices: typedView(Uint16Array, buffer, dataOffset, header.skin_indices),
        skinWeights: typedView(Float32Array, buffer, dataOffset, header.skin_weights),
        targets,
        joints,
        bones: Array.isArray(header.bones) ? header.bones : [],
        landmarkGroups,
        landmarkJoints,
    };
}

export async function loadMorphPack(url = POSE_STUDIO_MAKEHUMAN_ASSET_URL) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load Pose Studio MakeHuman asset: HTTP ${response.status}`);
    return parseMorphPack(await decompressIfNeeded(await response.arrayBuffer()));
}

function factorMax(value) {
    return Math.max(0.0, value * 2 - 1);
}

function factorMin(value) {
    return Math.max(0.0, 1 - value * 2);
}

export function calculateMorphFactors(params = {}) {
    const ageInput = Number(params.age ?? 25);
    const age = Math.max(0, Math.min(1, (ageInput - 1.0) / (90.0 - 1.0)));
    const gender = Number(params.gender ?? 0.5);
    const weight = Number(params.weight ?? 0.5);
    const muscle = Number(params.muscle ?? 0.5);
    const height = Number(params.height ?? 0.5);
    const breastSize = Number(params.breast_size ?? 0.5);
    const firmness = Number(params.firmness ?? 0.5);
    const penisLen = Number(params.penis_len ?? params.genital_size ?? 0.5);
    const penisCirc = Number(params.penis_circ ?? 0.5);
    const penisTest = Number(params.penis_test ?? 0.5);
    const factors = {
        male: gender,
        female: 1.0 - gender,
        maxmuscle: factorMax(muscle),
        minmuscle: factorMin(muscle),
        maxweight: factorMax(weight),
        minweight: factorMin(weight),
        maxheight: factorMax(height),
        minheight: factorMin(height),
        african: 0.333,
        asian: 0.333,
        caucasian: 0.334,
        maxcup: factorMax(breastSize),
        mincup: factorMin(breastSize),
        maxfirmness: factorMax(firmness),
        minfirmness: factorMin(firmness),
        "penis-length-incr": factorMax(penisLen),
        "penis-length-decr": factorMin(penisLen),
        "penis-circ-incr": factorMax(penisCirc),
        "penis-circ-decr": factorMin(penisCirc),
        "penis-testicles-incr": factorMax(penisTest),
        "penis-testicles-decr": factorMin(penisTest),
        universal: 1.0,
    };
    factors.averagemuscle = 1 - (factors.maxmuscle + factors.minmuscle);
    factors.averageweight = 1 - (factors.maxweight + factors.minweight);
    factors.averageheight = 1 - (factors.maxheight + factors.minheight);
    factors.averagecup = 1 - (factors.maxcup + factors.mincup);
    factors.averagefirmness = 1 - (factors.maxfirmness + factors.minfirmness);
    if (age < 0.5) {
        factors.old = 0.0;
        factors.baby = Math.max(0.0, 1 - age * 5.333);
        factors.young = Math.max(0.0, (age - 0.1875) * 3.2);
        factors.child = Math.max(0.0, Math.min(1.0, 5.333 * age) - factors.young);
    } else {
        factors.child = 0.0;
        factors.baby = 0.0;
        factors.old = Math.max(0.0, age * 2 - 1);
        factors.young = 1 - factors.old;
    }
    return factors;
}

function targetWeight(target, factors) {
    let weight = 1.0;
    for (const factor of target.factorValues) {
        weight *= factors[factor] ?? 0.0;
        if (weight < 0.001) return 0.0;
    }
    return weight;
}

function averageVertices(vertices, indices) {
    if (!indices?.length) return null;
    let x = 0;
    let y = 0;
    let z = 0;
    let count = 0;
    for (const vertex of indices) {
        const offset = Number(vertex) * 3;
        if (offset < 0 || offset + 2 >= vertices.length) continue;
        x += vertices[offset];
        y += vertices[offset + 1];
        z += vertices[offset + 2];
        count += 1;
    }
    return count ? [x / count, y / count, z / count] : null;
}

function solveBonePositions(data, vertices) {
    const positions = new Float32Array(data.bones.length * 6);
    data.bones.forEach((bone, index) => {
        const head = averageVertices(vertices, data.joints[bone.head_joint]) || [0, 0, 0];
        const tail = averageVertices(vertices, data.joints[bone.tail_joint]) || [0, 0, 0];
        positions.set(head, index * 6);
        positions.set(tail, index * 6 + 3);
    });
    return positions;
}

function findNoseIndices(data, vertices, leftEye, rightEye) {
    const body = data.landmarkGroups.body;
    if (!body?.length) return [];
    const eyeMid = leftEye && rightEye
        ? [(leftEye[0] + rightEye[0]) * 0.5, (leftEye[1] + rightEye[1]) * 0.5]
        : null;
    const eyeSpan = leftEye && rightEye ? Math.abs(leftEye[0] - rightEye[0]) : 0;
    const xLimit = Math.max(0.18, eyeSpan * 0.45);
    const candidates = [];
    const collect = (fallback) => {
        candidates.length = 0;
        for (const vertex of body) {
            const offset = vertex * 3;
            const x = vertices[offset];
            const y = vertices[offset + 1];
            const matches = fallback
                ? Math.abs(x) <= 0.35 && y >= 6.4 && y <= 7.4
                : eyeMid
                    ? Math.abs(x - eyeMid[0]) <= xLimit && y >= eyeMid[1] - 0.65 && y <= eyeMid[1] - 0.03
                    : Math.abs(x) <= 0.25 && y >= 6.4 && y <= 7.4;
            if (matches) candidates.push(vertex);
        }
    };
    collect(false);
    if (!candidates.length) collect(true);
    if (!candidates.length) return [];
    let selected = candidates[0];
    for (const vertex of candidates) {
        if (vertices[vertex * 3 + 2] > vertices[selected * 3 + 2]) selected = vertex;
    }
    const selectedOffset = selected * 3;
    const nearest = [];
    for (const vertex of body) {
        const offset = vertex * 3;
        const dx = vertices[offset] - vertices[selectedOffset];
        const dy = vertices[offset + 1] - vertices[selectedOffset + 1];
        const dz = vertices[offset + 2] - vertices[selectedOffset + 2];
        const distance = dx * dx + dy * dy + dz * dz;
        nearest.push({ vertex, distance });
    }
    nearest.sort((a, b) => a.distance - b.distance || a.vertex - b.vertex);
    return nearest.slice(0, 12).map((entry) => entry.vertex).sort((a, b) => a - b);
}

function solveLandmarks(data, vertices) {
    const leftIndices = Array.from(data.landmarkGroups.left_eye || []);
    const rightIndices = Array.from(data.landmarkGroups.right_eye || []);
    const leftEye = averageVertices(vertices, leftIndices);
    const rightEye = averageVertices(vertices, rightIndices);
    const noseIndices = findNoseIndices(data, vertices, leftEye, rightEye);
    const landmarks = {};
    const landmarkIndices = {};
    if (leftEye) {
        landmarks.left_eye = leftEye;
        landmarkIndices.left_eye = leftIndices;
    }
    if (rightEye) {
        landmarks.right_eye = rightEye;
        landmarkIndices.right_eye = rightIndices;
    }
    const nose = averageVertices(vertices, noseIndices);
    if (nose) {
        landmarks.nose = nose;
        landmarkIndices.nose = noseIndices;
    }
    for (const [name, indices] of Object.entries(data.landmarkJoints || {})) {
        if (landmarks[name]) continue;
        const point = averageVertices(vertices, indices);
        if (point) landmarks[name] = point;
    }
    return { landmarks, landmarkIndices };
}

export function modelUsesGenitals(params = {}) {
    return Number(params.gender ?? 0.5) >= 0.99;
}

export function buildModelIndices(data, includeGenitals) {
    if (!includeGenitals || !data.genitalIndices.length) return new Uint32Array(data.baseIndices);
    const indices = new Uint32Array(data.baseIndices.length + data.genitalIndices.length);
    indices.set(data.baseIndices, 0);
    indices.set(data.genitalIndices, data.baseIndices.length);
    return indices;
}

export function buildStaticModelData(data, includeGenitals) {
    return {
        uvs: new Float32Array(data.uvs),
        indices: buildModelIndices(data, includeGenitals),
        skinIndices: new Uint16Array(data.skinIndices),
        skinWeights: new Float32Array(data.skinWeights),
        bones: data.bones.map((bone) => ({ ...bone })),
    };
}

export function solveMorph(data, params = {}) {
    const factors = calculateMorphFactors(params);
    const vertices = new Float32Array(data.baseVertices);
    for (const target of data.targets) {
        const weight = targetWeight(target, factors);
        if (weight <= 0) continue;
        for (let i = 0; i < target.count; i++) {
            const vertexOffset = target.indices[i] * 3;
            const deltaOffset = i * 3;
            vertices[vertexOffset] += target.deltas[deltaOffset] * weight;
            vertices[vertexOffset + 1] += target.deltas[deltaOffset + 1] * weight;
            vertices[vertexOffset + 2] += target.deltas[deltaOffset + 2] * weight;
        }
    }
    const { landmarks, landmarkIndices } = solveLandmarks(data, vertices);
    return {
        vertices,
        bonePositions: solveBonePositions(data, vertices),
        landmarks,
        landmarkIndices,
        includeGenitals: modelUsesGenitals(params),
    };
}
