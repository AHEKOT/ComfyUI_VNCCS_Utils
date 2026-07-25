import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_CHARACTER_COLORS,
    MAX_POSE_STUDIO_CHARACTERS,
    cameraFramingToCharacterTransform,
    createPoseStudioCharacter,
    nextCharacterColor,
    nextCharacterSlot,
    normalizeCharacterColor,
    normalizeCharacterTransform,
    normalizePoseStudioCharacters,
    serializePoseStudioCharacter,
} from "../web/vnccs_pose_characters.mjs";


test("legacy singleton state migrates to one main character", () => {
    const legacy = {
        mesh: { age: 31, proportions: { height: 0.7 } },
        poses: [{ bones: { head: [1, 2, 3] } }, { bones: { spine: [4, 5, 6] } }],
        animation: {
            frameCount: 24,
            tracks: { head: { keys: [{ frame: 0, value: [0, 0, 0, 1] }] } },
        },
        export: {
            cam_offset_x: 2.5,
            cam_offset_y: -1.25,
            cam_zoom: 1.8,
            cam_yaw_deg: 35,
            cam_pitch_deg: -10,
        },
    };

    const normalized = normalizePoseStudioCharacters(legacy);

    assert.equal(normalized.characters.length, 1);
    assert.equal(normalized.activeCharacterId, "character-1");
    assert.deepEqual(normalized.characters[0], {
        id: "character-1",
        slot: 0,
        name: "Main Character",
        color: DEFAULT_CHARACTER_COLORS[0],
        transform: { x: 2.5, y: -1.25, z: 0, zoom: 1.8 },
        mesh: legacy.mesh,
        poses: legacy.poses,
        animation: legacy.animation,
    });

    legacy.mesh.proportions.height = 0;
    legacy.poses[0].bones.head[0] = 99;
    legacy.animation.tracks.head.keys[0].frame = 12;
    assert.equal(normalized.characters[0].mesh.proportions.height, 0.7);
    assert.equal(normalized.characters[0].poses[0].bones.head[0], 1);
    assert.equal(normalized.characters[0].animation.tracks.head.keys[0].frame, 0);
});


test("normalization keeps at least one character and caps a scene at four", () => {
    const empty = normalizePoseStudioCharacters({ characters: [] });
    assert.equal(empty.characters.length, 1);
    assert.equal(empty.characters[0].name, "Main Character");

    const sourceCharacters = Array.from({ length: 6 }, (_, index) => ({
        id: `cast-${index + 1}`,
        name: `Cast ${index + 1}`,
        poses: [{ marker: index + 1 }],
    }));
    const normalized = normalizePoseStudioCharacters({
        characters: sourceCharacters,
        active_character_id: "cast-6",
    });

    assert.equal(normalized.characters.length, MAX_POSE_STUDIO_CHARACTERS);
    assert.deepEqual(
        normalized.characters.map(character => character.id),
        ["cast-1", "cast-2", "cast-3", "cast-4"],
    );
    assert.equal(normalized.activeCharacterId, "cast-1");
    assert.equal(sourceCharacters.length, 6);
});


test("duplicate character ids are replaced with stable unique ids", () => {
    const normalized = normalizePoseStudioCharacters({
        characters: [
            { id: "lead", name: "Lead" },
            { id: "lead", name: "Double" },
            { id: "character-1", name: "Third" },
            { id: "lead", name: "Fourth" },
        ],
        active_character_id: "lead",
    });
    const ids = normalized.characters.map(character => character.id);

    assert.deepEqual(ids, ["lead", "character-1", "character-2", "character-3"]);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(normalized.activeCharacterId, "lead");
});


test("character colors and transforms are normalized and bounded", () => {
    assert.equal(normalizeCharacterColor(" #AbC "), "#aabbcc");
    assert.equal(normalizeCharacterColor("#01A2fF"), "#01a2ff");
    assert.equal(normalizeCharacterColor("not-a-color", "#0f8"), "#00ff88");

    assert.deepEqual(normalizeCharacterTransform({
        x: -500,
        y: "12.5",
        depth: 100,
        scale: 20,
    }), {
        x: -50,
        y: 12.5,
        z: 40,
        zoom: 7,
    });
    assert.deepEqual(normalizeCharacterTransform({
        offset_x: "invalid",
        offset_y: Infinity,
        z: -100,
        zoom: 0,
    }), {
        x: 0,
        y: 0,
        z: -40,
        zoom: 0.1,
    });

    const second = createPoseStudioCharacter({
        index: 1,
        color: "invalid",
        transform: { x: 1, y: 2, z: 3, zoom: 4 },
    });
    assert.equal(second.slot, 1);
    assert.equal(second.color, DEFAULT_CHARACTER_COLORS[1]);
    assert.deepEqual(second.transform, { x: 1, y: 2, z: 3, zoom: 4 });
});

test("saved camera framing converts zoom around the model camera target", () => {
    const pivot = { x: 2, y: 10, z: -1 };
    const transform = cameraFramingToCharacterTransform({
        zoom: 2,
        offset_x: 1.5,
        offset_y: -2,
    }, pivot);

    assert.deepEqual(transform, {
        x: 1,
        y: -14,
        z: 1,
        zoom: 2,
    });
    assert.deepEqual({
        x: pivot.x * transform.zoom + transform.x,
        y: pivot.y * transform.zoom + transform.y,
        z: pivot.z * transform.zoom + transform.z,
    }, {
        x: pivot.x + 2 * 1.5,
        y: pivot.y + 2 * -2,
        z: pivot.z,
    });
});

