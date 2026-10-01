import { airRefractivity } from "./refraction.js";

/**
 * Geometry of the planet and its atmosphere. The atmosphere is the shell between `groundRadiusKm` and
 * `groundRadiusKm + thicknessKm`. The observer can be inside it or above it.
 */
export interface PlanetGeometry {
    /** Radius of the ground, in km, `Rg` in the shaders. */
    groundRadiusKm: number;
    /** Thickness of the atmosphere shell, in km, so the top is at `groundRadiusKm + thicknessKm` (`Rt`). */
    thicknessKm: number;
}

/** An exponentially decaying density layer, the profile both Rayleigh and Mie scattering follow. */
export interface ExponentialLayer {
    /** Altitude over which the layer's density falls by a factor of e, in km. */
    scaleHeightKm: number;
}

/**
 * A tent-shaped density layer, peaking at `centerAltitudeKm` and falling linearly to zero `widthKm / 2` above
 * and below it. Ozone follows this rather than an exponential, since it is produced by UV in the stratosphere
 * rather than settling out of the air like aerosols.
 */
export interface TentLayer {
    centerAltitudeKm: number;
    widthKm: number;
}

/**
 * Physical parameters of the atmosphere, the same for Hillaire's tables and Bruneton's: they differ in how they
 * integrate this model, not in the model itself.
 *
 * Coefficients are per RGB channel and in `1/km`, at sea level. They are wavelength-dependent in reality, so
 * an RGB triple is already an approximation of a spectral quantity, picked for (680, 550, 440) nm.
 */
export interface AtmosphereModel {
    planet: PlanetGeometry;
    /**
     * The sun's spectrum at the top of the atmosphere, per channel: Bruneton's spectral irradiance at the three
     * wavelengths. Only the ratios between the channels count; `solarIlluminance` sets the scale.
     */
    solarSpectrum: readonly [number, number, number];
    /**
     * Illuminance of the sun at the top of the atmosphere, in lux, which puts the sky in physical units: luminance in
     * cd/m², ready for an exposure in EV100. See `luminanceScale`.
     */
    solarIlluminance: number;
    /**
     * The ground's albedo per channel, linear rather than sRGB: the share of the light it receives that it reflects,
     * diffusely. It lights the air from below and shows as the ground itself, lit by the sun and the sky. 0.3 by default,
     * the Earth's average; Bruneton's and Hillaire's work used 0.1, fresh snow reflects 0.8 or more.
     */
    groundAlbedo: readonly [number, number, number];
    rayleigh: ExponentialLayer & {
        /** Rayleigh scattering coefficient. Equals the extinction coefficient: air molecules do not absorb. */
        beta: readonly [number, number, number];
    };
    mie: ExponentialLayer & {
        /** Mie scattering coefficient. */
        betaScattering: readonly [number, number, number];
        /** Mie extinction coefficient, i.e. scattering plus absorption, so always >= `betaScattering`. */
        betaExtinction: readonly [number, number, number];
        /** Cornette-Shanks asymmetry factor, in [-1, +1]. Positive is forward-scattering, the physical case. */
        g: number;
    };
    ozone: TentLayer & {
        /** Ozone absorption coefficient. Ozone only absorbs, so there is no scattering counterpart. */
        betaAbsorption: readonly [number, number, number];
    };
    /**
     * Refractivity n - 1 of the air on the ground, see `airRefractivity`. It falls off with the Rayleigh layer's
     * density, and every ray bends by it: 0 leaves them straight.
     */
    refractivity: number;
}

/**
 * Earth. The defaults are the modern consensus values rather than a literal copy of osgHimmel's, which
 * predate both the ozone term and the now-standard aerosol scale height; see `OSGHIMMEL_ATMOSPHERE_MODEL` to
 * reproduce the original exactly.
 */
export const DEFAULT_ATMOSPHERE_MODEL: AtmosphereModel = {
    // Hillaire's 100 km rather than Bruneton's 60: cut at 60 km, where the air still has 5e-4 of its density at the
    // ground, the atmosphere ends in a visible edge when seen from space.
    planet: { groundRadiusKm: 6360, thicknessKm: 100 },
    solarSpectrum: [1.474, 1.8504, 1.91198],
    // The solar constant, 1361 W/m² (Kopp & Lean 2011), times sunlight's luminous efficacy of about 94 lm/W.
    solarIlluminance: 128_000,
    // The Earth's average, rather than the 0.1 of Bruneton's and Hillaire's work, which is dark soil or forest.
    groundAlbedo: [0.3, 0.3, 0.3],
    rayleigh: {
        scaleHeightKm: 8,
        // Bruneton & Neyret 2008, after Riley et al. 2004.
        beta: [5.8e-3, 1.35e-2, 3.31e-2],
    },
    mie: {
        // 1.2 km: aerosols hug the ground far more tightly than air itself does.
        scaleHeightKm: 1.2,
        betaScattering: [3e-3, 3e-3, 3e-3],
        // The usual single-scattering albedo of 0.9 for atmospheric aerosols, i.e. a tenth is absorbed.
        betaExtinction: [3e-3 / 0.9, 3e-3 / 0.9, 3e-3 / 0.9],
        g: 0.8,
    },
    ozone: {
        // Without it twilight goes gray instead of deep blue, because nothing else removes the green-yellow band from
        // the long, low-sun paths. Hillaire 2020's values.
        centerAltitudeKm: 25,
        widthKm: 30,
        betaAbsorption: [6.5e-4, 1.881e-3, 8.5e-5],
    },
    refractivity: airRefractivity(),
};

