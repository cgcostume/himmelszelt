// The precise variant: Bruneton & Neyret, "Precomputed Atmospheric Scattering" (2008), the model osgHimmel's
// atmosphere is built on. Use `@himmelszelt/dunstkreis/approx` for the cheaper Hillaire 2020 decomposition; the
// two share everything below and differ only in how they integrate it.
//
// The precompute pipeline (transmittance, irradiance, 4D inscatter, N scattering orders) is not implemented
// yet. What is here is the shared foundation: the model, refraction, and the WGSL layer.

// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical

// The physical model, shared by both variants.
export type {
    AtmosphereModel,
    ExponentialLayer,
    PlanetGeometry,
    PrecomputedTextureConfig,
    TentLayer,
} from "./model.js";
export {
    atmosphereTopRadiusKm,
    luminanceScale,
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_TEXTURE_CONFIG,
    OSGHIMMEL_ATMOSPHERE_MODEL,
} from "./model.js";

// Exposure in EV100, for the sky in cd/m².
export type { AutoExposureKey } from "./exposure.js";
export {
    autoExposureCompensation,
    DEFAULT_AUTO_EXPOSURE_KEYS,
    ev100FromLuminance,
    exposureFromEV100,
} from "./exposure.js";

// Packing the model into the DkAtmosphere uniform block the shaders take.
export { ATMOSPHERE_UNIFORM_SIZE, atmosphereUniformData } from "./uniforms.js";

// Pipeline-overridable constants, for specializing a shader at pipeline creation.
export type { QualityConstants } from "./quality.js";
export { DEFAULT_QUALITY, pipelineConstants } from "./quality.js";

// Pass and LUT interfaces. This package records into passes the caller owns; it creates no device, canvas,
// context or render pass of its own.
export type { AtmosphereLUTs, SkyParams, SkyPass } from "./pass.js";
export { MIN_OBSERVER_HEIGHT_M } from "./pass.js";

// Atmospheric refraction, traced through the model's air like the view rays: where the sun shows, on the CPU.
export { airRefractivity, apparentDirection, refractionAngle } from "./refraction.js";

// Reading a LUT back to the CPU, for inspecting or exporting one.
export type { TexturePixels } from "./readback.js";
export { readTexture } from "./readback.js";

// The raw WGSL, for inlining into a consumer's own pipelines instead of using the passes above.
export * as wgsl from "./wgsl/index.js";
