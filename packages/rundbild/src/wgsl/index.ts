/**
 * The WGSL layer, exported as plain strings. `cube` and `panorama` are binding-free, how the two lay out directions, for
 * whoever samples or writes such a map, and `ground` too, for an image's ground on a plane and its horizon lifted; `irradiance` and `panoramaPass` are the passes, with bindings of their own.
 *
 * Every identifier is prefixed `rb` (or `RB_` for constants) so several `@himmelszelt/*` fragments can share one
 * shader module.
 */
import cube from "./cube.wgsl";
import environment from "./environment.comp.wgsl";
import ground from "./ground.wgsl";
import irradiance from "./irradiance.comp.wgsl";
import panoramaPass from "./panorama.comp.wgsl";
import panorama from "./panorama.wgsl";
import spiral from "./spiral.wgsl";

export { workgroupSum } from "./reduce.js";

export { cube, environment, ground, irradiance, panorama, panoramaPass, spiral };

/** The panorama pass' output binding, which has to spell out the target's format. */
export const panoramaOutput = (format: GPUTextureFormat) =>
    `@group(1) @binding(0) var rbOutput: texture_storage_2d<${format}, write>;`;

/** The environment passes' output binding, one level of a cube map's six faces, which has to spell out its format. */
export const cubeOutput = (format: GPUTextureFormat) =>
    `@group(0) @binding(4) var rbOutput: texture_storage_2d_array<${format}, write>;`;
