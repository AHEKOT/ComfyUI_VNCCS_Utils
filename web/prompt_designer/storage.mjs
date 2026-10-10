import { normalizeState, promptId } from "./state.mjs";
import { readPromptResponse } from "./response.mjs";

const PREFIX = "vnccs:prompt-designer:";

// Browser drafts cover the interval before an acknowledged disk transaction.
export class DocumentStorage {
    constructor(node, api, status, storage, session) {
        this.node = node;
        this.api = api;
        this.status = status;
        try { this.storage = storage ?? globalThis.localStorage; }
        catch (error) { this.localError = error; }
        try { this.session = session ?? globalThis.sessionStorage; }
        catch { this.session = null; }
        this.writer = promptId();
        node.properties ??= {};
        const metadata = node.properties.promptDesigner;
        this.id = /^[a-f0-9]{32}$/.test(metadata?.id) ? metadata.id : promptId();
        this.revision = Number.isSafeInteger(metadata?.revision) ? metadata.revision : 0;
        // Fork a cloned node so its edits cannot replace the source document.
        if (node.graph?._nodes?.some(other => other !== node && other.properties?.promptDesigner?.id === this.id)) {
            this.id = promptId();
            this.revision = 0;
        }
    }

    async restore(raw) {
        const metadata = this.node.properties.promptDesigner;
        let draft;
        try {
            const previous = this.session?.getItem(PREFIX + this.id);
            this.previousDraftKey = previous && /^[a-f0-9]{32}$/.test(previous) ? `${PREFIX}${this.id}:draft:${previous}` : null;
            const value = (this.previousDraftKey && this.storage?.getItem(this.previousDraftKey)) || this.storage?.getItem(PREFIX + this.id);
            if (value) {
                this.corruptDraft = value;
                draft = JSON.parse(value);
                normalizeState(JSON.parse(draft.state));
                if (!Number.isSafeInteger(draft.revision)) throw new Error("Invalid draft revision.");
                if (!draft.dirty && (metadata?.dirty || draft.revision < this.revision)) draft = undefined;
                this.corruptDraft = null;
            }
        } catch (error) {
            draft = undefined;
            this.status(`Browser recovery could not be read: ${error.message}. Recovery data was retained.`, true);
        }
        // The property mirror also survives ComfyUI widget ordering changes.
        this.revision = draft?.revision ?? this.revision;
        let state;
        for (const value of [draft?.state, metadata?.state, raw]) {
            if (value === undefined) continue;
            try { state = normalizeState(JSON.parse(value)); break; }
            catch (error) { this.restoreError = error; }
        }
        this.restoreRequest = new AbortController();
        const timeout = setTimeout(() => this.restoreRequest.abort(), 10_000);
        try {
            const response = await this.api.fetchApi(`/vnccs/prompt_designer/documents/${this.id}`, { signal: this.restoreRequest.signal });
            const result = await readPromptResponse(response);
            if (!response.ok) throw new Error(result.error || "Disk recovery failed.");
            if (!Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error("Invalid disk revision.");
            const dirty = draft ? draft.dirty : metadata?.dirty;
            if (result.state && (!dirty && result.revision > this.revision || !state)) {
                state = normalizeState(result.state);
                this.revision = result.revision;
                this.restoreError = null;
            }
        } catch (error) {
            this.error = error;
            this.status(`Disk recovery unavailable: ${error.message}`, true);
        } finally {
            clearTimeout(timeout);
        }
        if (!state) throw this.restoreError;
        return state;
    }

    write(value) {
        this.pending = value;
        this.mirror(value, true);
        if (!this.localError) this.status("Saving edits to disk · Browser backup ready");
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 250);
    }

    mirror(value, dirty) {
        if (!this.disposed) this.node.properties.promptDesigner = { id: this.id, revision: this.revision, state: value, dirty };
        try {
            if (!this.storage) throw new Error("Browser recovery storage is unavailable.");
            if (this.corruptDraft) {
                this.storage.setItem(`${PREFIX}${this.id}:corrupt:${promptId()}`, this.corruptDraft);
                this.corruptDraft = null;
            }
            const draft = JSON.stringify({ state: value, revision: this.revision, dirty });
            // Separate writers prevent two tabs overwriting each other's unacknowledged drafts.
            this.storage.setItem(`${PREFIX}${this.id}:draft:${this.writer}`, draft);
            if (!this.disposed) {
                this.session?.setItem(PREFIX + this.id, this.writer);
                this.storage.setItem(PREFIX + this.id, draft);
                if (this.previousDraftKey) {
                    const previous = this.storage.getItem(this.previousDraftKey);
                    if (previous && JSON.parse(previous).dirty === false) this.storage.removeItem?.(this.previousDraftKey);
                }
            }
            this.localError = null;
        } catch (error) {
            this.localError = error;
            this.status(`Browser backup failed: ${error.message}. Waiting for disk save.`, true);
        }
    }

    async flush() {
        clearTimeout(this.timer);
        if (this.busy || !this.pending) return;
        const value = this.pending;
        this.busy = true;
        try {
            const response = await this.api.fetchApi(`/vnccs/prompt_designer/documents/${this.id}`, {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ state: JSON.parse(value), revision: this.revision }),
                signal: AbortSignal.timeout(30_000),
            });
            const result = await readPromptResponse(response);
            if (response.status === 409) {
                // A second tab keeps its newer document; this draft gets its own durable identity.
                this.id = promptId();
                this.revision = 0;
                this.mirror(this.pending, true);
                if (!this.disposed) this.node.graph?.change?.();
                this.status("Concurrent edits preserved as a separate document.");
                return;
            }
            if (!response.ok) throw new Error(result.error || "Disk save failed.");
            if (!Number.isSafeInteger(result.revision) || result.revision < 1 || result.revision < this.revision) throw new Error("Invalid disk save acknowledgement.");
            this.revision = result.revision;
            this.error = null;
            if (this.pending === value) this.pending = null;
            this.mirror(this.pending ?? value, !!this.pending);
            if (!this.disposed) this.node.graph?.change?.();
            this.status(this.pending ? "Saving latest edits to disk" : this.localError ? "Saved on disk · Browser backup unavailable" : "Saved on disk · Browser backup ready", !!this.localError);
        } catch (error) {
            this.error = error;
            this.status(`Not saved on disk: ${error.message}. Your draft is retained.`, true);
        } finally {
            this.busy = false;
            if (this.pending && ![404, 405].includes(this.error?.status) && (!this.disposed || !this.error)) {
                this.timer = setTimeout(() => this.flush(), this.error ? 3000 : 0);
            }
        }
    }

    dispose() {
        // Keep recovery data and let an in-flight transaction finish.
        this.flush();
        this.disposed = true;
        this.restoreRequest?.abort();
        clearTimeout(this.timer);
    }
}
