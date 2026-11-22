// From light to pixels: how bright a scene in cd/m² is shown, how its range is folded into the display's, and how the
// result is written.

// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical

// Exposure in EV100.
export { ev100FromLuminance, exposureFromEV100, localAdaptation, lowLightCompensation } from "./exposure.js";

// White balance, before the exposure: a reference white shown as D65.
export type { WhiteBalance } from "./white.js";
export {
    adaptationDegree,
    applyWhiteBalance,
    D65_WHITE,
    daylightWhite,
    MOON_WHITE,
    NO_WHITE_BALANCE,
    planckianWhite,
    SUN_WHITE,
    whiteBalance,
    WHITE_POINTS,
    whiteFromChromaticity,
} from "./white.js";

/**
 * A tone curve for a display: "neutral", Khronos PBR Neutral, which keeps colors as they are up to 0.76 and compresses
 * only above; "agx", Sobotka's, whose bright colors fade towards white as film does, flatter and grayer by day; or
 * "aces", Narkowicz's fit of the ACES filmic curve, saturated, shifting bright hues towards yellow; or "clip", none at
 * all, the exposed light cut off at 1, where it saturates, to see what the curves make of it.
 */
export type ToneCurve = "neutral" | "agx" | "aces" | "clip";

// A light meter for what changes rarely, and the histogram it counts.
export type {
    MeterAdaptation,
    MeterAverage,
    MeterFocus,
    MeterHistogram,
    MeterPass,
    MeterPassOptions,
    MeterReading,
} from "./meter.js";
export {
    adaptEV100,
    createMeterPass,
    METER_BINS,
    METER_BINS_PER_STOP,
    METER_LOWEST_STOP,
    meteredLuminance,
} from "./meter.js";

// The veil of a bright point source, the eye's own glare.
export { meanVeilingGlare, veilingGlare } from "./glare.js";

// A lens's starburst around a bright point source.
export { starburstSpikes } from "./lens.js";

// The eye at night: the rods' blue shift, before the exposure.
export { coneShare, darkAdaptedEye } from "./vision.js";

// Blue noise for the dither, as a texture on a device.
export { BLUE_NOISE_SIZE, blueNoiseData, blueNoiseTexture } from "./bluenoise.js";

// Bloom, over a linear, exposed image.
export type { BloomPass, BloomPassOptions } from "./bloom.js";
export { createBloomPass } from "./bloom.js";

// The raw WGSL, for inlining into a consumer's own shaders.
export * as wgsl from "./wgsl/index.js";
