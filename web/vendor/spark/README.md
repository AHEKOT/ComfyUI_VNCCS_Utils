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
