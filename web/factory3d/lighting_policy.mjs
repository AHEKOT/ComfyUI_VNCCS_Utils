const SHADOW_BUDGETS = Object.freeze({ low: 2, medium: 4, high: 6, ultra: 8 });

/** Allocate shadows in stored scene order, independently of illumination. */
export function allocateLocalLightShadows(lighting = {}, scene = {}, {
    viewMode = "3d",
    activeLevelId = "",
} = {}) {
    const shadowsEnabled = lighting.shadows?.enabled !== false
        && lighting.shadows?.quality !== "off";
    const budget = shadowsEnabled ? SHADOW_BUDGETS[lighting.shadows?.quality || "medium"] || 0 : 0;
    const hiddenBuildings = new Set((scene?.architecture?.buildings || [])
        .filter(building => building.visible === false)
        .map(building => building.building_id));
    const states = new Map();
    let allocated = 0;
    for (const light of lighting.lights || []) {
        let status;
        if (light.visible === false) status = "hidden";
        else if (!(Number(light.intensity) > 0)) status = "zero";
        else if (hiddenBuildings.has(light.building_id)) status = "building_hidden";
        else if (viewMode === "plan" && light.level_id && light.level_id !== activeLevelId) status = "other_floor";
        const enabled = !status;
        let castShadow = false;
        if (enabled) {
            if (!shadowsEnabled || light.cast_shadow === false) status = "shadows_off";
            else if (allocated < budget) {
                castShadow = true;
                allocated += 1;
                status = "shadow_active";
            } else status = "shadow_deferred";
        }
        states.set(light.light_id, { enabled, castShadow, status });
    }
    return states;
}

export function localLightStatusLabel(state) {
    return {
        hidden: "Hidden",
        zero: "Zero intensity",
        building_hidden: "Building hidden",
        other_floor: "Other floor in Plan",
        shadows_off: "Light on · Shadows off",
        shadow_active: "Light on · Shadows active",
        shadow_deferred: "Light on · Shadows deferred",
    }[state?.status] || "";
}
