import hashlib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "img2threejs"


class Img2ThreeJSVendorTests(unittest.TestCase):
    def test_exact_v120_skill_prompt_is_vendored(self):
        prompt = (UPSTREAM / "SKILL.md").read_bytes()
        self.assertEqual(
            hashlib.sha256(prompt).hexdigest(),
            "cc76b86304c1dd57a4eb6b552ccd0e62168ebc18960c1a8a07f9d1422487d372",
        )

    def test_upstream_license_and_commit_are_preserved(self):
        license_text = (UPSTREAM / "LICENSE").read_text(encoding="utf-8")
        commit_text = (UPSTREAM / "UPSTREAM_COMMIT").read_text(encoding="utf-8")
        self.assertIn("MIT License", license_text)
        self.assertIn("Copyright (c) 2026 hoainho", license_text)
        self.assertIn("e8ff28a6ae0cb534c7b2ebc15cb3f06709262d5b", commit_text)

    def test_upstream_is_vendored_as_source_not_nested_git_metadata(self):
        self.assertFalse((UPSTREAM / ".git").exists())
        self.assertTrue((UPSTREAM / "forge" / "stage3_build" / "generate_threejs_factory.py").is_file())


if __name__ == "__main__":
    unittest.main()
