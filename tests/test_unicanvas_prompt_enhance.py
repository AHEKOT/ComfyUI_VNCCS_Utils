import types
import unittest
from unittest.mock import patch

from helpers.unicanvas_package import load_unicanvas_package


def _stub_torch():
    fake_torch = types.ModuleType("torch")
    fake_torch.Tensor = object
    return fake_torch


UNICANVAS = load_unicanvas_package("vnccs_unicanvas_prompt_enhance_test", torch_module=_stub_torch())
ENHANCE = UNICANVAS.prompt_enhance


def _request(**overrides):
    values = dict(
        settings={"prompt_enhance": {"positive_system": "T2I:", "edit_system": "EDIT:", "negative_system": "NEG:"}},
        external=None,
        positive_text="a cat",
        negative_text="blurry",
        draw_id="test",
        steps=8,
    )
    values.update(overrides)
    return types.SimpleNamespace(**values)


class ExtractPromptTests(unittest.TestCase):
    def test_official_json_answers(self):
        self.assertEqual(ENHANCE.extract_prompt('{"rewritten_prompt": "A red cat.", "wh_ratio": "3:2"}'), "A red cat.")
        self.assertEqual(ENHANCE.extract_prompt('```json\n{"Rewritten": "Replace the hat."}\n```'), "Replace the hat.")

    def test_truncated_json_still_yields_the_prompt(self):
        self.assertEqual(ENHANCE.extract_prompt('{"rewritten_prompt": "A red cat.", "wh_ra'), "A red cat.")

    def test_json_without_a_prompt_yields_nothing(self):
        self.assertEqual(ENHANCE.extract_prompt('{"wh_ratio": "3:2"}'), "")

    def test_thinking_and_plain_text(self):
        self.assertEqual(ENHANCE.extract_prompt("<think>hmm</think>\n\"A red cat,\nsitting.\""), "A red cat, sitting.")
        self.assertEqual(ENHANCE.extract_prompt("<think>never closed"), "")

    def test_compose_request_marker(self):
        self.assertTrue(ENHANCE.compose_request("Rewrite:", " cat ").startswith("Rewrite:\ncat\n\n("))
        self.assertTrue(ENHANCE.compose_request("Rewrite it.", "cat").startswith("Rewrite it.\n\nUser request:\ncat"))

    def test_english_hint_only_for_requests_that_are_not_chinese(self):
        self.assertIn("write the descriptive prose of your answer in English", ENHANCE.compose_request("Rewrite:", "a red cat"))
        self.assertEqual(ENHANCE.compose_request("Rewrite:", "把猫变成蓝色"), "Rewrite:\n把猫变成蓝色")


class AutoEnhanceTests(unittest.TestCase):
    def run_auto(self, request, source=None, draw_clip="draw-clip"):
        calls = []

        def fake(clip, text, system, images=None):
            calls.append((clip, text, system, bool(images)))
            return f"[{text}]"

        with patch.object(ENHANCE, "enhance_text", fake):
            ENHANCE.apply_auto_enhance(request, draw_clip, source)
        return calls

    def test_text_to_image_uses_the_positive_system_prompt_on_the_draws_clip(self):
        request = _request()
        calls = self.run_auto(request)
        self.assertEqual(calls, [("draw-clip", "a cat", "T2I:", False), ("draw-clip", "blurry", "NEG:", False)])
        self.assertEqual((request.positive_text, request.negative_text), ("[a cat]", "[blurry]"))

    def test_edit_draw_uses_the_edit_system_prompt_and_the_canvas(self):
        from PIL import Image

        request = _request()
        with patch.object(ENHANCE, "reference_images", lambda settings: []):
            calls = self.run_auto(request, Image.new("RGB", (8, 8)))
        self.assertEqual(calls[0], ("draw-clip", "a cat", "EDIT:", True))

    def test_references_over_an_empty_canvas_stay_text_to_image(self):
        from PIL import Image

        request = _request()
        with patch.object(ENHANCE, "reference_images", lambda settings: [Image.new("RGB", (8, 8))]):
            calls = self.run_auto(request, None)
        self.assertEqual(calls[0], ("draw-clip", "a cat", "T2I:", False))

    def test_automatic_mode_never_loads_an_encoder_of_its_own(self):
        request = _request(settings={"prompt_enhance": {"model": "other.safetensors", "positive_system": "T2I:"}})

        def forbidden(*_args, **_kwargs):
            raise AssertionError("automatic mode must use the draw's CLIP only")

        with patch.object(ENHANCE, "load_enhance_clip", forbidden), patch.object(ENHANCE, "resolve_enhance_clip_name", forbidden):
            calls = self.run_auto(request)
        self.assertEqual(calls[0][0], "draw-clip")

    def test_linked_config_missing_setting_or_no_clip_leaves_prompts_alone(self):
        linked = _request(external={"model": object()})
        self.assertEqual(self.run_auto(linked), [])
        self.assertEqual(linked.positive_text, "a cat")
        self.assertEqual(self.run_auto(_request(settings={})), [])
        self.assertEqual(self.run_auto(_request(), draw_clip=None), [])

    def test_failure_keeps_the_original_prompts(self):
        request = _request()

        def boom(*_args, **_kwargs):
            raise RuntimeError("CLIP cannot generate")

        with patch.object(ENHANCE, "enhance_text", boom):
            ENHANCE.apply_auto_enhance(request, object(), None)
        self.assertEqual((request.positive_text, request.negative_text), ("a cat", "blurry"))


