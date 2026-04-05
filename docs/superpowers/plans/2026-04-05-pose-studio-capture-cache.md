# Pose Studio Capture Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop storing base64 PNG captures in the `pose_data` widget — move them to a server-side LRU cache — so ComfyUI can save workflow drafts with 12 active tabs without hitting size limits.

**Architecture:** JS uploads captures to `POST /vnccs/pose_captures/upload` right after rendering; server stores in a dict with LRU eviction (max 10 entries); widget stores only a `capture_id` string; Python `generate()` reads from the cache dict instead of the widget value.

**Tech Stack:** Python (aiohttp routes in `__init__.py`), JavaScript (ES module in `vnccs_pose_studio.js`)

---

### Task 1: Add server-side capture cache + upload endpoint

**Files:**
- Modify: `__init__.py` (add after `_vnccs_register_pose_library()`)

- [ ] **Step 1: Add cache dict and upload endpoint**

Add at the end of `__init__.py`, after line 174 (`_vnccs_register_pose_library()`):

```python
# === Pose Studio Capture Cache ===
VNCCS_CAPTURE_CACHE = {}
_CAPTURE_CACHE_MAX = 10

def _vnccs_register_capture_cache():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.post("/vnccs/pose_captures/upload")
    async def vnccs_pose_captures_upload(request):
        try:
            data = await request.json()
            capture_id = data.get("capture_id")
            if not capture_id:
                return web.json_response({"error": "missing capture_id"}, status=400)

            VNCCS_CAPTURE_CACHE[capture_id] = {
                "captured_images": data.get("captured_images", []),
                "lighting_prompts": data.get("lighting_prompts", []),
            }

            # LRU eviction: keep only last _CAPTURE_CACHE_MAX entries
            while len(VNCCS_CAPTURE_CACHE) > _CAPTURE_CACHE_MAX:
                oldest = next(iter(VNCCS_CAPTURE_CACHE))
                del VNCCS_CAPTURE_CACHE[oldest]

            return web.json_response({"status": "ok", "capture_id": capture_id})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/pose_captures/{capture_id}")
    async def vnccs_pose_captures_get(request):
        capture_id = request.match_info["capture_id"]
        entry = VNCCS_CAPTURE_CACHE.get(capture_id)
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(entry)

_vnccs_register_capture_cache()
```

- [ ] **Step 2: Verify syntax (no imports needed — aiohttp already imported in scope)**

```bash
cd /Users/ahekot/Documents/Development/ComfyUI_VNCCS_Utils
python -c "import ast; ast.parse(open('__init__.py').read()); print('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add __init__.py
git commit -m "feat: add server-side pose capture LRU cache endpoint"
```

---

### Task 2: JS — upload captures to server cache in `syncToNode`

**Files:**
- Modify: `web/vnccs_pose_studio.js` — `syncToNode()` method (~line 4029)

The current `syncToNode` builds a `data` object with `captured_images` and saves it to the widget. We need to:
1. Upload captures to the server cache asynchronously
2. Save only a `capture_id` in the widget (not the images themselves)

- [ ] **Step 1: Replace the data assembly + widget write block in `syncToNode`**

Find this block (lines 4182–4212):

```js
        // Update hidden pose_data widget
        // Exclude background_url from export to avoid inflating pose_data widget
        const exportToSave = { ...this.exportParams };
        delete exportToSave.background_url;

        const data = {
            mesh: this.meshParams,
            export: exportToSave,
            poses: this.poses,
            lights: this.lightParams,
            activeTab: this.activeTab,
            captured_images: this.poseCaptures,
            lighting_prompts: this.lightingPrompts,
            background_url: this.exportParams.background_url || null
        };

        const widget = this.node.widgets?.find(w => w.name === "pose_data");
        if (widget) {
            widget.value = JSON.stringify(data);
            console.log("[VNCCS PoseStudio] syncToNode saved data to widget. captured_images count:", this.poseCaptures.length);

            // Force ComfyUI to recognize the state change so it saves to the workflow
            if (widget.callback) {
                widget.callback(widget.value);
            }
            if (app.graph && app.graph.setDirtyCanvas) {
                app.graph.setDirtyCanvas(true, true);
            }
        }

        this._isSyncing = false;
    }
```

