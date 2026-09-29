# Pose Studio: Text to Motion

Describe a motion in words, let a motion model generate it, scrub to the frame you like and
press **OK**: the mannequin takes that pose. Supported models:

| Model | Starts from your pose | VRAM (approx.) | License |
| --- | --- | --- | --- |
| [NVIDIA Kimodo](https://research.nvidia.com/labs/sil/projects/kimodo/) SOMA RP v1.1 | Yes (frame-0 keyframe) | ~17 GB, under 3 GB with `TEXT_ENCODER_DEVICE=cpu` | NVIDIA Open Model License |
| [Tencent HY-Motion 1.0](https://github.com/Tencent-Hunyuan/HY-Motion-1.0) Lite | No (motion is applied on top of your pose) | 24 GB | Tencent HY-Motion 1.0 Community License, **not valid in the EU, UK and South Korea** |
| Tencent HY-Motion 1.0 | No (motion is applied on top of your pose) | 26 GB | Same as above |

Model code and weights are optional. Pose Studio works without them; the panel shows which
models are installed and how to install the missing ones.

## Animation and UniCanvas

In **Animation** mode, stand on a timeline frame and press **🏃 Motion**: the pose at that frame is
the start pose. Generate and preview the clip; **OK** deletes everything from that frame onward
(all tracks) and writes the clip there, so the animation ends where the clip ends and the frames
before it stay untouched (one undo step). **Cancel** keeps the previous animation exactly as it
was. Clips are keyed at the animation's frame rate, sparsely for long clips, with linear
interpolation in between; edit them on the timeline and export as usual.

**Several characters.** The motion goes to the selected character. Kimodo and HY-Motion are
single-person models: they cannot generate interactions between characters (a handshake, a hug),
and the panel says so when the scene has more than one character. A model that can declares
`capabilities.max_characters` above 1 in its JSON (default 1; the service rejects requests for
more characters than that). No backend implements that yet; see `MotionBackend` in
`api/text_to_motion/base.py`.
UniCanvas' pose editor has the same **Motion** button and panel, because it embeds Pose Studio.

Outside Animation mode the panel picks one frame as the pose (below).

## Using it

1. In pose edit mode, press **🏃 Motion** in the action bar.
2. Pick a model at the top of the panel. A model whose license excludes some territories shows
   an orange warning naming them, with a link to the license.
3. Write a prompt (for example *"A person jumps and lands on both feet."*), set the length in
   seconds, the steps (and guidance for HY-Motion) and a seed, then press **Generate**.
4. The generated motion appears on the timeline. Drag the scrubber (the pose updates live) or
   press ▶ to play it.
5. **OK** applies the selected frame as the pose (one undo step). **Cancel** or **Esc** restores
   the pose you started from.
6. To try again, change the prompt or seed and press **Regenerate**. Every generation starts
   from the pose the panel was opened with.

Options:

- **Start from current pose**: Kimodo constrains its first frame to your pose. HY-Motion cannot
  do that, so Pose Studio applies the motion's movement since its first frame on top of your
  pose. Unchecked, Kimodo generates freely and its movement is applied on top of your pose too.
- **Keep in place**: drops horizontal root travel so the character stays where it stands
  (vertical motion such as a jump or a crouch is kept).

Joints a model does not produce (fingers, extra spine joints, toes on some skeletons) keep your
start pose; head, hands and feet follow the model's rotation change when it provides one.

## Installing Kimodo

Kimodo is a pip package:

    pip install git+https://github.com/nv-tlabs/kimodo

Kimodo downloads its checkpoint (`nvidia/Kimodo-SOMA-RP-v1.1`) and its LLM2Vec text encoder on
the first generation, into the Hugging Face cache (or `$CHECKPOINT_DIR` / `$TEXT_ENCODERS_DIR`
if you set them). The text encoder is built on the gated `meta-llama/Meta-Llama-3-8B-Instruct`:
request access on its Hugging Face page and run `hf auth login` once in ComfyUI's environment.

Most of the memory is the text encoder. Start ComfyUI with `TEXT_ENCODER_DEVICE=cpu` to keep it
on the CPU; the motion model itself then needs under 3 GB of VRAM.

## Installing HY-Motion 1.0

HY-Motion's code is not a pip package. Clone it with git-lfs (the body model files are LFS) into
ComfyUI's models folder and install its dependencies:

    git lfs install
    git clone https://github.com/Tencent-Hunyuan/HY-Motion-1.0 <ComfyUI>/models/text_to_motion/code/HY-Motion-1.0
    pip install torchdiffeq transformers accelerate einops pyyaml omegaconf

On the first generation Pose Studio downloads the checkpoint (`tencent/HY-Motion-1.0`, only the
selected subfolder's files) and the text encoders (`Qwen/Qwen3-8B`, `openai/clip-vit-large-patch14`)
into `<ComfyUI>/models/text_to_motion/`, file by file with `hf_hub_download(token=False)`
(public repositories only; Pose Studio never reads credentials). Revisions are `main` until pinned.

**License territory.** The Tencent HY-Motion 1.0 Community License Agreement states: *"THIS
LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA AND IS
EXPRESSLY LIMITED TO THE TERRITORY"* and *"You must not use, reproduce, modify, distribute, or
display the Tencent HY-MOTION 1.0 Works, Output or results of the Tencent HY-MOTION 1.0 Works
outside the Territory."* Do not use HY-Motion, or poses made with it, in those territories.

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
  }
}
```

A new family implements `MotionBackend` (`api/text_to_motion/base.py`):

- `requires`: Python modules it needs; `check_available()` turns missing ones into an install hint.
- `load(report)`: load the model (use `ensure_weights(report)` for managed downloads).
- `generate(request, report)`: return a `SourceMotion` (`api/text_to_motion/transform.py`):
  world joint positions `[T, J, 3]` (y up, meters), optional world rotations `[T, J, 3, 3]`,
  and maps from Pose Studio's motion joints (`MOTION_JOINT_KEYS`) and rotation bones
  (`MOTION_ROTATION_BONES`) to the model's joint names. Leave out joints the skeleton lacks.
  `soma.py` (Kimodo) and `smplh.py` (SMPL-H, HY-Motion) are ready-made skeleton descriptions.
- `unload()`: free the model.

Then add the loader to `BACKENDS` in `registry.py`. The service places the motion on the
mannequin (heading, leg-length scale, pelvis anchor) and the browser retargets it, so nothing
else changes.

## HTTP API

| Route | Purpose |
| --- | --- |
| `GET /vnccs/pose_studio/motion/models` | Models with capabilities, license, availability and install hint |
| `POST /vnccs/pose_studio/motion/generate` | `{model, prompt, duration, steps, guidance, seed, use_start_pose, keypoints, rest_keypoints, head_axes, task_id}` → `{motion}` |
| `GET /vnccs/pose_studio/motion/status/{task_id}` | Progress of a running generation |
| `POST /vnccs/pose_studio/motion/unload` | Free the loaded model |

One model is loaded at a time; switching models unloads the previous one. Generation shares
UniCanvas' model lock and unloads ComfyUI's models first to make room.
