// Illustrated help popup for the UniCanvas pose editor ("?" in the editing bar).
// Everything here is static markup written by this module; no server or user text is inserted.

export const POSE_HELP_CSS = `
.vnccs-uc-pose-help { position:absolute; inset:0; z-index:5; display:flex; align-items:center; justify-content:center; padding:16px; box-sizing:border-box; background:rgba(8,6,12,.62); pointer-events:auto; }
.vnccs-uc-pose-help[hidden] { display:none; }
.vnccs-uc-pose-help-card { display:flex; flex-direction:column; width:min(760px, 100%); max-height:100%; min-height:0; box-sizing:border-box; border:1px solid var(--uc-border); border-radius:12px; background:var(--uc-panel, #17131f); color:var(--uc-text); box-shadow:0 18px 48px rgba(0,0,0,.55); zoom:var(--vnccs-uc-ui-scale, 1); }
.vnccs-uc-pose-help-bar { display:flex; align-items:center; gap:6px; padding:8px 12px; border-bottom:1px solid var(--uc-border); }
.vnccs-uc-pose-help-bar strong { flex:1; font-size:13px; color:var(--uc-accent, #ff8fa3); }
.vnccs-uc-pose-help-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:10px; padding:12px; overflow:auto; min-height:0; }
.vnccs-uc-pose-help-item { display:flex; flex-direction:column; gap:6px; padding:8px; border:1px solid var(--uc-border); border-radius:10px; background:rgba(255,255,255,.03); }
.vnccs-uc-pose-help-item > svg { width:100%; height:auto; display:block; border-radius:6px; }
.vnccs-uc-pose-help-item h4 { margin:0; font-size:12px; }
.vnccs-uc-pose-help-item p { margin:0; font-size:11px; line-height:1.45; color:var(--uc-muted); }
.vnccs-uc-pose-help-item kbd { padding:0 5px; border:1px solid var(--uc-border); border-bottom-width:2px; border-radius:4px; font:inherit; font-size:10px; color:var(--uc-text); }
.vnccs-uc-pose-help-item.wide { grid-column:1 / -1; }
.vnccs-uc-pose-help-buttons { display:flex; flex-wrap:wrap; gap:8px 14px; }
.vnccs-uc-pose-help-buttons > div { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--uc-muted); }
.vnccs-uc-pose-help-buttons .vnccs-uc-btn { pointer-events:none; }
.vnccs-uc-pose-help-legend { display:grid; grid-template-columns:max-content 1fr; align-items:center; gap:8px 14px; }
.vnccs-uc-pose-help-legend .vnccs-uc-btn { display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box; min-width:110px; height:30px; padding:0 14px; margin:0; pointer-events:none; white-space:nowrap; }
.vnccs-uc-pose-help-legend .vnccs-uc-btn.icon { min-width:0; width:42px; padding:0; }
.vnccs-uc-pose-help-legend span:not(.vnccs-uc-btn) { font-size:11px; line-height:1.4; color:var(--uc-muted); }
`;

const ACCENT = "#ff8fa3", VIOLET = "#b8a9e8", DOT = "#f5a800", BODY = "#8f8a86", LINE = "#9898a8";

// A small mannequin, offset by x / y.
const figure = (x = 0, y = 0, opacity = 1) => `<g transform="translate(${x} ${y})" opacity="${opacity}">
<circle cx="60" cy="24" r="10" fill="${BODY}"/><rect x="50" y="36" width="20" height="38" rx="8" fill="${BODY}"/>
<path d="M50 42 32 62M70 42 88 62M54 72 48 106M66 72 72 106" stroke="${BODY}" stroke-width="7" stroke-linecap="round" fill="none"/>
<g fill="${DOT}"><circle cx="60" cy="38" r="3"/><circle cx="60" cy="56" r="3"/><circle cx="32" cy="62" r="3"/><circle cx="88" cy="62" r="3"/><circle cx="48" cy="106" r="3"/><circle cx="72" cy="106" r="3"/></g></g>`;

