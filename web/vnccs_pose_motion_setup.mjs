// Text-to-motion model cards and setup: helps the user pick a model and install what it needs.
//
// Python packages are installed through ComfyUI-Manager (the same server API the VNCCS Control
// Center uses for its dependencies), then ComfyUI is restarted through Manager. Pose Studio never
// changes Manager's security settings: when Manager refuses, the card says exactly what to change.
// Code checkouts and gated logins stay manual steps with a command to copy, because Manager's git
// install would also run the model repository's pinned requirements.txt.

export const MOTION_SETUP_API = "/vnccs/pose_studio/motion/setup";

const PIP_ROUTES = ["/customnode/install/pip", "/v2/customnode/install/pip"];
const REBOOT_ROUTES = ["/manager/reboot", "/v2/manager/reboot"];

/** Setup progress of a model from the models endpoint. */
export function modelReadiness(model) {
    const steps = Array.isArray(model?.setup) ? model.setup : [];
    const checked = steps.filter((step) => step.done !== null && step.done !== undefined);
    return {
        ready: model?.available !== false,
        done: checked.filter((step) => step.done).length,
        total: checked.length,
        pendingPip: steps.filter((step) => step.kind === "pip" && step.done === false),
    };
}

export function modelOptionLabel(model) {
    if (!model) return "";
    return `${model.name} · ${model.available === false ? "needs setup" : "ready"}`;
}

/** Short facts that tell models apart: start pose, length, memory, download, setup effort. */
export function modelFacts(model) {
    if (!model) return [];
    const caps = model.capabilities || {};
    const facts = [caps.start_pose_constraint ? "Starts from your pose" : "Applied on top of your pose"];
    if (model.runner === "worker") facts.push(`Isolated worker${model.worker ? ` "${model.worker}"` : ""}`);
    const maxSeconds = Number(caps.duration?.max);
    if (maxSeconds > 0) facts.push(`Up to ${Number(maxSeconds.toFixed(1))} s`);
    const vram = Number(model.requirements?.vram_gb);
    if (vram > 0) facts.push(`~${vram} GB VRAM`);
    const download = Number(model.guide?.download_gb);
    if (download > 0) facts.push(`~${download} GB download`);
    return facts;
}

export function manualPipCommand(packages) {
    return `python -m pip install ${packages.join(" ")}`;
}

async function readError(response) {
    try {
        const text = await response.text();
        try {
            const data = JSON.parse(text);
            return { flag: typeof data?.error === "string" ? data.error : "", text };
        } catch {
            return { flag: "", text };
        }
    } catch {
        return { flag: "", text: "" };
    }
}

/**
 * Explain why ComfyUI-Manager refused an install, with the exact change the user can make.
 * `policy` is the read-only policy from the setup endpoint (may be null).
 */
export function describeManagerDenial({ status, flag }, policy = null, packages = []) {
    const manual = packages.length ? ` Or install it yourself in ComfyUI's Python: ${manualPipCommand(packages)}` : "";
    if (status === 404) {
        return `ComfyUI-Manager is not installed, so Pose Studio cannot install packages for you.${manual}`;
    }
    if (flag === "comfyui_outdated") {
        return `ComfyUI-Manager needs a newer ComfyUI for installs. Update ComfyUI and try again.${manual}`;
    }
    if (flag === "allow_pip_install") {
        const where = policy?.config_path ? ` in ${policy.config_path}` : " in ComfyUI-Manager's config.ini";
        const listen = policy?.listener_is_loopback === false
            ? ` ComfyUI must also listen on 127.0.0.1 (it listens on ${policy.listener}).`
            : "";
        return `ComfyUI-Manager only installs pip packages when you allow it: stop ComfyUI, add "allow_pip_install = true" under [default]${where}, and start ComfyUI again.${listen}${manual}`;
    }
    const level = policy?.security_level ? ` (now "${policy.security_level}")` : "";
    return `ComfyUI-Manager's security_level${level} does not allow pip installs. This version of Manager needs security_level = normal- or weak in its config.ini.${manual}`;
}

