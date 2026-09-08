import * as THREE from "../vendor/spark/three.module.js";

const DEFAULT_SURFACE = Object.freeze({
    color: "#d7d2ca",
    roughness: 0.78,
    metalness: 0,
    opacity: 1,
    transmission: 0,
    kind: "standard",
});

function materialFromData(value = {}, maps = {}) {
    const data = { ...DEFAULT_SURFACE, ...(value || {}) };
    const shared = {
        color: data.color,
        roughness: Number(data.roughness),
        metalness: Number(data.metalness),
        opacity: Number(data.opacity),
        transparent: Number(data.opacity) < 1 || data.kind === "glass",
        side: THREE.DoubleSide,
        // Closed architecture casts its rear faces so the visible surface does
        // not self-shadow along every triangle. Glass remains two-sided.
        shadowSide: data.kind === "glass" ? THREE.DoubleSide : THREE.BackSide,
        map: maps.color || null,
        normalMap: maps.normal || null,
        roughnessMap: maps.roughness || null,
        normalScale: new THREE.Vector2(
            Number(data.normal_strength) || 0,
            Number(data.normal_strength) || 0,
        ),
    };
    if (data.kind === "glass") {
        const transmission = Number(data.transmission);
        return new THREE.MeshPhysicalMaterial({
            ...shared,
            transmission: Math.max(0, Math.min(1, Number.isFinite(transmission) ? transmission : 1)),
            ior: Math.max(1, Math.min(2.5, Number(data.ior) || 1.5)),
            depthWrite: false,
        });
    }
    return new THREE.MeshStandardMaterial(shared);
}

export class FactoryMaterialRegistry {
    constructor({ resolveTexture = () => null } = {}) {
        this.resolveTexture = resolveTexture;
        this.materials = new Map();
        this.textures = new Map();
        this.signature = "";
        this.disposed = false;
        this._setToken = 0;
        this.defaultWall = materialFromData({ color: "#d7d2ca" });
        this.defaultFloor = materialFromData({ color: "#77716e", roughness: 0.9 });
        this.defaultCeiling = materialFromData({ color: "#eeeae4", roughness: 0.92 });
        this.defaultGlass = materialFromData({
            kind: "glass",
            color: "#cde9f3",
            opacity: 0.35,
            transmission: 1,
            roughness: 0.08,
        });
        this.openingHit = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0,
            colorWrite: false,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
    }

    async set(materialEntries = []) {
        if (this.disposed) return;
        const signature = JSON.stringify(materialEntries);
        if (signature === this.signature) return;
        const token = ++this._setToken;
        this.disposeCustom();
        const pendingTextures = new Map();
        const textureFor = (entry, field, colorSpace) => {
            const textureId = entry?.[field];
            if (!textureId) return Promise.resolve(null);
            const uvScale = entry.uv_scale || [1, 1];
            const uvOffset = entry.uv_offset || [0, 0];
            const key = JSON.stringify([
                textureId,
                colorSpace,
                uvScale,
                uvOffset,
                Number(entry.uv_rotation) || 0,
            ]);
            if (!pendingTextures.has(key)) {
                pendingTextures.set(key, this.resolveTexture(textureId).then(texture => {
                    if (!texture) return null;
                    texture.colorSpace = colorSpace;
                    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
                    texture.repeat.fromArray(uvScale);
                    texture.offset.fromArray(uvOffset);
                    texture.rotation = THREE.MathUtils.degToRad(Number(entry.uv_rotation) || 0);
                    texture.center.set(0.5, 0.5);
                    return texture;
                }).catch(() => null));
            }
            return pendingTextures.get(key);
        };
        const resolved = await Promise.all(materialEntries.map(async entry => {
            const [color, normal, roughness] = await Promise.all([
                textureFor(entry, "texture_id", THREE.SRGBColorSpace),
                textureFor(entry, "normal_texture_id", THREE.NoColorSpace),
                textureFor(entry, "roughness_texture_id", THREE.NoColorSpace),
            ]);
            return { entry, maps: { color, normal, roughness } };
        }));
        if (this.disposed || token !== this._setToken) {
            const retired = new Set(resolved.flatMap(value => Object.values(value.maps)).filter(Boolean));
            for (const texture of retired) texture.dispose?.();
            return;
        }
        for (const { entry, maps } of resolved) {
            for (const [kind, texture] of Object.entries(maps)) {
                if (texture) this.textures.set(`${entry.material_id}:${kind}`, texture);
            }
            this.materials.set(entry.material_id, materialFromData(entry, maps));
        }
        if (!this.disposed && token === this._setToken) this.signature = signature;
    }

