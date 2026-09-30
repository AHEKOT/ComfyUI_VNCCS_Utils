# Default prompt-enhance system prompts

Official prompts are copied verbatim (the FLUX.2, Qwen and Z-Image ones only get the user-text
marker at the end); the rest are written for this project because no official flow exists.

| Family | Files | Origin |
| --- | --- | --- |
| `qwen_image21` | positive, edit | Official: https://github.com/QwenLM/Qwen-Image-2.1/tree/main/prompt_rewrite/prompts (`system_prompt_t2i.txt`, `system_prompt_edit.txt`) |
| `qwen_image_edit` | positive, edit | Official: https://github.com/QwenLM/Qwen-Image `src/examples/tools/prompt_utils.py` (`polish_prompt_en`, `polish_edit_prompt`) |
| `flux_klein` | positive, edit | Official: https://github.com/black-forest-labs/flux2 `src/flux2/system_messages.py` (`SYSTEM_MESSAGE_UPSAMPLING_T2I`, `_I2I`) |
| `z_image` | positive | Official PE template: https://huggingface.co/spaces/Tongyi-MAI/Z-Image-Turbo `pe.py` (plus one line asking for English output) |
| `anima` | positive, negative | Written here from https://huggingface.co/circlestone-labs/Anima and the tag conventions in `models/anima.py` |
| `minimax_h3` | positive, edit | Written here (no official flow); picture roles follow https://github.com/astropuzzo/ComfyUI-MiniMax-H3-Image-Studio |
| `krea2_edit` | edit | Written here from https://github.com/lbouaraba/comfyui-krea2edit |

`sdxl` has no entry: its CLIP-only encoders cannot run `TextGenerate`.

Every request gets a short English-language hint appended after the user's text unless that text is
Chinese (`compose_request`): the 8B encoder otherwise answers English requests in Chinese.
