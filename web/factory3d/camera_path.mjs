import * as THREE from "../vendor/spark/three.module.js";

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

function eased(value, kind = "smooth") {
    const t = clamp01(value);
    if (kind === "linear") return t;
    if (kind === "ease_in") return t * t;
    if (kind === "ease_out") return 1 - (1 - t) * (1 - t);
    if (kind === "ease_in_out") return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    return t * t * (3 - 2 * t);
}

export function normalizedCameraPose(value = {}) {
    const position = new THREE.Vector3().fromArray(value.position || [0, 1.6, 0]);
    const quaternion = new THREE.Quaternion().fromArray(value.quaternion || [0, 0, 0, 1]);
    if (quaternion.lengthSq() < 1e-12) quaternion.identity();
    quaternion.normalize();
    return {
        position: position.toArray(),
        quaternion: quaternion.toArray(),
        fov: Math.max(5, Math.min(120, Number(value.fov) || 42)),
        focus_distance: Math.max(0.001, Number(value.focus_distance) || 1),
    };
}

export function cameraPoseFromLegacy(value = {}) {
    if (Array.isArray(value.quaternion)) return normalizedCameraPose(value);
    const position = new THREE.Vector3().fromArray(value.position || [0, 1.6, 0]);
    const target = new THREE.Vector3().fromArray(value.target || [0, 1.6, -1]);
    const up = new THREE.Vector3().fromArray(value.up || [0, 1, 0]).normalize();
    if (position.distanceToSquared(target) < 1e-12) target.set(position.x, position.y, position.z - 1);
    const matrix = new THREE.Matrix4().lookAt(position, target, up);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
    return normalizedCameraPose({
        position: position.toArray(),
        quaternion: quaternion.toArray(),
        fov: value.fov,
        focus_distance: position.distanceTo(target),
    });
}

export function legacyCameraFromPose(value = {}) {
    const pose = normalizedCameraPose(value);
    const position = new THREE.Vector3().fromArray(pose.position);
    const quaternion = new THREE.Quaternion().fromArray(pose.quaternion);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    return {
        position: pose.position,
        target: position.addScaledVector(forward, pose.focus_distance).toArray(),
        up: up.toArray(),
        fov: pose.fov,
    };
}

export class FactoryCameraPath {
    constructor(track = {}) {
        this.track = track;
        this.frames = (Array.isArray(track.keyframes) ? track.keyframes : [])
            .map(frame => ({ ...frame, ...normalizedCameraPose(frame) }))
            .sort((left, right) => Number(left.time) - Number(right.time));
        this.duration = Math.max(0.1, Number(track.duration) || this.frames.at(-1)?.time || 5);
        if (
            track.loop
            && this.frames.length > 1
            && Number(this.frames.at(-1).time) < this.duration - 1e-9
        ) {
            this.frames.push({ ...this.frames[0], time: this.duration, synthetic_loop: true });
        }
        this.points = this.frames.map(frame => new THREE.Vector3().fromArray(frame.position));
        this.segmentCurves = [];
        this.segmentArcTables = [];
        this.segmentLengths = [];
        this.totalLength = 0;
        for (let index = 1; index < this.points.length; index += 1) {
            let length = this.points[index - 1].distanceTo(this.points[index]);
            if (this.track.interpolation !== "linear") {
                const last = this.points.length - 1;
                const point = pointIndex => {
                    if (this.track.loop) {
                        const loopLength = this.frames.at(-1)?.synthetic_loop
                            ? this.points.length - 1
                            : this.points.length;
                        return this.points[(pointIndex + loopLength) % loopLength];
                    }
                    return this.points[Math.max(0, Math.min(last, pointIndex))];
                };
                const leftIndex = index - 1;
                const curve = new THREE.CatmullRomCurve3(
                    [point(leftIndex - 1), point(leftIndex), point(leftIndex + 1), point(leftIndex + 2)],
                    false,
                    "centripetal",
                    0.5,
                );
                const distances = [0];
                let previous = curve.getPoint(1 / 3);
                for (let sample = 1; sample <= 64; sample += 1) {
                    const current = curve.getPoint((1 + sample / 64) / 3);
                    distances.push(distances.at(-1) + previous.distanceTo(current));
                    previous = current;
                }
                length = distances.at(-1);
                this.segmentCurves.push(curve);
                this.segmentArcTables.push(distances);
            } else {
                this.segmentCurves.push(null);
                this.segmentArcTables.push(null);
            }
            this.segmentLengths.push(length);
            this.totalLength += length;
        }
    }

