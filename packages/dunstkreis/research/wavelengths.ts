/**
 * How DEFAULT_WAVELENGTHS was chosen: every set of four wavelengths on 10 nm steps, fitted as `fitSpectrumToRgb`
 * does, ranked by its color error on sky spectra the fit never saw, then reported on a third set of named ones.
 * Run with Node 24 or later, which strips the types: `node packages/dunstkreis/research/wavelengths.ts`.
 */
import {
    fitSpectrumToRgb,
    luminanceOf,
    ozoneAbsorptionAt,
    rayleighAt,
    rgbOfSpectrum,
    skySpectrum,
    solarIrradianceAt,
} from "../src/spectral.ts";

type Spectrum = (wavelength: number) => number;

/** The color error: the distance to the true color at equal luminance, relative to it. */
function colorError(matrix: number[][], wavelengths: readonly number[], r: Spectrum, truth: number[]): number {
    const samples = wavelengths.map((w) => solarIrradianceAt(w) * r(w));
    const rgb = matrix.map((row) => row.reduce((sum, m, j) => sum + m * (samples[j] as number), 0));
    const k = luminanceOf(truth) / luminanceOf(rgb);
    return Math.hypot(...rgb.map((v, i) => v * k - (truth[i] as number))) / Math.hypot(...truth);
}

/** Mean and worst error over `spectra`, with their true colors precomputed. */
function score(wavelengths: readonly number[], spectra: { r: Spectrum; truth: number[] }[]) {
    const matrix = fitSpectrumToRgb(wavelengths);
    const errors = spectra.map(({ r, truth }) => colorError(matrix, wavelengths, r, truth));
    return { mean: errors.reduce((a, b) => a + b, 0) / errors.length, worst: Math.max(...errors) };
}

const withTruth = (r: Spectrum) => ({ r, truth: rgbOfSpectrum(r) });

// Validation, off the training grid: other airmasses, half and one and a half times the ozone, and haze with an
// Ångström exponent of 1.3 rather than flat.
const depth = (w: number, airmass: number, ozone: number) =>
    airmass * (rayleighAt(w) * 8 + ozone * ozoneAbsorptionAt(w) * 15);
const validation: Spectrum[] = [];
for (const sun of [0.5, 3, 7, 14, 28, 50])
    for (const view of [0.2, 1, 4])
        for (const ozone of [0.5, 1.5])
            for (const [haze, angstrom] of [
                [0.1, 0],
                [0.5, -1.3],
            ] as const)
                validation.push(
                    (w) =>
                        Math.exp(-depth(w, sun + view, ozone)) *
                        ((1 - haze) * (rayleighAt(w) / rayleighAt(550)) + haze * (w / 550) ** angstrom),
                );

// The report: named skies, sunlight and twilight.
const named: Record<string, Spectrum> = {
    "sun overhead, at the ground": (w) => Math.exp(-depth(w, 1, 1)),
    "sun at 5°": (w) => Math.exp(-depth(w, 10, 1)),
    "sun at the horizon": (w) => Math.exp(-depth(w, 38, 1)),
    "blue sky, sun high": skySpectrum(1.2, 1, 0.1),
    "hazy sky": skySpectrum(1.5, 1, 0.5),
    "sky at sunset": skySpectrum(25, 1, 0.2),
    "twilight zenith": skySpectrum(60, 1, 0),
    "horizon at noon": skySpectrum(1.2, 6, 0.4),
};

const validationSet = validation.map(withTruth);
const namedSet = Object.values(named).map(withTruth);
const results: { wavelengths: number[]; validation: ReturnType<typeof score> }[] = [];
for (let a = 600; a <= 690; a += 10)
    for (let b = 540; b <= 620; b += 10)
        for (let c = 480; c <= 560; c += 10)
            for (let d = 420; d <= 480; d += 10)
                if (a > b && b > c && c > d)
                    results.push({ wavelengths: [a, b, c, d], validation: score([a, b, c, d], validationSet) });
// Ranked by the mean, with a quarter of the worst case.
const rank = ({ validation: v }: (typeof results)[number]) => v.mean + v.worst / 4;
results.sort((x, y) => rank(x) - rank(y));

const percent = (x: number) => `${(100 * x).toFixed(2)}%`.padStart(7);
console.log(`${results.length} sets of four, ranked on ${validation.length} validation spectra:\n`);
for (const { wavelengths, validation: v } of results.slice(0, 8)) {
    const n = score(wavelengths, namedSet);
    console.log(
        `${wavelengths.join(" ")}  validation ${percent(v.mean)} ${percent(v.worst)}  named ${percent(n.mean)} ${percent(n.worst)}`,
    );
}
const bruneton = [680, 550, 440];
const b = score(bruneton, namedSet);
console.log(`\nBruneton's three, fitted: named ${percent(b.mean)} ${percent(b.worst)}`);
console.log("\nPer named spectrum, the best set:");
const best = results[0]?.wavelengths ?? [];
const matrix = fitSpectrumToRgb(best);
for (const [name, r] of Object.entries(named))
    console.log(`  ${name.padEnd(28)} ${percent(colorError(matrix, best, r, rgbOfSpectrum(r)))}`);

// Bruneton's three wavelengths, converted without a fit: what the three-wavelength table in README.md compares.
const three = [680, 550, 440];
const solarThree = three.map(solarIrradianceAt);
const fromColumns = (columns: number[][]) => [0, 1, 2].map((i) => columns.map((column) => column[i] as number));
// As RGB, white balanced: each channel scaled so the sun above the air comes out at its true color.
const sun = rgbOfSpectrum(() => 1);
const balanced = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => (i === j ? (sun[i] as number) / (solarThree[i] as number) : 0)),
);
// Bruneton 2017's approximate mode: per channel, the spectrum taken as solar(λ) (λ / λc)⁻³.
const factors = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) =>
        i === j ? (rgbOfSpectrum((w) => (w / (three[j] as number)) ** -3)[i] as number) / (solarThree[j] as number) : 0,
    ),
);
// r(λ) interpolated linearly between the samples, extrapolated linearly beyond them.
const hat = (j: number) => (w: number) => {
    const [r, g, b] = three as [number, number, number];
    const t = w <= g ? (w - b) / (g - b) : (w - g) / (r - g);
    return w <= g ? ([0, t, 1 - t][j] as number) : ([t, 1 - t, 0][j] as number);
};
const interpolated = fromColumns([0, 1, 2].map((j) => rgbOfSpectrum(hat(j)).map((v) => v / (solarThree[j] as number))));
const conversions: Record<string, number[][]> = {
    "the samples as RGB, white balanced": balanced,
    "Bruneton 2017's per-channel factors": factors,
    "a matrix from interpolating r(λ)": interpolated,
    "a matrix fitted by least squares": fitSpectrumToRgb(three),
};
console.log("\nBruneton's three wavelengths, on the named spectra:");
for (const [name, matrix] of Object.entries(conversions)) {
    const errors = namedSet.map(({ r, truth }) => colorError(matrix, three, r, truth));
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    console.log(`  ${name.padEnd(38)} ${percent(mean)} ${percent(Math.max(...errors))}`);
}
