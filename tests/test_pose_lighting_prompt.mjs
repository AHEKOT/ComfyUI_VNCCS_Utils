import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";

for (const [type, y, description] of [
    ["point", 8, "overhead"],
    ["point", -9, "bottom-up"],
    ["directional", -90, "bottom-up"],
    ["directional", -70, "low"],
]) {
    test(`${type} light at height ${y} describes its visible lighting direction`, () => {
        const { w } = createScene();
        w.exportParams.prompt_template = "<lighting>\n<user_prompt>";
        const light = { type, color: "#0000ff", intensity: 2, x: 0, y, z: 3 };
        const prompt = w.generatePromptFromLights([light], "Authored pose prompt");
        assert.ok(prompt.includes(`Blue lighting coming from the ${description}`), prompt);
        assert.ok(prompt.endsWith("Authored pose prompt"));
    });
}

test("original lighting and disabled local lights retain only the authored prompt", () => {
    const { w } = createScene();
    w.exportParams.prompt_template = "<lighting>\n<user_prompt>";
    const light = { type: "point", color: "#0000ff", intensity: 2, x: 0, y: 8, z: 3 };
    w.exportParams.keepOriginalLighting = true;
    assert.equal(w.generatePromptFromLights([light], "Authored pose prompt"), "Authored pose prompt");
    w.exportParams.keepOriginalLighting = false;
    assert.equal(w.generatePromptFromLights([{ ...light, intensity: 0.05 }], "Authored pose prompt"), "Authored pose prompt");
});

test("pose prompt placeholders preserve literal dollar sequences in authored text", () => {
    const { w } = createScene();
    w.exportParams.prompt_template = "Start <user_prompt>\n<lighting>\nEnd <user_prompt>";
    const prompt = "Print $5, $$, $&, $`, and $' on the shirt";
    const light = { type: "directional", color: "#0000ff", intensity: 2, x: 0, y: 0, z: 30 };
    assert.equal(w.generatePromptFromLights([light], prompt),
        `Start ${prompt}\nstrong Blue lighting coming from the eye-level front\nEnd ${prompt}`);
});
