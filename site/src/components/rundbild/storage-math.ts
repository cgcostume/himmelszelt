// What a sky costs to hold in each projection, at the sharpness of an equirectangular of a given width: each sized so
// its largest texel covers no more of the sky than the equirectangular's at the horizon, (2π / W)² steradians.

export const STORAGES = [
    "equirectangular",
    "upperEquirectangular",
    "cube",
    "hemicube",
    "cubified",
    "cubifiedHemicube",
    "octahedral",
    "fisheye",
    "sphere",
] as const;
export type Storage = (typeof STORAGES)[number];

/** Bytes a texel, BC6H as its 16 bytes a block of 4 by 4. */
export const FORMATS = {
    rgba32float: 16,
    rgba16float: 8,
    rg11b10ufloat: 4,
    rgb9e5ufloat: 4,
    "bc6h-rgb-ufloat": 1,
} as const;
export type Format = keyof typeof FORMATS;

export interface Scenario {
    width: number;
    format: Format;
    count: number;
}

/** What holds the upper hemisphere alone. */
export const upperHalf = (storage: Storage) =>
    storage === "upperEquirectangular" ||
    storage === "hemicube" ||
    storage === "cubifiedHemicube" ||
    storage === "fisheye";

/**
 * The ratio of a projection's largest texel to its mean one, in the limit of many. A hemicube's is its cube's: the upper
 * half of every side face is as dense as the lower, by symmetry.
 */
const LARGEST_OVER_MEAN: Record<"cube" | "cubified" | "octahedral" | "fisheye" | "sphere", number> = {
    // At the middle of a face, 2/N squared, over 4π / 6N².
    cube: 6 / Math.PI,
    // At the middle of a face's edge, 1/√3 against a corner's √3/4 (per unit of the face, in [-1, 1] squared).
    cubified: 6 / (Math.PI * Math.sqrt(3)),
    // At the middle of an octahedron's face, (√3)³ against its corners' 1, a mean of π.
    octahedral: (3 * Math.sqrt(3)) / Math.PI,
    // At the zenith, (π/S)² over 2π spread on the inscribed circle; the corners hold no direction.
    fisheye: Math.PI ** 2 / 8,
    sphere: 1,
};

/** Densest texel over sparsest, in texels per steradian; the equirectangular's grows with its rows of π/H each. */
export function spreadOf(storage: Storage, width: number): number {
    switch (storage) {
        case "equirectangular":
        case "upperEquirectangular":
            // A row next to the horizon over a row at a pole: sin(π/H) / (1 - cos(π/H)), H = W/2.
            return 1 / Math.tan(Math.PI / width);
        case "cube":
        case "hemicube":
        case "octahedral":
            return 3 * Math.sqrt(3);
        case "cubified":
        case "cubifiedHemicube":
            return 4 / 3;
        case "fisheye":
            return Math.PI / 2;
        case "sphere":
            return 1;
    }
}

const up = (x: number) => Math.max(1, Math.ceil(x - 1e-9));
const toBlock = (n: number, block: number) => Math.ceil(n / block) * block;

/** A layer's texels across and down per level, from the largest first, and how many such layers. */
interface Layout {
    /** Of each part, its size at level 0 and how many: a hemicube's top face and its four half faces. */
    parts: { across: number; down: number; times: number }[];
    /** The size said under the name. */
    label: string;
    /** The texels across the largest part, which counts the levels. */
    largest: number;
}

