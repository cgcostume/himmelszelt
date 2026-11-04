// Clouds after Nubis3 (Schneider 2023) on the thesis' cloud map: a cloudscape of low clouds voxelized on the GPU, with
// its signed distance field and its light summed per voxel, marched per pixel with the density up-rezzed by detail
// noise; and sheets of high cloud read once each. Everything a renderer hands over is plain numbers, the sun as a
// direction, its light in lux, the sky's as irradiance.

// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical

export type { CloudParams, CloudscapeParams, SheetParams } from "./params.js";
export {
    DEFAULT_CLOUD_PARAMS,
    DEFAULT_CLOUDSCAPE,
    DEFAULT_SHEET,
    EVOLUTION_PERIOD,
    MAX_SHEETS,
    PARAMS_SIZE,
    drift,
    evolutionAt,
    paramsData,
} from "./params.js";

export type { CloudPass, CloudPassOptions, EncodeOptions, GridOptions } from "./clouds.js";
export { createCloudPass } from "./clouds.js";

// The raw WGSL, for inlining into a consumer's own pipelines instead of using the pass above.
export * as wgsl from "./wgsl/index.js";
