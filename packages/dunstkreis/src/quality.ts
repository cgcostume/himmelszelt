import type { ToneCurve } from "@himmelszelt/helldunkel";
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
    DK_SAMPLES_CUBE: number;
}

/** The defaults `quality.wgsl` declares, `DEFAULT_TEXTURE_CONFIG`'s. */
export const DEFAULT_QUALITY: QualityConstants = {
    DK_SAMPLES_TRANSMITTANCE: 100,
    DK_SAMPLES_MULTI_SCATTERING: 40,
    DK_SAMPLES_SKY_VIEW: 30,
    DK_SAMPLES_CUBE: 1,
};

/**
 * Builds the `constants` record for a pipeline descriptor from a texture configuration, i.e.
 * `{ compute: { module, entryPoint, constants: pipelineConstants(config) } }`, with the samples per cube map texel if
 * given. Every key matches an `override` in `wgsl/quality.wgsl`, or pipeline
 * creation fails; a test pins the two lists together.
 */
export function pipelineConstants(config: PrecomputedTextureConfig, samples: { cube?: number } = {}): QualityConstants {
    const { integralSamples } = config;
    return {
        DK_SAMPLES_TRANSMITTANCE: integralSamples.transmittance,
        DK_SAMPLES_MULTI_SCATTERING: integralSamples.multiScattering,
        DK_SAMPLES_SKY_VIEW: integralSamples.skyView,
        DK_SAMPLES_CUBE: samples.cube ?? DEFAULT_QUALITY.DK_SAMPLES_CUBE,
    };
}

/** The passes' switches, `wgsl/features.wgsl`, as their defaults there. */
export interface Features {
    toneMap: ToneCurve | false;
    /** The display's headroom in multiples of SDR white, for a float target on an HDR display; 1 for SDR. */
    headroom: number;
    dither: boolean;
    autoExposure: boolean;
    debugGrid: boolean;
    sunDisc: boolean;
    /** The eye's veil around the sun, its strength: 1 the eye's own, 0 none. */
    veil: number;
    discAlpha: boolean;
    supersample: boolean;
    cube: boolean;
    cubeScaled: boolean;
    cubify: boolean;
    /** Which rows of the sky-view table a dispatch writes: 0 all, 1 the sky, 2 the ground lit by the sky too. */
    skyViewRows: 0 | 1 | 2;
    /** The Moon as a second light of the sky, from a sky-view table of its own. */
    moonlight: boolean;
    /** Build the Moon's sky-view table rather than the Sun's. */
    moonView: boolean;
}

export const DEFAULT_FEATURES: Features = {
    toneMap: "neutral",
    headroom: 1,
    dither: true,
    autoExposure: false,
    debugGrid: false,
    sunDisc: true,
    veil: 0,
    discAlpha: false,
    supersample: true,
    cube: false,
    cubeScaled: false,
    cubify: false,
    skyViewRows: 0,
    moonlight: false,
    moonView: false,
};

/** The `constants` record for `features.wgsl`; a test pins its keys to the overrides declared there. */
export function featureConstants(features: Partial<Features> = {}): Record<string, number> {
    const f = { ...DEFAULT_FEATURES, ...features };
    return {
        DK_TONE_MAP: f.toneMap === false ? 0 : { neutral: 1, agx: 2, aces: 3, clip: 4 }[f.toneMap],
        DK_HEADROOM: f.headroom,
        DK_DITHER: Number(f.dither),
        DK_AUTO_EXPOSURE: Number(f.autoExposure),
        DK_DEBUG_GRID: Number(f.debugGrid),
        DK_SUN_DISC: Number(f.sunDisc),
        DK_VEIL: f.veil,
        DK_DISC_ALPHA: Number(f.discAlpha),
        DK_SUPERSAMPLE: Number(f.supersample),
        DK_CUBE: Number(f.cube),
        DK_CUBE_SCALED: Number(f.cubeScaled),
        DK_CUBIFY: Number(f.cubify),
        DK_SKY_VIEW_ROWS: f.skyViewRows,
        DK_MOONLIGHT: Number(f.moonlight),
        DK_MOON_VIEW: Number(f.moonView),
    };
}

/** `common.wgsl`'s own switch: the straight march for a model whose air does not bend. */
export const refractionConstants = (model: AtmosphereModel) => ({ DK_REFRACTION: model.refractivity > 0 ? 1 : 0 });

/** `common.wgsl`'s orders of scattering the march adds up: once, more than once, by default both. */
export const scatteringConstants = ({
    single = true,
    multiple = true,
}: {
    single?: boolean;
    multiple?: boolean;
} = {}) => ({
    DK_SINGLE_SCATTERING: Number(single),
    DK_MULTIPLE_SCATTERING: Number(multiple),
});

/**
 * The aureole, the aerosols' narrow forward lobe around the sun: the share of their scattering in it and its asymmetry.
 * 5 % at 0.98 by default, a glow of about a degree around the Sun, which brings a single Cornette-Shanks lobe's
 * forward peak to about what measured aerosols show; off, the one lobe carries all of it, as Bruneton's and Hillaire's
 * skies do. At the horizon the aerosol along a ray is some hundred times the zenith's and thins fast with altitude,
 * so a wide lobe there would be a band along the horizon rather than a glow.
 */
export interface Aureole {
    share: number;
    g: number;
}

export const DEFAULT_AUREOLE: Aureole = { share: 0.05, g: 0.98 };

/** `common.wgsl`'s aureole overrides, for every pass that marches the air and the sky pass that adds it. */
export const aureoleConstants = (aureole: Aureole | false = DEFAULT_AUREOLE) => ({
    DK_AUREOLE_SHARE: aureole === false ? 0 : aureole.share,
    DK_AUREOLE_G: aureole === false ? DEFAULT_AUREOLE.g : aureole.g,
});