    _segmentPosition(leftIndex, local, constantSpeed = false) {
        if (this.track.interpolation === "linear") {
            return this.points[leftIndex].clone().lerp(this.points[leftIndex + 1], local);
        }
        const curve = this.segmentCurves[leftIndex];
        let curveLocal = Math.max(0, Math.min(1, local));
        if (constantSpeed) {
            const table = this.segmentArcTables[leftIndex];
            const target = curveLocal * (table?.at(-1) || 0);
            let upper = table?.findIndex(distance => distance >= target) ?? -1;
            if (upper < 0) upper = 64;
            if (upper <= 0) upper = 1;
            const lower = upper - 1;
            const span = Math.max(1e-9, table[upper] - table[lower]);
            curveLocal = (lower + (target - table[lower]) / span) / 64;
        }
        return curve.getPoint((1 + curveLocal) / 3);
    }

    _constantSpeedSample(progress) {
        if (this.totalLength <= 1e-9) {
            return { position: this.points[0].clone(), leftIndex: 0, local: 0 };
        }
        const target = clamp01(progress) * this.totalLength;
        let traversed = 0;
        for (let index = 0; index < this.segmentLengths.length; index += 1) {
            const length = this.segmentLengths[index];
            if (traversed + length >= target || index === this.segmentLengths.length - 1) {
                const local = Math.max(0, Math.min(
                    1,
                    length > 1e-9 ? (target - traversed) / length : 0,
                ));
                return {
                    position: this._segmentPosition(index, local, true),
                    leftIndex: index,
                    local,
                };
            }
            traversed += length;
        }
        return {
            position: this.points.at(-1).clone(),
            leftIndex: Math.max(0, this.points.length - 2),
            local: 1,
        };
    }

    evaluate(timeSeconds) {
        if (!this.frames.length) return normalizedCameraPose();
        if (this.frames.length === 1) return normalizedCameraPose(this.frames[0]);
        let time = Number(timeSeconds) || 0;
        time = this.track.loop
            ? ((time % this.duration) + this.duration) % this.duration
            : Math.max(0, Math.min(this.duration, time));
        let rightIndex = this.frames.findIndex(frame => Number(frame.time) >= time);
        if (rightIndex <= 0) rightIndex = 1;
        if (rightIndex < 0) rightIndex = this.frames.length - 1;
        let left = this.frames[rightIndex - 1];
        let right = this.frames[rightIndex];
        const span = Math.max(1e-9, Number(right.time) - Number(left.time));
        let local = eased((time - Number(left.time)) / span, right.easing || left.easing);
        let position;
        if (this.track.constant_speed === true) {
            const sample = this._constantSpeedSample(time / this.duration);
            left = this.frames[sample.leftIndex];
            right = this.frames[sample.leftIndex + 1];
            local = eased(sample.local, right.easing || left.easing);
            position = sample.position;
        } else {
            position = this._segmentPosition(rightIndex - 1, local);
        }
        const quaternion = new THREE.Quaternion().fromArray(left.quaternion).slerp(
            new THREE.Quaternion().fromArray(right.quaternion),
            local,
        ).normalize();
        return {
            position: position.toArray(),
            quaternion: quaternion.toArray(),
            fov: THREE.MathUtils.lerp(left.fov, right.fov, local),
            focus_distance: THREE.MathUtils.lerp(left.focus_distance, right.focus_distance, local),
        };
    }
}
