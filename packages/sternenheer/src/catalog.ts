// The star catalogs: the bright stars, eight floats a star or three words in the compact layout, and the faint and the
// deep ones, packed into two words a star or six bytes in the compact layout, which the package loads by default.

import { colorFromColorIndex, type Rgb } from "./color.js";
import { illuminanceFromMagnitude } from "./light.js";

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
    /** The color index B-V the color comes from: the compact layout keeps this instead of the color. */
    colorIndex?: number;
}

/** Which layout of a catalog: "compact", the default, smaller and quicker to draw, or "full", as the data has it. */
export type CatalogVariant = "compact" | "full";

/** Floats per star in a catalog's data: magnitude, right ascension, declination, the two proper motions, red, green,
 *  blue. */
export const STAR_FIELDS = 8;

/**
 * Words per star in the compact layout: the right ascension in 22 bits, a third of an arcsecond, and the magnitude in
 * 10, hundredths from -2; the declination in 23 bits, a 13th of an arcsecond, and B-V in 9, hundredths from -0.5; the
 * proper motions in right ascension and declination as Int16 in milliarcseconds a year.
 */
export const COMPACT_STAR_WORDS = 3;

/** A catalog as the pass takes it, `count` stars: `STAR_FIELDS` floats a star, or `COMPACT_STAR_WORDS` words a star
 *  where `compact`. */
export interface StarCatalog {
    readonly count: number;
    readonly data: Float32Array | Uint32Array;
    readonly compact: boolean;
}

const code = (value: number, step: number, bits: number) => {
    const n = Math.round(value / step);
    if (!(n >= 0 && n < 2 ** bits)) throw new Error(`sternenheer: ${value} lies outside the compact layout`);
    return n;
};

/** A catalog from stars, full by default, as given; compact, each star needs its `colorIndex`. */
export function catalogFromStars(stars: readonly Star[], variant: CatalogVariant = "full"): StarCatalog {
    if (variant === "compact") {
        const words = new Uint32Array(stars.length * COMPACT_STAR_WORDS);
        stars.forEach((star, i) => {
            if (star.colorIndex === undefined) throw new Error("sternenheer: a compact catalog needs each colorIndex");
            const ra = Math.round(((((star.rightAscension % 360) + 360) % 360) / 360) * 2 ** 22) % 2 ** 22;
            const de = Math.round(((star.declination + 90) / 180) * (2 ** 23 - 1));
            // Int16 by an offset of half the range and the sign bit flipped.
            const mas = (pm: number) => code(pm + 32.768, 0.001, 16) ^ 0x8000;
            words[i * 3] = (ra | (code(star.magnitude + 2, 0.01, 10) << 22)) >>> 0;
            words[i * 3 + 1] = (de | (code(star.colorIndex + 0.5, 0.01, 9) << 23)) >>> 0;
            words[i * 3 + 2] = (mas(star.properMotionRightAscension) | (mas(star.properMotionDeclination) << 16)) >>> 0;
        });
        return { count: stars.length, data: words, compact: true };
    }
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
    return { count: stars.length, data, compact: false };
}

