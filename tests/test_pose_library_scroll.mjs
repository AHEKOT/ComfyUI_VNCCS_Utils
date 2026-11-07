import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";

for (const [deletedIndex, remaining, expected] of [[0, 3, 1], [1, 3, 2], [2, 3, 1], [0, 1, null]]) {
    test(`deleting visible item ${deletedIndex} of ${remaining} selects its nearest remaining neighbor`, async () => {
        const { w, context } = createScene();
        context.URLSearchParams = URLSearchParams;
        const poses = Array.from({ length: remaining }, (_, index) => ({ name: `Match ${index}`, category: "Standing" }));
        w.libraryPoses = [poses[0], { name: "Other search", category: "Standing" },
            { name: "Match in another category", category: "Seated" }, ...poses.slice(1)];
        w.libraryActiveCategory = "Standing";
        w.librarySearchInput = { value: "Match" };
        w.librarySelectedName = w.getLibraryPoseId(poses[deletedIndex]);
        const requests = [], selections = [];
        context.fetch = async (url, options) => {
            requests.push({ url, method: options.method });
            return { ok: true, json: async () => ({}) };
        };
        w.refreshLibrary = async full => { assert.equal(full, false); selections.push(w.librarySelectedName); };
        await w.deleteFromLibrary(poses[deletedIndex]);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].method, "DELETE");
        assert.match(requests[0].url, /category=Standing/);
        assert.deepEqual(selections, [expected === null ? null : w.getLibraryPoseId(poses[expected])]);
    });
}

test("a pending deletion preserves a newer selection and a failed deletion preserves the library", async () => {
    const { w, context } = createScene();
    context.URLSearchParams = URLSearchParams;
    context.console = { ...console, error() {} };
    const poses = w.libraryPoses = [{ name: "A" }, { name: "B" }, { name: "C" }];
    w.librarySelectedName = w.getLibraryPoseId(poses[0]);
    let finish, refreshes = 0;
    context.fetch = () => new Promise(resolve => { finish = resolve; });
    w.refreshLibrary = async () => { refreshes++; };
    const deleting = w.deleteFromLibrary(poses[0]);
    w.librarySelectedName = w.getLibraryPoseId(poses[2]);
    finish({ ok: true, json: async () => ({}) });
    await deleting;
    assert.equal(w.librarySelectedName, w.getLibraryPoseId(poses[2]));
    assert.equal(refreshes, 1);
    const messages = [];
    w.showMessage = message => messages.push(message);
    context.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: "Delete rejected" }) });
    await w.deleteFromLibrary(poses[2]);
    assert.equal(w.librarySelectedName, w.getLibraryPoseId(poses[2]));
    assert.equal(w.libraryPoses, poses);
    assert.equal(refreshes, 1);
    assert.match(messages[0], /Delete rejected/);
});
