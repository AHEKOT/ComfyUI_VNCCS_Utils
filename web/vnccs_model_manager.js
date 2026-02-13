import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Global Registry Cache to prevent API storms (multiple nodes requesting same data)
window.VNCCS_REGISTRY = window.VNCCS_REGISTRY || {};
window.VNCCS_FETCH_PROMISES = window.VNCCS_FETCH_PROMISES || {};

class VNCCS_ModelListWidget {
    constructor(node, container) {
        this.node = node;
        this.container = container;
        this.models = [];
        this.loading = false;
        this.downloadStatuses = {}; // Store status from server
        this.pollingInterval = null;
        this.downloadStartTimes = {}; // Local logic for fake progress

        // Styles
        this.styleContainer();

        // Start polling for status periodically
        this.startPolling();
    }

    styleContainer() {
        this.container.style.display = "flex";
        this.container.style.flexDirection = "column";
        this.container.style.gap = "0px";
        this.container.style.padding = "0px";
        this.container.style.backgroundColor = "#222";
        this.container.style.overflowY = "hidden"; // Main container non-scroll
        this.container.style.height = "100%";
        this.container.style.fontFamily = "sans-serif";
        this.container.style.position = "relative"; // Ensure we can place overlays

        // 0. Header Area
        this.header = document.createElement("div");
        this.header.style.cssText = `
            padding: 8px 10px;
            background: #1a1a1a;
            border-bottom: 2px solid #333;
            color: #ccc;
            font-size: 12px;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;

        this.statusText = document.createElement("span");
        this.statusText.innerText = "Status: Unknown";
        this.header.appendChild(this.statusText);

        // Add Settings Cog
        const settingsBtn = document.createElement("div");
        settingsBtn.innerHTML = "⚙️";
        settingsBtn.style.cssText = "cursor: pointer; font-size: 16px; transition: opacity 0.2s; opacity: 0.7;";
        settingsBtn.title = "Manage API Tokens";
        settingsBtn.onmouseover = () => settingsBtn.style.opacity = "1";
        settingsBtn.onmouseout = () => settingsBtn.style.opacity = "0.7";
        settingsBtn.onclick = () => this.showApiKeyDialog();

        this.header.appendChild(settingsBtn);
        this.container.appendChild(this.header);

        // 1. List Area (Scrollable)
        this.listArea = document.createElement("div");
        this.listArea.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        `;
        this.listArea.innerHTML = `<div style="color: #888; text-align: center; margin-top: 20px;">Click 'Check Models' to load list</div>`;
        this.container.appendChild(this.listArea);

        // 2. Footer Area (Sticky Bottom)
        this.footer = document.createElement("div");
        this.footer.style.cssText = `
            padding: 10px;
            background: #1a1a1a;
            border-top: 1px solid #333;
            display: flex;
            justify-content: center;
        `;

        const downloadAllBtn = document.createElement("button");
        downloadAllBtn.textContent = "Download All Missing/Updates";
        downloadAllBtn.className = "vnccs-btn-all";
        downloadAllBtn.style.cssText = `
            background: #44a; 
            color: white; 
            border: none; 
            border-radius: 4px; 
            padding: 8px 16px; 
            cursor: pointer;
            font-weight: bold;
            font-size: 12px;
            width: 100%;
        `;
        downloadAllBtn.onclick = () => this.downloadAll();

        this.footer.appendChild(downloadAllBtn);
        this.container.appendChild(this.footer);
    }

