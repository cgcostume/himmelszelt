/**
 * The WGSL layer, exported as plain strings. `cube` and `panorama` are binding-free, how the two lay out directions, for
 * whoever samples or writes such a map; `irradiance` and `panoramaPass` are the passes, with bindings of their own.
 *
 * Every identifier is prefixed `rb` (or `RB_` for constants) so several `@himmelszelt/*` fragments can share one
 * shader module.
 */
import cube from "./cube.wgsl";
import irradiance from "./irradiance.comp.wgsl";
import panoramaPass from "./panorama.comp.wgsl";
import panorama from "./panorama.wgsl";
import spiral from "./spiral.wgsl";

export { workgroupSum } from "./reduce.js";

export { cube, irradiance, panorama, panoramaPass, spiral };

/** The panorama pass' output binding, which has to spell out the target's format. */
export const panoramaOutput = (format: GPUTextureFormat) =>
    `@group(1) @binding(0) var rbOutput: texture_storage_2d<${format}, write>;`;