    get(materialId, fallback = "wall") {
        if (materialId && this.materials.has(materialId)) return this.materials.get(materialId);
        if (fallback === "floor") return this.defaultFloor;
        if (fallback === "ceiling") return this.defaultCeiling;
        if (fallback === "glass") return this.defaultGlass;
        return this.defaultWall;
    }

    disposeCustom() {
        for (const material of this.materials.values()) material.dispose?.();
        for (const texture of new Set(this.textures.values())) texture.dispose?.();
        this.materials.clear();
        this.textures.clear();
        this.signature = "";
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this._setToken += 1;
        this.disposeCustom();
        this.defaultWall.dispose();
        this.defaultFloor.dispose();
        this.defaultCeiling.dispose();
        this.defaultGlass.dispose();
        this.openingHit.dispose();
    }
}

function wallOpeningCells(length, height, openings) {
    const minimum = -length / 2;
    const maximum = length / 2;
    const normalized = openings.map(opening => {
        const center = minimum + Number(opening.offset) * length;
        const half = Math.min(length, Number(opening.width)) / 2;
        return {
            opening,
            start: Math.max(minimum, center - half),
            end: Math.min(maximum, center + half),
            bottom: Math.max(0, Number(opening.sill_height) || 0),
            top: Math.min(height, (Number(opening.sill_height) || 0) + Number(opening.height)),
        };
    }).filter(item => item.end - item.start >= 0.001 && item.top - item.bottom >= 0.001);
    const boundaries = Array.from(new Set([
        minimum,
        maximum,
        ...normalized.flatMap(item => [item.start, item.end]),
    ])).sort((left, right) => left - right);
    const cells = [];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
        const start = boundaries[index];
        const end = boundaries[index + 1];
        const width = end - start;
        if (width < 0.001) continue;
        const center = (start + end) / 2;
        const opening = normalized.find(item => center > item.start && center < item.end);
        if (!opening) {
            cells.push({ x: center, y: height / 2, width, height });
            continue;
        }
        if (opening.bottom > 0.001) {
            cells.push({
                x: center,
                y: opening.bottom / 2,
                width,
                height: opening.bottom,
            });
        }
        if (height - opening.top > 0.001) {
            cells.push({
                x: center,
                y: opening.top + (height - opening.top) / 2,
                width,
                height: height - opening.top,
            });
        }
    }
    return { cells, openings: normalized };
}

