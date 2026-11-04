import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capturePoseLibraryScroll } from "./pose_library_scroll.mjs";

export async function capturePoseLibraryRepositories(options = {}) {
    await capturePoseLibraryScroll({ ...options, beforeLoad: async page => {
        // A cached older module must never own controls after the extension update.
        await page.route(/\/web\/shared\/custom_select\.mjs(?:\?|$)/, route => {
            if (new URL(route.request().url()).searchParams.get("v") === "20261104-scaled-menu") return route.continue();
            return route.fulfill({ contentType: "text/javascript", body: 'throw new Error("Stale selector module loaded");' });
        });
    }, exercise: async (page, output) => {
        let repositories = [], failPublish = false;
        let local = { pose_count: 154, animation_count: 0, publish_repo_id: "", publishing_enabled: true };
        const publishes = [], additions = [], report = [];
        await page.route("**/vnccs/pose_library/repositories**", async route => {
            const path = new URL(route.request().url()).pathname;
            let body = {}, status = 200;
            if (path.endsWith("/repositories")) body = { repositories, local_repository: local };
            else if (path.includes("/progress/")) body = { status: "running", progress: 45, message: "Uploading library..." };
            else if (path.endsWith("/local/publish")) {
                const payload = route.request().postDataJSON(); publishes.push(payload);
                if (failPublish) { status = 403; body = { error: "Write access denied" }; }
                else {
                    local = { ...local, publish_repo_id: payload.repo_id, last_publish: 1, last_publish_result: { uploaded_count: 3 } };
                    body = { local_repository: local, result: local.last_publish_result };
                }
            } else if (path.endsWith("/add")) {
                const payload = route.request().postDataJSON(); additions.push(payload);
                if (payload.repo_id === "owner/missing") { status = 404; body = { error: "Repository not found" }; }
                else {
                    repositories = [...repositories, { repo_id: payload.repo_id, title: payload.repo_id, enabled: true }];
                    body = { repositories, refreshed: { status: "ok", downloaded_count: 1 } };
                }
            }
            await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        });
        const settle = async () => {
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.waitForFunction(() => !widget._uiScaleCommitTimer && !widget._libraryResizeFrame);
        };
        const geometry = () => page.evaluate(() => Object.fromEntries([
            "#host", ".vnccs-pose-studio", ".vnccs-ps-left", ".vnccs-ps-center", ".vnccs-ps-right-sidebar",
            ".vnccs-ps-library-modal", ".vnccs-ps-library-settings", ".vnccs-ps-library-local-repo",
            ".vnccs-ps-library-repo-add", ".vnccs-ps-library-repo-add-btn",
        ].map(selector => {
            const element = document.querySelector(selector), r = element.getBoundingClientRect();
            return [selector, { x: r.x, y: r.y, width: r.width, height: r.height }];
        })));
        for (const [width, height, scale] of [[900, 740, 1], [760, 680, 0.75], [2800, 2800, 1], [2800, 2800, 0.5], [1400, 950, 1.25]]) {
            await page.setViewportSize({ width: Math.max(1900, Math.ceil(width * scale + 80)), height: Math.max(1400, Math.ceil(height * scale + 80)) });
            await page.evaluate(([width, height, scale]) => {
                node.setSize([width, height]); node.onResize(node.size);
                document.querySelector("#host").style.transform = `scale(${scale})`;
                widget.showLibraryModal();
            }, [width, height, scale]);
            await page.locator(".vnccs-ps-library-menu-btn").click();
            await page.waitForSelector(".vnccs-ps-library-repo-add-btn");
            await settle();
            const before = await geometry();
            await page.locator(".vnccs-ps-library-local-repo .publish").click();
            const modal = page.locator(".vnccs-ps-modal-overlay:not(.vnccs-ps-library-overlay)");
            await modal.getByText("Publish Local Pose Repository", { exact: true }).waitFor();
            await modal.locator(".vnccs-ps-publish-repo").fill("owner/new-library");
            await modal.getByRole("button", { name: "Publish", exact: true }).click();
            assert.equal(await modal.locator(".vnccs-ps-publish-token").evaluate(e => e.validity.valid), false);
            await modal.locator(".vnccs-ps-publish-token").fill("test-write-credential");
            assert.equal(await modal.locator(".vnccs-ps-publish-token").evaluate(e => e.validity.valid), true);
            const bounds = await modal.locator(".vnccs-ps-modal").boundingBox();
            const host = before["#host"];
            assert.ok(bounds.x >= host.x && bounds.y >= host.y && bounds.x + bounds.width <= host.x + host.width + 1
                && bounds.y + bounds.height <= host.y + host.height + 1, "publish dialog fits the complete node");
            const form = await modal.locator(".vnccs-ps-publish-modal").evaluate(element => {
                const content = element.querySelector(".vnccs-ps-modal-content");
                return {
                    fontSize: parseFloat(getComputedStyle(element.querySelector(".vnccs-ps-publish-repo")).fontSize),
                    overflow: content.scrollHeight - content.clientHeight,
                    fields: Array.from(element.querySelectorAll("input, select, button"), field => {
                        const rect = field.getBoundingClientRect();
                        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                    }),
                };
            });
            assert.ok(form.fontSize * scale >= 15, "input text is readable at supported graph scales");
            assert.ok(form.overflow <= 1, "the complete publish form fits without scrolling");
            assert.ok(bounds.width >= Math.min(1000 * Math.min(1, scale), (host.width - 32) * 0.75), "dialog uses the available node width");
            for (const field of form.fields) {
                assert.ok(field.x >= bounds.x && field.y >= bounds.y && field.x + field.width <= bounds.x + bounds.width + 1
                    && field.y + field.height <= bounds.y + bounds.height + 1, "all fields and actions remain inside the dialog");
            }
            assert.deepEqual(await geometry(), before, "opening a publish dialog preserves the node and settings layout");
            await modal.locator(".vnccs-ps-publish-mode").click();
            const menu = page.locator(".vnccs-custom-select-menu");
            await menu.waitFor();
            const dropdown = await page.evaluate(() => {
                const select = document.querySelector(".vnccs-ps-publish-mode");
                const menu = document.querySelector(".vnccs-custom-select-menu");
                const source = select.getBoundingClientRect(), popup = menu.getBoundingClientRect();
                return {
                    controlFont: parseFloat(getComputedStyle(select).fontSize) * source.width / select.offsetWidth,
                    menuFont: parseFloat(getComputedStyle(menu).fontSize),
                    optionFonts: [...menu.querySelectorAll(".vnccs-custom-select-option-label")].map(label =>
                        parseFloat(getComputedStyle(label).fontSize) * label.getBoundingClientRect().height / label.offsetHeight),
                    x: popup.x, y: popup.y, width: popup.width, height: popup.height,
                    overflow: menu.scrollHeight - menu.clientHeight,
                    labelOverflow: [...menu.querySelectorAll(".vnccs-custom-select-option-label")].some(label => label.scrollWidth > label.clientWidth + 1),
                };
            });
            assert.ok(Math.abs(dropdown.controlFont - dropdown.menuFont) < 1, "popup text matches the visible control font at every graph scale");
            assert.ok(dropdown.optionFonts.every(font => Math.abs(font - dropdown.controlFont) < 1), "rendered option labels match the control, including host styles");
            assert.ok(dropdown.overflow <= 1 && !dropdown.labelOverflow, "both target options fit without scrolling or clipped text");
            const viewport = page.viewportSize();
            assert.ok(dropdown.x >= 0 && dropdown.y >= 0 && dropdown.x + dropdown.width <= viewport.width
                && dropdown.y + dropdown.height <= viewport.height, "target options remain within the viewport");
            assert.deepEqual(await geometry(), before, "opening the target list preserves the complete node layout");
            await page.locator("#host").screenshot({ path: join(output, width === 900 ? "after.png" : `after-${width}-${scale}.png`) });
            await menu.getByText("Use existing repository", { exact: true }).click();
            assert.equal(await modal.locator(".vnccs-ps-publish-mode").inputValue(), "existing");
            assert.equal(await menu.count(), 0);
            await modal.getByRole("button", { name: "Cancel", exact: true }).click();
            assert.equal(publishes.length, 0, "editing or cancelling does not publish");
            report.push({ width, height, scale, bounds: before, dialog: bounds, form, dropdown });
        }
        const add = page.locator(".vnccs-ps-library-repo-add-btn");
        const input = page.locator(".vnccs-ps-library-repo-input");
        await add.click();
        assert.match(await page.locator(".vnccs-ps-library-repo-notice").textContent(), /Enter owner\/repository/);
        await input.fill("https://example.com/owner/library"); await add.click();
        assert.equal(additions.length, 0, "invalid input never silently starts a request");
        await input.fill("owner/missing"); await add.click();
        await page.getByText("Failed to add repository: Repository not found", { exact: true }).waitFor();
        await input.fill("https://huggingface.co/owner/library/tree/main"); await add.click();
        await page.waitForFunction(() => !widget.librarySettingsMode);
        assert.equal(additions.at(-1).repo_id, "owner/library");
        await page.locator(".vnccs-ps-library-menu-btn").click();
        await page.waitForSelector(".vnccs-ps-library-local-repo .publish");

        await page.locator(".vnccs-ps-library-local-repo .publish").click();
        const modal = page.locator(".vnccs-ps-modal-overlay:not(.vnccs-ps-library-overlay)");
        await modal.locator(".vnccs-ps-publish-repo").fill("https://huggingface.co/owner/new-library/tree/main");
        await modal.locator(".vnccs-ps-publish-token").fill("test-write-credential");
        await modal.getByRole("button", { name: "Publish", exact: true }).click();
        await page.waitForFunction(() => !widget._localPoseRepositoryPublishActive && widget.localPoseRepository.publish_repo_id);
        assert.deepEqual({ ...publishes[0], task_id: undefined }, {
            repo_id: "owner/new-library", token: "test-write-credential", create: true, private: false, task_id: undefined,
        });
        assert.equal(await page.locator(".vnccs-ps-publish-token").count(), 0);
        assert.equal(await page.evaluate(() => node.widgets[0].value.includes("test-write-credential")), false);
        assert.match(await page.locator(".vnccs-ps-library-local-repo .vnccs-ps-library-repo-id").textContent(), /owner\/new-library/);

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.ready);
        await page.evaluate(() => setup());
        await page.waitForFunction(() => widget.viewer?.isInitialized() && !widget._modelLoadPromise);
        await page.evaluate(() => { node.setSize([900, 740]); node.onResize(node.size); widget.showLibraryModal(); });
        await page.locator(".vnccs-ps-library-menu-btn").click();
        await page.waitForSelector(".vnccs-ps-library-local-repo .publish");
        assert.match(await page.locator(".vnccs-ps-library-local-repo .vnccs-ps-library-repo-id").textContent(), /owner\/new-library/);
        assert.equal(await page.evaluate(() => widget.localPoseRepository.last_publish), 1);
        assert.equal(await page.evaluate(() => widget.localPoseRepository.last_publish_result.uploaded_count), 3);

        failPublish = true;
        await page.locator(".vnccs-ps-library-local-repo .publish").click();
        assert.equal(await modal.locator(".vnccs-ps-publish-mode").inputValue(), "existing");
        assert.equal(await modal.locator(".vnccs-ps-publish-repo").inputValue(), "owner/new-library");
        await modal.locator(".vnccs-ps-publish-token").fill("test-write-credential");
        await modal.getByRole("button", { name: "Publish", exact: true }).click();
        await page.getByText("Failed to publish local library: Write access denied", { exact: true }).waitFor();
        assert.equal(publishes.at(-1).create, false);
        assert.equal(local.publish_repo_id, "owner/new-library");
        await page.evaluate(() => widget.showMessage("Repository error remains above settings", true));
        await modal.getByText("Repository error remains above settings", { exact: true }).waitFor();
        await page.locator("#host").screenshot({ path: join(output, "after-error.png") });
        await modal.getByRole("button", { name: "OK", exact: true }).click();
        assert.equal(await modal.count(), 0);
        await writeFile(join(output, "after.geometry.json"), JSON.stringify({ report, checks: [
            "Publish opens above settings", "token required", "cancel does not publish", "Add validates input", "Add failure is visible",
            "Add normalizes and downloads repository", "publish remembers target", "token stays out of workflow", "publish failure keeps target",
            "publish target and history reload independently of download catalogs", "dropdown font matches the scaled control",
            "error dialog is clickable above settings",
        ] }, null, 2));
        console.log(`Pose repositories: ${report.length} sizes; Add, Publish, validation, failure and overlay checks passed. ${output}`);
    } });
}
