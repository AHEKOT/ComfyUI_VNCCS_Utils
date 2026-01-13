import { app } from "../../scripts/app.js";

app.registerExtension({
	name: "vnccs.legacy_compatibility",
	nodeCreated(node) {
		if (node.comfyClass === "VNCCS_QWEN_Detailer") {
			const onConfigure = node.onConfigure;
			node.onConfigure = function (w) {
				if (onConfigure) {
					onConfigure.apply(this, arguments);
				}

				const widget = this.widgets.find((w) => w.name === "color_match_method");
				if (widget) {
					const valid_methods = ["disabled", "kornia_reinhard"];
					if (!valid_methods.includes(widget.value)) {
						console.warn(`[VNCCS] Auto-fixing deprecated color match method '${widget.value}' to 'kornia_reinhard'`);
						widget.value = "kornia_reinhard";
					}
				}
			};
		}
	},
});