class EditImagesTests(unittest.TestCase):
    def test_canvas_is_always_picture_one_then_the_references(self):
        from PIL import Image

        refs = [Image.new("RGB", (32, 32)), Image.new("RGB", (64, 32))]
        canvas = Image.new("RGB", (64, 64), (255, 0, 0))
        with patch.object(ENHANCE, "reference_images", lambda _settings: refs):
            self.assertEqual(ENHANCE.edit_images(canvas, {}), [canvas, *refs])

    def test_an_empty_canvas_is_ignored_even_with_references(self):
        from PIL import Image

        with patch.object(ENHANCE, "reference_images", lambda _settings: [Image.new("RGB", (32, 32))]):
            self.assertIsNone(ENHANCE.edit_images(None, {}))


class FitImagesTests(unittest.TestCase):
    def test_canvas_budget_is_the_same_for_wide_tall_and_square(self):
        from PIL import Image

        for size in ((1024, 1024), (2048, 512), (512, 2048), (4000, 3000)):
            (fitted,) = ENHANCE.fit_images([Image.new("RGB", size)])
            self.assertLessEqual(fitted.width * fitted.height, ENHANCE.CANVAS_PIXELS * 1.06, size)
            self.assertEqual((fitted.width % 32, fitted.height % 32), (0, 0), size)
            self.assertAlmostEqual(fitted.width / fitted.height, size[0] / size[1], delta=0.2, msg=size)

    def test_small_pictures_are_not_upscaled_and_keep_their_own_aspect(self):
        from PIL import Image

        canvas, reference = ENHANCE.fit_images([Image.new("RGB", (320, 320)), Image.new("RGB", (640, 160))])
        self.assertEqual(canvas.size, (320, 320))
        self.assertEqual(reference.size, (640, 160))

    def test_many_references_share_the_total_budget(self):
        from PIL import Image

        few = ENHANCE.fit_images([Image.new("RGB", (1024, 1024))] + [Image.new("RGB", (2000, 2000)) for _ in range(2)])
        many = ENHANCE.fit_images([Image.new("RGB", (1024, 1024))] + [Image.new("RGB", (2000, 2000)) for _ in range(10)])
        self.assertGreater(few[1].width, many[1].width)
        self.assertGreaterEqual(many[1].width * many[1].height, ENHANCE.MIN_REFERENCE_PIXELS * 0.9)
        self.assertLessEqual(sum(image.width * image.height for image in few), ENHANCE.TOTAL_PIXELS * 1.05)


class EnhanceTextTests(unittest.TestCase):
    def test_tokenizes_each_picture_and_decodes_the_answer(self):
        from PIL import Image

        calls = {}

        class FakeClip:
            def tokenize(self, text, **kwargs):
                calls["tokenize"] = (text, kwargs)
                return "tokens"

            def generate(self, tokens, **kwargs):
                calls["generate"] = (tokens, kwargs)
                return [1, 2]

            def decode(self, ids):
                return '{"rewritten_prompt": "A red cat."}'

        with patch.object(ENHANCE, "_pil_to_image_tensor", lambda image: image.size), patch.object(ENHANCE, "_release_generation_state", lambda: None):
            out = ENHANCE.enhance_text(FakeClip(), "cat", "Rewrite:", [Image.new("RGB", (64, 64)), Image.new("RGB", (96, 32))])
        self.assertEqual(out, "A red cat.")
        self.assertTrue(calls["tokenize"][0].startswith("Rewrite:\ncat"))
        self.assertEqual(calls["tokenize"][1]["images"], [(64, 64), (96, 32)])
        self.assertEqual(calls["generate"][1]["max_length"], ENHANCE.MAX_NEW_TOKENS)
        self.assertNotIn("images", ENHANCE_TEXT_ONLY(FakeClip))

    def test_text_only_sends_no_images(self):
        seen = {}

        class FakeClip:
            def tokenize(self, text, **kwargs):
                seen.update(kwargs)
                return "tokens"

            def generate(self, tokens, **kwargs):
                return []

            def decode(self, ids):
                return "plain"

        with patch.object(ENHANCE, "_release_generation_state", lambda: None):
            self.assertEqual(ENHANCE.enhance_text(FakeClip(), "cat", "Rewrite:"), "plain")
        self.assertNotIn("images", seen)


def ENHANCE_TEXT_ONLY(clip_class):
    seen = {}

    class Probe(clip_class):
        def tokenize(self, text, **kwargs):
            seen.update(kwargs)
            return "tokens"

    with patch.object(ENHANCE, "_release_generation_state", lambda: None):
        ENHANCE.enhance_text(Probe(), "cat", "Rewrite:")
    return seen


