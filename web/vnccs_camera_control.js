import { app } from "../../scripts/app.js";
import {
    DISTANCE_OPTIONS,
    ELEVATION_STEPS,
    cameraStateFromRadarPoint,
    computeRadarGeometry,
    elevationFromRatio,
    parseCameraState,
    randomizeCameraState,
    serializeCameraState,
} from "./vnccs_camera_control_utils.mjs";

const STYLE_ID = "vnccs-camera-control-styles";
const DOM_WIDGET_NAME = "camera_control_ui";
const DATA_WIDGET_NAME = "camera_data";

const STYLES = `
.vnccs-camera-control {
    --vc-bg: #0a0a0f;
    --vc-panel: rgba(20, 16, 30, 0.82);
    --vc-surface: rgba(30, 28, 44, 0.9);
    --vc-border: rgba(255, 255, 255, 0.08);
    --vc-accent: #ff8fa3;
    --vc-accent-2: #b8a9e8;
    --vc-accent-border: rgba(255, 143, 163, 0.28);
    --vc-text: #e8e8f0;
    --vc-muted: #9898a8;
    --vc-dim: #5e5e70;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    max-width: 100%;
    max-height: 100%;
    padding: 6px;
    color: var(--vc-text);
    font: 11px 'Sora', -apple-system, BlinkMacSystemFont, sans-serif;
    overflow: hidden;
    box-sizing: border-box;
    pointer-events: auto;
    position: relative;
    user-select: none;
}

.vnccs-camera-surface {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    padding: 8px;
    border: 1px solid var(--vc-accent-border);
    border-radius: 12px;
    background: var(--vc-panel);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    box-sizing: border-box;
}

.vnccs-camera-surface::before {
    content: "";
    position: absolute;
    z-index: 2;
    top: 0;
    left: 14%;
    right: 14%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255, 143, 163, 0.55), transparent);
    pointer-events: none;
}

.vnccs-camera-main {
    display: grid;
    flex: 1 1 auto;
    grid-template-columns: minmax(0, 1fr) 52px;
    grid-template-rows: minmax(0, 1fr);
    align-items: stretch;
    gap: 8px;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}

.vnccs-camera-radar-wrap {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--vc-border);
    border-radius: 10px;
    background:
        radial-gradient(circle at 50% 42%, rgba(255, 143, 163, 0.055), transparent 55%),
        var(--vc-bg);
    box-sizing: border-box;
}

.vnccs-camera-radar {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
    cursor: crosshair;
}

.vnccs-camera-elevation {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
}

.vnccs-camera-elevation-title {
    color: var(--vc-dim);
    font-size: 8px;
    font-weight: 800;
    line-height: 1;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.08em;
}

.vnccs-camera-elevation-track {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--vc-border);
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.025);
    touch-action: none;
    cursor: ns-resize;
}

.vnccs-camera-elevation-line {
    position: absolute;
    top: 13px;
    bottom: 13px;
    left: 11px;
    width: 2px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.13);
    pointer-events: none;
}

.vnccs-camera-elevation-step {
    position: absolute;
    left: 5px;
    right: 3px;
    display: flex;
    min-width: 0;
    height: 20px;
    padding: 0;
    align-items: center;
    gap: 5px;
    border: 0;
    background: transparent;
    color: var(--vc-muted);
    font: 700 9px/1 'JetBrains Mono', 'Fira Code', monospace;
    cursor: pointer;
    transform: translateY(-50%);
}

.vnccs-camera-elevation-step::before {
    content: "";
    width: 10px;
    height: 10px;
    flex: 0 0 10px;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-radius: 50%;
    background: #1a1822;
    box-sizing: border-box;
}

.vnccs-camera-elevation-step.active {
    color: var(--vc-accent);
}

.vnccs-camera-elevation-step.active::before {
    border-color: var(--vc-accent);
    background: var(--vc-accent);
    box-shadow: 0 0 9px rgba(255, 143, 163, 0.48);
}

.vnccs-camera-footer {
    display: flex;
    flex: 0 0 auto;
    min-width: 0;
    margin-top: 7px;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.vnccs-camera-readout {
    min-width: 0;
    overflow: hidden;
    color: var(--vc-muted);
    font: 700 9px/1.25 'JetBrains Mono', 'Fira Code', monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vnccs-camera-readout strong {
    color: var(--vc-accent);
    font-weight: 800;
}

.vnccs-camera-toggles {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
}

.vnccs-camera-check {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--vc-muted);
    font-size: 9px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
}

.vnccs-camera-check input {
    width: 12px;
    height: 12px;
    margin: 0;
    accent-color: var(--vc-accent);
    cursor: pointer;
}

.vnccs-camera-check:has(input:checked) {
    color: var(--vc-text);
}

.vnccs-camera-random-scope {
    display: none;
    flex: 0 0 auto;
    min-width: 0;
    height: 24px;
    margin-top: 6px;
    padding: 2px 3px 2px 7px;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    border: 1px solid var(--vc-border);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.025);
    box-sizing: border-box;
}

.vnccs-camera-random-scope.visible {
    display: flex;
}

.vnccs-camera-random-scope-label {
    overflow: hidden;
    color: var(--vc-dim);
    font-size: 8px;
    font-weight: 800;
    line-height: 1;
    text-overflow: ellipsis;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
}

.vnccs-camera-random-scope-options {
    display: grid;
    flex: 0 0 auto;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 142px;
    height: 18px;
    padding: 1px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.28);
}

.vnccs-camera-random-scope-btn {
    min-width: 0;
    padding: 0 6px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--vc-muted);
    font: 800 8px/1 'JetBrains Mono', 'Fira Code', monospace;
    cursor: pointer;
    white-space: nowrap;
}

.vnccs-camera-random-scope-btn.active {
    background: var(--vc-accent);
    color: #24121a;
    box-shadow: 0 0 7px rgba(255, 143, 163, 0.28);
}

@media (max-width: 330px) {
    .vnccs-camera-main {
        grid-template-columns: minmax(0, 1fr) 46px;
        gap: 6px;
    }

    .vnccs-camera-footer {
        align-items: flex-start;
        flex-direction: column;
        gap: 5px;
    }
}
`;

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLES;
    document.head.appendChild(style);
}

