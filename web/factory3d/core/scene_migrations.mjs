export function migrateScene11To12(scene) {
    const version = scene.schema_version ?? 11;
    if (![11, 12].includes(version)) throw new Error("Normalize legacy scenes to version 11 before upgrading; future versions are unsupported");
    const result = structuredClone(scene);
    if (version === 12) return result;
    result.schema_version = 12;
    result.features = { transforms: 1, captures: 1, procedural_geometry: 1 };
    result.coordinate_system = "right-handed-y-up";
    result.units = "m";
    return result;
}
