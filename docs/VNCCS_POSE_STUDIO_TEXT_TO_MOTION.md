# Pose Studio: Text to Motion

Describe a motion in words and a motion model turns it into an animation on the Pose Studio
timeline (in UniCanvas' pose editor: a pose picked from the clip). Supported models:

| Model | Starts from your pose | Memory | License |
| --- | --- | --- | --- |
| ARDY Core RP, BF16 motion / INT4 encoder (default) | Yes (frame-0 keyframe) | 4.18 GiB VRAM, 32.46 GiB whole-process RAM measured (includes other resident components) | NVIDIA Open Model License, Meta Llama 3 Community License, MIT adapters |

**ARDY is built in.** Its standalone inference package is in
[`nodes/posestudio/ttm`](../nodes/posestudio/ttm/README.md), including configuration,
skeleton assets, licenses and dependencies. It runs in ComfyUI's own Python and requires
the prepared BF16 motion / INT4 encoder bundle. The encoder waits in RAM between prompts;
closing the Motion panel frees the model and encoder.

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

**Several characters.** The motion goes to the selected character. ARDY is a
single-person model: it cannot generate interactions between characters (a handshake, a hug),
and the panel says so when the scene has more than one character. A model that can declares
`capabilities.max_characters` above 1 in its JSON (default 1; the service rejects requests for
more characters than that). No backend implements that yet; see `MotionBackend` in
`nodes/posestudio/ttm/base.py`.
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
6. To try again, change the prompt or seed and press **Regenerate**. With **Start from current
   pose** enabled, generation starts from the visible pose at the moment you press the button,
   including a selected preview frame. **Cancel** restores the pose the panel was opened with.

Options:

- **Start from current pose** (ARDY): the first frame is
  constrained to your pose. Other models cannot do that, so Pose Studio applies the motion's
  movement since its first frame on top of your pose. Unchecked, ARDY generates freely and its
  movement is applied on top of your pose too.
- **Keep in place**: drops horizontal root travel so the character stays where it stands
  (vertical motion such as a jump or a crouch is kept).

Joints a model does not produce (fingers, extra spine joints, toes on some skeletons) keep your
start pose; head, hands and feet follow the model's rotation change when it provides one.

## ARDY (default)

[ARDY](https://github.com/nv-tlabs/ardy) generates autoregressive motion on a Core skeleton
with 27 joints at 20 FPS. It can constrain frame zero to the current pose. Joints the
model does not produce retain the target pose. The upstream foot-skate post-processing
requires a C++ extension and is not included.

## ARDY with a ConvRot INT4 text encoder

ARDY now uses BF16 motion weights and CUDA BF16 neural computation by default. Only its LLM2Vec text encoder is
quantized to ConvRot W4A4 INT4. Both LLM2Vec adapters are merged in their original
order; the encoder shards are consolidated into `text_encoder/model.safetensors`.
The ARDY denoiser and motion tokenizer use `motion.bf16.safetensors`. All 428 original
FP32 checkpoint tensors are rounded to BF16 and assigned without expanding their
parameter dtype. `options.motion_precision = "bf16"` selects this file for both
components. Neural computation uses CUDA BF16 autocast; the unchanged INT4 encoder
disables caller autocast, and sampling state, statistics and skeleton reconstruction
retain FP32. Original FP32 files are not used by the selected runtime configuration.
Compilation is disabled; the encoder is offloaded to RAM between prompts.

The stable model ID is `ardy-core-rp-20fps-h40`. All runtime files are loaded exclusively
from `ComfyUI/models/text_to_motion/ARDY-Core-RP-20FPS-Horizon40-int4/`. The project
publication copy is not a runtime source. The model card's **Download** button installs
`MIUProject/ARDY-Core-RP-20FPS-Horizon40-int4` at revision
`68dffcc920b468027c0a9a64036a0cc457c7d4b8` into that same directory. The explicit
24-file manifest includes motion, encoder, tokenizer, statistics and licenses.
Downloads use `token=False`; existing files are reused only after checking pinned
sizes and safetensors headers. Interrupted downloads can be retried. No upstream FP32 motion, original encoder or adapters are fetched.
Generation requires the downloaded runtime files; it does not perform conversion.

The Python module does not include weight files. Its local model specification and
24-file pinned manifest travel with the package. See the standalone README for installation
and direct inference outside ComfyUI. Conversion scripts and temporary validation reports
are not part of the runtime.

Recorded on RTX 5070 Ti: 1.929 s warm generation for a two-second walking clip;
4.18 GiB allocated VRAM, 4.31 GiB reserved VRAM, 31.12 GiB process RAM during generation
and 32.46 GiB across loading/generation. The trial includes encoder execution/transfers.
Whole-process RAM includes other resident ComfyUI components. These are single-prompt
measurements, not model-only memory requirements or universal speed guarantees.

The shared Mixamo skeleton projection preserves the target rig's local bone offsets;
only the pelvis receives root translation. ARDY exports 22 mapped world rotations,
including shoulders, neck and head. Source spine segments are projected onto the target
spine hierarchy. Different character proportions can still change hand and foot contacts.
The upstream foot-skate post-processing is not included.
