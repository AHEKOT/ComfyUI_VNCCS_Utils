# CG Creator browser evidence

`cg_creator.mjs` adapts the main VNCCS project's Background Creator browser
harness. It serves the actual Utils extension, CSS and vendored Spark renderer
on an ephemeral localhost port and opens them in a fresh headless Chromium.
The saved room and API responses are deterministic fixtures. The viewport loads
and renders real Gaussian data; model reconstruction and QI2 inference are mocked.
No ComfyUI process, weights, remote resources or user library writes are needed.

Install the existing browser-test dependencies and Chromium once:

```sh
cd tests/e2e
npm install
npx playwright install chromium
npm run cg-creator
```

From the repository root, the equivalent command is:

```sh
node tests/browser/cg_creator.mjs [chromium-executable] [output-directory]
```

The output defaults to `tests/e2e/evidence/cg-creator/` (ignored by Git):

- `after.png`, `after-compact.png`: the actual wide/compact workspace.
- `after-settings.png`, `after-save-view.png`: the actual settings/capture dialogs.
- `after-generating.png`, `after-completed.png`: job progress and the selected result.
- `after-empty.png`, `after-read-only.png`: empty/recovered workspace states.
- `after.geometry.json`, `report.json`: measured layout, assertions and browser errors.

Each run checks clipping, a nonempty rendered Gaussian frame, camera/FOV changes
before pointer release, exact CG camera restoration and serialized workflow state.
Unexpected routes, external resources and uncaught browser errors fail the run.
On failure, `after-failure.png` shows the actual failing page.
Each run clears only its named output files first, so a failed run cannot leave
older successful captures masquerading as current evidence.

After every CG Creator UI edit, run this harness, inspect the affected images and
embed the latest relevant After image in chat. State that it uses fixture data.
Real inference and ComfyUI graph behavior require separate runtime verification.