/** The `index`th star of a catalog. */
export function starAt({ data, compact }: StarCatalog, index: number): Star {
    if (compact) {
        const [a, b, c] = [data[index * 3] ?? 0, data[index * 3 + 1] ?? 0, data[index * 3 + 2] ?? 0];
        const colorIndex = (b >>> 23) * 0.01 - 0.5;
        return {
            magnitude: (a >>> 22) * 0.01 - 2,
            rightAscension: ((a & 0x3fffff) / 2 ** 22) * 360,
            declination: ((b & 0x7fffff) / (2 ** 23 - 1)) * 180 - 90,
            properMotionRightAscension: ((c << 16) >> 16) / 1000,
            properMotionDeclination: (c >> 16) / 1000,
            color: colorFromColorIndex(colorIndex),
            colorIndex,
        };
    }
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

/** A catalog from its bytes as `scripts/catalog.mjs` packs them, once `fetchPlanes` has unpacked them: little-endian,
 *  three Uint32 a star, compact, or eight floats, full. */
export function catalogFromBuffer(buffer: ArrayBuffer, variant: CatalogVariant = "compact"): StarCatalog {
    const compact = variant === "compact";
    const stride = compact ? COMPACT_STAR_WORDS : STAR_FIELDS;
    if (buffer.byteLength % (stride * 4) !== 0) throw new Error("sternenheer: not a star catalog");
    const view = new DataView(buffer);
    const data = compact ? new Uint32Array(buffer.byteLength / 4) : new Float32Array(buffer.byteLength / 4);
    for (let i = 0; i < data.length; i++)
        data[i] = compact ? view.getUint32(i * 4, true) : view.getFloat32(i * 4, true);
    return { count: data.length / stride, data, compact };
}

/** The tag of a file of byte planes, "SHBP", as the data scripts write them. */
const PLANES_MAGIC = 0x50424853;

/**
 * Fetches a file the data scripts wrote and unpacks it: gzip, undone by `DecompressionStream`, around byte planes, an
 * 8-byte header, the tag and the record's size, then each byte of a record for all records in turn, put back in order.
 * A server that sent it decompressed already, by its content encoding, is fine too.
 */
export async function fetchPlanes(url: string | URL): Promise<ArrayBuffer> {
    return (await fetchRecords(url)).buffer;
}

/** `fetchPlanes`, and the size of a record, which tells a file's layout. */
async function fetchRecords(url: string | URL): Promise<{ buffer: ArrayBuffer; stride: number }> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`sternenheer: ${response.status} fetching ${url}`);
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 8 || view.getUint32(0, true) !== PLANES_MAGIC)
        throw new Error(`sternenheer: ${url} is no data file`);
    const stride = view.getUint32(4, true);
    const records = (bytes.length - 8) / stride;
    if (!Number.isInteger(records)) throw new Error(`sternenheer: ${url} holds no whole records`);
    const out = new Uint8Array(bytes.length - 8);
    for (let k = 0; k < stride; k++) {
        const plane = bytes.subarray(8 + k * records, 8 + (k + 1) * records);
        for (let i = 0; i < records; i++) out[i * stride + k] = plane[i] as number;
    }
    return { buffer: out.buffer, stride };
}

/** The file of a variant, or a file given. */
const source = (files: Readonly<Record<CatalogVariant, URL>>, from: CatalogVariant | string | URL) =>
    from === "compact" || from === "full" ? files[from] : from;

/**
 * The shipped catalog: the 9,093 stars of the Yale Bright Star Catalogue, fifth revised edition, to magnitude 7.96,
 * every star visible to the naked eye. Compact, 89 KB, its magnitudes, colors and proper motions as the catalog lists
 * them and its positions within a sixth of an arcsecond; full, 208 KB, as floats. Resolved next to the package's own
 * files, which bundlers that know `new URL(..., import.meta.url)` copy along.
 */
export const BRIGHT_STARS = {
    compact: new URL("../data/brightstars-compact.bin.gz", import.meta.url),
    full: new URL("../data/brightstars.bin.gz", import.meta.url),
} as const;

/** Fetches a catalog: the shipped one, compact by default, or a file of either layout. */
export async function loadCatalog(from: CatalogVariant | string | URL = "compact"): Promise<StarCatalog> {
    const { buffer, stride } = await fetchRecords(source(BRIGHT_STARS, from));
    if (stride !== COMPACT_STAR_WORDS * 4 && stride !== STAR_FIELDS * 4)
        throw new Error("sternenheer: not a star catalog");
    return catalogFromBuffer(buffer, stride === STAR_FIELDS * 4 ? "full" : "compact");
}

/**
 * Stars packed into two Uint32 each, for the many faint ones: the right ascension at J2000.0 in 24 bits, a 13th of an
 * arcsecond, and the magnitude in 8, sixteenths from -2; the declination in 24 bits and the color index B-V in 8,
 * hundredths from -0.5. No proper motion: under a pixel in a lifetime for all but a few. The full layout of the faint
 * stars; the compact one, `DeepStars` with `compact`, sorts them into cells.
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

/** Words a block of compact stars takes on the GPU: its cell, each star's place in it, and two stars' magnitude and
 *  color codes a word. */
