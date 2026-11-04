type Rgb = [number, number, number];

const TO_XYZ = [
    [0.4124, 0.3576, 0.1805],
    [0.2126, 0.7152, 0.0722],
    [0.0193, 0.1192, 0.9505],
];
const TO_SRGB = [
    [3.2406, -1.5372, -0.4986],
    [-0.9689, 1.8758, 0.0415],
    [0.0557, -0.204, 1.057],
];
const times = (m: number[][], v: readonly number[]) =>
    m.map((row) => row.reduce((sum, c, j) => sum + c * (v[j] ?? 0), 0)) as Rgb;

/** How much the cones see of a luminance in cd/m²: 0 below 0.01, where the rods see alone, 1 above 4, smooth between. */
export function coneShare(luminance: number): number {
    const t = Math.min(Math.max((Math.log10(Math.max(luminance, 1e-30)) + 2) / 2.6, 0), 1);
    return t * t * (3 - 2 * t);
}

/**
 * Linear sRGB in cd/m² as the eye sees it at night: below some 4 cd/m² the rods take over, colors fade and shift
 * towards blue, and under the Moon the world turns blue. Jensen et al.'s blue shift with Larson et al.'s
 * scotopic luminance. The TypeScript twin of `hdNightVision` in `wgsl.vision`.
 */
export function nightVision(rgb: readonly [number, number, number]): Rgb {
    const [x, y, z] = times(
        TO_XYZ,
        rgb.map((c) => Math.max(c, 0)),
    );
    const sum = x + y + z;
    if (sum <= 0 || x <= 0) return [0, 0, 0];
    const scotopic = y * (1.33 * (1 + (y + z) / x) - 1.68);
    const s = coneShare(y);
    const cx = 0.25 + (x / sum - 0.25) * s;
    const cy = 0.25 + (y / sum - 0.25) * s;
    const luminance = 0.4468 * Math.max(scotopic, 0) * (1 - s) + y * s;
    const shifted = [(cx * luminance) / cy, luminance, ((1 - cx - cy) * luminance) / cy];
    return times(TO_SRGB, shifted).map((c) => Math.max(c, 0)) as Rgb;
}
