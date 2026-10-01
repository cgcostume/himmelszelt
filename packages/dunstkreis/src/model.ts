import { airRefractivity } from "./refraction.js";
import {
    DEFAULT_WAVELENGTHS,
    fitSpectrumToRgb,
    luminanceOf,
    ozoneAbsorptionAt,
    rayleighAt,
    solarIrradianceAt,
} from "./spectral.js";

/** A quantity at the model's four wavelengths, red to blue. */
export type Spectral = readonly [number, number, number, number];

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
 * Coefficients are at the model's four `wavelengths` and in `1/km`, at sea level. The light is computed at those four
 * and turned into RGB at the end, by a matrix fitted to sky spectra (`spectrumToRgb`).
 */
export interface AtmosphereModel {
    planet: PlanetGeometry;
    /** The four wavelengths, in nm, red to blue, every spectral quantity below is given at. */
    wavelengths: Spectral;
    /**
     * How the four wavelengths become RGB: "fitted", by a matrix fitted to sky spectra (`spectrumToRgb`); or "samples",
     * the first three taken as R, G and B and the fourth left out, as Bruneton & Neyret's three wavelengths were.
     */
    colorConversion: "fitted" | "samples";
    /**
     * The sun's spectrum at the top of the atmosphere at the four wavelengths: Bruneton's spectral irradiance. Only the
     * ratios between them count; `solarIlluminance` sets the scale.
     */
    solarSpectrum: Spectral;
    /**
     * Illuminance of the sun at the top of the atmosphere, in lux, which puts the sky in physical units: luminance in
     * cd/m², ready for an exposure in EV100. See `luminanceScale`.
     */
    solarIlluminance: number;
    /**
     * The ground's albedo in linear sRGB, not sRGB encoded: the share of the light it receives that it reflects,
     * diffusely. It lights the air from below and shows as the ground itself, lit by the sun and the sky. 0.3 by default,
     * the Earth's average; Bruneton's and Hillaire's work used 0.1, fresh snow reflects 0.8 or more. Spread over the
     * four wavelengths by `reflectanceAt`.
     */
    groundAlbedo: readonly [number, number, number];
    rayleigh: ExponentialLayer & {
        /** Rayleigh scattering coefficient. Equals the extinction coefficient: air molecules do not absorb. */
        beta: Spectral;
    };
    mie: ExponentialLayer & {
        /** Mie scattering coefficient. */
        betaScattering: Spectral;
        /** Mie extinction coefficient, i.e. scattering plus absorption, so always >= `betaScattering`. */
        betaExtinction: Spectral;
        /** Cornette-Shanks asymmetry factor, in [-1, +1]. Positive is forward-scattering, the physical case. */
        g: number;
    };
    ozone: TentLayer & {
        /** Ozone absorption coefficient. Ozone only absorbs, so there is no scattering counterpart. */
        betaAbsorption: Spectral;
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
/** The Earth's atmosphere at `wavelengths`, every spectral quantity from the same data. */
function earthAt(wavelengths: Spectral, colorConversion: AtmosphereModel["colorConversion"]): AtmosphereModel {
    const at = (f: (wavelength: number) => number): Spectral => wavelengths.map(f) as unknown as Spectral;
    return {
        // Hillaire's 100 km rather than Bruneton's 60: cut at 60 km, where the air still has 5e-4 of its density at the
        // ground, the atmosphere ends in a visible edge when seen from space.
        planet: { groundRadiusKm: 6360, thicknessKm: 100 },
        wavelengths,
        colorConversion,
        solarSpectrum: at(solarIrradianceAt),
        // The solar constant, 1361 W/m² (Kopp & Lean 2011), times sunlight's luminous efficacy of about 94 lm/W.
        solarIlluminance: 128_000,
        // The Earth's average, rather than the 0.1 of Bruneton's and Hillaire's work, which is dark soil or forest.
        groundAlbedo: [0.3, 0.3, 0.3],
        rayleigh: {
            scaleHeightKm: 8,
            // Bruneton's λ⁻⁴ fit; 5.8e-3, 1.35e-2 and 3.31e-2 at 680, 550 and 440 nm, Riley et al.'s.
            beta: at(rayleighAt),
        },
        mie: {
            // 1.2 km: aerosols hug the ground far more tightly than air itself does.
            scaleHeightKm: 1.2,
            betaScattering: at(() => 3e-3),
            // The usual single-scattering albedo of 0.9 for atmospheric aerosols, i.e. a tenth is absorbed.
            betaExtinction: at(() => 3e-3 / 0.9),
            g: 0.8,
        },
        ozone: {
            // Without it twilight goes gray instead of deep blue, because nothing else removes the green-yellow band from
            // the long, low-sun paths. Bruneton's cross-section for 300 Dobson units, which at 680, 550 and 440 nm gives
            // Hillaire's 6.5e-4, 1.881e-3 and 8.5e-5.
            centerAltitudeKm: 25,
            widthKm: 30,
            betaAbsorption: at(ozoneAbsorptionAt),
        },
        refractivity: airRefractivity(),
    };
}

export const DEFAULT_ATMOSPHERE_MODEL: AtmosphereModel = earthAt(DEFAULT_WAVELENGTHS, "fitted");

/**
 * The same air computed at Bruneton & Neyret's three wavelengths, 680, 550 and 440 nm, taken as R, G and B: how skies
 * were colored before, 5% off in hue on average and 14% in deep twilight, for comparison. The fourth repeats 440 nm.
 */
export const RGB_ATMOSPHERE_MODEL: AtmosphereModel = earthAt([680, 550, 440, 440], "samples");

/**
 * osgHimmel's `t_modelCfg` defaults verbatim, its three wavelengths taken as R, G and B, for A/B-ing this port against
 * the original. Note the thicker Mie layer, the weaker forward scattering, the much stronger Mie coefficient, and the
 * absent ozone. The fourth wavelength repeats the third.
 */
export const OSGHIMMEL_ATMOSPHERE_MODEL: AtmosphereModel = {
    ...RGB_ATMOSPHERE_MODEL,
    // osgHimmel drove these from `Earth::meanRadius()` and `Earth::atmosphereThicknessNonUniform()`.
    planet: { groundRadiusKm: 6371, thicknessKm: 85 },
    solarSpectrum: [1.474, 1.8504, 1.91198, 1.91198],
    rayleigh: { scaleHeightKm: 8, beta: [5.8e-3, 1.35e-2, 3.31e-2, 3.31e-2] },
    mie: {
        scaleHeightKm: 6,
        betaScattering: [20e-3, 20e-3, 20e-3, 20e-3],
        betaExtinction: [20e-3 / 0.9, 20e-3 / 0.9, 20e-3 / 0.9, 20e-3 / 0.9],
        g: 0.6,
    },
    ozone: { centerAltitudeKm: 25, widthKm: 30, betaAbsorption: [0, 0, 0, 0] },
};

/**
 * Sizes and sample counts of the tables. The errors quoted are the luminance's, mean and worst, against references
 * with many more samples or texels, over a sun 1.7° up, 5.7° and 12° down and 45° up; the costs a desktop GPU's
 * (RX 7900 XT), which an integrated or mobile one may take 20 to 50 times as long for. research/README.md has the details.
 */
export interface PrecomputedTextureConfig {
    /**
     * 256x64. Its effect on the sky: 0.04% on average, 0.6% at worst. 128x32 triples the mean; 512x128 divides it by
     * four for 2 ms instead of 0.9, once per model. Other shapes of as many texels measured no better.
     */
    transmittance: { width: number; height: number };
    /**
     * Hillaire's multiple-scattering LUT (h, muS), which replaces Bruneton's 4D inscatter table entirely. 128x64, wider
     * than high: deep twilight leans on it, and on its sun angles more than its altitudes. With the sun 12° down 1.2%
     * off on average and 2.6% at worst, where 64x64 is 2.6% and 11% off and Hillaire's 32x32 14% and 27%. 0.7 ms,
     * once per model.
     */
    multiScattering: { width: number; height: number };
    /**
     * Hillaire's per-frame sky-view LUT, over view direction with a horizon-biased latitude mapping. 128x256, taller
     * than wide: its columns, half a turn of azimuth from the sun, need far fewer texels than its rows, the angle from
     * the horizon. 0.03% off on average, 0.33% for the worst hundredth of texels; Hillaire's 192x108, with as many
     * texels, is four and six times that. 128x512 divides both by two and three, for 0.11 ms per rebuild instead of
     * 0.07.
     */
    skyView: { width: number; height: number };
    integralSamples: {
        /**
         * Per ray, 100: 0.015% on average, 0.2% at worst. 40 is faster, 0.1% on average, but moves the sun's cutoff
         * at the horizon by a texel here and there. Little better beyond 128. 0.9 ms for 100, linear in the count.
         */
        transmittance: number;
        /** Per direction, 40: 0.08% on average, 3% at worst. 20 is faster, 0.25% and 10%; no better beyond 64. */
        multiScattering: number;
        /**
         * Per view ray, 30: 0.4% on average, 4.8% at worst, in deep twilight. 20 for speed, 1.2% and 10%; 40 for
         * quality, 0.4% and 2.8%; little better beyond 64. The only count on the per-frame path, 0.07 ms per rebuild
         * for 30, linear.
         */
        skyView: number;
    };
}

export const DEFAULT_TEXTURE_CONFIG: PrecomputedTextureConfig = {
    transmittance: { width: 256, height: 64 },
    multiScattering: { width: 128, height: 64 },
    skyView: { width: 128, height: 256 },
    integralSamples: { transmittance: 100, multiScattering: 40, skyView: 30 },
};

/** Radius of the top of the atmosphere, in km, i.e. `Rt`. */
export function atmosphereTopRadiusKm(model: AtmosphereModel): number {
    return model.planet.groundRadiusKm + model.planet.thicknessKm;
}

const fitted = new Map<string, number[][]>();

/**
 * The matrix from the model's four wavelengths to linear sRGB, rows R, G and B, fitted to sky spectra
 * (`fitSpectrumToRgb`), once per set of wavelengths; with "samples", the first three as they are.
 */
export function spectrumToRgb(model: AtmosphereModel): number[][] {
    if (model.colorConversion === "samples")
        return [
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, 0],
        ];
    const key = model.wavelengths.join();
    let matrix = fitted.get(key);
    if (!matrix) {
        matrix = fitSpectrumToRgb(model.wavelengths);
        fitted.set(key, matrix);
    }
    return matrix;
}

/**
 * What the sun's spectrum is multiplied by to give it `solarIlluminance` once turned into RGB, weighing the channels as
 * Rec. 709 luminance does. `atmosphereUniformData` packs the spectrum scaled so, and everything the shaders compute
 * from it comes out in cd/m².
 */
export function luminanceScale(model: AtmosphereModel): number {
    const rgb = spectrumToRgb(model).map((row) =>
        row.reduce((sum, m, j) => sum + m * (model.solarSpectrum[j] as number), 0),
    );
    return model.solarIlluminance / luminanceOf(rgb);
}