    async downloadAll() {
        if (this.models.length === 0) return;

        // Stop any existing queue
        this.downloadQueue = [];
        this.isProcessingQueue = false;

        const tasks = [];
        Array.from(this.listArea.children).forEach(child => {
            const modelName = child.dataset.modelName;
            if (!modelName) return;

            const versionSelect = child.querySelector("select");
            const btn = child.querySelector("button");
            const btnText = btn.textContent;

            if (btnText === "Download" || btnText === "Switch/Update" || btnText === "Retry") {
                tasks.push({ name: modelName, version: versionSelect.value });
            }
        });

        if (tasks.length === 0) {
            this.showMessage("All models are up-to-date with current selections.");
            return;
        }

        this.showConfirm(`Start downloading ${tasks.length} models?`, () => {
            // 1. Mark all as queued visually
            this.downloadQueue = tasks;
            for (const task of tasks) {
                // Only mark manually if not already downloading
                const s = this.downloadStatuses[task.name];
                if (!s || s.status !== "downloading") {
                    this.downloadStatuses[task.name] = { status: "queued", message: "Waiting in queue..." };
                }
            }
            this.renderList();

            // 2. Start Processing
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        try {
            while (this.downloadQueue.length > 0) {
                const task = this.downloadQueue.shift(); // Get next

                // Double check if we should still download (maybe state changed?)
                // e.g. user manually clicked retry on it?

                // Start download
                await this.downloadModel(this.node.widgets[0].value, task.name, task.version);

                // Wait for completion with timeout
                try {
                    await this.waitForCompletion(task.name, 900000); // 15 min timeout per model
                } catch (e) {
                    console.error("Download timeout or error:", e);
                    this.downloadStatuses[task.name] = { status: "error", message: "Timed out / Error" };
                    this.renderList();
                    // Continue to next...
                }

                // Short rest
                await new Promise(r => setTimeout(r, 1000));
            }
        } finally {
            this.isProcessingQueue = false;
            // Clear any lingering "queued" statuses if we stopped early? 
            // If queue empty, we are fine.
        }
    }

    async waitForCompletion(modelName, timeoutMs = 600000) {
        const start = Date.now();
        return new Promise((resolve, reject) => {
            const check = () => {
                const s = this.downloadStatuses[modelName];

                if (Date.now() - start > timeoutMs) {
                    reject(new Error("Timeout"));
                    return;
                }

                // If status is success or error, we are done
                if (s && (s.status === "success" || s.status === "error")) {
                    resolve();
                } else if (!s) {
                    // Status disappeared? treat as error
                    reject(new Error("Status lost"));
                } else {
                    // Still downloading... check again in 2s
                    setTimeout(check, 2000);
                }
            };
            check();
        });
    }

    async fetchModels(repoId, force = false) {
        this.loading = true;

        if (force) {
            // Clear cache for this repo to ensure no stale data survives
            delete window.VNCCS_REGISTRY[repoId];
            const cacheKey = `vnccs_cache_${repoId}`;
            localStorage.removeItem(cacheKey);
        }

        if (!force && window.VNCCS_REGISTRY[repoId]) {
            this.models = window.VNCCS_REGISTRY[repoId];
            this.renderList();
        } else if (force || this.models.length === 0) {
            this.renderLoading();
        }

        // Debounce: if a fetch for this repo is already in flight, reuse it
        // UNLESS force is true, then we want a fresh network call
        if (!force && window.VNCCS_FETCH_PROMISES[repoId]) {
            try {
                const data = await window.VNCCS_FETCH_PROMISES[repoId];
                this.models = Array.isArray(data) ? data : (data.models || []);
                this.renderList();
                return;
            } catch (e) {
                // fall through to retry if previous failed
            }
        }

        // 2. Network Fetch in background
        const fetchPromise = (async () => {
            try {
                const url = `/vnccs/manager/check?repo_id=${encodeURIComponent(repoId)}${force ? '&force_refresh=true' : ''}`;
                const response = await api.fetchApi(url);
                const data = await response.json();

                if (!data.error) {
                    const models = Array.isArray(data) ? data : (data.models || []);
                    window.VNCCS_REGISTRY[repoId] = models;
                    return models;
                }
                throw new Error(data.error);
            } finally {
                delete window.VNCCS_FETCH_PROMISES[repoId];
            }
        })();

        window.VNCCS_FETCH_PROMISES[repoId] = fetchPromise;

        try {
            const models = await fetchPromise;
            this.models = models;
            const cacheKey = `vnccs_cache_${repoId}`;
            localStorage.setItem(cacheKey, JSON.stringify(this.models));

            await this.updateStatuses();
            this.renderList();

            // Notify others (Selectors) that fresh data with active versions is here
            // Pass data in detail to avoid extra fetches
            window.dispatchEvent(new CustomEvent("vnccs-registry-updated", {
                detail: { repo_id: repoId, models: this.models }
            }));
        } catch (e) {
            if (this.models.length === 0) this.renderError(e.message);
        } finally {
            this.loading = false;
        }
    }

    startPolling() {
        if (this.pollingInterval) clearInterval(this.pollingInterval);
        this.pollingInterval = setInterval(() => this.updateStatuses(), 2000);
    }

    showApiKeyDialog(modelName, repoId, version) {
        // Create an overlay (simple div over the listArea)
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: absolute; top:0; left:0; width:100%; height:100%; 
            background: rgba(0,0,0,0.85); z-index: 100;
            display: flex; flex-direction: column; justify-content: center; align-items: center;
            padding: 20px; box-sizing: border-box; text-align: center;
        `;

        const dialog = document.createElement("div");
        dialog.style.cssText = `
            background: #2a2a2a; border: 1px solid #555; border-radius: 8px; 
            padding: 15px; width: 100%; max-width: 350px;
            display: flex; flex-direction: column; gap: 10px;
        `;

        dialog.innerHTML = `
            <h3 style="margin:0 0 5px 0; color: #fff;">VNCCS Settings</h3>
            <p style="margin:0; font-size: 11px; color: #ccc; line-height: 1.4;">
                Provide tokens to enable faster downloads and higher rate limits.
            </p>
            
            <div style="text-align: left;">
                <label style="font-size: 11px; color: #aaa; display: block; margin-bottom: 2px;">Civitai API Key</label>
                <input type="password" id="civitai-api-key" placeholder="Paste Civitai Key here..." style="
                    background: #111; border: 1px solid #444; color: #fff; padding: 6px; border-radius: 4px; width: 100%; font-size: 11px;
                ">
                <a href="https://civitai.com/user/account" target="_blank" style="color: #6cf; font-size: 10px;">Get Civitai Key</a>
            </div>

            <div style="text-align: left; margin-top: 5px;">
                <label style="font-size: 11px; color: #aaa; display: block; margin-bottom: 2px;">Hugging Face Token</label>
                <input type="password" id="hf-token" placeholder="Paste HF Token here..." style="
                    background: #111; border: 1px solid #444; color: #fff; padding: 6px; border-radius: 4px; width: 100%; font-size: 11px;
                ">
                <a href="https://huggingface.co/settings/tokens" target="_blank" style="color: #6cf; font-size: 10px;">Get HF Token</a>
            </div>

            <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 5px;">
                <button id="cancel-key-btn" style="background: #444; border:none; color:white; padding: 5px 10px; border-radius:4px; cursor:pointer;">Cancel</button>
                <button id="save-key-btn" style="background: #4a4; border:none; color:white; padding: 5px 10px; border-radius:4px; cursor:pointer; font-weight:bold;">Save Changes</button>
            </div>
        `;

        overlay.appendChild(dialog);
        this.container.appendChild(overlay);

        // Event Listeners
        const civitaiInput = dialog.querySelector("#civitai-api-key");
        const hfInput = dialog.querySelector("#hf-token");
        const cancelBtn = dialog.querySelector("#cancel-key-btn");
        const saveBtn = dialog.querySelector("#save-key-btn");

        // Try to load current tokens from local storage or wait for next fetch?
        // Actually, better to just let user paste. If we want pre-fill, we'd need another API endpoint.
        // For now, let's keep it simple. User pastes, we save.

        cancelBtn.onclick = () => {
            this.container.removeChild(overlay);
        };

        saveBtn.onclick = async () => {
            const civitaiToken = civitaiInput.value.trim();
            const hfToken = hfInput.value.trim();

            const payload = {};
            if (civitaiToken) payload.civitai_token = civitaiToken;
            if (hfToken) payload.hf_token = hfToken;

            if (Object.keys(payload).length === 0) {
                this.showMessage("Please enter at least one token.", true);
                return;
            }

            // Send to backend
            try {
                const response = await api.fetchApi("/vnccs/manager/save_token", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });

                if (response.ok) {
                    // Close dialog
                    this.container.removeChild(overlay);
                    // Retry download if we were triggered by one
                    if (modelName && repoId && version) {
                        this.downloadModel(repoId, modelName, version);
                    }
                } else {
                    this.showMessage("Failed to save tokens on server.", true);
                }
            } catch (e) {
                this.showMessage("Failed to save tokens: " + e.message, true);
            }
        };
    }

    async updateStatuses() {
        try {
            const response = await api.fetchApi("/vnccs/manager/status");
            if (response.ok) {
                const newStatuses = await response.json();

                // Track transitions to "success" to trigger registry refresh (updates disk status in all nodes)
                let needsRefresh = false;
                for (const name in newStatuses) {
                    const s = newStatuses[name];
                    const oldS = this.downloadStatuses[name];
                    if (s && s.status === "success" && (!oldS || oldS.status !== "success")) {
                        needsRefresh = true;
                        break;
                    }
                }

                this.downloadStatuses = newStatuses;

                if (needsRefresh) {
                    const repoWidget = this.node.widgets?.find(w => w.name === "repo_id");
                    if (repoWidget && repoWidget.value) {
                        this.fetchModels(repoWidget.value);
                    }
                } else if (this.models.length > 0) {
                    this.renderList();
                }
            }
        } catch (e) { }
    }

    async downloadModel(repoId, modelName, version) {
        try {
            // Optimistic update
            this.downloadStatuses[modelName] = { status: "downloading", message: `Requesting v${version}...` };
            this.downloadStartTimes[modelName] = Date.now();
            this.renderList(); // Initial render to start animation

            const response = await api.fetchApi("/vnccs/manager/download", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo_id: repoId,
                    model_name: modelName,
                    version: version // Send selected version
                })
            });

            if (response.ok) {
                // Polling will handle the rest
                this.updateStatuses();
                window.dispatchEvent(new CustomEvent("vnccs-registry-updated"));
            } else {
                this.downloadStatuses[modelName] = { status: "error", message: "Request failed" };
                this.renderList();
            }

        } catch (e) {
            this.downloadStatuses[modelName] = { status: "error", message: e.message };
            this.renderList();
        }
    }

    renderLoading() {
        this.listArea.innerHTML = `<div style="color: #aaa; text-align: center; margin-top: 20px;">Loading models info...</div>`;
    }

    renderError(msg) {
        this.listArea.innerHTML = `<div style="color: #ff5555; text-align: center; margin-top: 20px;">Error: ${msg}</div>`;
    }

    renderList() {
        if (this.models.length === 0) {
            this.listArea.innerHTML = `<div style="color: #888; text-align: center;">No models found in config.</div>`;
            return;
        }

        const repoId = this.node.widgets[0].value;

        let totalModels = 0;
        let installedCount = 0;
        let hasUpdates = false;

        // Identify existing items to preserve them
        const existingItems = {};
        Array.from(this.listArea.children).forEach(child => {
            if (child.dataset.modelName) {
                existingItems[child.dataset.modelName] = child;
            } else {
                // Clear Loading models info... or Error messages if we are about to render real models
                child.remove();
            }
        });

        this.models.forEach((model, index) => {
            // New Backend API: active_version (string), installed_versions (array)
            const activeVer = model.active_version;
            const installedList = model.installed_versions || [];

            // Stats Calculation
            totalModels++;
            if (installedList.length > 0) {
                installedCount++;
                // Check if active version matches latest available 
                if (model.versions && model.versions.length > 0) {
                    // We only care if the LATEST version is physically present in the installed list
                    const cleanLatest = String(model.versions[0].version).replace(/^v/, '').trim();
                    const isLatestInstalled = installedList.some(v =>
                        String(v).replace(/^v/, '').trim() === cleanLatest
                    );

                    if (!isLatestInstalled) {
                        hasUpdates = true;
                    }
                }
            }

            const dynStatus = this.downloadStatuses[model.name];

            // Get or Create Item
            let item = existingItems[model.name];
            let versionSelect, btn, statusLabel, bgLayer;

            if (!item) {
                item = document.createElement("div");
                item.dataset.modelName = model.name;
                item.style.cssText = `
                    background: #333;
                    border: 1px solid #444;
                    border-radius: 8px;
                    padding: 8px;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    margin-bottom: 5px;
                    position: relative;
                    overflow: hidden; 
                    flex-shrink: 0;
                `;

                // Background layer for progress
                bgLayer = document.createElement("div");
                bgLayer.className = "progress-bg";
                bgLayer.style.cssText = "position: absolute; top:0; left:0; height:100%; width: 0%; background: rgba(40, 100, 40, 0.5); z-index: 0; transition: width 0.5s linear;";
                item.appendChild(bgLayer);

                // Content Wrapper
                const content = document.createElement("div");
                content.style.position = "relative";
                content.style.zIndex = "1";

                // Top Row
                const topRow = document.createElement("div");
                topRow.style.display = "flex";
                topRow.style.justifyContent = "space-between";
                topRow.innerHTML = `<span style="font-weight: bold; color: #eee; font-size: 13px;">${model.name}</span>`;
                statusLabel = document.createElement("span");
                statusLabel.style.fontSize = "11px";
                topRow.appendChild(statusLabel);
                content.appendChild(topRow);

                // Desc Row
                content.innerHTML += `<div style="font-size: 10px; color: #bbb;">${model.description || ""}</div>`;

                // Controls Row
                const controlsRow = document.createElement("div");
                controlsRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-top: 4px; flex-wrap: nowrap;";

                versionSelect = document.createElement("select");
                // flex: 0 1 auto to prevent growing, width auto to fit content
                versionSelect.style.cssText = "background: #222; color: #ddd; border: 1px solid #555; border-radius: 4px; font-size: 11px; padding: 2px; flex: 0 1 auto; width: auto; margin-right: 8px; max-width: 200px;";
                controlsRow.appendChild(versionSelect);

                btn = document.createElement("button");
                btn.className = "vnccs-btn";
                // Explicit width: auto and no flex grow
                btn.style.cssText = "border: none; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 11px; font-weight: bold; color: white; flex: 0 0 auto; width: auto;";
                controlsRow.appendChild(btn);
                content.appendChild(controlsRow);

                item.appendChild(content);
                this.listArea.appendChild(item);

                // Bind generic events once
                // Note: We re-bind onclick every render to capture closure scope if needed, 
                // but better is to read from Select DOM.
            } else {
                // Re-select elements
                bgLayer = item.querySelector(".progress-bg");
                statusLabel = item.querySelector("span:last-child"); // slightly fragile selector
                if (!statusLabel || statusLabel.parentElement.parentElement.parentElement !== item) {
                    // Fallback check if structure matches
                    statusLabel = item.children[1].children[0].children[1];
                }
                versionSelect = item.querySelector("select");
                btn = item.querySelector("button");
            }

            // Always update Options (in case versions changed?) - optimize later if slow
            // Check if options need update. Simple check: count
            if (versionSelect.options.length !== model.versions.length) {
                // Save current selection if possible
                const currentVal = versionSelect.value;
                versionSelect.innerHTML = "";
                model.versions.forEach((v, idx) => {
                    const opt = document.createElement("option");
                    opt.value = v.version;
                    opt.textContent = `v${v.version}`;

                    // Logic to visually indicate installed versions in the dropdown?
                    if (installedList.includes(v.version)) {
                        opt.textContent += (v.version === activeVer) ? " (Active)" : " (Installed)";
                        opt.style.color = "#8f8";
                    }

                    if (idx === 0) opt.selected = true;
                    versionSelect.appendChild(opt);
                });
                // Restore selection if it still exists
                if (currentVal && Array.from(versionSelect.options).some(o => o.value === currentVal)) {
                    versionSelect.value = currentVal;
                } else if (activeVer && Array.from(versionSelect.options).some(o => o.value === activeVer)) {
                    // Default to active version if current is invalid
                    versionSelect.value = activeVer;
                }
            }

            // --- Update State & Styling ---
            const updateState = () => {
                const selVer = versionSelect.value;
                const isDownloading = dynStatus && dynStatus.status === "downloading";
                const isError = dynStatus && dynStatus.status === "error";
                const isAuthRequired = dynStatus && dynStatus.status === "auth_required";
                const isSuccess = dynStatus && dynStatus.status === "success";
                const isQueued = dynStatus && dynStatus.status === "queued";

                // 1. Transient High Priority States (Downloading, Queued, Auth)
                if (isDownloading) {
                    let progress = 0;
                    let msg = dynStatus.message || "Downloading";
                    if (dynStatus.progress !== undefined) {
                        progress = dynStatus.progress;
                    } else {
                        const startTime = this.downloadStartTimes[model.name] || Date.now();
                        const elapsed = Date.now() - startTime;
                        progress = Math.min((elapsed / 30000) * 100, 95);
                    }
                    bgLayer.style.width = `${progress}%`;
                    bgLayer.style.transition = "width 0.2s linear";
                    bgLayer.style.background = "rgba(40, 100, 40, 0.5)";
                    statusLabel.innerHTML = `<span style="color: #ccf; font-family: monospace;">⬇ ${msg}</span>`;
                    item.style.borderColor = "#44a";
                    btn.textContent = "Downloading";
                    btn.disabled = true;
                    btn.style.background = "#448";
                    btn.style.color = "#aaa";
                    versionSelect.disabled = true;
                    return;
                }

                if (isQueued) {
                    item.style.borderColor = "#884";
                    bgLayer.style.width = "100%";
                    bgLayer.style.background = "repeating-linear-gradient(45deg, #443, #443 10px, #332 10px, #332 20px)";
                    statusLabel.innerHTML = `<span style="color: #dd8;">⏳ Queued</span>`;
                    btn.textContent = "Waiting...";
                    btn.disabled = true;
                    btn.style.background = "#554";
                    btn.style.color = "#aaa";
                    versionSelect.disabled = true;
                    return;
                }

                if (isAuthRequired) {
                    item.style.borderColor = "#fa0";
                    bgLayer.style.width = "100%";
                    bgLayer.style.background = "rgba(100, 80, 0, 0.2)";
                    statusLabel.innerHTML = `<span style="color: #fa0;">⚠ API Key Required</span>`;
                    btn.textContent = "Enter Key";
                    btn.disabled = false;
                    btn.style.background = "#ca0";
                    btn.style.color = "black";
                    versionSelect.disabled = true;
                    btn.onclick = (e) => {
                        e.stopPropagation();
                        this.showApiKeyDialog(model.name, repoId, selVer);
                    };
                    return;
                }

                // --- DISK TRUTH PRIORITY ---
                const isSelectedInstalled = installedList.includes(selVer);
                const isSelectedActive = (selVer === activeVer);

                // If version not on disk, it's NOT installed, period.
                if (!isSelectedInstalled && !isSelectedActive) {
                    // Reset cosmetic flags
                    bgLayer.style.width = "0%";
                    item.style.background = "#333";
                    versionSelect.disabled = false;

                    if (isError) {
                        item.style.borderColor = "#a44";
                        bgLayer.style.width = "100%";
                        bgLayer.style.background = "rgba(100, 40, 40, 0.2)";
                        statusLabel.innerHTML = `<span style="color: #f88;">⚠ ${dynStatus.message || "Error"}</span>`;
                        btn.textContent = "Retry";
                        btn.disabled = false;
                        btn.style.background = "#a44";
                        btn.style.color = "white";
                        btn.onclick = () => this.downloadModel(repoId, model.name, selVer);
                    } else {
                        item.style.borderColor = "#666";
                        statusLabel.innerHTML = `<span style="color: #ccc;">○ Not Installed</span>`;
                        btn.textContent = "Download";
                        btn.disabled = false;
                        btn.style.background = "#44a";
                        btn.style.color = "white";
                        btn.onclick = () => this.downloadModel(repoId, model.name, selVer);
                    }
                    return;
                }

                // --- INSTALLED/ACTIVE STATES ---
                versionSelect.disabled = false;
                bgLayer.style.width = "0%";
                item.style.background = "#333";

                let updateMsg = "";
                if (model.versions && model.versions.length > 0) {
                    const latestVer = model.versions[0].version;
                    if (String(selVer).replace(/^v/, '') !== String(latestVer).replace(/^v/, '')) {
                        updateMsg = ` <span style="color: #fca; font-size: 0.9em;">(Latest: v${latestVer})</span>`;
                    }
                }

                if (isSelectedActive) {
                    item.style.borderColor = "#484";
                    item.style.background = "rgba(40, 100, 40, 0.1)";
                    statusLabel.innerHTML = `<span style="color: #afa;">✓ Active</span>${updateMsg}`;
                    btn.textContent = "Active";
                    btn.disabled = true;
                    btn.style.background = "transparent";
                    btn.style.color = "#8c8";
                    btn.style.border = "1px solid #484";
                } else {
                    // Installed but not active
                    item.style.borderColor = isSuccess ? "#4a4" : "#aa4";
                    statusLabel.innerHTML = isSuccess ?
                        `<span style="color: #cfc;">✓ Installed v${selVer}</span>` :
                        `<span style="color: #ffc;">Installed</span>${updateMsg}`;

                    btn.textContent = "Set Active";
                    btn.disabled = false;
                    btn.style.background = "#aa4";
                    btn.style.color = "black";
                    btn.style.border = "none";
                    btn.onclick = async () => {
                        btn.textContent = "Activating...";
                        btn.disabled = true;
                        try {
                            await api.fetchApi("/vnccs/manager/set_active", {
                                method: "POST",
                                body: JSON.stringify({ model_name: model.name, version: selVer })
                            });
                            await this.fetchModels(repoId);
                            window.dispatchEvent(new CustomEvent("vnccs-registry-updated"));
                        } catch (e) {
                            console.error(e);
                            btn.textContent = "Error";
                            btn.disabled = false;
                        }
                    };
                }
            };

            versionSelect.onchange = updateState;
            // Initial call
            updateState();

            const currentChild = this.listArea.children[index];
            if (currentChild !== item) {
                this.listArea.insertBefore(item, currentChild);
            }
        });


        // Cleanup extra children if model list shrank
        while (this.listArea.children.length > this.models.length) {
            this.listArea.removeChild(this.listArea.lastChild);
        }

        // Update Header
        if (this.header && this.statusText) {
            if (installedCount === totalModels) {
                if (hasUpdates) {
                    this.statusText.innerHTML = `<span style="color: #fc4;">Updates Available (${installedCount}/${totalModels})</span>`;
                    this.header.style.borderBottomColor = "#aa4";
                } else {
                    this.statusText.innerHTML = `<span style="color: #8c8;">All Updated (${installedCount}/${totalModels})</span>`;
                    this.header.style.borderBottomColor = "#484";
                }
            } else {
                this.statusText.innerHTML = `<span style="color: #ccc;">Installed ${installedCount} models from ${totalModels}</span>`;
                this.header.style.borderBottomColor = "#333";
            }
        }
    }

    showMessage(text, isError = false) {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: absolute; top:0; left:0; width:100%; height:100%;
            background: rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center;
            z-index: 1000; padding: 20px; box-sizing: border-box;
        `;
        const box = document.createElement("div");
        box.style.cssText = `
            background: #222; border: 1px solid ${isError ? '#a44' : '#444'}; 
            padding: 15px; border-radius: 8px; max-width: 300px; width: 100%;
            text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.5);
        `;
        box.innerHTML = `<div style="color: #eee; font-size: 13px; margin-bottom: 15px; line-height: 1.4;">${text}</div>`;
        const btn = document.createElement("button");
        btn.innerText = "OK";
        btn.style.cssText = "background: #44a; color: white; border: none; padding: 6px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;";
        btn.onclick = () => overlay.remove();
        box.appendChild(btn);
        overlay.appendChild(box);
        this.container.appendChild(overlay);
    }

    showConfirm(text, onConfirm) {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: absolute; top:0; left:0; width:100%; height:100%;
            background: rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center;
            z-index: 1000; padding: 20px; box-sizing: border-box;
        `;
        const box = document.createElement("div");
        box.style.cssText = `
            background: #222; border: 1px solid #444; 
            padding: 15px; border-radius: 8px; max-width: 300px; width: 100%;
            text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.5);
        `;
        box.innerHTML = `<div style="color: #eee; font-size: 13px; margin-bottom: 15px; line-height: 1.4;">${text}</div>`;

        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.gap = "10px";
        row.style.justifyContent = "center";

        const cancel = document.createElement("button");
        cancel.innerText = "Cancel";
        cancel.style.cssText = "background: #444; color: white; border: none; padding: 6px 15px; border-radius: 4px; cursor: pointer;";
        cancel.onclick = () => overlay.remove();

        const ok = document.createElement("button");
        ok.innerText = "Confirm";
        ok.style.cssText = "background: #4a4; color: white; border: none; padding: 6px 15px; border-radius: 4px; cursor: pointer; font-weight: bold;";
        ok.onclick = () => { overlay.remove(); onConfirm(); };

        row.appendChild(cancel);
        row.appendChild(ok);
        box.appendChild(row);
        overlay.appendChild(box);
        this.container.appendChild(overlay);
    }
}

app.registerExtension({
    name: "VNCCS.ModelManager",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "VNCCS_ModelManager") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                // Add "Check" button widget
                this.addWidget("button", "Check/Refresh Models", null, () => {
                    const repoId = this.widgets.find(w => w.name === "repo_id")?.value;
                    if (repoId && this.listWidget) {
                        this.listWidget.fetchModels(repoId, true);
                    } else {
                        if (this.listWidget) this.listWidget.showMessage("Please enter a Repo ID first.", true);
                    }
                });

                // Helper to create DOM element
                const container = document.createElement("div");
                // ComfyUI DOM Widget wrapper
                this.addDOMWidget("ModelList", "div", container, {
                    serialize: false,
                    hideOnZoom: false
                });

                // Initialize logic
                this.listWidget = new VNCCS_ModelListWidget(this, container);

                // Increase default size to fit list
                this.setSize([400, 500]);

                // Auto-fetch on load (delayed to allow graph restore)
                setTimeout(() => {
                    const repoWidget = this.widgets?.find(w => w.name === "repo_id");
                    if (repoWidget && repoWidget.value && this.listWidget) {
                        this.listWidget.fetchModels(repoWidget.value);
                    }
                }, 100);
            };
        }

        if (nodeData.name === "VNCCS_ModelSelector") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                // 1. Ensure "model_name" and "version" widgets exist even if in "hidden" block
                // ComfyUI doesn't auto-create widgets for "hidden" inputs, so we add them manually
                let textWidget = this.widgets?.find(w => w.name === "model_name");
                if (!textWidget) {
                    textWidget = this.addWidget("text", "model_name", "", () => { }, { serialize: true });
                }
                // HACK: Completely hide the widget from rendering
                textWidget.computeSize = () => [0, -4];
                textWidget.type = "hidden";
                textWidget.draw = () => { }; // Override draw to do nothing

                let verWidget = this.widgets?.find(w => w.name === "version");
                if (!verWidget) {
                    verWidget = this.addWidget("text", "version", "auto", () => { }, { serialize: true });
                }
                verWidget.computeSize = () => [0, -4];
                verWidget.type = "hidden";
                verWidget.draw = () => { }; // Override draw to do nothing

                // 2. Create UI Container
                const container = document.createElement("div");
                // Style matches standard clean DOM usage
                Object.assign(container.style, {
                    width: "100%",
                    display: "flex",
                    flexDirection: "column",
                    boxSizing: "border-box"
                });

                // 3. Register DOM Widget
                // We add it to the node so ComfyUI renders it
                this.addDOMWidget("SelectorWidget", "div", container, {
                    serialize: false,
                    hideOnZoom: false
                });

                // 4. Initialize Logic Class
                this.selectorWidget = new VNCCS_SelectorWidget(this, container);

                // 5. Initial Data Update (Delayed)
                setTimeout(() => {
                    this.selectorWidget.refresh();
                }, 100);
            };

            // Handle Workflow Loading (Restore values)
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                if (onConfigure) onConfigure.apply(this, arguments);
                // Sync value when graph is restored
                if (this.selectorWidget) {
                    const w = this.widgets.find(x => x.name === "model_name");
                    if (w) {
                        this.selectorWidget.currentValue = w.value;
                        // Trigger a render so version logic runs (after fetch?)
                        // We might need to wait for fetch first, usually refresh() handles it
                        // but setting currentValue is key.
                        setTimeout(() => this.selectorWidget.refresh(), 500);
                    }
                }
            };
        }
    }
});

class VNCCS_SelectorWidget {
    constructor(node, container) {
        this.node = node;
        this.container = container;
        this.models = [];
        this.currentValue = "";

        // Base Design Resolution
        this.designWidth = 320;

        // Grab initial value from widget (if already set)
        const w = this.node.widgets.find(x => x.name === "model_name");
        if (w) this.currentValue = w.value;

        // Listen for global registry updates (sync with Manager)
        this._onRegistryUpdate = (e) => {
            // Avoid refreshing if node is gone or collapsed
            if (!this.container || !this.container.isConnected) {
                window.removeEventListener("vnccs-registry-updated", this._onRegistryUpdate);
                return;
            }

            // Check if event carries data for our repo
            const repoWidget = this.node.widgets.find(w => w.name === "repo_id");
            const repoId = repoWidget ? repoWidget.value : "MIUProject/VNCCS";

            if (e.detail && e.detail.repo_id === repoId && e.detail.models) {
                this.models = e.detail.models;
                this.render();
            } else {
                this.refresh();
            }
        };
        window.addEventListener("vnccs-registry-updated", this._onRegistryUpdate);

        // Styles
        this.styleContainer();

        // Hook Resize for scaling
        const onResize = node.onResize;
        node.onResize = (size) => {
            if (onResize) onResize.apply(node, [size]);
            this.updateScale();
        };

        // Initial Data Check: pick up from cache immediately if already there
        const repoWidget = this.node.widgets.find(w => w.name === "repo_id");
        const initRepoId = repoWidget ? repoWidget.value : "MIUProject/VNCCS";
        if (window.VNCCS_REGISTRY[initRepoId]) {
            this.models = window.VNCCS_REGISTRY[initRepoId];
        }

        this.render();
    }

    styleContainer() {
        // Main wrapper styling
        this.container.style.width = "100%";
        this.container.style.height = "100%";
        this.container.style.padding = "0";
        this.container.style.backgroundColor = "transparent";
        this.container.style.marginTop = "0px";
        this.container.style.overflow = "hidden";
        this.container.style.position = "relative";
    }

    updateScale() {
        if (!this.node || !this.innerContent) return;
        const availableWidth = Math.max(this.node.size[0] - 20, 100);
        const scale = availableWidth / this.designWidth;
        this.innerContent.style.transform = `scale(${scale})`;
        this.innerContent.style.transformOrigin = "top left";
        this.innerContent.style.width = `${this.designWidth}px`;
    }

    async refresh(force = false) {
        // 1. Re-sync inputs
        const repoWidget = this.node.widgets.find(w => w.name === "repo_id");
        const nameWidget = this.node.widgets.find(w => w.name === "model_name");

        const repo_id = repoWidget ? repoWidget.value : "MIUProject/VNCCS";
        if (nameWidget) this.currentValue = nameWidget.value;

        if (this.refreshBtn) this.refreshBtn.textContent = "⌛";

        if (force) {
            delete window.VNCCS_REGISTRY[repo_id];
        }

        if (!force && window.VNCCS_REGISTRY[repo_id]) {
            this.models = window.VNCCS_REGISTRY[repo_id];
            this.render();
            if (this.refreshBtn) this.refreshBtn.textContent = "↻";
            return;
        }

        if (this.models.length === 0) this.render();

        if (!force && window.VNCCS_FETCH_PROMISES[repo_id]) {
            try {
                this.models = await window.VNCCS_FETCH_PROMISES[repo_id];
                this.render();
                return;
            } catch (e) { } finally {
                if (this.refreshBtn) this.refreshBtn.textContent = "↻";
            }
        }

        try {
            const url = `/vnccs/manager/check?repo_id=${encodeURIComponent(repo_id)}${force ? '&force_refresh=true' : ''}`;
            const fetchPromise = (async () => {
                const response = await api.fetchApi(url);
                const data = await response.json();
                if (data.models) {
                    window.VNCCS_REGISTRY[repo_id] = data.models;
                    return data.models;
                }
                throw new Error(data.error || "Unknown error");
            })();

            window.VNCCS_FETCH_PROMISES[repo_id] = fetchPromise;
            this.models = await fetchPromise;
            this.render();
        } catch (e) {
            console.error("VNCCS Selector Fetch Error", e);
        } finally {
            if (this.refreshBtn) this.refreshBtn.textContent = "↻";
            delete window.VNCCS_FETCH_PROMISES[repo_id];
        }
    }

    setValue(name) {
        this.currentValue = name;
        // Update hidden widget
        const w = this.node.widgets.find(x => x.name === "model_name");
        if (w) w.value = name;

        // Try to update version immediately if possible
        const m = this.models.find(x => x.name === name);
        if (m && m.active_version) {
            const vw = this.node.widgets.find(x => x.name === "version");
            if (vw) vw.value = m.active_version;
        }

        this.render();
    }

    render() {
        // Ensure hidden widgets are in sync if model is found
        const selectedModel = this.models.find(m => m.name === this.currentValue);
        if (selectedModel) {
            const vw = this.node.widgets.find(x => x.name === "version");
            // If active version exists, sync it to python input
            if (vw && selectedModel.active_version) {
                vw.value = selectedModel.active_version;
            } else if (vw) {
                vw.value = "auto";
            }
        }

        this.container.innerHTML = "";

        // Inner Content Wrapper for Scaling
        this.innerContent = document.createElement("div");
        // We set fixed width here in updateScale, but init here

        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.width = "100%"; // Will fill the 320px inner content
        row.style.alignItems = "stretch";
        // Default border/bg for empty/loading
        row.style.border = "1px solid #444";
        row.style.borderRadius = "4px";
        row.style.overflow = "hidden";
        row.style.backgroundColor = "#2a2a2a";

        // --- Model Card Area ---
        const card = document.createElement("div");
        card.style.flex = "1";
        card.style.cursor = "pointer";
        card.style.padding = "8px 10px";
        card.style.display = "flex";
        card.style.flexDirection = "column";
        card.style.justifyContent = "center";
        card.style.position = "relative";
        card.title = "Click to Select Model";

        card.onclick = () => this.showModal();

        if (selectedModel) {
            // New API structure: uses active_version and installed_versions list
            const activeVer = selectedModel.active_version;

            // It is considered "installed" if we have an active version selected, OR if any version is installed
            // But visually we want to show green only if configured/active.
            // If installed but no active version set? -> Warning state 

            const isConfigured = !!activeVer;
            const hasAnyInstall = selectedModel.installed_versions && selectedModel.installed_versions.length > 0;

            if (isConfigured) {
                row.style.borderColor = "#484"; // Green path
                row.style.backgroundColor = "#162816";
                card.onmouseover = () => row.style.backgroundColor = "#1e351e";
                card.onmouseout = () => row.style.backgroundColor = "#162816";
            } else if (hasAnyInstall) {
                row.style.borderColor = "#aa4"; // Yellow path (Installed but not active?)
                row.style.backgroundColor = "#282816";
                card.onmouseover = () => row.style.backgroundColor = "#35351e";
                card.onmouseout = () => row.style.backgroundColor = "#282816";
            } else {
                row.style.borderColor = "#a44"; // Red (Missing)
                row.style.backgroundColor = "#281616";
                card.onmouseover = () => row.style.backgroundColor = "#351e1e";
                card.onmouseout = () => row.style.backgroundColor = "#281616";
            }

            // Version info
            let ver = "";
            const latestVer = (selectedModel.versions && selectedModel.versions.length > 0) ? selectedModel.versions[0].version : null;

            const normalize = (s) => String(s).replace(/^v/, '').trim();
            const formatV = (s) => String(s).startsWith('v') ? s : 'v' + s;

            if (isConfigured) {
                // We have an active version
                ver = formatV(activeVer);
                // Optionally warn if outdated?
                if (latestVer && normalize(activeVer) !== normalize(latestVer)) {
                    ver += ` <span style="color:#fa0; font-size:9px;">(New: ${formatV(latestVer)})</span>`;
                }
            } else {
                if (latestVer) {
                    ver = `${formatV(latestVer)} <span style="color:#f88;">(Not Active)</span>`;
                } else {
                    ver = "Unknown Version";
                }
            }

            const nameColor = isConfigured ? "#cec" : (hasAnyInstall ? "#fe8" : "#f88");
            const icon = isConfigured ? "✓" : (hasAnyInstall ? "⚠" : "✖");
            const iconColor = isConfigured ? "#4a4" : (hasAnyInstall ? "#fa0" : "#f44");

            card.innerHTML = `
                <div style="font-weight: bold; color: ${nameColor}; word-break: break-word; font-size: 13px; line-height: 1.3; padding-right: 15px;">${selectedModel.name}</div>
                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">${ver}</div>
                <div style="font-size: 10px; color: #8a8; margin-top: 5px; border-top: 1px solid rgba(100,150,100,0.2); padding-top: 4px; line-height: 1.25; font-style: italic;">
                    ${selectedModel.description || "No description available."}
                </div>
                <div style="position: absolute; top: 6px; right: 6px; color: ${iconColor}; font-weight: bold; font-size: 14px;">${icon}</div>
            `;
        } else if (this.currentValue) {
            // Case 2: We have a saved name, but no API data yet (or missing from repo)
            // If models list is empty, we are probably still loading or offline -> Show Name nicely
            // If models list exists but not found -> Show "Missing"

            if (this.models.length === 0) {
                card.innerHTML = `
                    <div style="font-weight: bold; color: #ddd; word-break: break-word; font-size: 13px;">${this.currentValue}</div>
                    <div style="font-size: 10px; color: #888; margin-top: 2px;">Loading info...</div>
                `;
            } else {
                card.innerHTML = `
                    <div style="font-weight: bold; color: #f88; word-break: break-word; font-size: 13px;">${this.currentValue}</div>
                    <div style="font-size: 10px; color: #d66; margin-top: 2px;">Not found in Repo</div>
                `;
            }
        } else {
            // Case 3: Empty (New Node)
            const color = "#ccc";
            card.innerHTML = `
                <div style="color: ${color}; font-style: italic; font-size: 13px; text-align: center; padding: 4px 0;">Select Model...</div>
            `;
        }

        row.appendChild(card);


        // --- Refresh Button ---
        const rBtn = document.createElement("div");
        rBtn.textContent = "↻";
        rBtn.title = "Refresh List";
        rBtn.style.width = "32px";
        rBtn.style.display = "flex";
        rBtn.style.alignItems = "center";
        rBtn.style.justifyContent = "center";
        rBtn.style.borderLeft = "1px solid #444";
        rBtn.style.fontSize = "16px";
        rBtn.style.cursor = "pointer";
        rBtn.style.backgroundColor = "rgba(0,0,0,0.2)"; // Slightly darker than card

        rBtn.onmouseover = () => { rBtn.style.backgroundColor = "#444"; rBtn.style.color = "#fff"; };
        rBtn.onmouseout = () => { rBtn.style.backgroundColor = "rgba(0,0,0,0.2)"; rBtn.style.color = "#888"; };
        rBtn.onclick = (e) => { e.stopPropagation(); this.refresh(true); };

        this.refreshBtn = rBtn;
        row.appendChild(rBtn);

        this.innerContent.appendChild(row);
        this.container.appendChild(this.innerContent);

        // --- Trigger Scale Update ---
        this.updateScale();
    }

    showModal() {
        if (!this.models.length) {
            // If empty, try refresh first? or custom confirm
            this.showConfirm("Model list empty. Refresh now?", () => {
                this.refresh();
            });
            return;
        }

        // Create Modal Overlay
        const overlay = document.createElement("div");
        Object.assign(overlay.style, {
            position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh",
            background: "rgba(0,0,0,0.6)", zIndex: "10000",
            display: "flex", justifyContent: "center", alignItems: "center"
        });

        const dialog = document.createElement("div");
        Object.assign(dialog.style, {
            width: "400px", maxWidth: "90%", maxHeight: "80vh",
            background: "#222", border: "1px solid #444", borderRadius: "8px",
            display: "flex", flexDirection: "column", boxShadow: "0 10px 30px rgba(0,0,0,0.5)"
        });

        // Header
        const header = document.createElement("div");
        header.innerHTML = "Select Model <span style='float:right; cursor:pointer'>✕</span>";
        Object.assign(header.style, {
            padding: "10px 15px", background: "#1a1a1a", borderBottom: "1px solid #333",
            fontWeight: "bold", color: "#ddd"
        });
        header.querySelector("span").onclick = () => document.body.removeChild(overlay);
        dialog.appendChild(header);

        // Search
        const search = document.createElement("input");
        search.placeholder = "Filter models...";
        Object.assign(search.style, {
            padding: "10px", background: "#111", border: "none",
            borderBottom: "1px solid #333", color: "#fff", outline: "none", width: "100%", boxSizing: "border-box"
        });
        dialog.appendChild(search);

        // List
        const list = document.createElement("div");
        Object.assign(list.style, {
            flex: "1", overflowY: "auto", padding: "0"
        });

        const renderItems = (filter = "") => {
            list.innerHTML = "";
            const lowerFilter = filter.toLowerCase();
            this.models
                .filter(m => m.name.toLowerCase().includes(lowerFilter))
                .sort((a, b) => a.name.localeCompare(b.name))
                .forEach(m => {
                    const el = document.createElement("div");
                    const isSelected = m.name === this.currentValue;
                    Object.assign(el.style, {
                        padding: "8px 15px", borderBottom: "1px solid #333", cursor: "pointer",
                        background: isSelected ? "#2a3a2a" : "transparent"
                    });

                    el.onmouseover = () => { if (!isSelected) el.style.background = "#333"; };
                    el.onmouseout = () => { if (!isSelected) el.style.background = "transparent"; };

                    el.innerHTML = `
                        <div style="color: ${isSelected ? '#6c6' : '#eee'}; font-weight: bold;">${m.name}</div>
                        <div style="color: #888; font-size: 11px;">${m.description || ""}</div>
                    `;
                    el.onclick = () => {
                        this.setValue(m.name);
                        document.body.removeChild(overlay);
                    };
                    list.appendChild(el);
                });

            if (!list.hasChildNodes()) {
                list.innerHTML = "<div style='padding:20px; text-align:center; color:#666'>No matches found</div>";
            }
        };

        renderItems();
        search.oninput = (e) => renderItems(e.target.value);

        dialog.appendChild(list);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        overlay.onclick = (e) => {
            if (e.target === overlay) document.body.removeChild(overlay);
        };

        search.focus();
    }

    showMessage(text, isError = false) {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; top:0; left:0; width:100vw; height:100vh;
            background: rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center;
            z-index: 20000; padding: 20px; box-sizing: border-box;
        `;
        const box = document.createElement("div");
        box.style.cssText = `
            background: #222; border: 1px solid ${isError ? '#a44' : '#444'}; 
            padding: 15px; border-radius: 8px; max-width: 300px; width: 100%;
            text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.5);
        `;
        box.innerHTML = `<div style="color: #eee; font-size: 13px; margin-bottom: 15px; line-height: 1.4;">${text}</div>`;
        const btn = document.createElement("button");
        btn.innerText = "OK";
        btn.style.cssText = "background: #44a; color: white; border: none; padding: 6px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;";
        btn.onclick = () => overlay.remove();
        box.appendChild(btn);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }

    showConfirm(text, onConfirm) {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; top:0; left:0; width:100vw; height:100vh;
            background: rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center;
            z-index: 20000; padding: 20px; box-sizing: border-box;
        `;
        const box = document.createElement("div");
        box.style.cssText = `
            background: #222; border: 1px solid #444; 
            padding: 15px; border-radius: 8px; max-width: 300px; width: 100%;
            text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.5);
        `;
        box.innerHTML = `<div style="color: #eee; font-size: 13px; margin-bottom: 15px; line-height: 1.4;">${text}</div>`;

        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.gap = "10px";
        row.style.justifyContent = "center";

        const cancel = document.createElement("button");
        cancel.innerText = "Cancel";
        cancel.style.cssText = "background: #444; color: white; border: none; padding: 6px 15px; border-radius: 4px; cursor: pointer;";
        cancel.onclick = () => overlay.remove();

        const ok = document.createElement("button");
        ok.innerText = "Confirm";
        ok.style.cssText = "background: #4a4; color: white; border: none; padding: 6px 15px; border-radius: 4px; cursor: pointer; font-weight: bold;";
        ok.onclick = () => { overlay.remove(); onConfirm(); };

        row.appendChild(cancel);
        row.appendChild(ok);
        box.appendChild(row);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }
}
