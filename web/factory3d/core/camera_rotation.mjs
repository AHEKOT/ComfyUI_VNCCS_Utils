import { Euler, Quaternion, MathUtils } from "../../vendor/spark/three.module.js";

// Pitch / yaw / roll use one YXZ convention in both directions.
export function factoryCameraQuaternion(rotation = [0, 0, 0]) {
    return new Quaternion().setFromEuler(new Euler(...rotation.map(MathUtils.degToRad), "YXZ")).toArray();
}

export function factoryCameraEuler(value = [0, 0, 0, 1]) {
    const quaternion = new Quaternion().fromArray(value).normalize();
    const euler = new Euler().setFromQuaternion(quaternion, "YXZ");
    return [euler.x, euler.y, euler.z].map(MathUtils.radToDeg);
}