export function layoutOf(storage: Storage, width: number, block: number): Layout {
    const texels = (k: number, covered: number) => (k * covered * width ** 2) / (4 * Math.PI ** 2);
    const half = upperHalf(storage);
    switch (storage) {
        case "equirectangular":
        case "upperEquirectangular": {
            // The rows of π/H each, H = W/2: a quarter of the width for the upper half.
            const across = toBlock(2 * up(width / 2), 2 * block);
            const down = half ? toBlock(across / 4, block) : across / 2;
            return { parts: [{ across, down, times: 1 }], label: `${across} × ${down}`, largest: across };
        }
        case "cube":
        case "cubified":
        case "hemicube":
        case "cubifiedHemicube": {
            const k = LARGEST_OVER_MEAN[storage === "cube" || storage === "hemicube" ? "cube" : "cubified"];
            // A hemicube's side faces are halved: an even size.
            const n = toBlock(up(Math.sqrt(texels(k, 4 * Math.PI) / 6)), half ? 2 * block : block);
            if (!half) return { parts: [{ across: n, down: n, times: 6 }], label: `6 × ${n}²`, largest: n };
            return {
                parts: [
                    { across: n, down: n, times: 1 },
                    { across: n, down: n / 2, times: 4 },
                ],
                label: `${n}² + 4 × ${n} × ${n / 2}`,
                largest: n,
            };
        }
        default: {
            const covered = storage === "fisheye" ? 2 * Math.PI : 4 * Math.PI;
            const inside = texels(LARGEST_OVER_MEAN[storage], covered);
            // Fisheye and sphere map on their inscribed circle, the corners left over.
            const n = toBlock(up(Math.sqrt(storage === "octahedral" ? inside : (inside * 4) / Math.PI)), block);
            return { parts: [{ across: n, down: n, times: 1 }], label: `${n}²`, largest: n };
        }
    }
}

/**
 * More than one map makes an atlas, as light probes are packed: every tile drawn with a gutter of one texel each side, a
 * copy of its edge for the bilinear filter, as DDGI's probes are (Majercik et al. 2019), and its mip levels down to 4
 * texels across, each with its own gutter, before the tiles would blur into each other. Cube maps go into a cube map
 * array, whose faces the hardware filters across: levels as few, no gutter.
 */
export const ATLAS_GUTTER = 1;
export const ATLAS_SMALLEST = 4;

export interface Cost {
    storage: Storage;
    label: string;
    levels: number;
    /** Texels each side of every tile, 0 but in an atlas. */
    gutter: number;
    /** Level 0, and all levels, of all maps. */
    base: number;
    total: number;
    spread: number;
    /** The share of texels a projection of an even spread, as sharp, would not need. */
    wasted: number;
}

export function costOf(storage: Storage, scenario: Scenario): Cost {
    const bc = scenario.format.startsWith("bc");
    const { parts, label, largest } = layoutOf(storage, scenario.width, bc ? 4 : 1);
    const atlas = scenario.count > 1;
    const layered = storage === "cube" || storage === "cubified";
    const gutter = atlas && !layered ? ATLAS_GUTTER : 0;
    const full = Math.floor(Math.log2(largest)) + 1;
    const levels = atlas ? Math.max(1, Math.min(full, Math.floor(Math.log2(largest / ATLAS_SMALLEST)) + 1)) : full;
    const bytesOf = (w: number, h: number) =>
        bc ? Math.ceil(w / 4) * Math.ceil(h / 4) * 16 : w * h * FORMATS[scenario.format];
    let base = 0;
    let total = 0;
    for (let level = 0; level < levels; ++level) {
        for (const { across, down, times } of parts) {
            const w = Math.max(1, across >> level) + 2 * gutter;
            const h = Math.max(1, down >> level) + 2 * gutter;
            const bytes = times * bytesOf(w, h);
            if (level === 0) base += bytes;
            total += bytes;
        }
    }
    const covered = upperHalf(storage) ? 2 * Math.PI : 4 * Math.PI;
    const even = (covered * scenario.width ** 2) / (4 * Math.PI ** 2);
    const texels = parts.reduce((sum, { across, down, times }) => sum + across * down * times, 0);
    // In an atlas, each tile as drawn, gutters and all.
    const tiles = parts
        .map(({ across, down, times }) => {
            const [w, h] = [across + 2 * gutter, down + 2 * gutter];
            return `${times > 1 ? `${times} × ` : ""}${w === h ? `${w}²` : `${w} × ${h}`}`;
        })
        .join(" + ");
    return {
        storage,
        label: gutter ? `${tiles} with gutters` : label,
        levels,
        gutter,
        base: base * scenario.count,
        total: total * scenario.count,
        spread: spreadOf(storage, scenario.width),
        wasted: Math.max(0, 1 - even / texels),
    };
}
