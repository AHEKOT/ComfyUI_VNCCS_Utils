---
name: Debugging approach — fix all at once
description: Don't patch errors one at a time; read all relevant files first and fix everything in one pass
type: feedback
---

When debugging device/runtime errors in vendor code, read ALL relevant files (warping.py, ptu3d.py, multiperson_model.py, etc.) before making any edits. Patch all issues in a single pass rather than one error at a time — each round-trip wastes the user's tokens and requires a ComfyUI restart.

**Why:** User ran out of tokens in a previous session because CPU/CUDA device mismatches in metrabs vendor code were fixed one file at a time across multiple turns, requiring repeated test runs between each fix.

**How to apply:** When a new class of error appears (e.g. device mismatch, import error), immediately read all files in the affected module tree, identify every occurrence of the problem pattern, and fix them all before asking the user to test.