function findWidget(node, name) {
    return node?.widgets?.find((widget) => widget?.name === name);
}

function hideDataWidget(node) {
    const widget = findWidget(node, DATA_WIDGET_NAME);
    if (!widget) return null;

    widget.type = "hidden";
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
    if (widget.element) widget.element.style.display = "none";
    return widget;
}

function syncDOMWidgetWidth(node) {
    const widget = findWidget(node, DOM_WIDGET_NAME);
    const nodeWidth = Number(node?.size?.[0]);
    if (!widget || !Number.isFinite(nodeWidth) || nodeWidth <= 0) return;

    if (!widget._vnccsWidthBound) {
        const descriptor = Object.getOwnPropertyDescriptor(widget, "width");
        if (!descriptor || descriptor.configurable) {
            try {
                Object.defineProperty(widget, "width", {
                    configurable: true,
                    get() {
                        const width = Number(this._node?.size?.[0]);
                        return Number.isFinite(width) && width > 0 ? width : undefined;
                    },
                    set(_value) {
                        // DOM widget width follows the node width.
                    },
                });
            } catch (_) {
                // Older LiteGraph builds can expose a non-configurable width.
            }
        }
        widget._vnccsWidthBound = true;
    }

    widget.triggerDraw?.();
}

class VNCCSCameraWidget {
    constructor(node) {
        this.node = node;
        this.state = parseCameraState(findWidget(node, DATA_WIDGET_NAME)?.value);
        this.geometry = computeRadarGeometry(260);
        this.draggingRadar = false;
        this.draggingElevation = false;

        ensureStyles();
        this.buildDOM();
        this.installEvents();
        this.resizeObserver = typeof ResizeObserver === "function"
            ? new ResizeObserver(() => this.resize())
            : null;
        this.resizeObserver?.observe(this.container);
        this.resizeObserver?.observe(this.radarWrap);
        this.updateUI();
        requestAnimationFrame(() => this.resize());
    }