test("saved camera framing rejects incomplete data instead of inventing defaults", () => {
    assert.throws(
        () => cameraFramingToCharacterTransform(
            { zoom: 2, offset_x: 1 },
            { x: 0, y: 1, z: 0 },
        ),
        /requires finite zoom, offsets, and model pivot/,
    );
});


test("character serialization deeply copies mutable scene data", () => {
    const character = {
        id: "hero",
        slot: 2,
        name: "Hero",
        color: "#ABCDEF",
        transform: { x: 1, y: 2, z: 3, zoom: 1.5 },
        mesh: { body: { muscle: 0.8 } },
        poses: [{ bones: { head: [10, 20, 30] } }],
        animation: {
            tracks: { head: { keys: [{ frame: 0, value: [0, 0, 0, 1] }] } },
        },
    };

    const serialized = serializePoseStudioCharacter(character);

    assert.deepEqual(serialized, { ...character, color: "#abcdef" });
    assert.notEqual(serialized.transform, character.transform);
    assert.notEqual(serialized.mesh, character.mesh);
    assert.notEqual(serialized.mesh.body, character.mesh.body);
    assert.notEqual(serialized.poses, character.poses);
    assert.notEqual(serialized.poses[0].bones, character.poses[0].bones);
    assert.notEqual(serialized.animation, character.animation);
    assert.notEqual(serialized.animation.tracks, character.animation.tracks);

    serialized.mesh.body.muscle = 0.1;
    serialized.poses[0].bones.head[0] = 99;
    serialized.animation.tracks.head.keys[0].frame = 20;
    assert.equal(character.mesh.body.muscle, 0.8);
    assert.equal(character.poses[0].bones.head[0], 10);
    assert.equal(character.animation.tracks.head.keys[0].frame, 0);

    character.mesh.body.muscle = 1;
    character.poses[0].bones.head[1] = 77;
    character.animation.tracks.head.keys[0].value[3] = -1;
    assert.equal(serialized.mesh.body.muscle, 0.1);
    assert.equal(serialized.poses[0].bones.head[1], 20);
    assert.equal(serialized.animation.tracks.head.keys[0].value[3], 1);
});


test("character slots stay stable and new colors avoid the remaining defaults", () => {
    const remainingAfterFirstRemoval = [
        { id: "second", slot: 1, color: DEFAULT_CHARACTER_COLORS[1] },
        { id: "third", slot: 2, color: DEFAULT_CHARACTER_COLORS[2] },
        { id: "fourth", slot: 3, color: DEFAULT_CHARACTER_COLORS[3] },
    ];
    assert.equal(nextCharacterSlot(remainingAfterFirstRemoval), 0);
    assert.equal(nextCharacterColor(remainingAfterFirstRemoval, 0), DEFAULT_CHARACTER_COLORS[0]);

    const normalized = normalizePoseStudioCharacters({
        characters: [
            { id: "fourth", slot: 3, color: DEFAULT_CHARACTER_COLORS[3] },
            { id: "second", slot: 1, color: DEFAULT_CHARACTER_COLORS[1] },
        ],
    });
    assert.deepEqual(normalized.characters.map(character => character.slot), [1, 3]);
    assert.deepEqual(
        normalized.characters.map(character => character.id),
        ["second", "fourth"],
    );
    assert.deepEqual(
        normalized.characters.map(character => serializePoseStudioCharacter(character).slot),
        [1, 3],
    );
});


test("each serialized character retains its own poses and animation", () => {
    const normalized = normalizePoseStudioCharacters({
        characters: [
            {
                id: "alice",
                poses: [{ bones: { head: [0, 15, 0] } }],
                animation: {
                    frameCount: 24,
                    tracks: { head: { keys: [{ frame: 6, value: [0, 0.1, 0, 0.99] }] } },
                },
            },
            {
                id: "bob",
                poses: [{ bones: { spine: [5, 0, 0] } }],
                animation: {
                    frameCount: 24,
                    tracks: { spine: { keys: [{ frame: 12, value: [0.1, 0, 0, 0.99] }] } },
                },
            },
        ],
    });
    const saved = normalized.characters.map(character => serializePoseStudioCharacter(character));

    assert.deepEqual(saved[0].poses, [{ bones: { head: [0, 15, 0] } }]);
    assert.deepEqual(saved[1].poses, [{ bones: { spine: [5, 0, 0] } }]);
    assert.deepEqual(Object.keys(saved[0].animation.tracks), ["head"]);
    assert.deepEqual(Object.keys(saved[1].animation.tracks), ["spine"]);

    saved[0].poses[0].bones.head[1] = 90;
    saved[0].animation.tracks.head.keys[0].frame = 18;
    assert.equal(saved[1].poses[0].bones.spine[0], 5);
    assert.equal(saved[1].animation.tracks.spine.keys[0].frame, 12);
    assert.equal(normalized.characters[0].poses[0].bones.head[1], 15);
    assert.equal(normalized.characters[0].animation.tracks.head.keys[0].frame, 6);
});
