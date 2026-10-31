// Skies as images: cube maps and panoramas, one laid out as the other, and the diffuse image-based lighting from them.
// Records into passes the caller owns; it creates no device, canvas, context or render pass of its own.

// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical

// A cube map laid out as a panorama.
export type { PanoramaPass, PanoramaPassOptions, PanoramaProjection } from "./panorama.js";
export { createPanoramaPass } from "./panorama.js";

// A panorama as a cube map, and one environment faded into another.
export type {
    CubeFromPanoramaOptions,
    CubeFromPanoramaPass,
    EnvironmentBlendOptions,
    EnvironmentBlendPass,
} from "./environment.js";
export { createCubeFromPanoramaPass, createEnvironmentBlendPass, mixCoefficients } from "./environment.js";

// Diffuse image-based lighting from a cube map: spherical harmonics and an irradiance cube map.
export type { IrradiancePass, IrradiancePassOptions } from "./ibl.js";
export { createIrradiancePass } from "./ibl.js";

// Radiance HDR files.
export type { RgbeImage } from "./rgbe.js";
export { decodeRgbe, encodeRgbe } from "./rgbe.js";

// The raw WGSL, for inlining into a consumer's own pipelines instead of using the passes above.
export * as wgsl from "./wgsl/index.js";
