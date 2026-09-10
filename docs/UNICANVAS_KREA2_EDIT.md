# UniCanvas Krea2 Identity Edit

UniCanvas includes Krea2 Identity Edit v1.2 as an image-editing module. Import an image, place the bbox over the area to edit, select **Krea2 Edit** in the model picker, and describe the change in Prompt. An empty bbox is rejected before loading weights.

Two cards use the same edit module:

| Card | Defaults | Intended use |
| --- | --- | --- |
| Krea2 Edit | Turbo FP8, 10 steps, CFG 1, Euler / simple | Recoloring, adding objects, changing attributes and style |
| Krea2 Edit Raw | Raw FP8, 20 steps, CFG 3, Euler / simple | Object removal and larger changes needing stronger guidance |

The upstream author recommends Raw with guidance for removing salient content; distilled Turbo may reproduce the subject instead. Start around 1024 × 1024 inference resolution. The author recommends staying at or below 2 megapixels; larger inputs can duplicate subjects or bleed source content. UniCanvas's existing inference-scale control still applies.

## Download and runtime requirements

Selecting a missing preset starts the existing card download flow. Each card contains four required public weights:

| Role | File under the ComfyUI models directory | Publisher |
| --- | --- | --- |
| Diffusion model | `diffusion_models/krea2_turbo_fp8_scaled.safetensors` or `diffusion_models/krea2_raw_fp8_scaled.safetensors` | Comfy-Org/Krea-2 |
| Image/text encoder | `text_encoders/qwen3vl_4b_fp8_scaled.safetensors` | Comfy-Org/Krea-2 |
| VAE | `vae/qwen_image_vae.safetensors` | Comfy-Org/Krea-2 |
| Required edit LoRA | `loras/Krea2/krea2_identity_edit_v1_2.safetensors` | conradlocke/krea2-identity-edit |

Both cards share the encoder, VAE and LoRA; existing files are reused. The card is ready only when all four assets exist. The edit LoRA always runs at model strength 1 and CLIP strength 0, independently of optional Turbo toggles and the LoRA Stack. A duplicate entry for that adapter in the optional stack is ignored.

ComfyUI must include native Krea2, Qwen3-VL, and EmptySD3LatentImage support. The bundled edit implementation requires no separate custom-node package or additional Python dependency beyond ComfyUI and VNCCS-Utils. The FP8 preset's hardware and memory behavior depend on the ComfyUI host; model inference was not executed with full weights on the development Mac.

Downloads use the existing Hugging Face downloader with `token=False`, pinned to these revisions:

- `Comfy-Org/Krea-2`: `e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96`
- `conradlocke/krea2-identity-edit`: `89e9e7a09ee2e5c9331e952063d79b1b8a703280`

## Likeness

The upper-right **Likeness** slider and numeric field range from 0 to 10, defaulting to **4**. They update together during interaction. Each card remembers its value across card changes and workflow serialization.

Likeness maps directly to the author's `ref_boost`. It adds `log(max(likeness, 0.0001))` to target-to-reference attention logits. This multiplies the relative reference attention weight before normalization:

- **1** leaves reference attention at its baseline.
- **4** is the supplied workflow's starting value.
- Lower values permit larger departures from the reference.
- Higher values favor source appearance, potentially resisting the requested edit.

Zero strongly suppresses the reference attention path; the source remains available through image-grounded text conditioning. Likeness is not a denoise percentage. The edit sampler always runs at denoise 1.

`grounding_px` is a separate upstream quality control: the resolution of the image seen by Qwen3-VL. UniCanvas fixes it at 768, the upstream default, and exposes `ref_boost` as Likeness. The negative branch always encodes the same image with an empty instruction, including when CFG exceeds 1. The Negative field is disabled for this module; its previous text remains available when switching to other models.

## Inference contract

The integration follows the author's single-image workflow:

1. Load native Krea2 and Qwen3-VL with CLIP type `krea2`; apply Identity Edit v1.2.
2. Encode the edit instruction together with the bbox image through Qwen3-VL. Encode an empty instruction with the same image for the unconditional branch.
3. Create an empty 16-channel SD3 target latent at the requested inference dimensions and batch size.
4. Fit the source in pixel space using the author's v1.2 geometry, VAE-encode it once **before sampling**, and apply the model's latent scaling.
5. Run attention over `[text | clean source (frame 1) | noisy target (frame 0)]`; return only target tokens. Apply Likeness to target-to-source attention.
6. Sample and decode, then use UniCanvas's existing mask compositing and result-layer handling.

Inpaint and outpaint retain their existing masks, edge blending and output placement. The mask controls final result compositing; it does not replace the edit workflow with an SDXL inpaint latent or partial-denoise source initialization. Outpaint uses the existing black missing-region reference and prompt suffix. In panorama mode the current perspective bbox supplies the image and generated edits use the existing projection back onto the panorama.

The module uses one bbox image. The upstream optional second reference and regional reference-attention mask are not exposed by this integration.

## Sources and validation

- [Author's example workflow](https://github.com/lbouaraba/comfyui-krea2edit/blob/86f886dac23013d88996e3a2e99093ba44d322fb/workflows/krea2_identity_edit.json)
- [Edit nodes and inference notes](https://github.com/lbouaraba/comfyui-krea2edit)
- [Identity Edit model card](https://huggingface.co/conradlocke/krea2-identity-edit)
- [Native Krea2 split weights](https://huggingface.co/Comfy-Org/Krea-2)

The private helper is adapted from upstream revision `86f886dac23013d88996e3a2e99093ba44d322fb`, under Apache-2.0. Attribution, modifications and license text are in `licenses/comfyui-krea2edit-NOTICE` and `licenses/comfyui-krea2edit-LICENSE`. Model weights retain the publishers' own licenses.

Automated tests cover required weights, preset identity, mandatory LoRA application, image-grounded positive and negative encoding, clean source token order, attention bias, reference encoding timing, native wrapper signatures, full-denoise empty targets in all edit modes, and immediate slider/number synchronization and persistence. Full-weight inference and visual quality still require verification on the actual ComfyUI host.
