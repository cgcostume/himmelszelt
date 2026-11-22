// The sky after Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" (EGSR 2020), on
// Bruneton & Neyret's model: small tables precomputed per model, one of the whole sky per sun, and a
// compute pass that writes it into the caller's target. Bruneton's four-dimensional table may come later as another
// way to fill the sky-view table.

// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical

// The physical model.
export type {
    AtmosphereModel,
    ExponentialLayer,
    PlanetGeometry,
    PrecomputedTextureConfig,
    Spectral,
    TentLayer,
} from "./model.js";
export {
    atmosphereTopRadiusKm,
    luminanceScale,
    spectrumToRgb,
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_TEXTURE_CONFIG,
    OSGHIMMEL_ATMOSPHERE_MODEL,
    RGB_ATMOSPHERE_MODEL,
} from "./model.js";

// The four wavelengths the light is computed at, the spectral data behind the model, and the fitted matrix to RGB.
export {
    DEFAULT_WAVELENGTHS,
    fitSpectrumToRgb,
    luminanceOf,
    ozoneAbsorptionAt,
    rayleighAt,
    reflectanceAt,
    rgbOfSpectrum,
    skySpectrum,
    solarIrradianceAt,
} from "./spectral.js";

// Exposure in EV100, for the sky in cd/m².
export type { AutoExposureKey, Tint } from "./exposure.js";
export { autoExposureCompensation, autoExposureTint } from "./exposure.js";
export { ev100FromLuminance, exposureFromEV100 } from "@himmelszelt/helldunkel";
// The white balance, before the exposure: a reference white shown as D65.
export type { WhiteBalance } from "@himmelszelt/helldunkel";
export { NO_WHITE_BALANCE, whiteBalance } from "@himmelszelt/helldunkel";

// Packing the model into the DkAtmosphere uniform block the shaders take.
export { ATMOSPHERE_UNIFORM_SIZE, atmosphereUniformData } from "./uniforms.js";

// Pipeline-overridable sample counts, for specializing a shader at pipeline creation.
export type { ToneCurve } from "@himmelszelt/helldunkel";
export type { Aureole, QualityConstants } from "./quality.js";
export {
    aureoleConstants,
    DEFAULT_AUREOLE,
    DEFAULT_QUALITY,
    LENS_VEIL,
    pipelineConstants,
} from "./quality.js";

// What a device needs: the features and limits to request it with, and what one lacks.
export type { DeviceRequirements, RequirementOptions } from "./requirements.js";
export { skyRequirements, unmetRequirements } from "./requirements.js";

// Precomputing the tables and rendering the sky with them.
export type { PrecomputeOptions } from "./luts.js";
export { MULTI_SCATTERING_LOG2_OFFSET, precomputeAtmosphere } from "./luts.js";
export type { SkyPassOptions } from "./sky.js";
export { createSkyPass } from "./sky.js";

// Pass and LUT interfaces. This package records into passes the caller owns; it creates no device, canvas,
// context or render pass of its own.
export type {
    AerialPerspectiveOptions,
    AerialPerspectivePass,
    AerialPerspectivePassOptions,
    AerialPerspectiveScene,
    AerialPerspectiveVolume,
    AtmosphereLUTs,
    SkyCubeOptions,
    SkyCubePass,
    SkyParams,
    SkyPass,
} from "./pass.js";
export { clampObserverHeight, MAX_OBSERVER_HEIGHT_M, MIN_OBSERVER_HEIGHT_M } from "./pass.js";

// Atmospheric refraction, traced through the model's air like the view rays: where the sun shows, on the CPU.
export {
    airRefractivity,
    airTransmittance,
    apparentDirection,
    apparentHorizon,
    lightThroughAir,
    refractionAngle,
} from "./refraction.js";
// The share of the Sun's disc the Moon leaves uncovered in a solar eclipse.
export { discUncovered } from "./eclipse.js";

// What the air does to light from beyond it, a star's, the Moon's, a satellite's: one table per observer height of the
// bend, the transmittance, the airmass and the turbulence over the apparent altitude, looked up here and by `wgsl.air`.
export type { Air, AirTable } from "./air.js";
export {
    AIR_TABLE_FORMAT,
    AIR_TABLE_ROWS,
    AIR_TABLE_WIDTH,
    airAt,
    airLift,
    airShows,
    airTable,
    airTableFrom,
    createAirTexture,
    liftedDirection,
    unbentDirection,
    writeAirTexture,
} from "./air.js";

// The air's turbulence: how it moves an image and makes a point flicker, for `wgsl.seeing` and the shimmer pass.
export type { PathTurbulence, Seeing, Turbulence } from "./seeing.js";
export {
    SEEING_UNIFORM_SIZE,
    SEEING_WAVELENGTH_M,
    scintillation,
    scintillationIndex,
    seeingUniformData,
    shimmerScales,
    turbulenceStrength,
    turbulenceThrough,
    turbulenceWind,
    zenithScintillation,
    zenithTilt,
} from "./seeing.js";
export type { ShimmerParams, ShimmerParts, ShimmerPass, ShimmerPassOptions } from "./shimmer.js";
export {
    AIR_CHANNEL_DISPERSION,
    AIR_DISPERSION,
    createShimmerPass,
    shimmerExtent,
    shimmerReach,
    shimmerShows,
} from "./shimmer.js";

// Reading a LUT back to the CPU, for inspecting or exporting one.
export type { TexturePixels } from "./readback.js";
export { readTexture } from "./readback.js";

// The raw WGSL, for inlining into a consumer's own pipelines instead of using the passes above.
export * as wgsl from "./wgsl/index.js";
