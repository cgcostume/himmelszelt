// White balance, a camera step before the exposure: the light of a reference white shown as D65, the working white of
// linear sRGB, at its own luminance. By the linear Bradford transform, as ICC profiles and raw converters adapt.

type Rgb = [number, number, number];
type Mat3 = [Rgb, Rgb, Rgb];

/** A white balance as a 3x3 matrix over linear sRGB, nine numbers column-major, as WGSL's `mat3x3f` takes them. */
export type WhiteBalance = readonly [number, number, number, number, number, number, number, number, number];

/** D65 in linear sRGB at unit luminance, the white every package works in: balanced on it, nothing changes. */
export const D65_WHITE: readonly [number, number, number] = [1, 1, 1];

/**
 * The CIE's standard white points as chromaticities x, y for the 2° observer (CIE 15:2018), to four places as color
 * standards round them: A a tungsten lamp at 2,856 K, D50 the white of print, D55, D65 sRGB's, D75 north sky light, and
 * E equal energy. `whiteFromChromaticity` turns one into a white for `whiteBalance`.
 */
export const WHITE_POINTS = {
    A: [0.4476, 0.4074],
    D50: [0.3457, 0.3585],
    D55: [0.3324, 0.3474],
    D65: [0.3127, 0.329],
    D75: [0.299, 0.3149],
    E: [1 / 3, 1 / 3],
} as const satisfies Record<string, readonly [number, number]>;

/** No white balance, the identity: what `whiteBalance(D65_WHITE)` returns, exactly. */
export const NO_WHITE_BALANCE: WhiteBalance = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const times = (a: Mat3, b: Mat3) =>
    a.map((row) => [0, 1, 2].map((j) => row.reduce((s, v, k) => s + v * (b[k]?.[j] ?? 0), 0))) as Mat3;
const apply = (m: Mat3, v: readonly number[]) => m.map((row) => row.reduce((s, c, j) => s + c * (v[j] ?? 0), 0)) as Rgb;
function inverse([[a, b, c], [d, e, f], [g, h, i]]: Mat3): Mat3 {
    const A = e * i - f * h;
    const B = f * g - d * i;
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [
        [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ];
}

// Linear sRGB to XYZ from its primaries and D65, at x 0.3127, y 0.3290 (IEC 61966-2-1), so D65 is 1, 1, 1 at Y 1.
const xyzOf = ([x, y]: readonly [number, number]) => [x / y, 1, (1 - x - y) / y] as Rgb;
const PRIMARIES = [xyzOf([0.64, 0.33]), xyzOf([0.3, 0.6]), xyzOf([0.15, 0.06])];
const UNSCALED: Mat3 = [0, 1, 2].map((i) => PRIMARIES.map((p) => p[i] ?? 0)) as Mat3;
const SCALE = apply(inverse(UNSCALED), xyzOf([0.3127, 0.329]));
const SRGB_TO_XYZ = UNSCALED.map((row) => row.map((c, j) => c * (SCALE[j] ?? 0))) as Mat3;
const XYZ_TO_SRGB = inverse(SRGB_TO_XYZ);
// Lam's sharpened cone space, Bradford's.
const BRADFORD: Mat3 = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
];
const SRGB_TO_LMS = times(BRADFORD, SRGB_TO_XYZ);
const LMS_TO_SRGB = inverse(SRGB_TO_LMS);
const D65_LMS = apply(SRGB_TO_LMS, D65_WHITE);
const luminanceOf = (rgb: readonly number[]) => apply(SRGB_TO_XYZ, rgb)[1];

/**
 * The white balance that shows `white`, given in linear sRGB, as D65 of the same luminance: the Moon through the air
 * becomes a neutral gray as bright as it was. Every channel's cone response is scaled by D65's over the white's, in
 * Bradford's sharpened space (linear Bradford, ICC.1:2022 Annex E). A gray white gives `NO_WHITE_BALANCE`.
 */
export function whiteBalance(white: readonly [number, number, number]): WhiteBalance {
    const [r, g, b] = white;
    if (r === g && g === b) return NO_WHITE_BALANCE;
    const lms = apply(SRGB_TO_LMS, white);
    const y = luminanceOf(white);
    const gain = D65_LMS.map((c, i) => (c * y) / (lms[i] ?? 1));
    const m = times(LMS_TO_SRGB, SRGB_TO_LMS.map((row, i) => row.map((c) => c * (gain[i] ?? 1))) as Mat3);
    return [m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]];
}

/** `rgb` in linear sRGB balanced by `balance`: the TypeScript twin of `hdWhiteBalance` in `wgsl.whitebalance`. */
export function applyWhiteBalance(rgb: readonly [number, number, number], balance: WhiteBalance): Rgb {
    const [r, g, b] = rgb;
    const m = balance;
    return [m[0] * r + m[3] * g + m[6] * b, m[1] * r + m[4] * g + m[7] * b, m[2] * r + m[5] * g + m[8] * b];
}

/** The white of chromaticity x, y in linear sRGB at unit luminance; a white outside sRGB's gamut keeps its negative
 *  channel, which `whiteBalance` takes as it is. */
export function whiteFromChromaticity([x, y]: readonly [number, number]): Rgb {
    return apply(XYZ_TO_SRGB, xyzOf([x, y]));
}

/**
 * The white of a black body at `kelvin`, in linear sRGB at unit luminance: a tungsten lamp at 2,856 K, illuminant A.
 * Kang et al.'s cubic spline fit of the Planckian locus (2002), within 0.001 in x and y from 1,667 K to 25,000 K, and
 * held within that range. The same fit as sternenheer's `planckianLocus`.
 */
export function planckianWhite(kelvin: number): Rgb {
    const t = Math.min(Math.max(kelvin, 1667), 25000);
    const o = 1 / t;
    const x =
        t <= 4000
            ? 0.17991 + o * (877.6956 + o * (-234358.0 + o * -266123900.0))
            : 0.24039 + o * (222.6347 + o * (2107037.9 + o * -3025846900.0));
    const y =
        t <= 2222
            ? -0.20219683 + x * (2.18555832 + x * (-1.3481102 + x * -1.1063814))
            : t <= 4000
              ? -0.16748867 + x * (2.09137015 + x * (-1.3741859 + x * -0.9549476))
              : -0.37001483 + x * (3.75112997 + x * (-5.8733867 + x * 3.081758));
    return whiteFromChromaticity([x, y]);
}

/**
 * The white of daylight at a correlated color temperature in `kelvin`, in linear sRGB at unit luminance, on the CIE's
 * daylight locus (CIE 15:2018), from 4,000 K to 25,000 K and held within: D65 at 6,504 K, D50 at 5,003 K. Daylight lies
 * a little above the Planckian locus, towards green.
 */
export function daylightWhite(kelvin: number): Rgb {
    const t = Math.min(Math.max(kelvin, 4000), 25000);
    const o = 1e3 / t;
    const x =
        t <= 7000
            ? 0.244063 + o * (0.09911 + o * (2.9678 + o * -4.607))
            : 0.23704 + o * (0.24748 + o * (1.9018 + o * -2.0064));
    return whiteFromChromaticity([x, -3 * x * x + 2.87 * x - 0.275]);
}
