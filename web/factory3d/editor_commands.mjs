const clone = value => globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));

export class FactoryCommandHistory {
    constructor({ limit = 100, onRestore = () => {} } = {}) {
        this.limit = Math.max(1, Number(limit) || 100);
        this.onRestore = onRestore;
        this.undoStack = [];
        this.redoStack = [];
        this.pending = null;
    }

    begin(label, value) {
        if (this.pending) return;
        this.pending = { label: String(label || "Edit"), before: clone(value) };
    }

    commit(value) {
        if (!this.pending) return false;
        const entry = { ...this.pending, after: clone(value) };
        this.pending = null;
        if (JSON.stringify(entry.before) === JSON.stringify(entry.after)) return false;
        this.undoStack.push(entry);
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack.length = 0;
        return true;
    }

    cancel() {
        if (!this.pending) return false;
        const before = this.pending.before;
        this.pending = null;
        this.onRestore(clone(before), { direction: "cancel" });
        return true;
    }

    push(label, before, after) {
        this.pending = { label: String(label || "Edit"), before: clone(before) };
        return this.commit(after);
    }

    undo() {
        const entry = this.undoStack.pop();
        if (!entry) return false;
        this.redoStack.push(entry);
        this.onRestore(clone(entry.before), { direction: "undo", label: entry.label });
        return true;
    }

    redo() {
        const entry = this.redoStack.pop();
        if (!entry) return false;
        this.undoStack.push(entry);
        this.onRestore(clone(entry.after), { direction: "redo", label: entry.label });
        return true;
    }

    clear() {
        this.pending = null;
        this.undoStack.length = 0;
        this.redoStack.length = 0;
    }

    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }
}

export function preserveScrollState(root, operation) {
    const states = new Map();
    for (const element of root?.querySelectorAll?.("[data-preserve-scroll]") || []) {
        states.set(element.dataset.preserveScroll, {
            top: element.scrollTop,
            left: element.scrollLeft,
        });
    }
    const result = operation();
    requestAnimationFrame(() => {
        for (const element of root?.querySelectorAll?.("[data-preserve-scroll]") || []) {
            const state = states.get(element.dataset.preserveScroll);
            if (!state) continue;
            element.scrollTop = state.top;
            element.scrollLeft = state.left;
        }
    });
    return result;
}
