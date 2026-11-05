import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";

test("Publish always opens configuration for new and linked libraries", async () => {
    const { w } = createScene();
    const opened = [];
    w.showPublishLocalRepositoryModal = configure => opened.push(configure);
    w.showMessage = message => assert.fail(message);
    for (const publish_repo_id of ["", "owner/library"]) {
        w.localPoseRepository = { publish_repo_id };
        await w.publishLocalPoseRepository();
        await w.publishLocalPoseRepository(true);
    }
    assert.deepEqual(opened, [false, true, false, true]);
    w._localPoseRepositoryPublishActive = true;
    await w.publishLocalPoseRepository();
    assert.equal(opened.length, 4, "only an already running publish prevents a duplicate");
});

test("Publish sends explicit credentials, remembers success and allows another publish", async () => {
    const { w, context } = createScene();
    const requests = [], updates = [];
    let cleared = false;
    context.setInterval = () => 1;
    context.clearInterval = () => { cleared = true; };
    context.fetch = async (url, options) => {
        requests.push({ url, payload: JSON.parse(options.body) });
        return { ok: true, json: async () => ({
            local_repository: { publish_repo_id: "owner/library" },
            result: { uploaded_count: 3 },
        }) };
    };
    w.createRepositoryTaskId = () => "publish-test";
    w.createInlineRepositoryProgress = () => ({ update: value => updates.push(value), close() {} });
    w.setRepositoryProgressState = w.renderPoseRepositorySettings = () => {};
    w.pollRepositoryProgress = async () => {};
    await w.runLocalPoseRepositoryPublish({ repo_id: "owner/library", token: "explicit-test-token", create: true, private: true });
    assert.deepEqual(requests, [{
        url: "/vnccs/pose_library/repositories/local/publish",
        payload: { repo_id: "owner/library", token: "explicit-test-token", create: true, private: true, task_id: "publish-test" },
    }]);
    assert.equal(w.localPoseRepository.publish_repo_id, "owner/library");
    assert.equal(updates.at(-1).status, "success");
    assert.equal(w._localPoseRepositoryPublishActive, false);
    assert.equal(cleared, true);
    assert.doesNotMatch(w.node.widgets[0].value, /explicit-test-token/);
});