Replace with:

```js
        // Update hidden pose_data widget
        // Exclude background_url and captured_images from widget to avoid inflating workflow size.
        // Captures are uploaded to server-side LRU cache; only the capture_id is stored in widget.
        const exportToSave = { ...this.exportParams };
        delete exportToSave.background_url;

        // Derive stable capture_id from node id (available via this.node.id)
        const captureId = `vnccs_capture_${this.node.id}`;

        const data = {
            mesh: this.meshParams,
            export: exportToSave,
            poses: this.poses,
            lights: this.lightParams,
            activeTab: this.activeTab,
            capture_id: captureId,
            background_url: this.exportParams.background_url || null
        };

        // Upload captures to server cache (fire-and-forget; errors are non-fatal)
        if (this.poseCaptures && this.poseCaptures.some(c => c)) {
            fetch('/vnccs/pose_captures/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    capture_id: captureId,
                    captured_images: this.poseCaptures,
                    lighting_prompts: this.lightingPrompts || []
                })
            }).catch(e => console.warn("[VNCCS PoseStudio] Capture upload failed:", e));
        }

        const widget = this.node.widgets?.find(w => w.name === "pose_data");
        if (widget) {
            widget.value = JSON.stringify(data);
            console.log("[VNCCS PoseStudio] syncToNode saved data to widget. capture_id:", captureId, "captures count:", this.poseCaptures.length);

            // Force ComfyUI to recognize the state change so it saves to the workflow
            if (widget.callback) {
                widget.callback(widget.value);
            }
            if (app.graph && app.graph.setDirtyCanvas) {
                app.graph.setDirtyCanvas(true, true);
            }
        }

        this._isSyncing = false;
    }
```

- [ ] **Step 2: Commit**

```bash
git add web/vnccs_pose_studio.js
git commit -m "feat: upload pose captures to server cache, store only capture_id in widget"
```

---

### Task 3: JS — fix `vnccs_req_pose_sync` handler to send captures from memory

**Files:**
- Modify: `web/vnccs_pose_studio.js` — `vnccs_req_pose_sync` handler (~line 4331)

The handler currently reads `captured_images` from `poseWidget.value` (the widget JSON). Now they won't be there — we need to build the upload payload from memory instead.

- [ ] **Step 1: Replace the sync handler body**

Find this block (lines 4331–4365):

```js
        api.addEventListener("vnccs_req_pose_sync", async (event) => {
            const nodeId = event.detail.node_id;
            const node = app.graph.getNodeById(nodeId);
            if (node && node.studioWidget) {
                try {
                    // Safe mode: ensure viewer is initialized
                    if (!node.studioWidget.viewer || !node.studioWidget.viewer.isInitialized()) {

                        await node.studioWidget.loadModel();
                    }

                    // Update lights and state before capture
                    if (node.studioWidget.viewer) {
                        node.studioWidget.viewer.updateLights(node.studioWidget.lightParams);
                    }
                    node.studioWidget.syncToNode(true);

                    // 2. Retrieve data
                    const poseWidget = node.widgets.find(w => w.name === "pose_data");
                    if (poseWidget) {
                        const data = JSON.parse(poseWidget.value);
                        data.node_id = nodeId;

                        // 3. Upload to sync endpoint
                        await fetch('/vnccs/pose_sync/upload_capture', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(data)
                        });
                    }
                } catch (e) {
                    console.error("[VNCCS] Batch Sync Error:", e);
                }
            }
        });
```

Replace with:

