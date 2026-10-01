// The sky after Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" (EGSR 2020), on the
// model osgHimmel took from Bruneton & Neyret: small tables precomputed per model, one of the whole sky per sun, and a
// compute pass that writes it into the caller's target. Bruneton's four-dimensional table may come later as another
// way to fill the sky-view table.

// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical

// The physical model.
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

// Pipeline-overridable sample counts, for specializing a shader at pipeline creation.
export type { QualityConstants } from "./quality.js";
export { DEFAULT_QUALITY, pipelineConstants } from "./quality.js";

// What a device needs: the features and limits to request it with, and what one lacks.
export type { DeviceRequirements, RequirementOptions } from "./requirements.js";
export { skyRequirements, unmetRequirements } from "./requirements.js";

// Precomputing the tables and rendering the sky with them.
export type { PrecomputeOptions } from "./luts.js";
export { precomputeAtmosphere } from "./luts.js";
export type { SkyPassOptions } from "./sky.js";
export { createSkyPass } from "./sky.js";

// Diffuse image-based lighting from a cube map: spherical harmonics and an irradiance cube map.
export type { IrradiancePass, IrradiancePassOptions } from "./ibl.js";
export { createIrradiancePass } from "./ibl.js";

// Pass and LUT interfaces. This package records into passes the caller owns; it creates no device, canvas,
// context or render pass of its own.
export type { AtmosphereLUTs, SkyCubeOptions, SkyCubePass, SkyParams, SkyPass } from "./pass.js";
export { clampObserverHeight, MAX_OBSERVER_HEIGHT_M, MIN_OBSERVER_HEIGHT_M } from "./pass.js";

// Atmospheric refraction, traced through the model's air like the view rays: where the sun shows, on the CPU.
export { airRefractivity, apparentDirection, refractionAngle } from "./refraction.js";

// Reading a LUT back to the CPU, for inspecting or exporting one.
export type { TexturePixels } from "./readback.js";
export { readTexture } from "./readback.js";

// The raw WGSL, for inlining into a consumer's own pipelines instead of using the passes above.
export * as wgsl from "./wgsl/index.js";