/** Queue a pip install with ComfyUI-Manager. Returns `{ ok }` or `{ ok: false, status, flag }`. */
export async function installPipPackages(fetchApi, packages) {
    const joined = packages.join(" ");
    let last = { ok: false, status: 404, flag: "" };
    for (const route of PIP_ROUTES) {
        // Current Manager reads a JSON body; older versions read the package list as plain text.
        for (const body of [JSON.stringify({ packages: joined }), joined]) {
            const response = await fetchApi(route, {
                method: "POST",
                headers: { "Content-Type": body === joined ? "text/plain" : "application/json" },
                body,
            });
            if (response.ok) return { ok: true };
            if (response.status === 404 || response.status === 405) {
                last = { ok: false, status: 404, flag: "" };
                break;
            }
            const { flag, text } = await readError(response);
            last = { ok: false, status: response.status, flag, text };
            if (response.status !== 400) return last;
        }
    }
    return last;
}

/** Restart ComfyUI through ComfyUI-Manager. Resolves true when the restart was accepted. */
export async function restartComfyUI(fetchApi) {
    for (const route of REBOOT_ROUTES) {
        try {
            const response = await fetchApi(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
            if (response.status === 404 || response.status === 405) continue;
            return response.ok;
        } catch {
            // A successful reboot can drop the connection before the response arrives.
            return true;
        }
    }
    return false;
}

/** Wait until the server went away (or a few probes passed) and answers again. */
export async function waitForServer(probe, { interval = 1500, attempts = 80, sleep = null } = {}) {
    const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let sawDown = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        await wait(interval);
        try {
            const ok = await probe();
            if (ok && (sawDown || attempt >= 6)) return true;
            if (!ok) sawDown = true;
        } catch {
            sawDown = true;
        }
    }
    return false;
}

export const SETUP_STYLES = `
.vnccs-ps-t2m-card { display: flex; flex-direction: column; gap: 5px; padding: 8px; border-radius: 8px;
    background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); line-height: 1.35; }
.vnccs-ps-t2m-card-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vnccs-ps-t2m-badge { padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; }
.vnccs-ps-t2m-badge.is-ready { background: rgba(46, 213, 115, 0.18); color: #2ed573; }
.vnccs-ps-t2m-badge.is-setup { background: rgba(255, 170, 0, 0.18); color: var(--ps-warning, #ffaa00); }
.vnccs-ps-t2m-facts { display: flex; flex-wrap: wrap; gap: 4px; }
.vnccs-ps-t2m-fact { padding: 1px 6px; border-radius: 6px; background: rgba(255, 255, 255, 0.07); font-size: 10px; opacity: 0.85; }
.vnccs-ps-t2m-muted { opacity: 0.7; }
.vnccs-ps-t2m-steps { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.vnccs-ps-t2m-step { display: grid; grid-template-columns: 16px 1fr auto; gap: 6px; align-items: start; }
.vnccs-ps-t2m-step-mark { text-align: center; font-weight: 700; }
.vnccs-ps-t2m-step.is-done .vnccs-ps-t2m-step-mark { color: #2ed573; }
.vnccs-ps-t2m-step.is-todo .vnccs-ps-t2m-step-mark { color: var(--ps-warning, #ffaa00); }
.vnccs-ps-t2m-step small { display: block; opacity: 0.65; }
.vnccs-ps-t2m-step code { display: block; margin-top: 2px; padding: 2px 4px; border-radius: 4px; background: rgba(0, 0, 0, 0.35);
    font-size: 10px; white-space: pre-wrap; word-break: break-all; }
.vnccs-ps-t2m-step-actions { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.vnccs-ps-t2m-step-actions .vnccs-ps-btn, .vnccs-ps-t2m-setup-actions .vnccs-ps-btn { padding: 2px 8px; font-size: 10px; }
.vnccs-ps-t2m-setup-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.vnccs-ps-t2m-setup-msg { white-space: pre-wrap; }
.vnccs-ps-t2m-setup-msg.is-error { color: var(--ps-error, #ff4757); }
.vnccs-ps-t2m-card a { color: inherit; }
`;

