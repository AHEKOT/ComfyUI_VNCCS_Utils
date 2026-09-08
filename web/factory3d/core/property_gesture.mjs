import { acceptNumericDraft } from "./property_descriptors.mjs";

/** One live scalar gesture, resolved against current entities on every update. */
export class FactoryPropertyGesture {
    constructor({ history, read, write, preview, finish, capture = null, restore = null }) {
        Object.assign(this, { history, read, write, preview, finish, capture, restore });
        this.pending = null;
    }

    input(ref, descriptor, draft) {
        if (this.pending && (this.pending.ref.id !== ref.id || this.pending.ref.kind !== ref.kind
            || this.pending.ref.sceneId !== ref.sceneId || this.pending.path !== descriptor.id)) this.commit();
        const current = this.read(ref, descriptor.id);
        if (!Number.isFinite(current)) return { valid: false, message: "This object is no longer available." };
        const accepted = acceptNumericDraft(descriptor, draft, this.pending?.before ?? current);
        if (!accepted.valid) return accepted;
        this.pending ||= { ref: { ...ref }, path: descriptor.id, before: current, after: current,
            snapshotBefore: this.capture?.(ref) };
        this.write(ref, descriptor.id, accepted.value);
        this.pending.after = accepted.value;
        this.preview(ref, descriptor.id, accepted.value);
        return accepted;
    }

    commit() {
        const patch = this.pending;
        if (!patch) return false;
        this.pending = null;
        const command = this.capture ? { ref: patch.ref, path: "$pose", before: patch.snapshotBefore, after: this.capture(patch.ref) }
            : { ref: patch.ref, path: patch.path, before: patch.before, after: patch.after };
        const changed = this.history.pushPatch(`Edit ${patch.ref.kind}`, [command]);
        this.finish(patch.ref, patch.path, patch.after, "commit");
        return changed;
    }

    cancel() {
        const patch = this.pending;
        if (!patch) return false;
        this.pending = null;
        if (Number.isFinite(this.read(patch.ref, patch.path))) {
            if (this.restore) this.restore(patch.ref, patch.snapshotBefore);
            else this.write(patch.ref, patch.path, patch.before);
            this.preview(patch.ref, patch.path, patch.before);
            this.finish(patch.ref, patch.path, patch.before, "cancel");
        }
        return true;
    }
}
