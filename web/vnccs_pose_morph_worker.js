const MORPH_URL = "/vnccs/character_studio/morph_data.bin";

let morphDataPromise = null;
let morphData = null;

function readAscii(bytes, start, length) {
    let text = "";
    for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[start + i]);
    return text;
}

function factorMax(value) {
    return Math.max(0.0, value * 2 - 1);
}

function factorMin(value) {
    return Math.max(0.0, 1 - value * 2);
}

function calculateFactors(params) {
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
    for (const value of target.factorValues) {
        weight *= factors[value] ?? 0.0;
        if (weight < 0.001) return 0.0;
    }
    return weight;
}

async function loadMorphData() {
    if (morphData) return morphData;
    if (morphDataPromise) return morphDataPromise;

    morphDataPromise = fetch(MORPH_URL).then(async (response) => {
        if (!response.ok) throw new Error(`Failed to load morph data: ${response.status}`);
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const magic = readAscii(bytes, 0, 8);
        if (magic !== "VNMORPH1") throw new Error("Invalid morph data header");

        const view = new DataView(buffer);
        const headerLength = view.getUint32(8, true);
        const headerText = new TextDecoder().decode(bytes.subarray(12, 12 + headerLength));
        const header = JSON.parse(headerText);
        const dataOffset = 12 + headerLength + ((4 - ((12 + headerLength) % 4)) % 4);

        const baseInfo = header.base_vertices;
        const baseVertices = new Float32Array(
            buffer,
            dataOffset + baseInfo.offset,
            baseInfo.length
        );

        const targets = header.targets.map((target) => {
            const factorValues = [];
            for (const tagValue of Object.values(target.tags || {})) {
                factorValues.push(tagValue === true ? "universal" : String(tagValue));
            }
            return {
                factorValues,
                count: target.count,
                indices: new Uint32Array(buffer, dataOffset + target.indices.offset, target.indices.length),
                deltas: new Float32Array(buffer, dataOffset + target.deltas.offset, target.deltas.length),
            };
        });

        const joints = {};
        for (const [name, indices] of Object.entries(header.joints || {})) {
            joints[name] = new Uint32Array(indices);
        }

        morphData = {
            baseVertices,
            targets,
            joints,
            bones: Array.isArray(header.bones) ? header.bones : [],
            vertexCount: header.vertex_count,
        };
        return morphData;
    });

    return morphDataPromise;
}

function averageJoint(vertices, indices, out, outOffset) {
    if (!indices || indices.length === 0) {
        out[outOffset] = 0;
        out[outOffset + 1] = 0;
        out[outOffset + 2] = 0;
        return;
    }

    let x = 0;
    let y = 0;
    let z = 0;
    let count = 0;
    for (let i = 0; i < indices.length; i++) {
        const vertexIndex = indices[i] * 3;
        if (vertexIndex + 2 >= vertices.length) continue;
        x += vertices[vertexIndex];
        y += vertices[vertexIndex + 1];
        z += vertices[vertexIndex + 2];
        count++;
    }

    if (count <= 0) {
        out[outOffset] = 0;
        out[outOffset + 1] = 0;
        out[outOffset + 2] = 0;
        return;
    }

    out[outOffset] = x / count;
    out[outOffset + 1] = y / count;
    out[outOffset + 2] = z / count;
}

function solveBonePositions(data, vertices) {
    if (!data.bones.length) return null;
    const positions = new Float32Array(data.bones.length * 6);
    for (let i = 0; i < data.bones.length; i++) {
        const bone = data.bones[i];
        averageJoint(vertices, data.joints[bone.head_joint], positions, i * 6);
        averageJoint(vertices, data.joints[bone.tail_joint], positions, i * 6 + 3);
    }
    return positions;
}

function solveMorph(data, params) {
    const factors = calculateFactors(params);
    const vertices = new Float32Array(data.baseVertices);

    for (const target of data.targets) {
        const weight = targetWeight(target, factors);
        if (weight <= 0) continue;
        const indices = target.indices;
        const deltas = target.deltas;
        for (let i = 0; i < target.count; i++) {
            const vertexOffset = indices[i] * 3;
            const deltaOffset = i * 3;
            vertices[vertexOffset] += deltas[deltaOffset] * weight;
            vertices[vertexOffset + 1] += deltas[deltaOffset + 1] * weight;
            vertices[vertexOffset + 2] += deltas[deltaOffset + 2] * weight;
        }
    }

    return {
        vertices,
        bonePositions: solveBonePositions(data, vertices),
    };
}

self.onmessage = async (event) => {
    const { type, seq, params } = event.data || {};
    try {
        if (type === "warmup") {
            await loadMorphData();
            self.postMessage({ type: "ready" });
            return;
        }
        if (type !== "solve") return;

        const data = await loadMorphData();
        const result = solveMorph(data, params || {});
        const transfers = [result.vertices.buffer];
        if (result.bonePositions) transfers.push(result.bonePositions.buffer);
        self.postMessage({
            type: "result",
            seq,
            vertices: result.vertices,
            bonePositions: result.bonePositions,
        }, transfers);
    } catch (error) {
        self.postMessage({
            type: "error",
            seq,
            message: error?.message || String(error),
        });
    }
};
