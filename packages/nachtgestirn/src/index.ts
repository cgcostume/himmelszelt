// The Moon as it looks tonight: a compute pass that draws its disc along every pixel's ray, over the sky, shaded by
// Hapke's lunar reflectance law over NASA's maps of its color and relief, lit by the Sun and by earthshine, and
// darkened and reddened in Earth's shadow during a lunar eclipse. Everything a renderer hands over is plain numbers:
// directions, angles, lux.

// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical

export type { MoonOrientationInput, RefractionTable, Vec3 } from "./orientation.js";
export {
    EARTH_GEOMETRIC_ALBEDO,
    EARTH_RADIUS_KM,
    MOON_GEOMETRIC_ALBEDO,
    MOON_RADIUS_KM,
    SUN_ILLUMINANCE,
    earthshineIlluminance,
    ev100ForLuminance,
    horizonZ,
    liftedDirection,
    mapWidthFor,
    meanLuminance,
    moonEV100,
    moonIlluminance,
    moonOrientation,
    phaseLaw,
    selenographic,
    toSelenographic,
    refractionTable,
    REFRACTION_SAMPLES,
    viewFrame,
} from "./orientation.js";

export type { MoonMapFiles, MoonMaps, MoonMapsOptions } from "./maps.js";
export { createMoonMaps, loadMoonMaps, MOON_MAPS } from "./maps.js";

export type { EarthShadow, EncodeOptions, MoonParams, MoonPass, MoonPassOptions } from "./moon.js";
export { createMoonPass, PARAMS_SIZE, paramsData } from "./moon.js";

// The raw WGSL, for inlining into a consumer's own pipelines instead of using the pass above.
export * as wgsl from "./wgsl/index.js";