    buildDOM() {
        this.container = document.createElement("div");
        this.container.className = "vnccs-camera-control";

        this.surface = document.createElement("div");
        this.surface.className = "vnccs-camera-surface";

        this.main = document.createElement("div");
        this.main.className = "vnccs-camera-main";

        this.radarWrap = document.createElement("div");
        this.radarWrap.className = "vnccs-camera-radar-wrap";

        this.canvas = document.createElement("canvas");
        this.canvas.className = "vnccs-camera-radar";
        this.canvas.setAttribute("aria-label", "Camera azimuth and distance radar");
        this.ctx = this.canvas.getContext("2d");
        this.radarWrap.appendChild(this.canvas);

        const elevationPanel = document.createElement("div");
        elevationPanel.className = "vnccs-camera-elevation";

        const elevationTitle = document.createElement("div");
        elevationTitle.className = "vnccs-camera-elevation-title";
        elevationTitle.textContent = "Height";

        this.elevationTrack = document.createElement("div");
        this.elevationTrack.className = "vnccs-camera-elevation-track";
        this.elevationTrack.setAttribute("aria-label", "Camera elevation");

        const elevationLine = document.createElement("div");
        elevationLine.className = "vnccs-camera-elevation-line";
        this.elevationTrack.appendChild(elevationLine);

        this.elevationButtons = new Map();
        [...ELEVATION_STEPS].reverse().forEach((elevation, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "vnccs-camera-elevation-step";
            button.dataset.elevation = String(elevation);
            button.style.top = `${8 + (index * 28)}%`;
            button.textContent = `${elevation}°`;
            button.title = `Elevation ${elevation}°`;
            this.elevationButtons.set(elevation, button);
            this.elevationTrack.appendChild(button);
        });

        elevationPanel.append(elevationTitle, this.elevationTrack);
        this.main.append(this.radarWrap, elevationPanel);

        this.footer = document.createElement("div");
        this.footer.className = "vnccs-camera-footer";

        this.readout = document.createElement("div");
        this.readout.className = "vnccs-camera-readout";

        const toggles = document.createElement("div");
        toggles.className = "vnccs-camera-toggles";

        const triggerLabel = document.createElement("label");
        triggerLabel.className = "vnccs-camera-check";
        this.triggerInput = document.createElement("input");
        this.triggerInput.type = "checkbox";
        triggerLabel.append(this.triggerInput, document.createTextNode("Trigger"));

        const randomLabel = document.createElement("label");
        randomLabel.className = "vnccs-camera-check";
        randomLabel.title = "Choose a new camera angle, height and distance for every queued generation";
        this.randomInput = document.createElement("input");
        this.randomInput.type = "checkbox";
        randomLabel.append(this.randomInput, document.createTextNode("Random"));

        toggles.append(triggerLabel, randomLabel);
        this.footer.append(this.readout, toggles);

        this.randomScope = document.createElement("div");
        this.randomScope.className = "vnccs-camera-random-scope";

        const randomScopeLabel = document.createElement("span");
        randomScopeLabel.className = "vnccs-camera-random-scope-label";
        randomScopeLabel.textContent = "Random angle";

        const randomScopeOptions = document.createElement("div");
        randomScopeOptions.className = "vnccs-camera-random-scope-options";
        this.randomScopeButtons = new Map();
        [
            ["full", "360°", "Randomize around the full 360 degrees"],
            ["front", "Front ±45°", "Randomize only front, front-left and front-right views"],
        ].forEach(([mode, label, title]) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "vnccs-camera-random-scope-btn";
            button.textContent = label;
            button.title = title;
            button.dataset.mode = mode;
            this.randomScopeButtons.set(mode, button);
            randomScopeOptions.appendChild(button);
        });