export function createWallObject(wall, level, openings, materials, junctions = {}) {
    const start = new THREE.Vector2().fromArray(wall.start);
    const end = new THREE.Vector2().fromArray(wall.end);
    const direction = end.clone().sub(start);
    const length = direction.length();
    const group = new THREE.Group();
    group.name = wall.name || "Wall";
    group.userData = { factoryType: "wall", factoryId: wall.wall_id };
    if (length < 0.001) return group;
    const elevation = Number(level?.elevation) + Number(wall.elevation_offset || 0);
    const height = Math.max(0.05, Number(wall.height) || Number(level?.height) || 2.8);
    const thickness = Math.max(0.01, Number(wall.thickness) || 0.12);
    const openingData = wallOpeningCells(
        length,
        height,
        openings.filter(opening => opening.visible !== false),
    );
    const leftMaterial = materials.get(wall.material_left, "wall");
    const rightMaterial = materials.get(wall.material_right, "wall");
    const capMaterial = materials.get(wall.material_caps, "wall");
    for (const cell of openingData.cells) {
        const minimum = -length / 2;
        const maximum = length / 2;
        const cellStart = cell.x - cell.width / 2;
        const cellEnd = cell.x + cell.width / 2;
        const startExtension = Math.abs(cellStart - minimum) < 1e-6
            ? Math.max(0, Number(junctions?.start?.extension) || 0)
            : 0;
        const endExtension = Math.abs(cellEnd - maximum) < 1e-6
            ? Math.max(0, Number(junctions?.end?.extension) || 0)
            : 0;
        const sealedWidth = cell.width + startExtension + endExtension;
        const sealedX = cell.x + (endExtension - startExtension) / 2;
        const geometry = new THREE.BoxGeometry(sealedWidth, cell.height, thickness);
        const mesh = new THREE.Mesh(geometry, [
            capMaterial,
            capMaterial,
            capMaterial,
            capMaterial,
            rightMaterial,
            leftMaterial,
        ]);
        mesh.position.set(sealedX, elevation + cell.y, 0);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = group.userData;
        group.add(mesh);
    }
    for (const value of openingData.openings) {
        const geometry = new THREE.PlaneGeometry(value.end - value.start, value.top - value.bottom);
        const material = value.opening.kind === "window"
            ? materials.get(value.opening.material_id, "glass")
            : materials.openingHit;
        const pane = new THREE.Mesh(geometry, material);
        pane.position.set(
            (value.start + value.end) / 2,
            elevation + (value.bottom + value.top) / 2,
            0,
        );
        pane.castShadow = false;
        pane.receiveShadow = false;
        pane.userData = {
            factoryType: "opening",
            factoryId: value.opening.opening_id,
            wallId: wall.wall_id,
            ignoreLightOcclusion: value.opening.kind !== "window",
        };
        group.add(pane);

        const planSymbol = new THREE.Group();
        planSymbol.name = `${value.opening.kind || "opening"} plan symbol`;
        planSymbol.position.set((value.start + value.end) / 2, elevation + 0.035, 0);
        planSymbol.userData = {
            factoryType: "opening",
            factoryId: value.opening.opening_id,
            wallId: wall.wall_id,
            factoryPlanOnly: true,
        };
        const symbolWidth = Math.max(0.05, value.end - value.start);
        const symbolDepth = Math.max(0.2, thickness * 2.4);
        const hit = new THREE.Mesh(
            new THREE.BoxGeometry(symbolWidth, 0.025, symbolDepth),
            new THREE.MeshBasicMaterial({
                color: value.opening.kind === "door" ? "#ffca85" : "#69d8ff",
                transparent: true,
                opacity: 0.22,
                depthTest: false,
            }),
        );
        hit.material.userData.factoryOwned = true;
        hit.userData = planSymbol.userData;
        hit.renderOrder = 48;
        planSymbol.add(hit);
        const lineMaterial = new THREE.LineBasicMaterial({
            color: value.opening.kind === "door" ? "#ffe2b5" : "#d8f5ff",
            depthTest: false,
        });
        lineMaterial.userData.factoryOwned = true;
        const halfWidth = symbolWidth / 2;
        const linePoints = value.opening.kind === "door"
            ? [
                new THREE.Vector3(-halfWidth, 0.015, 0),
                new THREE.Vector3(-halfWidth, 0.015, symbolWidth),
                new THREE.Vector3(halfWidth, 0.015, 0),
            ]
            : [
                new THREE.Vector3(-halfWidth, 0.015, -symbolDepth * 0.22),
                new THREE.Vector3(halfWidth, 0.015, -symbolDepth * 0.22),
                new THREE.Vector3(-halfWidth, 0.015, symbolDepth * 0.22),
                new THREE.Vector3(halfWidth, 0.015, symbolDepth * 0.22),
            ];
        if (value.opening.kind === "door") {
            const geometry = new THREE.BufferGeometry().setFromPoints(linePoints);
            const line = new THREE.Line(geometry, lineMaterial);
            line.userData = planSymbol.userData;
            line.renderOrder = 50;
            planSymbol.add(line);
        } else {
            for (let index = 0; index < linePoints.length; index += 2) {
                const geometry = new THREE.BufferGeometry().setFromPoints(linePoints.slice(index, index + 2));
                const line = new THREE.Line(geometry, lineMaterial);
                line.userData = planSymbol.userData;
                line.renderOrder = 50;
                planSymbol.add(line);
            }
        }
        group.add(planSymbol);
    }
    group.position.set((start.x + end.x) / 2, 0, (start.y + end.y) / 2);
    group.rotation.y = -Math.atan2(direction.y, direction.x);
    return group;
}

