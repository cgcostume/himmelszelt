// What the data scripts share: their options, the download cache, skipping work already done, the license notices they
// print, and the files they write, byte planes gzip compressed, as the package's loaders read them.
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { fetchSource } from "./mirror.mjs";

/** The package's own data directory, next to the scripts, wherever the package is installed. */
export const DATA = fileURLToPath(new URL("../data/", import.meta.url));

/**
 * The options every script takes: `--out <dir>` where it writes, the package's data directory by default; `--cache
 * <dir>` where downloads are kept, `node_modules/.cache/sternenheer` of the directory it is run from; `--force` to
 * redo the work even where the output is newer than its inputs. The rest are the script's own, as `option` reads them.
 */
export function options(argv = process.argv.slice(2)) {
    const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
    const out = resolve(option("--out", DATA));
    const cache = resolve(option("--cache", join("node_modules", ".cache", "sternenheer")));
    mkdirSync(out, { recursive: true });
    return { out, cache, force: argv.includes("--force"), option, flag: (name) => argv.includes(name) };
}

/** Whether `output` exists and is newer than every input that exists: then the script has nothing to do. */
export function upToDate(output, inputs, force = false) {
    if (force || !existsSync(output)) return false;
    const made = statSync(output).mtimeMs;
    return inputs.every((input) => !existsSync(input) || statSync(input).mtimeMs <= made);
}

/** The files the package's scripts download or build, as the asset mirror holds them. */
export const ASSETS = fileURLToPath(new URL("../assets.json", import.meta.url));

/** Downloads `url` into the cache once, from the asset mirror first, and returns the file's path. */
export function download(url, cache, name, size) {
    const file = join(cache, name);
    if (existsSync(file)) return file;
    mkdirSync(dirname(file), { recursive: true });
    fetchSource(ASSETS, url, file, size);
    return file;
}

/** sharp, which writes the maps' WebPs: a peer dependency, installed with the package or on its own. */
export async function sharp() {
    try {
        return (await import("sharp")).default;
    } catch {
        throw new Error("the maps need sharp: npm install sharp");
    }
}

/** The data sets and the terms they come under, as `data/LICENSE.md` gives them. */
export const LICENSES = {
    yale: {
        name: "the Yale Bright Star Catalogue, 5th revised edition (Hoffleit & Warren 1991)",
        terms: "as NASA's HEASARC distributes it, a U.S. Government work for public use; the catalog's own files name Hoffleit and Warren as its copyright holders",
        credit: "Hoffleit, D., Warren Jr., W. H. (1991), The Bright Star Catalogue, 5th revised ed., Yale University Observatory; NASA HEASARC",
        url: "https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/bsc5p.html",
    },
    hipparcos: {
        name: "the Hipparcos catalogue (ESA 1997)",
        terms: "CC BY-NC 3.0 IGO: free to share and adapt for non-commercial use, with credit",
        credit: "ESA",
        url: "https://www.cosmos.esa.int/web/hipparcos/catalogues",
    },
    tycho: {
        name: "the Tycho-2 catalogue (Høg et al. 2000)",
        terms: "CC BY-NC 3.0 IGO: free to share and adapt for non-commercial use, with credit",
        credit: "ESA",
        url: "https://www.cosmos.esa.int/web/hipparcos/catalogues",
    },
    constellations: {
        name: "d3-celestial's constellation lines (Olaf Frohn)",
        terms: "BSD 3-Clause, data/LICENSE-d3-celestial.txt",
        credit: "d3-celestial, Olaf Frohn",
        url: "https://github.com/ofrohn/d3-celestial",
    },
    milkyway: {
        name: "NASA's Deep Star Maps 2020 (SVS 4851)",
        terms: "NASA media, free to use with credit",
        credit: "NASA's Scientific Visualization Studio",
        url: "https://svs.gsfc.nasa.gov/4851",
    },
};

/** Prints the terms a data set comes under and the credit they ask for. */
export function notice(key) {
    const { name, terms, credit, url } = LICENSES[key];
    console.log(`Data from ${name}: ${terms}. Credit "${credit}". ${url}`);
}

/** The tag of a byte-plane file: "SHBP". */
export const PLANES_MAGIC = 0x50424853;

/**
 * Writes `bytes` as byte planes, gzip compressed: an 8-byte header, the tag and the record's size `stride`, then for
 * each byte of a record the bytes at that place of every record in turn. Neighboring stars' exponents, top bits and
 * colors then lie side by side, which gzip packs far tighter. The loaders turn it back, `DecompressionStream` and all.
 */
export function writePlanes(path, bytes, stride) {
    if (bytes.length % stride !== 0)
        throw new Error(`${path}: ${bytes.length} bytes are no whole records of ${stride}`);
    const records = bytes.length / stride;
    const planes = new Uint8Array(8 + bytes.length);
    const view = new DataView(planes.buffer);
    view.setUint32(0, PLANES_MAGIC, true);
    view.setUint32(4, stride, true);
    for (let k = 0; k < stride; k++)
        for (let i = 0; i < records; i++) planes[8 + k * records + i] = bytes[i * stride + k];
    const packed = gzipSync(planes, { level: 9 });
    writeFileSync(`${path}.part`, packed);
    renameSync(`${path}.part`, path);
    return packed.length;
}

export const megabytes = (n) => `${(n / 1e6).toFixed(n < 1e6 ? 2 : 1)} MB`;

