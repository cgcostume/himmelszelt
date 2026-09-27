import type { PrecomputedTextureConfig } from "./model.js";

/**
 * The pipeline-overridable constants declared by `wgsl/quality.wgsl`, as a typed record. These specialize a
 * shader at pipeline creation rather than being read at runtime, which lets the compiler unroll the
 * integration loops, and is why the sample counts are not part of the uniform block.
 */
export interface QualityConstants {
    /** Indexable, since this is handed straight to a pipeline descriptor's `constants` record. */
    [name: string]: number;

    DK_SAMPLES_TRANSMITTANCE: number;
    DK_SAMPLES_INSCATTER: number;
    DK_SAMPLES_IRRADIANCE: number;
    DK_SAMPLES_INSCATTER_SPHERICAL: number;
    DK_SAMPLES_MULTI_SCATTERING: number;
    DK_SAMPLES_SKY_VIEW: number;
    /** WebGPU takes booleans as 0 or 1 in the `constants` record. */
    DK_TONE_MAP: number;
    DK_DITHER: number;
    DK_DEBUG_GRID: number;
    DK_CUBE: number;
    DK_CUBE_SAMPLES: number;
    DK_GROUND_LIGHT: number;
    DK_GROUND_SAMPLES: number;
    DK_SUN_DISC: number;
}

/** osgHimmel's sample counts, fewer for the transmittance, tone mapped and dithered, an image with the sun disc. */
export const DEFAULT_QUALITY: QualityConstants = {
    DK_SAMPLES_TRANSMITTANCE: 100,
    DK_SAMPLES_INSCATTER: 50,
    DK_SAMPLES_IRRADIANCE: 32,
    DK_SAMPLES_INSCATTER_SPHERICAL: 16,
    DK_SAMPLES_MULTI_SCATTERING: 20,
    DK_SAMPLES_SKY_VIEW: 30,
    DK_TONE_MAP: 1,
    DK_DITHER: 1,
    DK_DEBUG_GRID: 0,
    DK_CUBE: 0,
    DK_CUBE_SAMPLES: 1,
    DK_GROUND_LIGHT: 0,
    DK_GROUND_SAMPLES: 64,
    DK_SUN_DISC: 1,
};

/**
 * Builds the `constants` record for a pipeline descriptor from a texture configuration, i.e.
 * `{ compute: { module, entryPoint, constants: pipelineConstants(config) } }`.
 *
 * Every key must match an `override` declared in `wgsl/quality.wgsl`, or pipeline creation fails; a test
 * pins the two lists together.
 */
export function pipelineConstants(
    config: PrecomputedTextureConfig,
    options: {
        toneMap?: boolean;
        dither?: boolean;
        debugGrid?: boolean;
        cube?: boolean;
        cubeSamples?: 1 | 8 | 64;
        groundLight?: boolean;
        groundSamples?: 8 | 64;
        sunDisc?: boolean;
    } = {},
): QualityConstants {
    const { integralSamples } = config;

    return {
        DK_SAMPLES_TRANSMITTANCE: integralSamples.transmittance,
        DK_SAMPLES_INSCATTER: integralSamples.inscatter,
        DK_SAMPLES_IRRADIANCE: integralSamples.irradiance,
        DK_SAMPLES_INSCATTER_SPHERICAL: integralSamples.inscatterSpherical,
        DK_SAMPLES_MULTI_SCATTERING: integralSamples.multiScattering,
        DK_SAMPLES_SKY_VIEW: integralSamples.skyView,
        DK_TONE_MAP: options.toneMap === false ? 0 : 1,
        DK_DITHER: options.dither === false ? 0 : 1,
        DK_DEBUG_GRID: options.debugGrid ? 1 : 0,
        DK_CUBE: options.cube ? 1 : 0,
        DK_CUBE_SAMPLES: options.cubeSamples ?? 1,
        DK_GROUND_LIGHT: options.groundLight ? 1 : 0,
        DK_GROUND_SAMPLES: options.groundSamples ?? 64,
        DK_SUN_DISC: options.sunDisc === false ? 0 : 1,
    };
}