function roomShape(polygon) {
    const shape = new THREE.Shape();
    polygon.forEach((point, index) => {
        if (index === 0) shape.moveTo(point[0], point[1]);
        else shape.lineTo(point[0], point[1]);
    });
    shape.closePath();
    return shape;
}

function createRoomSurface(room, level, surface, kind, materials) {
    if (surface?.enabled === false || !Array.isArray(room.polygon) || room.polygon.length < 3) {
        return null;
    }
    const thickness = Math.max(0.001, Number(surface.thickness) || 0.02);
    const geometry = new THREE.ExtrudeGeometry(roomShape(room.polygon), {
        depth: thickness,
        bevelEnabled: false,
        curveSegments: 1,
        steps: 1,
    });
    geometry.rotateX(Math.PI / 2);
    const material = materials.get(surface.material_id, kind);
    const mesh = new THREE.Mesh(geometry, material);
    const levelElevation = Number(level?.elevation) || 0;
    mesh.position.y = kind === "ceiling"
        ? levelElevation + (Number(surface.height) || Number(level?.height) || 2.8)
        : levelElevation;
    mesh.castShadow = kind === "ceiling";
    mesh.receiveShadow = true;
    mesh.userData = { factoryType: kind, factoryId: room.room_id };
    return mesh;
}

export function createRoomObject(room, level, materials) {
    const group = new THREE.Group();
    group.name = room.name || "Room";
    group.userData = { factoryType: "room", factoryId: room.room_id };
    const floor = createRoomSurface(room, level, room.floor, "floor", materials);
    const ceiling = createRoomSurface(room, level, room.ceiling, "ceiling", materials);
    if (floor) group.add(floor);
    if (ceiling) group.add(ceiling);
    return group;
}

function wallJunctionAssignments(sceneData = {}) {
    const architecture = sceneData.architecture || {};
    const levels = new Map((sceneData.levels || []).map(level => [level.level_id, level]));
    const junctions = new Map();
    const assignments = new Map();
    const keyFor = (wall, point) => [
        wall.building_id || "scene",
        wall.level_id || "level",
        (Number(point?.[0]) || 0).toFixed(4),
        (Number(point?.[1]) || 0).toFixed(4),
    ].join(":");
    for (const wall of architecture.walls || []) {
        const level = levels.get(wall.level_id);
        if (!level || level.visible === false || wall.visible === false) continue;
        const thickness = Math.max(0.01, Number(wall.thickness) || 0.12);
        for (const endpoint of ["start", "end"]) {
            const key = keyFor(wall, wall[endpoint]);
            if (!junctions.has(key)) junctions.set(key, []);
            const other = wall[endpoint === "start" ? "end" : "start"];
            const direction = new THREE.Vector2(
                (Number(other?.[0]) || 0) - (Number(wall[endpoint]?.[0]) || 0),
                (Number(other?.[1]) || 0) - (Number(wall[endpoint]?.[1]) || 0),
            );
            if (direction.lengthSq() > 1e-12) direction.normalize();
            junctions.get(key).push({
                wall,
                endpoint,
                thickness,
                direction,
            });
        }
    }
    for (const connected of junctions.values()) {
        if (connected.length < 2) continue;
        const maximumThickness = Math.max(...connected.map(item => item.thickness));
        for (const item of connected) {
            let extension = 0;
            for (const other of connected) {
                if (other === item || !item.direction.lengthSq() || !other.direction.lengthSq()) continue;
                const angle = Math.acos(THREE.MathUtils.clamp(
                    item.direction.dot(other.direction),
                    -1,
                    1,
                ));
                const tangent = Math.tan(angle / 2);
                const candidate = tangent > 1e-4
                    ? (maximumThickness * 0.5) / tangent
                    : maximumThickness * 8;
                extension = Math.max(extension, candidate);
            }
            const wallAssignment = assignments.get(item.wall.wall_id) || {};
            wallAssignment[item.endpoint] = {
                extension: Math.max(0.002, Math.min(maximumThickness * 8, extension)),
            };
            assignments.set(item.wall.wall_id, wallAssignment);
        }
    }
    return assignments;
}