const arrow = (d, color = ACCENT) => `<path d="${d}" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
const svg = (body, label) => `<svg viewBox="0 0 120 120" role="img" aria-label="${label}">${body}</svg>`;
const scene = body => `<rect width="120" height="120" fill="#1b2433"/><path d="M0 84h120v36H0z" fill="#132030"/>${body}`;

const ILLUSTRATIONS = {
    rotate: svg(scene(`${figure()}<circle cx="32" cy="62" r="14" stroke="${ACCENT}" stroke-width="2" fill="none"/><ellipse cx="32" cy="62" rx="5" ry="14" stroke="#e05555" stroke-width="2" fill="none"/><circle cx="32" cy="62" r="4.5" fill="${ACCENT}"/>`), "Rotating a joint"),
    move: svg(scene(`${figure(4, 0)}${arrow("M60 56H12M12 56l7-6M12 56l7 6")}${arrow("M60 56h48M108 56l-7-6M108 56l-7 6")}${arrow("M60 56V6M60 6l-6 7M60 6l6 7")}`), "Moving the body"),
    depth: svg(scene(`${figure(-4, 8, 0.35)}${figure(4, 0)}${arrow("M96 106 78 62M78 62l1 9M78 62l8 5", VIOLET)}<text x="88" y="118" fill="${VIOLET}" font-size="16" font-weight="700" font-family="sans-serif">Z</text>`), "Moving in depth"),
    view: svg(scene(`${figure()}<path d="M22 100a48 20 0 0 0 76 0" stroke="${LINE}" stroke-width="2" stroke-dasharray="4 3" fill="none"/>${arrow("M98 100l-2-8M98 100l-8-1", LINE)}`), "Orbiting the view"),
};

const mouse = (highlight, extra = "") => `<svg viewBox="0 0 40 56" width="34" height="48" role="img" aria-hidden="true"><rect x="6" y="4" width="28" height="48" rx="14" fill="none" stroke="${LINE}" stroke-width="2"/><path d="M20 4v20M6 24h28" stroke="${LINE}" stroke-width="2"/>${highlight}${extra}</svg>`;
const MOUSE_ORBIT = mouse(`<path d="M20 4h0a14 14 0 0 1 14 14v6H20z" fill="${ACCENT}"/>`);
const MOUSE_PAN = mouse(`<rect x="17" y="8" width="6" height="12" rx="3" fill="${ACCENT}"/>`);
const MOUSE_WHEEL = mouse(`<rect x="17" y="8" width="6" height="12" rx="3" fill="${ACCENT}"/>`, `<path d="M13 32l7 7 7-7" stroke="${ACCENT}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);

const EYE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;

const ITEMS = [
    { key: "rotate", title: "Rotate a joint", html: `Drag a <b style="color:${DOT}">yellow joint dot</b>. A rotation gizmo appears around it: drag a ring to turn the limb. Grab the body again to leave the joint.` },
    { key: "move", title: "Move the body", html: "Drag the <b>torso</b> (the body itself, not a dot). The mannequin slides left, right, up and down on the wall - the layers below stay where they are." },
    { key: "depth", title: "Move in depth (Z)", html: "Hold <kbd>Shift</kbd> while dragging the torso. Drag <b>up</b> to move away from the wall, <b>down</b> to come closer. An indicator next to the pointer shows which axes you are controlling." },
    { key: "view", title: "Look around", html: "The view is only for inspecting: it never changes the image. Use it to check a hand or a foot from the side, then press <b>Reset camera</b>." },
];

export function buildPoseHelp(document, { onClose } = {}) {
    const overlay = document.createElement("div");
    overlay.className = "vnccs-uc-pose-help"; overlay.hidden = true;
    overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-label", "Editing pose help");
    const card = document.createElement("div"); card.className = "vnccs-uc-pose-help-card";
    const bar = document.createElement("div"); bar.className = "vnccs-uc-pose-help-bar";
    const title = document.createElement("strong"); title.textContent = "Editing pose - how it works";
    const close = document.createElement("button"); close.type = "button"; close.className = "vnccs-uc-btn"; close.textContent = "Close";
    bar.append(title, close);
    const grid = document.createElement("div"); grid.className = "vnccs-uc-pose-help-grid";
    const item = (svgMarkup, heading, html) => {
        const cell = document.createElement("div"); cell.className = "vnccs-uc-pose-help-item";
        cell.innerHTML = `${svgMarkup}<h4>${heading}</h4><p>${html}</p>`;
        return cell;
    };
    for (const entry of ITEMS) grid.append(item(ILLUSTRATIONS[entry.key], entry.title, entry.html));
    const mice = document.createElement("div"); mice.className = "vnccs-uc-pose-help-item";
    mice.innerHTML = `<div class="vnccs-uc-pose-help-buttons"><div>${MOUSE_ORBIT}<span>Right-drag<br>orbit</span></div><div>${MOUSE_PAN}<span>Middle-drag<br>pan</span></div><div>${MOUSE_WHEEL}<span>Wheel<br>zoom</span></div></div><h4>Camera mouse controls</h4><p>These move the editing view only. Undo (<kbd>Ctrl</kbd>+<kbd>Z</kbd>) reverts the mannequin, never the view.</p>`;
    grid.append(mice);
    const buttons = document.createElement("div"); buttons.className = "vnccs-uc-pose-help-item wide";
    buttons.innerHTML = `<h4>Buttons</h4><div class="vnccs-uc-pose-help-legend">
<span class="vnccs-uc-btn icon">${EYE}</span><span>Show or hide the layers below the pose (the wall). The eye closes when they are hidden.</span>
<span class="vnccs-uc-btn">Reset camera</span><span>Editing view back to the image framing. The mannequin is not touched.</span>
<span class="vnccs-uc-btn">Cancel</span><span>Discard this session and restore the pose.</span>
<span class="vnccs-uc-btn primary">Save pose</span><span>Keep the pose and leave the editor (Enter).</span></div>
<p>The Pose Library is in the <b>Scene</b> tab; body shape, gender and proportions are in <b>Body</b>. A new character starts as a copy of the current one.</p>`;
    grid.append(buttons);
    card.append(bar, grid); overlay.append(card);
    const hide = () => { overlay.hidden = true; onClose?.(); };
    close.addEventListener("click", hide);
    overlay.addEventListener("pointerdown", event => { if (event.target === overlay) hide(); });
    overlay.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(); }
    });
    return { overlay, close, show() { overlay.hidden = false; close.focus?.(); }, hide, get open() { return !overlay.hidden; } };
}
