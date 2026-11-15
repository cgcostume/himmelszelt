// The star catalog the package ships, and any other laid out like it: eight floats per star, as the pass reads them.

import { colorFromColorIndex, type Rgb } from "./color.js";

/** One star as the pass takes it. Positions at equinox J2000.0; the pass moves them by their proper motion. */
export interface Star {
    /** Apparent visual magnitude: lower is brighter, about 6.5 the naked-eye limit. */
    magnitude: number;
    /** Right ascension at equinox J2000.0, in degrees. */
    rightAscension: number;
    /** Declination at equinox J2000.0, in degrees. */
    declination: number;
    /** Annual proper motion in right ascension on the sky (μα cos δ) and in declination, in arcseconds per year. */
    properMotionRightAscension: number;
    properMotionDeclination: number;
    /** Linear sRGB at unit luminance: the star's chromaticity, `colorFromColorIndex`. */
    color: Rgb;
}

/** Floats per star in a catalog's data: magnitude, right ascension, declination, the two proper motions, red, green,
 *  blue. */
export const STAR_FIELDS = 8;

/** A catalog as the pass takes it: `STAR_FIELDS` floats per star, `count` stars. */
export interface StarCatalog {
    readonly count: number;
    readonly data: Float32Array;
}

/** A catalog from stars. */
export function catalogFromStars(stars: readonly Star[]): StarCatalog {
    const data = new Float32Array(stars.length * STAR_FIELDS);
    stars.forEach((star, i) => {
        data.set(
            [
                star.magnitude,
                star.rightAscension,
                star.declination,
                star.properMotionRightAscension,
                star.properMotionDeclination,
                ...star.color,
            ],
            i * STAR_FIELDS,
        );
    });
    return { count: stars.length, data };
}

/** The `index`th star of a catalog. */
export function starAt({ data }: StarCatalog, index: number): Star {
    const at = index * STAR_FIELDS;
    const f = (k: number) => data[at + k] ?? 0;
    return {
        magnitude: f(0),
        rightAscension: f(1),
        declination: f(2),
        properMotionRightAscension: f(3),
        properMotionDeclination: f(4),
        color: [f(5), f(6), f(7)],
    };
}

/** A catalog from the bytes of a `.bin` as `scripts/catalog.mjs` writes them: little-endian floats, eight per star. */
export function catalogFromBuffer(buffer: ArrayBuffer): StarCatalog {
    if (buffer.byteLength % (STAR_FIELDS * 4) !== 0) throw new Error("sternenheer: not a star catalog");
    const data = new Float32Array(buffer.byteLength / 4);
    const view = new DataView(buffer);
    for (let i = 0; i < data.length; i++) data[i] = view.getFloat32(i * 4, true);
    return { count: data.length / STAR_FIELDS, data };
}

/**
 * The shipped catalog: the 9,093 stars of the Yale Bright Star Catalogue, fifth revised edition, to magnitude 7.1,
 * every star visible to the naked eye, 291 KB. Resolved next to the package's own files, which bundlers that know
 * `new URL(..., import.meta.url)` copy along.
 */
export const BRIGHT_STARS = new URL("../data/brightstars.bin", import.meta.url);

/** Fetches a catalog, the shipped one by default. */
export async function loadCatalog(url: string | URL = BRIGHT_STARS): Promise<StarCatalog> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`sternenheer: ${response.status} fetching ${url}`);
    return catalogFromBuffer(await response.arrayBuffer());
}

/**
 * Stars packed into two Uint32 each, for the many faint ones: the right ascension at J2000.0 in 24 bits, a 13th of an
 * arcsecond, and the magnitude in 8, sixteenths from -2; the declination in 24 bits and the color index B-V in 8,
 * hundredths from -0.5. No proper motion: under a pixel in a lifetime for all but a few.
 */
export interface PackedStars {
    readonly count: number;
    readonly data: Uint32Array;
}

/** One packed star, as `packStars` takes and `packedStarAt` gives it: degrees, magnitudes. */
export interface FaintStar {
    magnitude: number;
    rightAscension: number;
    declination: number;
    colorIndex: number;
}

const bits = (value: number, top: number) => Math.min(Math.max(Math.round(value), 0), top);

/** Packs stars, in the order given: brightest first lets a renderer draw only the first so many. */
export function packStars(stars: readonly FaintStar[]): PackedStars {
    const data = new Uint32Array(stars.length * 2);
    stars.forEach((star, i) => {
        const ra = Math.round(((((star.rightAscension % 360) + 360) % 360) / 360) * 2 ** 24) % 2 ** 24;
        data[i * 2] = (ra | (bits((star.magnitude + 2) / 0.0625, 255) << 24)) >>> 0;
        const de = bits(((star.declination + 90) / 180) * (2 ** 24 - 1), 2 ** 24 - 1);
        data[i * 2 + 1] = (de | (bits((star.colorIndex + 0.5) / 0.01, 255) << 24)) >>> 0;
    });
    return { count: stars.length, data };
}

/** The `index`th of packed stars. */
export function packedStarAt({ data }: PackedStars, index: number): FaintStar {
    const [a, b] = [data[index * 2] ?? 0, data[index * 2 + 1] ?? 0];
    return {
        magnitude: (a >>> 24) * 0.0625 - 2,
        rightAscension: ((a & 0xffffff) / 2 ** 24) * 360,
        declination: ((b & 0xffffff) / (2 ** 24 - 1)) * 180 - 90,
        colorIndex: (b >>> 24) * 0.01 - 0.5,
    };
}

/** Packed stars from the bytes of a `.bin` as `scripts/hipparcos.mjs` writes them: little-endian Uint32 pairs. */
export function packedStarsFromBuffer(buffer: ArrayBuffer): PackedStars {
    if (buffer.byteLength % 8 !== 0) throw new Error("sternenheer: not packed stars");
    const view = new DataView(buffer);
    const data = new Uint32Array(buffer.byteLength / 4);
    for (let i = 0; i < data.length; i++) data[i] = view.getUint32(i * 4, true);
    return { count: data.length / 2, data };
}

/** The colors the pass looks a packed star's up in: linear sRGB at unit luminance for each of the 256 color indices. */
export function packedStarColors(): Float32Array {
    const colors = new Float32Array(256 * 4);
    for (let i = 0; i < 256; i++) colors.set(colorFromColorIndex(i * 0.01 - 0.5), i * 4);
    return colors;
}

/**
 * The shipped faint stars: the 108,883 stars of the Hipparcos catalogue (ESA 1997) the bright star catalog does not
 * hold, to magnitude 12 or so and complete to about 8, brightest first, 871 KB. Resolved next to the package's own
 * files, as `BRIGHT_STARS`.
 */
export const HIPPARCOS = new URL("../data/hipparcos.bin", import.meta.url);

/** Fetches packed stars, the shipped Hipparcos stars by default, to draw besides the shipped catalog. */
export async function loadFaintStars(url: string | URL = HIPPARCOS): Promise<PackedStars> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`sternenheer: ${response.status} fetching ${url}`);
    return packedStarsFromBuffer(await response.arrayBuffer());
}
