/** Serializable pose layer contracts shared by the canvas and editor host. */
export const POSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4" r="2"/><path d="M5 9l7-2 7 2M12 7v7M8 21l4-7 4 7M5 9l-2 5m16-5 2 5"/><circle cx="12" cy="14" r="1"/></svg>';
export const isImageLayer = layer => layer?.type === "raster" || layer?.type === "pose";
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

export function serializePose(pose, includeData = true) {
    if (!pose) return undefined;
    const result = clone(pose);
    if (!includeData && result.character?.source === "upload") delete result.character.dataURL;
    if (!includeData && result.studio?.background_url?.startsWith("data:")) {
        delete result.studio.background_url;
        result.backgroundCached = true;
    }
    return result;
}

export function poseLayerBelow(layers, layer) {
    const index = layers.indexOf(layer);
    return index < 0 ? [] : layers.slice(index + 1).filter(item => item.visible && isImageLayer(item));
}

export function poseGenerationLayer(host) {
    const eligible = layer => layer?.type === "pose" && layer.visible
        && layer.pose?.rect && intersects(layer.pose.rect, host.bbox);
    return eligible(host.activeLayer) ? host.activeLayer : host.layers.find(eligible) || null;
}

export function poseCharacterIssue(host, layer) {
    const character = layer?.pose?.character;
    if (character?.source === "upload") return character.dataURL ? null : "The character image is missing. Upload it again.";
    if (character?.source === "layer") {
        return host.layers.some(item => item.id === character.layerId && item !== layer && isImageLayer(item))
            ? null : "The character layer no longer exists. Choose another character image.";
    }
    return "Choose a character image from a layer or upload one, then press Generate.";
}
function intersects(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Compose image2 from the lower stack and the explicitly selected character. */
export async function composePoseReference(host, layer, size) {
    const out = host._createCanvas(size.width, size.height);
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    const lower = poseLayerBelow(host.layers, layer);
    const drawLayer = item => {
        ctx.save();
        ctx.globalAlpha = item.opacity;
        ctx.globalCompositeOperation = item.blendMode || "source-over";
        host.drawRasterLayerToWorldRect(ctx, item, host.bbox, { x: 0, y: 0, width: out.width, height: out.height });
        ctx.restore();
    };
    [...lower].reverse().forEach(drawLayer);
    const character = layer.pose?.character;
    if (character?.source === "layer") {
        const selected = host.layers.find(item => item.id === character.layerId && item !== layer && isImageLayer(item));
        if (!selected) throw new Error("The character layer no longer exists. Select another character image.");
        // An already visible lower layer is part of image2 exactly once.
        const bounds = host.getLayerWorldBounds(selected);
        if (!lower.includes(selected) || (bounds && !intersects(bounds, host.bbox))) {
            if (!bounds) throw new Error("The character layer is empty. Select another character image.");
            const scale = Math.min(out.width / bounds.width, out.height / bounds.height);
            const width = bounds.width * scale, height = bounds.height * scale;
            ctx.save(); ctx.globalAlpha = selected.opacity;
            host.drawRasterLayerToWorldRect(ctx, selected, bounds,
                { x: (out.width - width) / 2, y: (out.height - height) / 2, width, height });
            ctx.restore();
        }
    } else if (character?.source === "upload") {
        if (!character.dataURL) throw new Error("The character image is missing. Load it again.");
        const image = await host.loadImage(character.dataURL);
        const scale = Math.min(out.width / image.width, out.height / image.height);
        const width = image.width * scale, height = image.height * scale;
        ctx.drawImage(image, (out.width - width) / 2, (out.height - height) / 2, width, height);
    }
    return out;
}


export function mergePoseCache(live, cached) {
    if (!live) return clone(cached);
    const result = clone(live);
    if (result.backgroundCached && cached?.studio?.background_url) {
        result.studio = { ...result.studio, background_url: cached.studio.background_url };
        delete result.backgroundCached;
    }
    if (result.character?.source === "upload" && !result.character.dataURL
        && cached?.character?.source === "upload" && cached.character.name === result.character.name) {
        result.character.dataURL = cached.character.dataURL;
    }
    return result;
}

export function poseAtPanoramaCamera(layer, panorama) {
    const anchor = layer?.pose?.panoramaCamera;
    return !panorama || !anchor || ["yaw", "pitch", "roll", "fov"].every(key =>
        Math.abs(Number(anchor[key] ?? (key === "fov" ? 90 : 0)) - Number(panorama.settings[key] ?? (key === "fov" ? 90 : 0))) < 1e-6);
}
