// Clouds after Nubis3 (Schneider 2023) on the thesis' cloud map: a cloudscape of low clouds voxelized on the GPU, with
// its signed distance field and its light summed per voxel, marched per pixel with the density up-rezzed by detail
// noise; and sheets of high cloud read once each. Everything a renderer hands over is plain numbers, the sun as a
// direction, its light in lux, the sky's as irradiance.

// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical

export type { CloudParams, CloudscapeParams, LayerMotion, SheetNoise, SheetParams, SunlightRow } from "./params.js";
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
    continuedMotion,
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

// The layered model's sky: its numbers, the kinds of cloud for each of its places, and blends between two.
export type { CloudLayer, DeepLayer, HighSheet, LayeredParams, LayeredSky, Sky, SkyDials } from "./layers.js";
export {
    CLOUD_TYPES,
    DEFAULT_DEEP_LAYER,
    DEFAULT_HIGH_SHEET,
    DEFAULT_LAYERED_PARAMS,
    DEFAULT_LAYERED_SKY,
    DEFAULT_LOW_LAYER,
    DEFAULT_MIDDLE_LAYER,
    layeredSky,
    mixLayeredSky,
} from "./layers.js";

// The layered model as passes: the marched layers, the high sheet, and both composed over a background.
export type {
    LayerEncodeOptions,
    LayerMarch,
    LayerMarchOptions,
    LayerMarchSettings,
    LayerUpdateOptions,
} from "./layerpass.js";
export { createLayerMarch, DEFAULT_LAYER_MARCH } from "./layerpass.js";
export type { HighSheetEncodeOptions, HighSheetOptions, HighSheetPass, HighSheetUpdateOptions } from "./highsheet.js";
export { createHighSheet } from "./highsheet.js";
export type {
    LayeredCloudParams,
    LayeredCloudPass,
    LayeredCloudPassOptions,
    LayeredEncodeOptions,
    LayeredUpdateOptions,
    LayeredQuality,
} from "./layered.js";
export { createLayeredCloudPass, LAYERED_QUALITY } from "./layered.js";

export type {
    AerialPerspective,
    CloudPass,
    CloudPassOptions,
    EncodeOptions,
    GridOptions,
    KeyframeOptions,
    Keyframes,
    SunlightAtmosphere,
} from "./clouds.js";
export { createCloudPass } from "./clouds.js";

// Rainbows: what raindrops send of the sun's light into every scattering angle, as a table, and where the bows stand.
export type { Rainbow, RainbowTable } from "./rainbow.js";
export {
    antisolarAngle,
    bowDirection,
    bowRadius,
    bowTop,
    DEFAULT_RAINBOW,
    RAINBOW_FROM,
    RAINBOW_TO,
    rainbowPhase,
    rainbowTable,
    rainDropRadius,
    rainExtinction,
    waterIndex,
} from "./rainbow.js";
// The corona thin cloud lays around the Sun and the Moon.
export type { Corona } from "./corona.js";
export { CORONA_WAVELENGTHS, coronaShare, DEFAULT_CORONA, diffractionLobe } from "./corona.js";

// The raw WGSL, for inlining into a consumer's own pipelines instead of using the pass above.
export * as wgsl from "./wgsl/index.js";
