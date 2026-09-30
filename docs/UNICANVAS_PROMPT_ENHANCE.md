# UniCanvas prompt enhance

The magic wand in the top-right corner of the **Prompt** and **Negative** boxes rewrites the text
with a Qwen3-VL text encoder (ComfyUI `TextGenerate`) and a per-family system prompt. It is a bare
outline icon: while it works its stroke turns into a flowing gradient, and when it is done sparkles
and confetti burst out and the new prompt replaces the old one (Ctrl+Z restores it).

## Two ways to enhance, two encoders

- **The wand** (manual) runs on a dedicated Qwen3-VL encoder picked in the UniCanvas settings; the
  default is the one Qwen-Image-2.1 uses (`qwen3vl_8b_int8_convrot.safetensors`, Comfy-Org/Qwen-Image-2.1),
  downloaded from Hugging Face into `models/text_encoders` on first use. When that is the very file
  the family already has loaded, it is used as is. Otherwise the encoder is loaded for the rewrite and
  **unloaded again right after it** (`release_enhance_clip`), so it does not keep VRAM.
- **Always enhance when I press Generate** runs in the background right before the prompts are encoded
  and always uses **the CLIP of the family that draws** - no encoder of its own, no extra VRAM. A CLIP
  that cannot generate text (SDXL's) simply keeps your prompt.

## Pictures

Edit-style prompts are written while looking at the canvas (always picture 1) and the Edit-model
references (pictures 2 and up, at most 10). An empty canvas - which an edit model would draw as a
black picture - is ignored: the request stays text-to-image, with the text-to-image prompt and no
pictures at all. Every picture keeps its own aspect ratio and is shrunk to a pixel budget (a 32x32 block is one
token): the canvas up to 1 MP, each reference up to 0.5 MP, the whole set up to 3.5 MP (references
share what the canvas leaves, never below 0.15 MP). Measured on the real encoder: text 20 px tall
on a 1024 px canvas is still read correctly at 0.6 MP, so 1 MP leaves headroom.

The encoder tends to answer English requests in Chinese, so every request gets a short "write the
prose in English" hint after the user's text unless that text is Chinese.

While a Qwen3-VL generation runs outside ComfyUI's executor, the DynamicVRAM state the executor
normally cleans after each node must be released (`_release_generation_state`); skipping it makes
the second generation on the same encoder abort the whole process with a CUDA assert.

## Settings

UniCanvas settings (gear in the widget) > **Prompt enhance**, per node:

- **Magic wand in the prompt boxes** - shows or hides the wands.
- **Always enhance when I press Generate** - see above; the boxes keep what you typed. A failed rewrite
  falls back to your original prompt.
- **Wand encoder** - the Qwen3-VL file the wand uses.
- **Edit system prompts...** - opens the dialog below.

ComfyUI settings > VNCCS > UniCanvas > Prompt enhance (global) > **System prompts per model family**
opens the same dialog: one **tab per model family**, so a family can never be entered twice. Each
family has a text-to-image prompt, an edit prompt (image edit / inpaint / outpaint, written while
looking at the canvas; empty = use the text-to-image one) and a negative prompt (empty = no wand on
the negative box). Changes are saved as you type; a family whose prompts equal the shipped default
stores nothing, so later default updates still reach it. "Clear" removes the wand for a family,
"Reset to shipped default" undoes your edits. The entry text is followed by the user's prompt; a
system prompt that does not end with `:` gets a `User request:` marker. Answers in JSON
(`rewritten_prompt` / `Rewritten`) are unwrapped, so official rewriter prompts work unchanged.

## Never with a VNCSS Config

While a VNCSS Config is linked the wand is hidden and no enhance setting reaches the draw
(frontend: `promptEnhancePayload`; backend: `apply_auto_enhance` skips `request.external`).
A family without a system prompt, or whose negative prompt is unused (`negative_prompt=False`),
shows no wand for that box either. SDXL has no default entry.

## Defaults

`config/prompt_enhance/<family>.<positive|edit|negative>.txt`, served by
`GET /vnccs/unicanvas/prompt_enhance_defaults`. See `config/prompt_enhance/SOURCES.md`.

## Code

`nodes/unicanvas/prompt_enhance.py` (encoder, rewrite), `enhance.py` (defaults + `POST
/vnccs/unicanvas/enhance_prompt`), `draw_pipeline.py::enhance_prompts` (automatic mode),
`web/vnccs_unicanvas_prompt_enhance.mjs` (wand, settings).