/**
 * The card for one model: what it is good at, its facts and, until it is ready, its setup steps.
 * `actions` = { installPip(step, button), installAll(steps, button), download(step, button),
 *               copy(text, button), restart(button), recheck(button) }.
 */
export function renderModelCard(doc, model, actions, { message = "", error = false, restartPending = false } = {}) {
    const el = (tag, className = "", text = "") => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    };
    const button = (text, onClick, title = "") => {
        const node = el("button", "vnccs-ps-btn", text);
        node.type = "button";
        if (title) node.title = title;
        node.addEventListener("click", () => onClick(node));
        return node;
    };
    const card = el("div", "vnccs-ps-t2m-card");
    if (!model) return card;
    const readiness = modelReadiness(model);
    const guide = model.guide || {};

    const head = el("div", "vnccs-ps-t2m-card-head");
    head.append(el("strong", "", model.name));
    head.append(el("span", `vnccs-ps-t2m-badge ${readiness.ready ? "is-ready" : "is-setup"}`,
        readiness.ready ? "Ready" : readiness.total ? `Setup ${readiness.done}/${readiness.total}` : "Needs setup"));
    card.append(head);
    if (guide.summary || model.description) card.append(el("div", "", guide.summary || model.description));
    const facts = el("div", "vnccs-ps-t2m-facts");
    for (const fact of modelFacts(model)) facts.append(el("span", "vnccs-ps-t2m-fact", fact));
    card.append(facts);
    if (guide.best_for) card.append(el("div", "vnccs-ps-t2m-muted", `Good for: ${guide.best_for}`));

    if (!readiness.ready) {
        if (guide.setup_effort) card.append(el("div", "vnccs-ps-t2m-muted", `Setup: ${guide.setup_effort}`));
        const list = el("div", "vnccs-ps-t2m-steps");
        for (const step of model.setup || []) {
            const state = step.done === true ? "is-done" : step.done === false ? "is-todo" : "is-info";
            const row = el("div", `vnccs-ps-t2m-step ${state}`);
            row.dataset.step = step.id;
            const mark = el("span", "vnccs-ps-t2m-step-mark", step.done === true ? "✓" : step.done === false ? "○" : "•");
            const body = el("div");
            body.append(el("span", "", step.label));
            if (step.detail) body.append(el("small", "", step.detail));
            const command = step.kind === "pip" ? manualPipCommand(step.packages || []) : step.command;
            if (command && step.kind !== "pip" && step.done !== true) body.append(el("code", "", command));
            const buttons = el("div", "vnccs-ps-t2m-step-actions");
            if (step.done !== true) {
                if (step.kind === "pip") buttons.append(button("Install", (node) => actions.installPip(step, node), `Install with ComfyUI-Manager: ${(step.packages || []).join(" ")}`));
                if (step.kind === "download") buttons.append(button("Download", (node) => actions.download(step, node)));
                if (command && step.kind !== "pip") buttons.append(button("Copy", (node) => actions.copy(command, node), "Copy the command"));
                if (step.link) {
                    const link = el("a", "vnccs-ps-btn", "Open");
                    link.href = step.link;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    buttons.append(link);
                }
            }
            row.append(mark, body, buttons);
            list.append(row);
        }
        card.append(list);

        const footer = el("div", "vnccs-ps-t2m-setup-actions");
        if (readiness.pendingPip.length > 1) {
            footer.append(button("Install all packages", (node) => actions.installAll(readiness.pendingPip, node)));
        }
        if (restartPending) {
            const restart = button("Restart ComfyUI", (node) => actions.restart(node), "Restart through ComfyUI-Manager to finish the installation");
            restart.classList.add("primary");
            footer.append(restart);
        }
        footer.append(button("Check again", (node) => actions.recheck(node), "Look for the installed parts again"));
        card.append(footer);
    }
    const note = el("div", `vnccs-ps-t2m-setup-msg${error ? " is-error" : ""}`, message);
    note.style.display = message ? "" : "none";
    card.append(note);
    return card;
}
