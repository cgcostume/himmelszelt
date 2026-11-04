// The star catalog the package ships, and any other laid out like it: eight floats per star, as the pass reads them.

import type { Rgb } from "./color.js";

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
