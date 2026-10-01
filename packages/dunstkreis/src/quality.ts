import type { AtmosphereModel, PrecomputedTextureConfig } from "./model.js";

/**
 * The sample counts declared by `wgsl/quality.wgsl`, as a typed record for a pipeline descriptor's `constants`. They
 * specialize a shader at pipeline creation rather than being read at runtime, which lets the compiler unroll the
 * integration loops, and is why they are not part of the uniform block.
 */
export interface QualityConstants {
    /** Indexable, since this is handed straight to a pipeline descriptor's `constants` record. */
    [name: string]: number;

    DK_SAMPLES_TRANSMITTANCE: number;
    DK_SAMPLES_MULTI_SCATTERING: number;
    DK_SAMPLES_SKY_VIEW: number;
    DK_SAMPLES_GROUND: number;
    DK_SAMPLES_CUBE: number;
}

/** The defaults `quality.wgsl` declares, `DEFAULT_TEXTURE_CONFIG`'s. */
export const DEFAULT_QUALITY: QualityConstants = {
    DK_SAMPLES_TRANSMITTANCE: 100,
    DK_SAMPLES_MULTI_SCATTERING: 40,
    DK_SAMPLES_SKY_VIEW: 30,
    DK_SAMPLES_GROUND: 1024,
    DK_SAMPLES_CUBE: 1,
};

/**
 * Builds the `constants` record for a pipeline descriptor from a texture configuration, i.e.
 * `{ compute: { module, entryPoint, constants: pipelineConstants(config) } }`, with the samples of the sky's light on
 * the ground and per cube map texel if given. Every key matches an `override` in `wgsl/quality.wgsl`, or pipeline
 * creation fails; a test pins the two lists together.
 */
export function pipelineConstants(
    config: PrecomputedTextureConfig,
    samples: { ground?: number; cube?: number } = {},
): QualityConstants {
    const { integralSamples } = config;
    return {
        DK_SAMPLES_TRANSMITTANCE: integralSamples.transmittance,
        DK_SAMPLES_MULTI_SCATTERING: integralSamples.multiScattering,
        DK_SAMPLES_SKY_VIEW: integralSamples.skyView,
        DK_SAMPLES_GROUND: samples.ground ?? DEFAULT_QUALITY.DK_SAMPLES_GROUND,
        DK_SAMPLES_CUBE: samples.cube ?? DEFAULT_QUALITY.DK_SAMPLES_CUBE,
    };
}

/**
 * A tone curve for a display: "neutral", Khronos PBR Neutral, which keeps colors as they are up to 0.76 and compresses
 * only above, or "agx", Sobotka's, whose bright colors fade towards white as film does, flatter and greyer by day.
 */
export type ToneCurve = "agx" | "neutral";

/** The passes' switches, `wgsl/features.wgsl`, as their defaults there. */
export interface Features {
    toneMap: ToneCurve | false;
    dither: boolean;
    autoExposure: boolean;
    debugGrid: boolean;
    sunDisc: boolean;
    cube: boolean;
    cubify: boolean;
    /** Which rows of the sky-view table a dispatch writes: 0 all, 1 the sky, 2 the ground lit by the sky too. */
    skyViewRows: 0 | 1 | 2;
}

export const DEFAULT_FEATURES: Features = {
    toneMap: "neutral",
    dither: true,
    autoExposure: false,
    debugGrid: false,
    sunDisc: true,
    cube: false,
    cubify: false,
    skyViewRows: 0,
};

/** The `constants` record for `features.wgsl`; a test pins its keys to the overrides declared there. */
export function featureConstants(features: Partial<Features> = {}): Record<string, number> {
    const f = { ...DEFAULT_FEATURES, ...features };
    return {
        DK_TONE_MAP: f.toneMap === false ? 0 : f.toneMap === "neutral" ? 1 : 2,
        DK_DITHER: Number(f.dither),
        DK_AUTO_EXPOSURE: Number(f.autoExposure),
        DK_DEBUG_GRID: Number(f.debugGrid),
        DK_SUN_DISC: Number(f.sunDisc),
        DK_CUBE: Number(f.cube),
        DK_CUBIFY: Number(f.cubify),
        DK_SKY_VIEW_ROWS: f.skyViewRows,
    };
}

/** `common.wgsl`'s own switch: the straight march for a model whose air does not bend. */
export const refractionConstants = (model: AtmosphereModel) => ({ DK_REFRACTION: model.refractivity > 0 ? 1 : 0 });