export class FactoryArchitectureRuntime {
    constructor(scene, { resolveTexture = () => null } = {}) {
        this.scene = scene;
        this.root = new THREE.Group();
        this.root.name = "VNCCS Factory architecture";
        this.materials = new FactoryMaterialRegistry({ resolveTexture });
        this.items = new Map();
        this.buildingRoots = new Map();
        this.disposed = false;
        this._setToken = 0;
        this.scene.add(this.root);
    }

    async set(sceneData = {}) {
        if (this.disposed) return;
        const token = ++this._setToken;
        this.sceneData = sceneData;
        const architecture = sceneData.architecture || {};
        const usedMaterialIds = new Set();
        for (const wall of architecture.walls || []) {
            usedMaterialIds.add(wall.material_left);
            usedMaterialIds.add(wall.material_right);
            usedMaterialIds.add(wall.material_caps);
        }
        for (const room of architecture.rooms || []) {
            usedMaterialIds.add(room.floor?.material_id);
            usedMaterialIds.add(room.ceiling?.material_id);
        }
        for (const opening of architecture.openings || []) usedMaterialIds.add(opening.material_id);
        usedMaterialIds.delete("");
        await this.materials.set(
            (architecture.materials || []).filter(material => usedMaterialIds.has(material.material_id)),
        );
        if (this.disposed || token !== this._setToken) return;
        this.clear();
        const levels = new Map((sceneData.levels || []).map(item => [item.level_id, item]));
        const buildings = Array.isArray(architecture.buildings) ? architecture.buildings : [];
        for (const building of buildings) {
            const object = new THREE.Group();
            object.name = building.name || "Building";
            object.userData = { factoryType: "building", factoryId: building.building_id };
            object.position.fromArray(building.position || [0, 0, 0]);
            object.rotation.y = THREE.MathUtils.degToRad(Number(building.rotation_y) || 0);
            object.visible = building.visible !== false;
            this.root.add(object);
            this.buildingRoots.set(building.building_id, object);
            this.items.set(`building:${building.building_id}`, object);
        }
        const openingsByWall = new Map();
        for (const opening of architecture.openings || []) {
            if (opening.visible === false) continue;
            if (!openingsByWall.has(opening.wall_id)) openingsByWall.set(opening.wall_id, []);
            openingsByWall.get(opening.wall_id).push(opening);
        }
        const wallJunctions = wallJunctionAssignments(sceneData);
        for (const wall of architecture.walls || []) {
            const level = levels.get(wall.level_id);
            if (!level || level.visible === false || wall.visible === false) continue;
            const object = createWallObject(
                wall,
                level,
                openingsByWall.get(wall.wall_id) || [],
                this.materials,
                wallJunctions.get(wall.wall_id),
            );
            (this.buildingRoots.get(wall.building_id) || this.root).add(object);
            this.items.set(`wall:${wall.wall_id}`, object);
        }
        for (const room of architecture.rooms || []) {
            const level = levels.get(room.level_id);
            if (!level || level.visible === false || room.visible === false) continue;
            const object = createRoomObject(room, level, this.materials);
            (this.buildingRoots.get(room.building_id) || this.root).add(object);
            this.items.set(`room:${room.room_id}`, object);
        }
    }