/**
 * osgHimmel's `t_modelCfg` defaults verbatim, for A/B-ing this port against the original. Note the thicker
 * Mie layer, the weaker forward scattering, the much stronger Mie coefficient, and the absent ozone.
 */
export const OSGHIMMEL_ATMOSPHERE_MODEL: AtmosphereModel = {
    ...DEFAULT_ATMOSPHERE_MODEL,
    // osgHimmel drove these from `Earth::meanRadius()` and `Earth::atmosphereThicknessNonUniform()`.
    planet: { groundRadiusKm: 6371, thicknessKm: 85 },
    mie: {
        scaleHeightKm: 6,
        betaScattering: [20e-3, 20e-3, 20e-3],
        betaExtinction: [20e-3 / 0.9, 20e-3 / 0.9, 20e-3 / 0.9],
        g: 0.6,
    },
    ozone: { centerAltitudeKm: 25, widthKm: 30, betaAbsorption: [0, 0, 0] },
};

/**
 * Sizes and sample counts of the tables. The errors quoted are the luminance's, against references with many more
 * samples or four times the texels, over a sun 1.7° up, 5.7° and 12° down and 45° up; the costs a desktop GPU's
 * (RX 7900 XT), which an integrated or mobile one may take 20 to 50 times as long for. The README has the full table.
 */
export interface PrecomputedTextureConfig {
    /**
     * 256x64. Read bilinearly; its effect on the sky: 0.09% on average, 3.6% at worst in deep twilight. 128x32 doubles
     * both, 512x128 halves them for 2 ms instead of 0.9, once per model.
     */
    transmittance: { width: number; height: number };
    /**
     * Hillaire's multiple-scattering LUT (h, muS), which replaces Bruneton's 4D inscatter table entirely. 64x64, as deep
     * twilight leans on it: 0.9% off on average with the sun 12° down, where 32x32 is 9% off. 0.35 ms instead of 0.11,
     * once per model.
     */
    multiScattering: { width: number; height: number };
    /**
     * Hillaire's per-frame sky-view LUT, over view direction with a horizon-biased latitude mapping. 256x144: 0.07% off
     * on average, 1% for the worst hundredth of texels, around the sun; 192x108, Hillaire's, doubles both. 384x216
     * halves them again, for 0.12 ms per rebuild instead of 0.07.
     */
    skyView: { width: number; height: number };
    integralSamples: {
        /**
         * Per ray, 100: 0.01% on average, 0.13% at worst. 40 is faster, 0.08% on average, but moves the sun's cutoff at
         * the horizon by a texel here and there. No better beyond 128. 0.9 ms for 100, linear in the count.
         */
        transmittance: number;
        /** Per direction, 40: 0.1% on average. 20 is faster, 0.26%; no better beyond 64, which half floats limit. */
        multiScattering: number;
        /**
         * Per view ray, 30: 0.14% on average, 1.2% at worst. 15 to 20 for speed, 0.2% and 3%; 40 for quality, 0.09% and
         * 0.7%; little better beyond 64. The only count on the per-frame path, 0.05 ms per rebuild for 30 at 192x108,
         * linear in the count and the texels.
         */
        skyView: number;
    };
}

export const DEFAULT_TEXTURE_CONFIG: PrecomputedTextureConfig = {
    transmittance: { width: 256, height: 64 },
    multiScattering: { width: 64, height: 64 },
    skyView: { width: 256, height: 144 },
    integralSamples: { transmittance: 100, multiScattering: 40, skyView: 30 },
};

/** Radius of the top of the atmosphere, in km, i.e. `Rt`. */
export function atmosphereTopRadiusKm(model: AtmosphereModel): number {
    return model.planet.groundRadiusKm + model.planet.thicknessKm;
}

/**
 * What the sun's spectrum is multiplied by to give it `solarIlluminance`, weighing the channels as Rec. 709
 * luminance does: 0.2126, 0.7152, 0.0722. `atmosphereUniformData` packs the spectrum scaled so, and everything the
 * shaders compute from it is in cd/m².
 */
export function luminanceScale(model: AtmosphereModel): number {
    const [r, g, b] = model.solarSpectrum;
    return model.solarIlluminance / (0.2126 * r + 0.7152 * g + 0.0722 * b);
}
