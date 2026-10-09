# Pose Studio: Text to Motion

Describe a motion in words and a motion model turns it into an animation on the Pose Studio
timeline (in UniCanvas' pose editor: a pose picked from the clip). Supported models:

| Model | Starts from your pose | VRAM (approx.) | License |
| --- | --- | --- | --- |
| [NVIDIA ARDY](https://research.nvidia.com/labs/sil/projects/ardy/) Core RP 20FPS (default) | Yes (frame-0 keyframe) | Built in. Small motion model; the 8B text encoder waits in RAM (~16 GB) and uses the GPU only while reading the prompt | NVIDIA Open Model License (weights), Apache 2.0 (code) |
| [NVIDIA Kimodo](https://research.nvidia.com/labs/sil/projects/kimodo/) SOMA RP v1.1 | Yes (frame-0 keyframe) | Built in, same text encoder as ARDY | NVIDIA Open Model License (weights), Apache 2.0 (code) |

**ARDY and Kimodo are built in.** Their inference code is part of VNCCS Utils
(`api/text_to_motion/vendor/`) and runs in ComfyUI's own Python like UniCanvas Draw: nothing to
install, no extra process. The first generation downloads the checkpoint and the text encoder
into `models/text_to_motion`. The text encoder (Llama 3 8B) waits in system RAM and is moved to
the GPU only while your prompt is read; closing the Motion panel frees the model and the encoder.

Model code and weights are optional. Pose Studio works without them. The model list marks each
model **ready** or **needs setup**, and the card under it says what the model is good at (start
pose, maximum length, memory, download size) and, until it is ready, lists its setup steps:

- **Python packages** (`pip` steps, for future models whose dependencies are safe in ComfyUI's
  Python; none of the bundled models uses one) have an **Install** button that queues
  `pip install` through ComfyUI-Manager and then offers **Restart ComfyUI**. Manager only
  allows it with `allow_pip_install = true` in its `config.ini`; Pose Studio never edits that
  file and the card says what to change when Manager refuses.
- **Code checkouts** and **gated logins** are manual steps with a **Copy** button for the
  command and a link. They are not installed through Manager on purpose: Manager's git install
  also runs the repository's `requirements.txt`, and these repositories pin torch, numpy and
  transformers versions that would break ComfyUI.
- **Downloads** Pose Studio can do itself have a **Download** button;
  model weights listed as automatic are fetched on the first generation.
- **Check again** looks for the installed parts after you did a manual step.

## Animation and UniCanvas

**🏃 Motion** always works on the animation: pressed in Image mode it switches Pose Studio to
Animation mode first. Stand on a timeline frame and press it: the pose at that frame is the start
pose. Generate and preview the clip; **Use as animation** deletes everything from that frame onward
(all tracks) and writes the clip there, so the animation ends where the clip ends and the frames
before it stay untouched (one undo step). **Cancel** keeps the previous animation exactly as it
was. Clips are keyed at the animation's frame rate, sparsely for long clips, with linear
interpolation in between; edit them on the timeline and export as usual.

**Several characters.** The motion goes to the selected character. ARDY and Kimodo are
single-person models: they cannot generate interactions between characters (a handshake, a hug),
and the panel says so when the scene has more than one character. A model that can declares
`capabilities.max_characters` above 1 in its JSON (default 1; the service rejects requests for
more characters than that). No backend implements that yet; see `MotionBackend` in
`api/text_to_motion/base.py`.
UniCanvas' pose editor has the same **Motion** button and panel, because it embeds Pose Studio.
It edits a single pose, so there the panel keeps that pose mode: drag the slider to the frame you
like and press **Use this frame**.

## Using it

1. Press **🏃 Motion** in the action bar (Pose Studio switches to Animation mode).
2. Pick a model at the top of the panel; the card under it helps you choose and set it up. A
   model whose license excludes some territories shows an orange warning naming them, with a
   link to the license.
3. Write a prompt (for example *"A person jumps and lands on both feet."*), set the length in
   seconds, the steps or guidance supported by the model and a seed, then press **Generate**.
4. The generated motion appears on the timeline. Drag the scrubber (the pose updates live) or
   press ▶ to play it.
5. **Use as animation** writes the clip to the timeline (one undo step); in UniCanvas, **Use this
   frame** applies the selected frame as the pose. **Cancel** or **Esc** restores what you
   started from.
6. To try again, change the prompt or seed and press **Regenerate**. Every generation starts
   from the pose the panel was opened with.

Options:

- **Start from current pose** (ARDY and Kimodo): the first frame is
  constrained to your pose. Other models cannot do that, so Pose Studio applies the motion's
  movement since its first frame on top of your pose. Unchecked, ARDY or Kimodo generates freely and its
  movement is applied on top of your pose too.
- **Keep in place**: drops horizontal root travel so the character stays where it stands
  (vertical motion such as a jump or a crouch is kept).

Joints a model does not produce (fingers, extra spine joints, toes on some skeletons) keep your
start pose; head, hands and feet follow the model's rotation change when it provides one.

## ARDY (default) and Kimodo

[ARDY](https://github.com/nv-tlabs/ardy) is NVIDIA's autoregressive successor to
[Kimodo](https://github.com/nv-tlabs/kimodo), built for real-time generation, so it is the
default. Both start exactly from your pose (a frame-0 keyframe). ARDY's Core skeleton (27 joints,
20 FPS) uses Mixamo-style names; Kimodo uses the SOMA skeleton with fingers (30 FPS). Joints a
model lacks keep your start pose.

Nothing has to be installed. On the first generation Pose Studio downloads, file by file with
`token=False` (no Hugging Face login):

- the checkpoint, `nvidia/ARDY-Core-RP-20FPS-Horizon40` or `nvidia/Kimodo-SOMA-RP-v1.1`, into
  `models/text_to_motion/checkpoints/`;
- the shared LLM2Vec text encoder into `models/text_to_motion/text_encoders/`: Meta Llama 3 8B
  Instruct from the ungated mirror `NousResearch/Meta-Llama-3-8B-Instruct` plus the
  `McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp` and `-mntp-supervised` adapters (~17 GB).

If a download is refused (for example a repository became gated), download that repository
yourself into the folder the error names and put an empty file called `.complete` next to it.
Each repository revision has its own `revisions/<identity>` folder. Changing a revision
downloads that revision separately; files and markers from older folders are not reused.
The upstream foot-skate post-processing is a C++ extension and is not included.

## Adding another model

Every model is one JSON file in `config/motion_models/`. A new checkpoint of a supported family
needs only a new file; a new family also needs a backend class.

```jsonc
{
  "id": "kimodo-soma-rp-v1.1",          // lowercase, unique
  "name": "Kimodo SOMA RP v1.1",        // shown in the model picker
  "order": 10,                           // picker order
  "backend": "kimodo",                   // key in api/text_to_motion/registry.py BACKENDS
  "description": "...",
  "homepage": "https://...",
  "code": { "url": "https://github.com/...", "install": "shown when the model is missing" },
  "weights": [
    {
      "role": "model",                   // backend-specific: model, text_encoder_llm, ...
      "source": "huggingface",
      "repo_id": "org/repo",
      "revision": "main",
      "files": ["subfolder/config.yml"],  // exact files, fetched with hf_hub_download(token=False)
      "optional_files": [],              // skipped when the repository lacks them
      "index_file": "",                  // safetensors index: every shard it lists is fetched too
      "local_dir": "folder under models/text_to_motion",
      "managed": true,                   // false: the model's own code downloads it (no files needed)
      "gated": false
    }
  ],
  "options": {},                         // backend-specific settings
  "capabilities": {
    "start_pose_constraint": true,       // the model can start from a given pose
    "max_characters": 1,                 // >1 only for models that generate interactions
    "duration": { "min": 1, "max": 10, "default": 4 },
    "steps": { "min": 10, "max": 200, "default": 100 },       // omit if not adjustable
    "guidance": { "min": 1, "max": 10, "default": 5 }         // omit if not adjustable
  },
  "requirements": { "vram_gb": 17, "notes": "shown under the picker" },
  "license": {
    "name": "...", "url": "https://...", "commercial_use": true,
    "restricted_territories": ["..."],   // non-empty -> warning in the panel
    "territory_notice": "exact license wording",
    "notice": "attribution notice required by the license"
  },
  "guide": {                             // the card that helps users pick a model
    "summary": "one or two sentences: what it is, its main strength or limit",
    "best_for": "kinds of motion it suits",
    "setup_effort": "how hard the setup is",
    "download_gb": 17
  },
  "setup": [                             // shown with a status mark until the model is ready
    // pip: Install button via ComfyUI-Manager; done when every module imports
    { "id": "package", "kind": "pip", "label": "...", "packages": ["einops>=0.7"], "modules": ["einops"] },
    // manual: explanation, optional command (Copy button) and https link; "check" asks the backend
    { "id": "code", "kind": "manual", "check": "code", "label": "...", "command": "git clone ...", "link": "https://..." },
    // download: Download button, runs backend.run_download(step); auto: happens on first generation
    { "id": "weights", "kind": "auto", "check": "weights", "label": "..." }
  ]
}
```

`pip` packages must be plain requirement names (optionally pinned) or `git+https://github.com/...`
URLs. There is no `git` kind: install code checkouts as `manual` steps (see above).

A new family implements `MotionBackend` (`api/text_to_motion/base.py`):

- `requires`: Python modules it needs; `check_available()` turns missing ones into an install hint.
- `load(report)`: load the model (use `ensure_weights(report)` for managed downloads).
- `generate(request, report)`: return a `SourceMotion` (`api/text_to_motion/transform.py`):
  world joint positions `[T, J, 3]` (y up, meters), optional world rotations `[T, J, 3, 3]`,
  and maps from Pose Studio's motion joints (`MOTION_JOINT_KEYS`) and rotation bones
  (`MOTION_ROTATION_BONES`) to the model's joint names. Leave out joints the skeleton lacks.
  `soma.py` provides the Kimodo skeleton description.
- `unload()`: free the model.
- `check_part(name)`: answer the `check` names your setup steps use (`True`/`False`), and
  `run_download(step, report)` for a `download` step.

Then add the loader to `BACKENDS` in `registry.py`. The service places the motion on the
mannequin (heading, leg-length scale, pelvis anchor) and the browser retargets it, so nothing
else changes.

## HTTP API

| Route | Purpose |
| --- | --- |
| (files) `models/text_to_motion/workers/`, `jobs/` | Isolated worker heartbeats and jobs, see `api/text_to_motion/worker_protocol.py` |
| `GET /vnccs/pose_studio/motion/models` | Models with capabilities, license, availability install hint, guide and setup step status |
| `GET /vnccs/pose_studio/motion/setup/policy` | ComfyUI-Manager's install policy (read-only: config path, `allow_pip_install`, listener) |
| `POST /vnccs/pose_studio/motion/setup/download` | Run a model's `download` setup step (same-origin requests with `X-VNCCS-CSRF: 1`) |
| `POST /vnccs/pose_studio/motion/generate` | `{model, prompt, duration, steps, guidance, seed, use_start_pose, keypoints, rest_keypoints, head_axes, task_id}` → `{motion}` |
| `GET /vnccs/pose_studio/motion/status/{task_id}` | Progress of a running generation |
| `POST /vnccs/pose_studio/motion/unload` | Free the loaded model |

One model is loaded at a time; switching models unloads the previous one. Generation shares
UniCanvas' model lock and unloads ComfyUI's models first to make room.