    async reconcile(sceneData, previous) {
        if (this.disposed) return;
        const before = previous?.architecture || {};
        const after = sceneData.architecture || {};
        // A registry replacement invalidates shared materials. Ordinary edits
        // reuse that registry and every unaffected mesh, including its GPU data.
        const assignedMaterials = new Set([
            ...(after.walls || []).flatMap(item => [item.material_left, item.material_right, item.material_caps]),
            ...(after.rooms || []).flatMap(item => [item.floor?.material_id, item.ceiling?.material_id]),
            ...(after.openings || []).map(item => item.material_id),
        ].filter(Boolean));
        const missingMaterial = (after.materials || []).some(item => assignedMaterials.has(item.material_id)
            && !this.materials.materials.has(item.material_id));
        if (missingMaterial || JSON.stringify(before.materials) !== JSON.stringify(after.materials)) {
            await this.set(sceneData);
            return;
        }
        this.sceneData = sceneData;
        const oldLevels = new Map((previous?.levels || []).map(level => [level.level_id, level]));
        const levels = new Map((sceneData.levels || []).map(level => [level.level_id, level]));
        const oldJunctions = wallJunctionAssignments(previous);
        const junctions = wallJunctionAssignments(sceneData);
        const keep = new Set();
        const disposeItem = object => {
            object.traverse(child => {
                child.geometry?.dispose?.();
                for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
                    if (material?.userData?.factoryOwned) material.dispose?.();
                }
            });
            object.removeFromParent();
        };
        for (const building of after.buildings || []) {
            const key = `building:${building.building_id}`;
            keep.add(key);
            if (!this.buildingRoots.has(building.building_id)) {
                const group = new THREE.Group();
                group.userData = { factoryType: "building", factoryId: building.building_id };
                this.buildingRoots.set(building.building_id, group);
                this.items.set(key, group);
                this.root.add(group);
            }
            this.buildingRoots.get(building.building_id).name = building.name || "Building";
            this.updateBuilding(building);
        }
        for (const [type, list, idKey] of [["wall", "walls", "wall_id"], ["room", "rooms", "room_id"]]) {
            const oldItems = new Map((before[list] || []).map(item => [item[idKey], item]));
            for (const item of after[list] || []) {
                const id = item[idKey], key = `${type}:${id}`;
                const level = levels.get(item.level_id);
                if (!level || level.visible === false || item.visible === false) continue;
                keep.add(key);
                const old = oldItems.get(id);
                const openings = (after.openings || []).filter(value => value.wall_id === id && value.visible !== false);
                const oldOpenings = (before.openings || []).filter(value => value.wall_id === id && value.visible !== false);
                const changed = JSON.stringify([item, level, openings, junctions.get(id)])
                    !== JSON.stringify([old, oldLevels.get(old?.level_id), oldOpenings, oldJunctions.get(id)]);
                let object = this.items.get(key);
                if (!object || changed) {
                    const replacement = type === "wall"
                        ? createWallObject(item, level, openings, this.materials, junctions.get(id))
                        : createRoomObject(item, level, this.materials);
                    if (object) disposeItem(object);
                    object = replacement;
                    this.items.set(key, object);
                }
                const parent = this.buildingRoots.get(item.building_id) || this.root;
                if (object.parent !== parent) parent.add(object);
            }
        }
        // Children are reconciled before obsolete buildings are removed.
        const retired = [...this.items].sort(([left], [right]) => Number(left.startsWith("building:")) - Number(right.startsWith("building:")));
        for (const [key, object] of retired) {
            if (keep.has(key)) continue;
            disposeItem(object);
            this.items.delete(key);
            if (key.startsWith("building:")) this.buildingRoots.delete(key.slice(9));
        }
    }

    setActiveLevel(
        levelId,
        planMode = false,
        { hideCeilings = planMode, hiddenWallId = "" } = {},
    ) {
        this.activeLevelId = levelId;
        this.activePlanMode = planMode;
        for (const [key, object] of this.items) {
            if (key.startsWith("building:")) continue;
            const [type, sourceId] = key.split(":");
            const source = type === "wall"
                ? this.sceneData?.architecture?.walls?.find(item => item.wall_id === sourceId)
                : this.sceneData?.architecture?.rooms?.find(item => item.room_id === sourceId);
            const level = this.sceneData?.levels?.find(item => item.level_id === source?.level_id);
            object.visible = source?.visible !== false
                && level?.visible !== false
                && (!planMode || !levelId || source?.level_id === levelId)
                && !(type === "wall" && sourceId === hiddenWallId);
            object.traverse(child => {
                if (child !== object && child.userData?.factoryType === "ceiling") {
                    child.visible = !hideCeilings;
                }
                if (child.userData?.factoryPlanOnly) child.visible = planMode;
            });
        }
    }

    updateBuilding(building) {
        const object = this.buildingRoots.get(building?.building_id);
        if (!object) return false;
        object.position.fromArray(building.position || [0, 0, 0]);
        object.rotation.y = THREE.MathUtils.degToRad(Number(building.rotation_y) || 0);
        object.visible = building.visible !== false;
        object.updateMatrixWorld(true);
        return true;
    }

    updateItem(type, id, sceneData = this.sceneData) {
        this.sceneData = sceneData || this.sceneData;
        const architecture = this.sceneData?.architecture || {};
        if (type === "building") {
            const building = architecture.buildings?.find(item => item.building_id === id);
            return building ? this.updateBuilding(building) : false;
        }
        let sourceType = type;
        let sourceId = id;
        if (type === "opening") {
            const opening = architecture.openings?.find(item => item.opening_id === id);
            sourceType = "wall";
            sourceId = opening?.wall_id || "";
        }
        const source = sourceType === "wall"
            ? architecture.walls?.find(item => item.wall_id === sourceId)
            : architecture.rooms?.find(item => item.room_id === sourceId);
        const previous = this.items.get(`${sourceType}:${sourceId}`);
        if (!source || !previous) return false;
        const level = this.sceneData?.levels?.find(item => item.level_id === source.level_id);
        if (!level) return false;
        const replacement = sourceType === "wall"
            ? createWallObject(
                source,
                level,
                (architecture.openings || []).filter(item => item.wall_id === sourceId && item.visible !== false),
                this.materials,
                wallJunctionAssignments(this.sceneData).get(sourceId),
            )
            : createRoomObject(source, level, this.materials);
        replacement.visible = source.visible !== false
            && level.visible !== false
            && (this.activePlanMode !== true || !this.activeLevelId || source.level_id === this.activeLevelId);
        previous.traverse(child => {
            child.geometry?.dispose?.();
            const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of childMaterials) {
                if (material?.userData?.factoryOwned) material.dispose?.();
            }
        });
        const parent = previous.parent;
        if (!parent) return false;
        parent.add(replacement);
        parent.remove(previous);
        this.items.set(`${sourceType}:${sourceId}`, replacement);
        return true;
    }

    clear() {
        for (const object of [...this.root.children]) {
            object.traverse(child => {
                child.geometry?.dispose?.();
                const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
                for (const material of childMaterials) {
                    if (material?.userData?.factoryOwned) material.dispose?.();
                }
            });
            this.root.remove(object);
        }
        this.items.clear();
        this.buildingRoots.clear();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this._setToken += 1;
        this.clear();
        this.materials.dispose();
        this.scene.remove(this.root);
    }
}
