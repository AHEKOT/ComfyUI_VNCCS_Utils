# VNCCS-Utils Project Rules

Binding rules for the whole repository and every VNCCS-Utils widget: 3D Factory, Pose Studio,
UniCanvas, Model Manager, Model Selector, and future interactive nodes.

## Realtime interaction is mandatory

Every interactive control must show its effect continuously while the user interacts with it;
the user must never have to release the mouse, pointer, pen, or key before seeing the result.

- Sliders, numeric scrubbing, color, angle and camera controls, gizmos, drag pads and
  timelines update visible state from `input`, `pointermove` or an equivalent continuous event.
- `change`, `pointerup`, drag-end, and blur may commit undo history, persistence,
  synchronization, or an expensive final-quality result - never the first visible update.
- Do not debounce visible feedback until interaction ends; frame-limit with
  `requestAnimationFrame` or a bounded realtime cadence, always rendering the newest value.
- Update the affected runtime object directly instead of reloading the whole widget.
- If full quality is too expensive per frame, show an immediate lightweight preview during
  the gesture and the final-quality result after it ends; keep the last valid frame visible
  and let stale async results lose to the newest control value.
- Paired sliders and exact numeric fields stay synchronized during interaction, and undo
  records one command per completed gesture while the viewport and UI update continuously.

A control that only reveals its result on release is a bug and must not be shipped.

## E2E tests (Playwright)

`tests/e2e/` is the browser E2E suite for the UniCanvas UI; the only input is `COMFYUI_URL`,
pointing at a running test-platform instance:

    cd tests/e2e
    npm install
    npx playwright install chromium          # first run on a machine only
    COMFYUI_URL=http://localhost:8188 npx playwright test

The specs guard the standalone-tab smoke path, the measurement helper, the settings popover,
the pose edit session and backdrop, the standalone sidebar setting, `VNCSS Config` overrides,
and the prompt guide; nothing calls GPU generation or downloads models. Geometric assertions
read layer pixels and pose state through the read-only `window.__VNCCS_UC_E2E__` hook in
`web/vnccs_unicanvas_modes.mjs`; `PW_CHROMIUM_PATH=<chrome>` reuses a preinstalled Chromium.

## Test platform (Docker)

`tests/e2e/platform/` builds a ComfyUI with the VNCSS and VNCCS_Utils nodes preinstalled. The
primary CPU-only local lane, `docker compose -p vnccs-<something> -f
tests/e2e/platform/docker-compose.yml up -d`, serves the UI at `http://localhost:8188` with
the working tree bind-mounted over `custom_nodes/ComfyUI_VNCCS_Utils`, so WIP code needs no
image rebuild; `PORT=<port>` moves it, and a CUDA build variant exists for optional
GPU-dependent verification. Always give the compose project a unique name
(`-p vnccs-<something>`): worktrees sharing the default name would share one container and port.

## Evidence and browser cache

Evidence for UI changes is an **After** capture only - no Before captures or Before/After
pairs. Run `node evidence.mjs --topic <topic> --phase after` (workdir `tests/e2e`); it writes
`tests/e2e/evidence/<topic>/after.png` plus `after.geometry.json`. Host the capture on an
`evidence/<topic>` branch when opening a PR; built-in scenarios are `settings-panel`,
`pose-editor`, `config-override`, and `icons`.

After a code change or a container restart the browser keeps the OLD extension bundle: always
hard-reload (Ctrl+Shift+R) before judging a fix on the live instance.
