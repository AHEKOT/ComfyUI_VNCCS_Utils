/**
 * Grab the torso (not a joint dot) to move the mannequin in the plane of the wall (drag) or
 * toward / away from it (Shift + drag). Joint dots, limbs and everything else keep Pose Studio's
 * own behavior; the move goes through the backdrop's character transform path, so it persists,
 * undoes and respects the wall like any other placement.
 */
const TORSO = /(pelvis|hips|spine|chest)/i;
const NOT_TORSO = /(head|neck)/i;

// True when the point on the mesh is closest to a trunk bone (pelvis / spine / chest).
export function isTorsoPoint(viewer, point) {
    const THREE = viewer.THREE, at = new THREE.Vector3();
    let best = null, bestDistance = Infinity;
    for (const [name, bone] of Object.entries(viewer.bones || {})) {
        if (typeof bone?.getWorldPosition !== "function") continue;
        const distance = bone.getWorldPosition(at).distanceToSquared(point);
        if (distance < bestDistance) { bestDistance = distance; best = name; }
    }
    return Boolean(best) && TORSO.test(best) && !NOT_TORSO.test(best);
}

const ARROWS = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
// Four arrows: the drag moves the mannequin sideways and up / down on the wall.
const PLANE_ICON = `<svg viewBox="0 0 24 24" width="28" height="28" ${ARROWS}><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>`;
// A slanted axis with the letter Z: the drag moves the mannequin away from / toward the wall.
const DEPTH_ICON = `<svg viewBox="0 0 24 24" width="28" height="28" ${ARROWS}><path d="M4 18 15 7M15 7H10M15 7v5M4 18h5M4 18v-5"/><text x="15" y="22" font-size="9" font-weight="700" fill="currentColor" stroke="none">Z</text></svg>`;

// Indicator next to the grab point: which axes the current drag controls.
function createIndicator(canvas) {
    const host = canvas.parentElement;
    if (!host?.appendChild) return null;
    const element = document.createElement("div");
    element.className = "vnccs-uc-pose-drag-hint";
    element.hidden = true;
    const icon = document.createElement("span"), label = document.createElement("span");
    element.append(icon, label);
    host.appendChild(element);
    let mode = null;
    return {
        show(event, depth) {
            const box = canvas.getBoundingClientRect(), hostBox = host.getBoundingClientRect?.() || box;
            element.style.left = `${event.clientX - hostBox.left + 26}px`;
            element.style.top = `${event.clientY - hostBox.top + 26}px`;
            if (mode !== depth) {
                mode = depth;
                icon.innerHTML = depth ? DEPTH_ICON : PLANE_ICON;
                label.textContent = depth ? "Depth (Z): up = away, down = closer" : "Move: left / right / up / down";
                element.classList.toggle("depth", depth);
            }
            element.hidden = false;
        },
        hide() { element.hidden = true; mode = null; },
        remove() { element.remove(); },
    };
}

export function installBodyDrag(editor) {
    const { canvas, viewer } = editor.studio, THREE = viewer.THREE;
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(), point = new THREE.Vector3();
    let drag = null;
    const indicator = createIndicator(canvas);
    const aim = event => {
        const box = canvas.getBoundingClientRect();
        ndc.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
        ray.setFromCamera(ndc, viewer.camera);
    };
    // The wall's normal: the framing's view direction, so "depth" always means into the image.
    const wallNormal = () => {
        const framing = editor.layer?.pose.viewport;
        return framing ? new THREE.Vector3().fromArray(framing.target).sub(new THREE.Vector3().fromArray(framing.position)).normalize()
            : viewer.camera.getWorldDirection(new THREE.Vector3());
    };
    const onDown = event => {
        if (event.button !== 0 || !editor.initialized || !editor.visible || !viewer.skinnedMesh) return;
        if (viewer.transform?.dragging || viewer.transform?.axis || viewer.directDrag?.active) return;
        aim(event);
        if (ray.intersectObjects(viewer._getRaycastableJointMarkers?.() || [], false).length) return;
        const hit = ray.intersectObject(viewer.skinnedMesh, true)[0];
        if (!hit || !isTorsoPoint(viewer, hit.point)) return;
        event.stopImmediatePropagation(); event.preventDefault();
        const normal = wallNormal();
        plane.setFromNormalAndCoplanarPoint(normal, hit.point);
        drag = { id: event.pointerId, normal, last: hit.point.clone(), lastY: event.clientY, distance: hit.distance };
        // Grabbing the body ends the joint edit: no rotation gizmo stays around a bone.
        viewer.deselectBone?.({ source: "viewer" });
        viewer.recordState?.();
        if (viewer.orbit) viewer.orbit.enabled = false;
        canvas.setPointerCapture?.(event.pointerId);
        lastEvent = event;
        indicator?.show(event, event.shiftKey);
    };
    const onMove = event => {
        if (!drag || event.pointerId !== drag.id) return;
        aim(event);
        lastEvent = event;
        indicator?.show(event, event.shiftKey);
        const shift = new THREE.Vector3();
        if (event.shiftKey) {
            // Depth: pixels to world units at the grabbed distance.
            const perPixel = (2 * drag.distance * Math.tan((viewer.camera.fov * Math.PI) / 360)) / Math.max(0.1, viewer.camera.zoom || 1) / (canvas.getBoundingClientRect().height || 1);
            shift.copy(drag.normal).multiplyScalar(-(event.clientY - drag.lastY) * perPixel);
        } else if (ray.ray.intersectPlane(plane, point)) shift.copy(point).sub(drag.last);
        if (ray.ray.intersectPlane(plane, point)) drag.last.copy(point);
        drag.lastY = event.clientY;
        if (shift.lengthSq() > 0) editor.backdrop?.moveActiveCharacter(shift);
    };
    const onUp = event => {
        if (!drag || event.pointerId !== drag.id) return;
        drag = null;
        indicator?.hide();
        if (viewer.orbit) viewer.orbit.enabled = true;
        canvas.releasePointerCapture?.(event.pointerId);
    };
    // Holding or releasing Shift mid-drag switches the indicator without waiting for a move.
    let lastEvent = null;
    const onShift = event => {
        if (drag && event.key === "Shift" && lastEvent) indicator?.show(lastEvent, event.type === "keydown");
    };
    globalThis.addEventListener?.("keydown", onShift);
    globalThis.addEventListener?.("keyup", onShift);
    canvas.addEventListener("pointerdown", onDown, { capture: true });
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
        canvas.removeEventListener("pointerdown", onDown, { capture: true });
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("pointercancel", onUp);
        if (drag && viewer.orbit) viewer.orbit.enabled = true;
        drag = null;
        indicator?.remove();
        globalThis.removeEventListener?.("keydown", onShift);
        globalThis.removeEventListener?.("keyup", onShift);
    };
}
