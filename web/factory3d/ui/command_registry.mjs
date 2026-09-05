export const FACTORY_COMMANDS = Object.freeze([
    { id: "polygon_room", label: "Draw polygon room", group: "Architecture", keywords: "concave L shape outline contour" },
    { id: "primitive", label: "Add parametric shape", group: "Create", keywords: "box sphere cylinder cone ramp stairs roof solid" },
    { id: "save", label: "Save scene", group: "Scene", keywords: "persist" },
    { id: "scenes", label: "Open scene manager", group: "Scene" },
    { id: "library", label: "Open asset library", group: "Assets", keywords: "models import reusable" },
    { id: "import", label: "Import 3D model", group: "Assets", keywords: "GLB glTF FBX OBJ STL PLY" },
    { id: "terrain", label: "Add terrain", group: "Landscape" },
    { id: "light", label: "Add light", group: "Lighting" },
    { id: "lighting", label: "Scene lighting settings", group: "Lighting", keywords: "sun shadows environment" },
    { id: "camera", label: "Add camera from current view", group: "Cameras" },
    { id: "3d", label: "Switch to 3D view", group: "View" },
    { id: "plan", label: "Switch to Plan view", group: "View", keywords: "top orthographic floor" },
    { id: "wall", label: "Draw wall", group: "Architecture" },
    { id: "room", label: "Draw room", group: "Architecture" },
    { id: "opening", label: "Add door or window opening", group: "Architecture" },
    { id: "frame", label: "Frame selection", group: "View", keywords: "focus fit" },
    { id: "drop", label: "Drop selection to surface", group: "Placement" },
    { id: "undo", label: "Undo", group: "Edit" },
    { id: "redo", label: "Redo", group: "Edit" },
    { id: "output", label: "Output settings", group: "Output", keywords: "resolution export panorama" },
    { id: "expand", label: "Toggle expanded editor", group: "View" },
]);

export function findFactoryCommands(query = "") {
    const words = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
    return FACTORY_COMMANDS.filter(command => {
        const text = `${command.label} ${command.group} ${command.keywords || ""}`.toLowerCase();
        return words.every(word => text.includes(word));
    });
}