        this.randomScope.append(randomScopeLabel, randomScopeOptions);
        this.surface.append(this.main, this.footer, this.randomScope);
        this.container.appendChild(this.surface);
    }

    installEvents() {
        this.canvas.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            this.draggingRadar = true;
            this.canvas.setPointerCapture?.(event.pointerId);
            this.updateRadarFromPointer(event);
        });
        this.canvas.addEventListener("pointermove", (event) => {
            if (this.draggingRadar) this.updateRadarFromPointer(event);
        });
        const finishRadarDrag = (event) => {
            this.draggingRadar = false;
            if (this.canvas.hasPointerCapture?.(event.pointerId)) {
                this.canvas.releasePointerCapture(event.pointerId);
            }
        };
        this.canvas.addEventListener("pointerup", finishRadarDrag);
        this.canvas.addEventListener("pointercancel", finishRadarDrag);

        this.elevationTrack.addEventListener("pointerdown", (event) => {
            if (event.target?.closest?.("button")) return;
            event.preventDefault();
            this.draggingElevation = true;
            this.elevationTrack.setPointerCapture?.(event.pointerId);
            this.updateElevationFromPointer(event);
        });
        this.elevationTrack.addEventListener("pointermove", (event) => {
            if (this.draggingElevation) this.updateElevationFromPointer(event);
        });
        const finishElevationDrag = (event) => {
            this.draggingElevation = false;
            if (this.elevationTrack.hasPointerCapture?.(event.pointerId)) {
                this.elevationTrack.releasePointerCapture(event.pointerId);
            }
        };
        this.elevationTrack.addEventListener("pointerup", finishElevationDrag);
        this.elevationTrack.addEventListener("pointercancel", finishElevationDrag);

        for (const [elevation, button] of this.elevationButtons) {
            button.addEventListener("click", () => {
                this.state.elevation = elevation;
                this.commit();
            });
        }

        this.triggerInput.addEventListener("change", () => {
            this.state.include_trigger = this.triggerInput.checked;
            this.commit();
        });
        this.randomInput.addEventListener("change", () => {
            this.state.random = this.randomInput.checked;
            this.commit();
        });
        for (const [mode, button] of this.randomScopeButtons) {
            button.addEventListener("click", () => {
                this.state.random_azimuth_mode = mode;
                this.commit();
            });
        }
    }

    resize() {
        const rect = this.radarWrap.getBoundingClientRect();
        const cssWidth = Math.max(1, rect.width || 260);
        const cssHeight = Math.max(1, rect.height || 260);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
        const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

        if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
        if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;

        this.cssWidth = cssWidth;
        this.cssHeight = cssHeight;
        this.dpr = dpr;
        this.geometry = computeRadarGeometry(cssWidth, cssHeight);
        this.draw();
    }

    loadFromNode() {
        this.state = parseCameraState(findWidget(this.node, DATA_WIDGET_NAME)?.value);
        this.updateUI();
    }

    updateRadarFromPointer(event) {
        const rect = this.canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const point = {
            x: (event.clientX - rect.left) * (this.geometry.width / rect.width),
            y: (event.clientY - rect.top) * (this.geometry.height / rect.height),
        };
        this.state = cameraStateFromRadarPoint(this.state, point, this.geometry);
        this.commit();
    }

    updateElevationFromPointer(event) {
        const rect = this.elevationTrack.getBoundingClientRect();
        if (!rect.height) return;
        this.state.elevation = elevationFromRatio((event.clientY - rect.top) / rect.height);
        this.commit();
    }

    randomizeForQueue() {
        if (!this.state.random) return;
        this.state = randomizeCameraState(this.state);
        this.commit();
    }

    commit() {
        const dataWidget = findWidget(this.node, DATA_WIDGET_NAME);
        if (dataWidget) dataWidget.value = serializeCameraState(this.state);
        this.updateUI();
        this.node?.setDirtyCanvas?.(true, true);
    }

    updateUI() {
        this.triggerInput.checked = this.state.include_trigger;
        this.randomInput.checked = this.state.random;
        this.randomScope.classList.toggle("visible", this.state.random);
        this.randomScope.setAttribute("aria-hidden", this.state.random ? "false" : "true");
        for (const [mode, button] of this.randomScopeButtons) {
            const active = mode === this.state.random_azimuth_mode;
            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        }
        for (const [elevation, button] of this.elevationButtons) {
            const active = elevation === this.state.elevation;
            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        }

        const distanceLabel = this.state.distance === "close-up"
            ? "CLOSE"
            : this.state.distance === "medium shot" ? "MEDIUM" : "WIDE";
        this.readout.innerHTML = [
            `<strong>AZ</strong> ${this.state.azimuth}°`,
            `<strong>EL</strong> ${this.state.elevation}°`,
            `<strong>${distanceLabel}</strong>`,
        ].join(" · ");
        this.draw();
    }

    draw() {
        if (!this.ctx || !this.cssWidth || !this.cssHeight) return;
        const ctx = this.ctx;
        const { width, height, centerX, centerY, outerRadius, radii, size } = this.geometry;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const background = ctx.createRadialGradient(
            centerX,
            centerY,
            0,
            centerX,
            centerY,
            outerRadius * 1.2,
        );
        background.addColorStop(0, "rgba(30, 24, 40, 0.54)");
        background.addColorStop(1, "rgba(8, 8, 13, 0.96)");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);

        ctx.save();
        ctx.translate(centerX, centerY);

        if (this.state.random && this.state.random_azimuth_mode === "front") {
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, outerRadius, Math.PI / 4, Math.PI * 3 / 4);
            ctx.closePath();
            ctx.fillStyle = "rgba(255, 143, 163, 0.055)";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 143, 163, 0.22)";
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        ctx.strokeStyle = "rgba(255, 255, 255, 0.105)";
        ctx.lineWidth = 1;
        for (const distance of DISTANCE_OPTIONS) {
            ctx.beginPath();
            ctx.arc(0, 0, radii[distance], 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.beginPath();
        for (let angle = 0; angle < 360; angle += 45) {
            const radians = angle * Math.PI / 180;
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(radians) * outerRadius, Math.sin(radians) * outerRadius);
        }
        ctx.strokeStyle = "rgba(255, 255, 255, 0.075)";
        ctx.stroke();

        ctx.fillStyle = "rgba(232, 232, 240, 0.28)";
        ctx.font = `800 ${Math.max(7, size * 0.034)}px 'Sora', sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("FRONT", 0, outerRadius * 0.72);

        ctx.strokeStyle = "rgba(232, 232, 240, 0.24)";
        ctx.lineWidth = Math.max(1.5, size * 0.008);
        ctx.beginPath();
        ctx.moveTo(0, outerRadius * 0.93);
        ctx.lineTo(0, outerRadius * 0.79);
        ctx.moveTo(0, outerRadius * 0.79);
        ctx.lineTo(-size * 0.018, outerRadius * 0.83);
        ctx.moveTo(0, outerRadius * 0.79);
        ctx.lineTo(size * 0.018, outerRadius * 0.83);
        ctx.stroke();

        const subjectSize = Math.max(7, size * 0.034);
        ctx.fillStyle = "#b8a9e8";
        ctx.shadowColor = "rgba(184, 169, 232, 0.48)";
        ctx.shadowBlur = size * 0.035;
        ctx.fillRect(-subjectSize / 2, -subjectSize / 2, subjectSize, subjectSize);
        ctx.shadowBlur = 0;

        const radius = radii[this.state.distance];
        const cameraAngle = (Math.PI / 2) - (this.state.azimuth * Math.PI / 180);
        const cameraX = radius * Math.cos(cameraAngle);
        const cameraY = radius * Math.sin(cameraAngle);
        const triangleSize = Math.max(7, size * 0.034);

        ctx.translate(cameraX, cameraY);
        ctx.rotate(cameraAngle + Math.PI / 2);
        ctx.fillStyle = "#ff8fa3";
        ctx.strokeStyle = "#2a1420";
        ctx.lineWidth = Math.max(1, size * 0.006);
        ctx.shadowColor = "rgba(255, 143, 163, 0.58)";
        ctx.shadowBlur = size * 0.045;
        ctx.beginPath();
        ctx.moveTo(0, triangleSize);
        ctx.lineTo(-triangleSize * 0.72, -triangleSize * 0.7);
        ctx.lineTo(triangleSize * 0.72, -triangleSize * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.stroke();
        ctx.restore();
    }

    dispose() {
        this.resizeObserver?.disconnect();
    }
}

app.registerExtension({
    name: "VNCCS.VisualCameraControl",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "VNCCS_VisualPositionControl") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            this.setSize([380, 420]);
            const dataWidget = hideDataWidget(this);

            this.cameraWidget = new VNCCSCameraWidget(this);
            this.cameraDOMWidget = this.addDOMWidget(
                DOM_WIDGET_NAME,
                "ui",
                this.cameraWidget.container,
                { serialize: false, hideOnZoom: false },
            );

            if (dataWidget) {
                const previousBeforeQueued = dataWidget.beforeQueued;
                dataWidget.beforeQueued = (...args) => {
                    previousBeforeQueued?.apply(dataWidget, args);
                    this.cameraWidget?.randomizeForQueue();
                };
            }

            this.cameraWidget.commit();
            syncDOMWidgetWidth(this);
            setTimeout(() => {
                syncDOMWidgetWidth(this);
                this.cameraWidget?.resize();
            }, 50);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            hideDataWidget(this);
            setTimeout(() => {
                if (!this.cameraWidget) return;
                syncDOMWidgetWidth(this);
                this.cameraWidget.loadFromNode();
                this.cameraWidget.resize();
            }, 100);
        };

        nodeType.prototype.onResize = function () {
            syncDOMWidgetWidth(this);
            clearTimeout(this._vnccsCameraResizeTimer);
            this._vnccsCameraResizeTimer = setTimeout(() => {
                syncDOMWidgetWidth(this);
                this.cameraWidget?.resize();
            }, 50);
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            clearTimeout(this._vnccsCameraResizeTimer);
            this.cameraWidget?.dispose();
            onRemoved?.apply(this, arguments);
        };
    },
});
