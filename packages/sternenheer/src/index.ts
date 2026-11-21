// The stars as they look tonight: the nine thousand stars of the Yale Bright Star Catalogue and the Milky Way behind
// them, drawn by compute passes over the sky, in cd/m², each star's light at the eye in lux spread over its image,
// lifted, dimmed and twinkling in the air near the horizon. Everything a renderer hands over is plain data: one
// rotation for the moment and the place, a camera, an exposure, and the air as dunstkreis' air table and seeing.

// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical

export type { CatalogVariant, DeepStars, FaintStar, PackedStars, Star, StarCatalog } from "./catalog.js";
export {
    BRIGHT_STARS,
    catalogFromBuffer,
    catalogFromStars,
    COMPACT_BLOCK_WORDS,
    COMPACT_STAR_WORDS,
    cellDirection,
    DEEP_STEPS,
    deepStarsFromBuffer,
    HIPPARCOS,
    isCompact,
    loadCatalog,
    loadDeepStars,
    loadFaintStars,
    packedStarAt,
    packedStarColors,
    packedStarsFromBuffer,
    packStars,
    STAR_FIELDS,
    starAt,
    TYCHO,
} from "./catalog.js";

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

export type { ConstellationLines } from "./constellations.js";
export {
    CONSTELLATION_LINES,
    CONSTELLATIONS,
    constellationMask,
    constellationsFromBuffer,
    loadConstellations,
    ZODIAC,
} from "./constellations.js";

export type { MilkyWay, MilkyWayFiles, MilkyWayImage } from "./milkyway.js";
export {
    createMilkyWay,
    loadMilkyWay,
    MILKY_WAY_LUMINANCE,
    MILKY_WAY_MAPS,
    MILKY_WAY_STOPS,
} from "./milkyway.js";

export type {
    EncodeOptions,
    HaloLevel,
    StarImage,
    StarsInspection,
    StarsParams,
    StarsPass,
    StarsPassOptions,
} from "./stars.js";
export {
    createStarsPass,
    deepStarBlocks,
    haloGrid,
    haloLevels,
    haloLevelWidth,
    haloWeights,
    PARAMS_SIZE,
    paramsData,
} from "./stars.js";

// The raw WGSL, for inlining into a consumer's own pipelines instead of using the pass above.
export * as wgsl from "./wgsl/index.js";
