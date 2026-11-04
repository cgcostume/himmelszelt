// Clouds after Nubis3 (Schneider 2023) on the thesis' cloud map: a cloudscape of low clouds voxelized on the GPU, with
// its signed distance field and its light summed per voxel, marched per pixel with the density up-rezzed by detail
// noise; and sheets of high cloud read once each. Everything a renderer hands over is plain numbers, the sun as a
// direction, its light in lux, the sky's as irradiance.

// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical

export type { CloudParams, CloudscapeParams, SheetNoise, SheetParams, SunlightRow } from "./params.js";
export {
    DEFAULT_CLOUD_PARAMS,
    DEFAULT_CLOUDSCAPE,
    DEFAULT_SHEET,
    DEFAULT_SHEET_NOISE,
    EVOLUTION_PERIOD,
    MAX_SHEETS,
    PARAMS_SIZE,
    SUNLIGHT_ENTRIES,
    SUNLIGHT_SIZE,
    DRIFT_PERIOD_KM,
    drift,
    evolutionAt,
    paramsData,
    sunlightData,
    sizedCloudscape,
    slabHeightKm,
    sunlightRows,
} from "./params.js";

// Weather as presets of the clouds' shape, and blends between them.
export type { Weather, WeatherName } from "./weather.js";
export { mixWeather, WEATHER } from "./weather.js";

export type { AerialPerspective, CloudPass, CloudPassOptions, EncodeOptions, GridOptions } from "./clouds.js";
export { createCloudPass } from "./clouds.js";

// The raw WGSL, for inlining into a consumer's own pipelines instead of using the pass above.
export * as wgsl from "./wgsl/index.js";