export const COMPACT_BLOCK_WORDS = 97;

/** Whether packed stars come in the compact layout: then they are `DeepStars`, in cells. */
export const isCompact = (stars: PackedStars): stars is DeepStars => "compact" in stars && stars.compact === true;

/** The direction J2000 equatorial through a place in a cell of the cube, 0 to 1 across and up, as the shader has it. */
export function cellDirection(cell: number, across: number, up: number): [number, number, number] {
    const face = Math.floor(cell / 64);
    const sign = face % 2 === 1 ? -1 : 1;
    const u = ((cell % 8) + across) * 0.25 - 1;
    const v = ((Math.floor(cell / 8) % 8) + up) * 0.25 - 1;
    const n = Math.hypot(1, u, v);
    const [a, b, c] = [sign / n, u / n, v / n];
    const axis = Math.floor(face / 2);
    return axis === 0 ? [a, b, c] : axis === 1 ? [c, a, b] : [b, c, a];
}

/** The `index`th of packed stars, of deep ones the `index`th place of their blocks, magnitude Infinity where empty. */
export function packedStarAt(stars: PackedStars, index: number): FaintStar {
    const { data } = stars;
    if (isCompact(stars)) {
        const base = Math.floor(index / 64) * COMPACT_BLOCK_WORDS;
        const local = index % 64;
        const place = data[base + 1 + local] ?? 0;
        const info = ((data[base + 65 + (local >> 1)] ?? 0) >>> ((local & 1) * 16)) & 0xffff;
        const [x, y, z] = cellDirection(
            data[base] ?? 0,
            ((place & 0xffff) + 0.5) / 65536,
            ((place >>> 16) + 0.5) / 65536,
        );
        return {
            magnitude: info === 0xffff ? Number.POSITIVE_INFINITY : (info & 0xff) * 0.0625 - 2,
            rightAscension: ((((Math.atan2(y, x) * 180) / Math.PI) % 360) + 360) % 360,
            declination: (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI,
            colorIndex: (info >>> 8) * 0.01 - 0.5,
        };
    }
    const [a, b] = [data[index * 2] ?? 0, data[index * 2 + 1] ?? 0];
    return {
        magnitude: a === 0xffffffff && b === 0xffffffff ? Number.POSITIVE_INFINITY : (a >>> 24) * 0.0625 - 2,
        rightAscension: ((a & 0xffffff) / 2 ** 24) * 360,
        declination: ((b & 0xffffff) / (2 ** 24 - 1)) * 180 - 90,
        colorIndex: (b >>> 24) * 0.01 - 0.5,
    };
}

/** Packed stars from their bytes as `scripts/hipparcos.mjs` packs them, once `fetchPlanes` has unpacked them:
 *  little-endian Uint32 pairs. */
export function packedStarsFromBuffer(buffer: ArrayBuffer): PackedStars {
    if (buffer.byteLength % 8 !== 0) throw new Error("sternenheer: not packed stars");
    const view = new DataView(buffer);
    const data = new Uint32Array(buffer.byteLength / 4);
    for (let i = 0; i < data.length; i++) data[i] = view.getUint32(i * 4, true);
    return { count: data.length / 2, data };
}

/** The colors the pass looks a star's color index up in, hundredths of B-V from -0.5: linear sRGB at unit luminance
 *  for each of 512, to 4.61, the bright star catalog's reddest in the compact layout. */
export function packedStarColors(): Float32Array {
    const colors = new Float32Array(512 * 4);
    for (let i = 0; i < 512; i++) colors.set(colorFromColorIndex(i * 0.01 - 0.5), i * 4);
    return colors;
}

/**
 * The faint stars: the 108,883 stars of the Hipparcos catalogue (ESA 1997) the bright star catalog does not hold, to
 * magnitude 12 or so and complete to about 8. Compact, 579 KB, in the deep stars' cells, their places within 0.4
 * arcseconds; full, 701 KB, brightest first. Not shipped, as ESA's terms, CC BY-NC 3.0 IGO, are not the package's:
 * `npx @himmelszelt/sternenheer data hipparcos` makes both files next to the package's own, where these resolve, as
 * `BRIGHT_STARS`.
 */
export const HIPPARCOS = {
    compact: new URL("../data/hipparcos-compact.bin.gz", import.meta.url),
    full: new URL("../data/hipparcos.bin.gz", import.meta.url),
} as const;

/** Fetches packed stars to draw besides the catalog: the Hipparcos stars, compact by default, or a file of either
 *  layout. */
export async function loadFaintStars(from: CatalogVariant | string | URL = "compact"): Promise<PackedStars> {
    const { buffer, stride } = await fetchRecords(source(HIPPARCOS, from));
    const cells = buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === DEEP_MAGIC;
    return stride === 6 || cells ? deepStarsFromBuffer(buffer) : packedStarsFromBuffer(buffer);
}

/**
 * Packed stars by the million, sorted for a renderer: by the cell of the sky they stand in, a face of a cube cut 8 by
 * 8, and brightest first within it, in blocks of `blockSize`, a cell's last one filled up with empty stars. A pass
 * draws the blocks of the cells in view, as deep as it is asked to, and reads none of the others. Full: two words a
 * star as `PackedStars`, an empty one both words all ones. Compact: `COMPACT_BLOCK_WORDS` words a block, its cell, then
 * each star's place in the cell in 16 bits across and 16 up, a 0.4th of an arcsecond, then two stars a word, each the
 * magnitude code in 8 bits and the color index's in 8, all ones for an empty star.
 */
export interface DeepStars extends PackedStars {
    readonly compact: boolean;
    /** Stars a block holds, 64, and how many blocks `data` holds. */
    readonly blockSize: number;
    readonly blocks: number;
    /** Per cell its first block, and one more entry, `blocks`. */
    readonly cellBlocks: Uint32Array;
    /** Per cell the unit vector to its middle, J2000 equatorial, and how far from it its stars stand, in radians. */
    readonly cellCones: Float32Array;
    /** Per cell and quarter magnitude from -2, `DEEP_STEPS` of them: how many of its blocks hold all its stars up to
     *  there. */
    readonly cellDepths: Uint32Array;
    /** The magnitude of the brightest of them, and the luminance in cd/m² the stars of the richest cell add up to
     *  over it: what a pass tells from that an exposure shows none of them. */
    readonly brightest: number;
    readonly luminance: number;
}

/** The quarter magnitudes a cell's depths are listed for: -2 to 14. */
export const DEEP_STEPS = 64;

const DEEP_MAGIC = 0x53444853;
const DEEP_HEADER = 8;
const DEEP_CELL = 6;

/** Deep stars from their bytes as `scripts/tycho.mjs` packs them, once `fetchPlanes` has unpacked them: a header, the
 *  cells, the stars, two words a star (version 1) or 6 bytes (version 2, compact), laid out in blocks for the GPU. */
export function deepStarsFromBuffer(buffer: ArrayBuffer): DeepStars {
    const view = new DataView(buffer);
    const version = buffer.byteLength >= DEEP_HEADER * 4 ? view.getUint32(4, true) : 0;
    if (view.getUint32(0, true) !== DEEP_MAGIC || (version !== 1 && version !== 2))
        throw new Error("sternenheer: not deep stars");
    const compact = version === 2;
    const word = (at: number) => view.getUint32(at * 4, true);
    const [count, blockSize, blocks, cells] = [word(2), word(3), word(4), word(5)];
    if (compact && blockSize !== 64) throw new Error("sternenheer: compact deep stars come in blocks of 64");
    const start = compact ? word(6) : (DEEP_HEADER + cells * DEEP_CELL) * 4;
    if (buffer.byteLength !== start + blocks * blockSize * (compact ? 6 : 8))
        throw new Error("sternenheer: not deep stars");
    const cellBlocks = new Uint32Array(cells + 1);
    const cellCones = new Float32Array(cells * 4);
    for (let cell = 0; cell < cells; cell++) {
        const at = (DEEP_HEADER + cell * DEEP_CELL) * 4;
        cellBlocks[cell + 1] = (cellBlocks[cell] ?? 0) + view.getUint32(at + 4, true);
        for (let k = 0; k < 4; k++) cellCones[cell * 4 + k] = view.getFloat32(at + 8 + k * 4, true);
    }
    let data: Uint32Array;
    if (compact) {
        // Blocks as the GPU reads them: the cell, the 64 places, then the codes two stars a word.
        data = new Uint32Array(blocks * COMPACT_BLOCK_WORDS);
        for (let cell = 0; cell < cells; cell++)
            for (let block = cellBlocks[cell] ?? 0; block < (cellBlocks[cell + 1] ?? 0); block++) {
                const base = block * COMPACT_BLOCK_WORDS;
                data[base] = cell;
                for (let k = 0; k < 64; k++) {
                    const at = start + (block * 64 + k) * 6;
                    data[base + 1 + k] = view.getUint32(at, true);
                    data[base + 65 + (k >> 1)] =
                        ((data[base + 65 + (k >> 1)] ?? 0) | (view.getUint16(at + 4, true) << ((k & 1) * 16))) >>> 0;
                }
            }
    } else {
        // The file is little-endian, as nearly every machine: read in place there.
        const native = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
        data = native ? new Uint32Array(buffer, start) : new Uint32Array(blocks * blockSize * 2);
        if (!native) for (let i = 0; i < data.length; i++) data[i] = view.getUint32(start + i * 4, true);
    }
    const codeOf = compact
        ? (slot: number) =>
              ((data[Math.floor(slot / 64) * COMPACT_BLOCK_WORDS + 65 + ((slot % 64) >> 1)] ?? 0) >>>
                  ((slot & 1) * 16)) &
              0xff
        : (slot: number) => (data[slot * 2] ?? 0) >>> 24;
    const cellDepths = new Uint32Array(cells * DEEP_STEPS);
    const lux = Float64Array.from({ length: 256 }, (_, code) => illuminanceFromMagnitude(code * 0.0625 - 2));
    let brightest = 255;
    let luminance = 0;
    for (let cell = 0; cell < cells; cell++) {
        const stars = view.getUint32((DEEP_HEADER + cell * DEEP_CELL) * 4, true);
        const first = cellBlocks[cell] ?? 0;
        // Brightest first: the stars up to a quarter magnitude end where the next one's begin.
        let star = 0;
        let light = 0;
        for (let step = 0; step < DEEP_STEPS; step++) {
            for (; star < stars; star++) {
                const code = codeOf(first * blockSize + star);
                if (code >>> 2 > step) break;
                light += lux[code] ?? 0;
                brightest = Math.min(brightest, code);
            }
            cellDepths[cell * DEEP_STEPS + step] = Math.ceil(star / blockSize);
        }
        const radius = cellCones[cell * 4 + 3] ?? 0;
        if (radius > 0) luminance = Math.max(luminance, light / (2 * Math.PI * (1 - Math.cos(radius))));
    }
    return {
        count,
        data,
        compact,
        blockSize,
        blocks,
        cellBlocks,
        cellCones,
        cellDepths,
        brightest: brightest * 0.0625 - 2,
        luminance,
    };
}

/**
 * The deep stars: the 2.4 million stars of the Tycho-2 catalogue (Høg et al. 2000) that neither the bright star
 * catalog nor the Hipparcos stars hold, to magnitude 12 or so and complete to about 11. Compact, 12.0 MB, their places
 * within 0.4 arcseconds; full, 14.1 MB. Not shipped, for ESA's terms as `HIPPARCOS` and for their size:
 * `npx @himmelszelt/sternenheer data tycho` makes both files next to the package's own, where these resolve.
 */
export const TYCHO = {
    compact: new URL("../data/tycho-compact.bin.gz", import.meta.url),
    full: new URL("../data/tycho.bin.gz", import.meta.url),
} as const;

/** Fetches deep stars to draw besides the catalog, lazily, for their size: Tycho-2's, compact by default, or a file of
 *  either layout. */
export async function loadDeepStars(from: CatalogVariant | string | URL = "compact"): Promise<DeepStars> {
    return deepStarsFromBuffer(await fetchPlanes(source(TYCHO, from)));
}
