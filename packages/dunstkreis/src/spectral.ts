/**
 * The light is computed at four wavelengths, not in RGB: a color on a screen is a weighted sum over the whole
 * spectrum, ∫ CMF(λ) S(λ) dλ, and four samples of S(λ) with a fitted matrix give it to within about 1%, where three
 * used directly as R, G and B were 5% off on average and 14% in twilight. See research/README.md for how.
 */

/** Wavelengths in nm, 360 to 830 every 10, for the tables below. */
const TABLE_START = 360;
const TABLE_STEP = 10;

/** The sun's spectral irradiance above the atmosphere, W/m²/nm, as in Bruneton's 2017 implementation. */
const SOLAR_SPECTRUM = [
    1.11776, 1.14259, 1.01249, 1.14716, 1.72765, 1.73054, 1.6887, 1.61253, 1.91198, 2.03474, 2.02042, 2.02212, 1.93377,
    1.95809, 1.91686, 1.8298, 1.8685, 1.8931, 1.85149, 1.8504, 1.8341, 1.8345, 1.8147, 1.78158, 1.7533, 1.6965, 1.68194,
    1.64654, 1.6048, 1.52143, 1.55622, 1.5113, 1.474, 1.4482, 1.41018, 1.36775, 1.34188, 1.31429, 1.28303, 1.26758,
    1.2367, 1.2082, 1.18737, 1.14683, 1.12362, 1.1058, 1.07124, 1.04992,
];

/** Ozone's absorption cross-section, m², as in Bruneton's 2017 implementation, after the Serdyuchenko et al. data. */
const OZONE_CROSS_SECTION = [
    1.18e-27, 2.182e-28, 2.818e-28, 6.636e-28, 1.527e-27, 2.763e-27, 5.52e-27, 8.451e-27, 1.582e-26, 2.316e-26,
    3.669e-26, 4.924e-26, 7.752e-26, 9.016e-26, 1.48e-25, 1.602e-25, 2.139e-25, 2.755e-25, 3.091e-25, 3.5e-25,
    4.266e-25, 4.672e-25, 4.398e-25, 4.701e-25, 5.019e-25, 4.305e-25, 3.74e-25, 3.215e-25, 2.662e-25, 2.238e-25,
    1.852e-25, 1.473e-25, 1.209e-25, 9.423e-26, 7.455e-26, 6.566e-26, 5.105e-26, 4.15e-26, 4.228e-26, 3.237e-26,
    2.451e-26, 2.801e-26, 2.534e-26, 1.624e-26, 1.465e-26, 2.078e-26, 1.383e-26, 7.105e-27,
];

/** Ozone's number density at the layer's peak, per m³: 300 Dobson units spread over 15 km. */
const OZONE_PEAK_DENSITY = (300 * 2.687e20) / 15_000;

function tabulated(table: readonly number[], wavelength: number): number {
    const x = (wavelength - TABLE_START) / TABLE_STEP;
    const i = Math.min(Math.max(Math.floor(x), 0), table.length - 2);
    const f = Math.min(Math.max(x - i, 0), 1);
    return (table[i] as number) * (1 - f) + (table[i + 1] as number) * f;
}

/** The sun's spectral irradiance above the atmosphere at a wavelength in nm, W/m²/nm. */
export const solarIrradianceAt = (wavelength: number) => tabulated(SOLAR_SPECTRUM, wavelength);

/** Rayleigh scattering of the air at sea level at a wavelength in nm, per km: Bruneton's 1.24062e-6 / λ⁴, λ in µm. */
export const rayleighAt = (wavelength: number) => 1.24062e-3 / (wavelength / 1000) ** 4;

/** Ozone's absorption at the layer's peak at a wavelength in nm, per km. */
export const ozoneAbsorptionAt = (wavelength: number) =>
    tabulated(OZONE_CROSS_SECTION, wavelength) * OZONE_PEAK_DENSITY * 1000;

/**
 * A reflectance given in linear sRGB at a wavelength in nm: through the three primaries' dominant wavelengths, 610,
 * 550 and 465 nm, linearly, and held beyond them. A gray stays the same gray at every wavelength.
 */
export function reflectanceAt([r, g, b]: readonly [number, number, number], wavelength: number): number {
    if (wavelength >= 610) return r;
    if (wavelength >= 550) return g + ((r - g) * (wavelength - 550)) / 60;
    if (wavelength >= 465) return b + ((g - b) * (wavelength - 465)) / 85;
    return b;
}

/** CIE 1931 2° color matching functions, x̄ ȳ z̄, by the multi-lobe fit of Wyman, Sloan and Shirley (2013). */
function colorMatching(wavelength: number): [number, number, number] {
    const g = (mean: number, below: number, above: number) =>
        Math.exp(-0.5 * ((wavelength - mean) / (wavelength < mean ? below : above)) ** 2);
    return [
        1.056 * g(599.8, 37.9, 31.0) + 0.362 * g(442.0, 16.0, 26.7) - 0.065 * g(501.1, 20.4, 26.2),
        0.821 * g(568.8, 46.9, 40.5) + 0.286 * g(530.9, 16.3, 31.1),
        1.217 * g(437.0, 11.8, 36.0) + 0.681 * g(459.0, 26.0, 13.8),
    ];
}

const XYZ_TO_LINEAR_SRGB = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.969266, 1.8760108, 0.041556],
    [0.0556434, -0.2040259, 1.0572252],
] as const;

/** The linear sRGB color matching functions: how much a wavelength adds to R, G and B. */
function rgbMatching(wavelength: number): [number, number, number] {
    const [x, y, z] = colorMatching(wavelength);
    return XYZ_TO_LINEAR_SRGB.map(([a, b, c]) => a * x + b * y + c * z) as [number, number, number];
}