/** The faint stars' cells: the six faces of a cube, each cut `GRID` by `GRID`, and the stars a block holds. */
export const GRID = 8;
export const CELLS = 6 * GRID * GRID;
export const BLOCK = 64;
const CELLS_MAGIC = 0x53444853;
const RAD = Math.PI / 180;

/** The cell a direction leaves the cube through, and where in it, from 0 to 1 across and up. */
export function cellOf(direction) {
    const axis = direction.reduce((best, c, i, all) => (Math.abs(c) > Math.abs(all[best]) ? i : best), 0);
    const major = direction[axis];
    const at = (k) => ((direction[(axis + k) % 3] / Math.abs(major) + 1) / 2) * GRID;
    const [u, v] = [at(1), at(2)];
    const [iu, iv] = [Math.min(Math.floor(u), GRID - 1), Math.min(Math.floor(v), GRID - 1)];
    return { cell: ((axis * 2 + (major < 0 ? 1 : 0)) * GRID + iv) * GRID + iu, local: [u - iu, v - iv] };
}

const clampRound = (value, top) => Math.min(Math.max(Math.round(value), 0), top);

/** The two words of a star in the full layout: the right ascension in 24 bits and the magnitude code in 8, the
 *  declination in 24 bits and B-V in 8. */
export const fullWords = (ra, de, magnitude, bv) => [
    ((Math.round((ra / 360) * 2 ** 24) % 2 ** 24) | (magnitude << 24)) >>> 0,
    (clampRound(((de + 90) / 180) * (2 ** 24 - 1), 2 ** 24 - 1) | (clampRound((bv + 0.5) / 0.01, 255) << 24)) >>> 0,
];

/**
 * Faint stars `{ vmag, ra, de, bv }` (degrees) sorted for a renderer, by cell and brightest first within it, in blocks
 * of `BLOCK`, a cell's last one filled up with empty stars; a header of eight Uint32 and six words a cell first. Full:
 * version 1, two words a star as `fullWords`, an empty star both words all ones, records of 8 bytes. Compact: version 2,
 * 6 bytes a star, its place in its cell in 16 bits across and 16 up, then the magnitude code and B-V in a byte each, an
 * empty star's all ones; the stars start at the byte the header's seventh word says, the header filled up to whole
 * records of 6 bytes. Returns the bytes, the record's size and the counts.
 */
export function packCells(stars, compact) {
    const record = compact ? 6 : 8;
    const packed = stars.map(({ vmag, ra, de, bv }) => {
        const direction = [
            Math.cos(de * RAD) * Math.cos(ra * RAD),
            Math.cos(de * RAD) * Math.sin(ra * RAD),
            Math.sin(de * RAD),
        ];
        const { cell, local } = cellOf(direction);
        const magnitude = clampRound((vmag + 2) / 0.0625, 254);
        const words = compact
            ? [
                  (Math.min(Math.floor(local[0] * 65536), 65535) |
                      (Math.min(Math.floor(local[1] * 65536), 65535) << 16)) >>>
                      0,
                  magnitude | (clampRound((bv + 0.5) / 0.01, 255) << 8),
              ]
            : fullWords(ra, de, magnitude, bv);
        return { cell, magnitude, direction, words };
    });
    packed.sort((a, b) => a.cell - b.cell || a.magnitude - b.magnitude);
    const cells = Array.from({ length: CELLS }, () => ({ stars: [], blocks: 0, center: [0, 0, 1], radius: 0 }));
    for (const star of packed) cells[star.cell].stars.push(star);
    let blocks = 0;
    for (const cell of cells) {
        cell.blocks = Math.ceil(cell.stars.length / BLOCK);
        blocks += cell.blocks;
        if (cell.stars.length === 0) continue;
        const sum = cell.stars.reduce((s, { direction: d }) => [s[0] + d[0], s[1] + d[1], s[2] + d[2]], [0, 0, 0]);
        cell.center = sum.map((c) => c / Math.hypot(...sum));
        const dot = (d) => Math.min(d[0] * cell.center[0] + d[1] * cell.center[1] + d[2] * cell.center[2], 1);
        cell.radius = Math.max(...cell.stars.map(({ direction }) => Math.acos(dot(direction))));
    }
    const start = Math.ceil(((8 + CELLS * 6) * 4) / record) * record;
    const buffer = new ArrayBuffer(start + blocks * BLOCK * record);
    const view = new DataView(buffer);
    for (const [i, word] of [
        CELLS_MAGIC,
        compact ? 2 : 1,
        packed.length,
        BLOCK,
        blocks,
        CELLS,
        compact ? start : 0,
        0,
    ].entries())
        view.setUint32(i * 4, word, true);
    let at = 32;
    for (const cell of cells) {
        view.setUint32(at, cell.stars.length, true);
        view.setUint32(at + 4, cell.blocks, true);
        for (let i = 0; i < 3; i++) view.setFloat32(at + 8 + i * 4, cell.center[i], true);
        view.setFloat32(at + 20, cell.radius, true);
        at += 24;
    }
    at = start;
    for (const cell of cells)
        for (let k = 0; k < cell.blocks * BLOCK; k++) {
            const words = cell.stars[k]?.words ?? [0xffffffff, compact ? 0xffff : 0xffffffff];
            view.setUint32(at, words[0], true);
            if (compact) view.setUint16(at + 4, words[1], true);
            else view.setUint32(at + 4, words[1], true);
            at += record;
        }
    return { bytes: new Uint8Array(buffer), stride: record, blocks, count: packed.length };
}
