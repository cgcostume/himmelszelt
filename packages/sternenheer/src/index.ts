// The stars as they look tonight: the nine thousand stars of the Yale Bright Star Catalogue and the Milky Way behind
// them, drawn by compute passes over the sky, in cd/m², each star's light at the eye in lux spread over its image,
// lifted, dimmed and twinkling in the air near the horizon. Everything a renderer hands over is plain numbers: one
// rotation for the moment and the place, a camera, an exposure, and the air as two functions of the altitude.

// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical

export type { Star, StarCatalog } from "./catalog.js";
export { BRIGHT_STARS, catalogFromBuffer, catalogFromStars, loadCatalog, STAR_FIELDS, starAt } from "./catalog.js";

export {
    illuminanceFromMagnitude,
    luminanceFromSurfaceBrightness,
    MAGNITUDE_ZERO_ILLUMINANCE,
    magnitudeFromIlluminance,
    S10_LUMINANCE,
    SUN_ILLUMINANCE,
    SUN_MAGNITUDE,
    surfaceBrightnessFromLuminance,
} from "./light.js";

export type { Rgb } from "./color.js";
export {
    colorFromColorIndex,
    colorFromColorIndexApprox,
    linearSrgbFromChromaticity,
    planckianLocus,
    temperatureFromColorIndex,
    temperatureFromColorIndexApprox,
} from "./color.js";

export type { AirTable } from "./air.js";
export { AIR_SAMPLES, airTable, airTableAltitude, airTableBend, liftedDirection, scintillationIndex } from "./air.js";

export type { MilkyWay, MilkyWayFiles } from "./milkyway.js";
export { createMilkyWay, loadMilkyWay, MILKY_WAY_LUMINANCE, MILKY_WAY_MAPS } from "./milkyway.js";

export type { EncodeOptions, StarsParams, StarsPass, StarsPassOptions } from "./stars.js";
export { createStarsPass, PARAMS_SIZE, paramsData } from "./stars.js";

// The raw WGSL, for inlining into a consumer's own pipelines instead of using the pass above.
export * as wgsl from "./wgsl/index.js";