```js
        api.addEventListener("vnccs_req_pose_sync", async (event) => {
            const nodeId = event.detail.node_id;
            const node = app.graph.getNodeById(nodeId);
            if (node && node.studioWidget) {
                try {
                    // Safe mode: ensure viewer is initialized
                    if (!node.studioWidget.viewer || !node.studioWidget.viewer.isInitialized()) {
                        await node.studioWidget.loadModel();
                    }

                    // Update lights and state before capture
                    if (node.studioWidget.viewer) {
                        node.studioWidget.viewer.updateLights(node.studioWidget.lightParams);
                    }
                    node.studioWidget.syncToNode(true);

                    // Build payload from widget metadata + in-memory captures
                    const poseWidget = node.widgets.find(w => w.name === "pose_data");
                    if (poseWidget) {
                        const widgetData = JSON.parse(poseWidget.value);
                        // Attach fresh captures from memory (not from widget, which no longer stores them)
                        const payload = {
                            ...widgetData,
                            node_id: nodeId,
                            captured_images: node.studioWidget.poseCaptures || [],
                            lighting_prompts: node.studioWidget.lightingPrompts || []
                        };

                        await fetch('/vnccs/pose_sync/upload_capture', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                    }
                } catch (e) {
                    console.error("[VNCCS] Batch Sync Error:", e);
                }
            }
        });
```

- [ ] **Step 2: Commit**

```bash
git add web/vnccs_pose_studio.js
git commit -m "feat: build sync payload from in-memory captures instead of widget value"
```

---

### Task 4: JS — fix `loadFromNode` to not expect `captured_images` in widget

**Files:**
- Modify: `web/vnccs_pose_studio.js` — `loadFromNode()` method (~line 4215)

The current `loadFromNode` restores `captured_images` from the widget. Now that field is gone — the code should simply skip it (captures will be regenerated on first queue).

- [ ] **Step 1: Remove the captured_images restore block**

Find this block (lines 4303–4305):

```js
            if (data.captured_images && Array.isArray(data.captured_images)) {
                this.poseCaptures = data.captured_images;
            }
```

Replace with:

```js
            // captured_images are no longer persisted in widget (stored in server-side LRU cache).
            // poseCaptures will be regenerated on the next syncToNode(true) call.
```

- [ ] **Step 2: Commit**

```bash
git add web/vnccs_pose_studio.js
git commit -m "fix: remove stale captured_images restore from loadFromNode"
```

---

### Task 5: Python — read captures from LRU cache in `generate()`

**Files:**
- Modify: `nodes/pose_studio.py` — `generate()` method (~line 122)

After the live sync reads data from the temp file, the `captured_images` field will be present (because `vnccs_req_pose_sync` handler now explicitly adds them to the payload). This already works. But as a fallback when live sync fails, we should try the LRU cache using `capture_id` from the widget.

- [ ] **Step 1: Add cache fallback after the live sync block**

In `nodes/pose_studio.py`, find the end of the live sync block (~line 175):

```python
        except (json.JSONDecodeError, TypeError):
            data = {}
```

The full block ends here. Right after `data = {}` (the except block), the code does:
```python
        if not isinstance(data, dict):
```

Between those two lines, add the cache fallback:

```python
        except (json.JSONDecodeError, TypeError):
            data = {}

        # Fallback: if live sync produced no captured_images, try LRU cache
        if isinstance(data, dict) and not data.get("captured_images"):
            capture_id = data.get("capture_id")
            if capture_id:
                try:
                    from .. import VNCCS_CAPTURE_CACHE
                    cached = VNCCS_CAPTURE_CACHE.get(capture_id)
                    if cached:
                        data["captured_images"] = cached.get("captured_images", [])
                        data["lighting_prompts"] = cached.get("lighting_prompts", [])
                        print(f"[VNCCS Pose Studio] Loaded {len(data['captured_images'])} captures from LRU cache (id={capture_id})")
                except Exception as e:
                    print(f"[VNCCS Pose Studio] Cache fallback failed: {e}")
```

- [ ] **Step 2: Verify syntax**

```bash
cd /Users/ahekot/Documents/Development/ComfyUI_VNCCS_Utils
python -c "import ast; ast.parse(open('nodes/pose_studio.py').read()); print('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add nodes/pose_studio.py
git commit -m "feat: fallback to LRU capture cache in pose studio generate()"
```