class SharedEncoderTests(unittest.TestCase):
    def test_same_file_and_loader_type_is_the_enhance_encoder(self):
        name = ENHANCE.DEFAULT_ENHANCE_CLIP
        self.assertTrue(ENHANCE.is_enhance_encoder({"clip_name": name, "clip_type": "qwen_image"}, name))
        self.assertTrue(ENHANCE.is_enhance_encoder({"clip_name": "sub/" + name, "clip_type": "Qwen_Image"}, name))
        self.assertFalse(ENHANCE.is_enhance_encoder({"clip_name": name, "clip_type": "wan"}, name))
        self.assertFalse(ENHANCE.is_enhance_encoder({"clip_name": "other.safetensors", "clip_type": "qwen_image"}, name))


class EncoderResolutionTests(unittest.TestCase):
    def test_default_encoder_downloads_once_when_missing(self):
        installed = []

        def download():
            installed.append(ENHANCE.DEFAULT_ENHANCE_CLIP)

        with patch.object(ENHANCE, "_safe_filename_list", lambda category: list(installed)), patch.object(ENHANCE, "_download_default_clip", download):
            self.assertEqual(ENHANCE.resolve_enhance_clip_name(""), ENHANCE.DEFAULT_ENHANCE_CLIP)
            self.assertEqual(ENHANCE.resolve_enhance_clip_name(None), ENHANCE.DEFAULT_ENHANCE_CLIP)
        self.assertEqual(installed, [ENHANCE.DEFAULT_ENHANCE_CLIP])

    def test_a_picked_encoder_must_be_installed(self):
        with patch.object(ENHANCE, "_safe_filename_list", lambda category: ["qwen3vl_4b_fp8_scaled.safetensors"]):
            self.assertEqual(ENHANCE.resolve_enhance_clip_name("qwen3vl_4b_fp8_scaled.safetensors"), "qwen3vl_4b_fp8_scaled.safetensors")
            with self.assertRaises(ValueError):
                ENHANCE.resolve_enhance_clip_name("../../evil.safetensors")


class StopTests(unittest.TestCase):
    """Stop = ComfyUI's interrupt flag, checked at every draw progress tick except the terminal ones."""

    def fake_comfy(self, flag):
        import sys

        class Interrupted(BaseException):
            pass

        def throw():
            if flag["on"]:
                flag["on"] = False
                raise Interrupted()

        management = types.ModuleType("comfy.model_management")
        management.throw_exception_if_processing_interrupted = throw
        management.InterruptProcessingException = Interrupted
        management.interrupt_current_processing = lambda value=True: flag.__setitem__("on", value)
        package = types.ModuleType("comfy")
        package.model_management = management
        return patch.dict(sys.modules, {"comfy": package, "comfy.model_management": management}), Interrupted

    def test_progress_ticks_raise_the_interrupt_but_terminal_stages_do_not(self):
        progress = UNICANVAS.progress
        flag = {"on": False}
        patcher, interrupted = self.fake_comfy(flag)
        with patcher:
            progress._set_draw_progress("stop-test", "sampling", 0.4, 1, 6)  # no flag: fine
            progress.set_interrupt(True)
            progress._set_draw_progress("stop-test", "cancelled", 1.0, 0, 0, "Stopped")  # terminal stages never raise
            progress._set_draw_progress("stop-test", "error", 1.0)
            self.assertTrue(flag["on"])
            with self.assertRaises(interrupted):
                progress._set_draw_progress("stop-test", "sampling", 0.5, 2, 6)
            self.assertFalse(flag["on"], "the interrupt is consumed by the draw it stopped")
            self.assertEqual(progress.interrupt_types(), (interrupted,))

    def test_without_comfy_nothing_is_interrupted(self):
        import sys

        with patch.dict(sys.modules, {"comfy": None, "comfy.model_management": None}):
            self.assertEqual(UNICANVAS.progress.interrupt_types(), ())
            UNICANVAS.progress._set_draw_progress("stop-test", "sampling", 0.1, 1, 6)


class DefaultPromptTests(unittest.TestCase):
    def test_shipped_defaults(self):
        entries = {entry["family"]: entry for entry in UNICANVAS.enhance.load_default_prompts()}
        for family in ("qwen_image21", "qwen_image_edit", "flux_klein", "z_image", "anima", "minimax_h3", "krea2_edit"):
            self.assertIn(family, entries)
            self.assertTrue(entries[family]["positive"] or entries[family]["edit"], family)
        self.assertTrue(entries["qwen_image21"]["positive"].startswith("# Image Prompt Rewriting Expert"))
        self.assertIn("wh_ratio", entries["qwen_image21"]["edit"])
        for family in ("anima", "qwen_image21", "qwen_image_edit", "z_image"):
            self.assertTrue(entries[family]["negative"], f"{family} uses the negative prompt, so it needs a negative wand")


if __name__ == "__main__":
    unittest.main()
