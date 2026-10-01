import { expect, test } from "@playwright/test";
import {
    atmosphereTopRadiusKm,
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_TEXTURE_CONFIG,
    OSGHIMMEL_ATMOSPHERE_MODEL,
} from "../src/model.js";
import {
    DEFAULT_WAVELENGTHS,
    fitSpectrumToRgb,
    luminanceOf,
    ozoneAbsorptionAt,
    rayleighAt,
    rgbOfSpectrum,
    skySpectrum,
    solarIrradianceAt,
} from "../src/spectral.js";

test("the osgHimmel preset reproduces the original's t_modelCfg defaults", () => {
    const m = OSGHIMMEL_ATMOSPHERE_MODEL;

    // Three wavelengths taken as R, G and B, the fourth repeating the third.
    expect(m.wavelengths).toEqual([680, 550, 440, 440]);
    expect(m.colorConversion).toBe("samples");
    expect(m.groundAlbedo).toEqual([0.3, 0.3, 0.3]);
    expect(m.rayleigh.scaleHeightKm).toBe(8);
    expect(m.rayleigh.beta).toEqual([5.8e-3, 1.35e-2, 3.31e-2, 3.31e-2]);
    expect(m.mie.scaleHeightKm).toBe(6);
    expect(m.mie.betaScattering).toEqual([20e-3, 20e-3, 20e-3, 20e-3]);
    expect(m.mie.betaExtinction[0]).toBeCloseTo(20e-3 / 0.9, 10);
    expect(m.mie.g).toBe(0.6);
    // The original had no ozone term at all, hence the zeroed coefficient rather than a missing layer.
    expect(m.ozone.betaAbsorption).toEqual([0, 0, 0, 0]);
    // Earth::meanRadius() + Earth::atmosphereThicknessNonUniform(), matching sternzeit's earth constants.
    expect(m.planet).toEqual({ groundRadiusKm: 6371, thicknessKm: 85 });
});

test("the spectral data give the model's coefficients at Bruneton's wavelengths as before", () => {
    // Bruneton's and Hillaire's values at 680, 550 and 440 nm, which the three-wavelength model used.
    expect([680, 550, 440].map(rayleighAt).map((v) => Number(v.toPrecision(3)))).toEqual([5.8e-3, 1.36e-2, 3.31e-2]);
    expect([680, 550, 440].map(ozoneAbsorptionAt).map((v) => Number(v.toPrecision(3)))).toEqual([
        6.5e-4, 1.88e-3, 8.5e-5,
    ]);
    expect([680, 550, 440].map(solarIrradianceAt)).toEqual([1.474, 1.8504, 1.91198]);
});

test("the fitted matrix keeps the sun white and puts the sky within about a percent of its true color", () => {
    const matrix = fitSpectrumToRgb(DEFAULT_WAVELENGTHS);
    const samples = (r: (w: number) => number) => DEFAULT_WAVELENGTHS.map((w) => solarIrradianceAt(w) * r(w));
    const toRgb = (r: (w: number) => number) =>
        matrix.map((row) => row.reduce((sum, m, j) => sum + m * (samples(r)[j] as number), 0));
    // The color error: the distance between the two colors at equal luminance, relative to the true one.
    const error = (r: (w: number) => number) => {
        const want = rgbOfSpectrum(r);
        const got = toRgb(r);
        const k = luminanceOf(want) / luminanceOf(got);
        return Math.hypot(...got.map((v, i) => v * k - (want[i] as number))) / Math.hypot(...want);
    };
    expect(error(() => 1)).toBeLessThan(0.002);
    expect(error(skySpectrum(1.2, 1, 0.1))).toBeLessThan(0.01);
    expect(error(skySpectrum(25, 1, 0.2))).toBeLessThan(0.03);
});

test("the default model deviates from the original only where intended", () => {
    const d = DEFAULT_ATMOSPHERE_MODEL;
    const o = OSGHIMMEL_ATMOSPHERE_MODEL;

    // Unchanged: Rayleigh is settled physics, the same law at other wavelengths, and the ground reflectance was never
    // contentious.
    expect(d.rayleigh.scaleHeightKm).toBe(o.rayleigh.scaleHeightKm);
    d.wavelengths.forEach((w, i) => {
        expect(d.rayleigh.beta[i]).toBeCloseTo(rayleighAt(w), 12);
    });
    expect(d.groundAlbedo).toEqual(o.groundAlbedo);

    // Changed: the aerosol layer is far thinner and more forward-scattering than the original assumed, and
    // ozone is present. The original's own source carries 1.2 as a commented-out alternative to its 6.
    expect(d.mie.scaleHeightKm).toBe(1.2);
    expect(d.mie.g).toBe(0.8);
    expect(d.mie.betaExtinction[0]).toBeCloseTo((d.mie.betaScattering[0] as number) / 0.9, 12);
    expect(d.ozone.betaAbsorption.some((c) => c > 0)).toBe(true);
});

test("atmosphereTopRadiusKm is the ground radius plus the shell thickness", () => {
    expect(atmosphereTopRadiusKm(DEFAULT_ATMOSPHERE_MODEL)).toBe(6460);
    expect(atmosphereTopRadiusKm(OSGHIMMEL_ATMOSPHERE_MODEL)).toBe(6456);
});

test("the texture config keeps osgHimmel's transmittance resolution", () => {
    expect(DEFAULT_TEXTURE_CONFIG.transmittance).toEqual({ width: 256, height: 64 });

    // Hillaire's tables, which replace Bruneton's 4D one of 32 x 128 x 32 x 8: far smaller.
    const hillaireTexels = 128 * 64 + 128 * 256;
    expect(hillaireTexels).toBeLessThan((32 * 128 * 32 * 8) / 10);
});