/** The linear sRGB of the spectrum solar(λ) r(λ), integrated from 360 to 830 nm. */
export function rgbOfSpectrum(r: (wavelength: number) => number): [number, number, number] {
    const rgb: [number, number, number] = [0, 0, 0];
    for (let wavelength = 360; wavelength <= 830; ++wavelength) {
        const weight = rgbMatching(wavelength);
        const s = solarIrradianceAt(wavelength) * r(wavelength);
        for (let c = 0; c < 3; ++c) rgb[c] = (rgb[c] as number) + (weight[c] as number) * s;
    }
    return rgb;
}

export const luminanceOf = ([r, g, b]: readonly number[]) =>
    0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);

/**
 * The spectra the matrix is fitted to, as the factor r(λ) on the sun's spectrum: sunlight through `sunAirmass` of air
 * and ozone, scattered by air (λ⁻⁴) or haze (flat), mixed by `haze`, then through `viewAirmass` more on its way to
 * the eye. Airmass 1 is the column overhead: Rayleigh over its 8 km scale height, ozone over its 15 km.
 */
export function skySpectrum(sunAirmass: number, viewAirmass: number, haze: number) {
    const depth = (wavelength: number, airmass: number) =>
        airmass * (rayleighAt(wavelength) * 8 + ozoneAbsorptionAt(wavelength) * 15);
    return (wavelength: number) =>
        Math.exp(-depth(wavelength, sunAirmass + viewAirmass)) *
        ((1 - haze) * (rayleighAt(wavelength) / rayleighAt(550)) + haze);
}

/** The spectra `fitSpectrumToRgb` fits to: the sun above the air first, then 84 skies. */
export const TRAINING_SPECTRA = [(_: number) => 1];
for (const sunAirmass of [0, 1, 2, 5, 10, 20, 38])
    for (const viewAirmass of [0, 0.5, 2, 6])
        for (const haze of [0, 0.3, 0.7]) TRAINING_SPECTRA.push(skySpectrum(sunAirmass, viewAirmass, haze));

/** Solves A x = b, n by n, by Gaussian elimination with partial pivoting, on a flat row-major copy. */
function solve(matrix: number[][], vector: number[]): number[] {
    const n = vector.length;
    const w = n + 1;
    const m = matrix.flatMap((row, i) => [...row, vector[i] as number]);
    const at = (i: number, j: number) => m[i * w + j] as number;
    for (let i = 0; i < n; ++i) {
        let pivot = i;
        for (let k = i + 1; k < n; ++k) if (Math.abs(at(k, i)) > Math.abs(at(pivot, i))) pivot = k;
        for (let j = 0; j < w; ++j) [m[i * w + j], m[pivot * w + j]] = [at(pivot, j), at(i, j)];
        for (let k = i + 1; k < n; ++k) {
            const f = at(k, i) / at(i, i);
            for (let j = i; j < w; ++j) m[k * w + j] = at(k, j) - f * at(i, j);
        }
    }
    const x = new Array<number>(n).fill(0);
    for (let i = n - 1; i >= 0; --i) {
        let sum = at(i, n);
        for (let j = i + 1; j < n; ++j) sum -= at(i, j) * (x[j] as number);
        x[i] = sum / at(i, i);
    }
    return x;
}

/**
 * The matrix from samples of a spectrum at `wavelengths` to its linear sRGB, rows R, G and B: fitted by least squares
 * to sky spectra of every kind, each normalized to unit luminance so the fit weighs hue, not brightness; the sun above
 * the air weighted a thousandfold, so it stays white. Scaled so the sun's samples come out at unit luminance.
 */
export function fitSpectrumToRgb(wavelengths: readonly number[], spectra = TRAINING_SPECTRA): number[][] {
    const samples = spectra.map((r) => {
        const rgb = rgbOfSpectrum(r);
        const n = luminanceOf(rgb);
        return { s: wavelengths.map((w) => (solarIrradianceAt(w) * r(w)) / n), rgb: rgb.map((v) => v / n) };
    });
    const n = wavelengths.length;
    const rows = [0, 1, 2].map((c) => {
        // The normal equations, weighted: (S^T W S) m = S^T W y.
        const a = Array.from({ length: n }, () => new Array<number>(n).fill(0));
        const b = new Array<number>(n).fill(0);
        samples.forEach(({ s, rgb }, k) => {
            const weight = k === 0 ? 1000 : 1;
            for (let i = 0; i < n; ++i) {
                const si = s[i] as number;
                b[i] = (b[i] as number) + weight * si * (rgb[c] as number);
                const row = a[i] as number[];
                for (let j = 0; j < n; ++j) row[j] = (row[j] as number) + weight * si * (s[j] as number);
            }
        });
        return solve(a, b);
    });
    const sun = wavelengths.map(solarIrradianceAt);
    const scale = 1 / luminanceOf(rows.map((row) => row.reduce((sum, m, j) => sum + m * (sun[j] as number), 0)));
    return rows.map((row) => row.map((m) => m * scale));
}

/**
 * The four wavelengths the light is computed at, in nm, red to blue. Chosen by research/wavelengths.ts: every set of
 * four on 10 nm steps between 420 and 690 nm, 4788 of them, fitted as `fitSpectrumToRgb` does and ranked by their
 * color error on 72 sky spectra the fit never saw. This one is 0.57% off on average and 1.6% at worst; the three of
 * Bruneton's model, 680, 550 and 440 nm, taken as R, G and B, 5% and 14%.
 */
export const DEFAULT_WAVELENGTHS = [630, 580, 510, 440] as const;
