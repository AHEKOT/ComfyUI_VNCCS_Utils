# Browser renderer provenance

- SparkJS `v2.1.0` (`@sparkjsdev/spark`), commit
  `fec6d05d0caa1ab1b3ac8a3d480ce13383ff1c96`, MIT license.
- Three.js `r180`, MIT license.

The Spark ES module is the official minified distribution with its bare
`three` and `three/addons/postprocessing/Pass.js` imports rewritten to the
adjacent vendored modules. `three.module.js`, `three.core.js`, `Pass.js`,
`OrbitControls.js`, and `TransformControls.js` are official Three.js r180
files pointed at the same local module so the ComfyUI widget works without a
CDN. Spark's worker/WASM payloads remain embedded in its official distribution.

## Draco decoder modifications

`libs/draco/gltf/draco_wasm_wrapper.js` is the official three.js r180 Draco
WASM wrapper with its two `XMLHttpRequest` readers (sync and async file
reads) replaced by stubs. `DRACOLoader` always passes the WASM binary in
memory (`wasmBinary`), so these readers are never used. The asm.js fallback
`draco_decoder.js` was removed for the same reason (it contained the same
readers); `model_loader.mjs` forces the WASM decoder.
