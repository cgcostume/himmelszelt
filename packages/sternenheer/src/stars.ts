import { blueNoiseTexture, NO_WHITE_BALANCE, type ToneCurve, type WhiteBalance } from "@himmelszelt/helldunkel";
import {
    COMPACT_STAR_WORDS,
    DEEP_STEPS,
    type DeepStars,
    isCompact,
    type PackedStars,
    packedStarAt,
    packedStarColors,
    STAR_FIELDS,
    type StarCatalog,
} from "./catalog.js";
import { type ConstellationLines, constellationMask } from "./constellations.js";
import { illuminanceFromMagnitude } from "./light.js";
import type { MilkyWay } from "./milkyway.js";
import * as wgsl from "./wgsl/index.js";

export interface StarsPassOptions {
    /** Format of the target `encode` writes, with `STORAGE_BINDING` usage: rgba8unorm for a display, bgra8unorm with
     *  "bgra8unorm-storage", rgba16float or rgba32float for linear output, or an HDR canvas. */
    format: GPUTextureFormat;
    /** The stars to draw, `loadCatalog`; without, the Milky Way alone. Compact or full: the pass decodes the layout it
     *  is made with, and `setCatalog` takes that one. */
    catalog?: StarCatalog | null;
    /** Faint stars to draw besides the catalog's, `loadFaintStars`: the Hipparcos catalogue's, compact in cells or
     *  full, brightest first. Drawn with `catalog` only. */
    faintStars?: PackedStars | null;
    /** Stars by the million to draw besides, `loadDeepStars`: the Tycho-2 catalogue's. Each one's light is added to
     *  the pixels around it, so they fill no tile, and only the cells of the sky in view are read. Drawn with
     *  `catalog` only. */
    deepStars?: DeepStars | null;
    /** The constellations' lines, `loadConstellations`, between stars of `catalog`; without, none are drawn. */
    constellations?: ConstellationLines | null;
    /** The Milky Way, `loadMilkyWay`; without, the stars alone. */
    milkyWay?: MilkyWay | null;
    /** Tone map for a display, as dunstkreis' sky pass: "neutral" by default, "agx", "aces", "clip"; `false` writes the
     *  exposed luminance, linear, for a renderer that composes more over it, the Moon say. */
    toneMap?: ToneCurve | false;
    /** How many times SDR white an HDR display shows, 1 by default. */
    headroom?: number;
    /** Dither the tone mapped output against banding by a step of helldunkel's blue noise, false by default: for an
     *  8-bit target over smooth gradients. */
    dither?: boolean;
    /** The blue noise to dither by, helldunkel's `blueNoiseTexture(device)` by default: one for a frame's passes. */
    blueNoise?: GPUTexture;
    /** Whether `encode` composes over a background in cd/m², true by default. Without, it writes the stars' light
     *  alone, with alpha 0, for a renderer that adds it. */
    background?: boolean;
    /** The stars and the sky behind them as the eye sees them at night rather than a camera, by helldunkel's
     *  `hdDarkAdaptedEye`, on the composed light before the exposure. With a background only; off by default. */
    darkAdapted?: boolean;
    /** The tiles the stars are binned into, 16 pixels by default, and how many stars a tile holds, 64: a full tile
     *  keeps its brightest, the same ones every frame, and drops the faintest. */
    tileSize?: number;
    capacity?: number;
    /** Keeps what the passes leave between them readable, for `inspect`, and times each pass on the GPU's clock where the
     *  device has "timestamp-query": for a figure or a debugger, off by default, and nothing is kept or timed then. */
    debug?: boolean;
}

/** Everything that can change per frame. Directions ENU (x east, y north, z up). */
export interface StarsParams {
    /** The rotation from the catalog's J2000 equatorial frame into ENU, nine numbers column major: sternzeit's
     *  `stars.horizontalMatrix` for the moment and the place. Identity by default: the equinox east on the horizon. */
    skyRotation: Float32Array;
    /** Years since J2000.0, for the stars' proper motion; 0 by default. */
    years: number;
    /** Inverse view-projection, column major, and the projection's bend, as `@himmelszelt/dunstkreis`' sky pass. */
    inverseViewProjection: Float32Array;
    projectionDistance: number;
    /** Exposure in EV100: a moonless sky meters around -9, a moonlit one around -6. */
    ev100: number;
    /** A white balance, `@himmelszelt/helldunkel`'s `whiteBalance(white)`, on the composed light, background included,
     *  before the exposure: `NO_WHITE_BALANCE` by default, the identity. */
    whiteBalance: WhiteBalance;
    /** The exposure in EV100 the image is finally shown at, for the cut-off, the knee and the halo, when a later pass
     *  exposes what this one writes linear; null by default, `ev100`. */
    displayEV100: number | null;
    /** The z below which a ray hits the ground; -1 by default, the whole sphere. */
    horizonZ: number;
    /** What hides the stars behind it, the Moon say: towards its center as it shows, ENU, and its angular diameter
     *  in degrees. Null by default, nothing. */
    occluder: { direction: ArrayLike<number>; angularDiameter: number } | null;
    /** The air: `@himmelszelt/dunstkreis`' air table for the observer's height, as `createAirTexture` makes it, and the
     *  table's `horizon` in degrees, the lowest ray that still reaches space. It lifts every star near the horizon,
     *  dims and reddens it and thins a point's light where it squeezes the sky, looks the Milky Way up along the
     *  unbent ray, dimmed alone, and hides what lies below that horizon. Null by default, no air. */
    air: { texture: GPUTexture; horizon: number } | null;
    /** The width of a star's core on the target, in pixels: the standard deviation of its Gaussian point spread, 0.7
     *  by default. Never under 0.6, so no star falls between pixels. On the sky the core narrows as the view zooms in,
     *  and the star brightens, as it does in a telescope. */
    psfPixels: number;
    /** The exposed luminance, in units of display white, at which a star's core stops brightening, 1 by default: the
     *  core stays a point, and the light beyond goes into its halo. */
    knee: number;
    /** How much of the light beyond the knee its halo shows, 1 by default, all of it, 0 for none, which also skips the
     *  halos' passes and frees their memory. The halo spreads that light, and adds none: it is a sign that a star is
     *  brighter than the display shows, as a glow in the eye or a lens around a bright light, and grows wider with the
     *  star's light. */
    halo: number;
    /** How the air's turbulence makes the stars twinkle: `@himmelszelt/dunstkreis`' `seeingUniformData(seeing)`, the
     *  `DkSeeing` block, with the observer's speed in `speed` from above the atmosphere. Null by default, no
     *  twinkling; the stars twinkle through the air only. */
    seeing: Float32Array | null;
    /** How strongly the stars twinkle, 1 for what the seeing gives, 0 for none: the variance of their flicker scales
     *  by its square. And the time in seconds the twinkling runs on, which a renderer advances per frame. */
    scintillation: number;
    time: number;
    /** The viewer's eye's veil around a bright star, CIE's glare equation by the angle on the viewer's own field of
     *  view, 1 for the eye's own, 0 for none, a camera. */
    glare: number;
    /** How many degrees of the viewer's field of view the target's height spans, for the veil and the halo: 30 by
     *  default, a screen at arm's length. */
    viewerFov: number;
    /** What the stars' light is multiplied by, and the Milky Way's, 1 for as measured. */
    starLight: number;
    milkyWay: number;
    /** Artistic offsets in stops, 0 by default, which is physical: the stars' light and the Milky Way's multiplied by
     *  2^stops before the exposure, +1 twice as bright, -1 half. Anything else is a deliberate departure from the
     *  calibration, for a filmic or a designed sky. The stars' offset acts before the knee, so bright stars grow their
     *  halos and fainter ones come up, as in a longer exposure; the faint and the deep stars follow it too. */
    starCompensation: number;
    milkyWayCompensation: number;
    /** Stars fainter than this magnitude are left out; 99 by default, all of them. */
    magnitudeLimit: number;
    /** How many of the faint stars are drawn, the brightest first, of compact ones to the sixteenth of a magnitude the
     *  last of them has; Infinity by default, all the pass got. */
    faintStars: number;
    /** The magnitude down to which the deep stars are drawn; Infinity by default, all the pass got, 0 for none. */
    deepStars: number;
    /** Below this exposed luminance, in units of display white, a star's image is cut off: 1/2048 by default. */
    threshold: number;
    /** The constellations to draw lines of, by their abbreviations, "Ori" or `ZODIAC`; null, all of them; none by
     *  default. They show only where the pass got `constellations`. */
    constellations: readonly string[] | null;
    /** The lines as a hint on the display rather than light in the sky, the same at any exposure: how much of their
     *  color shows, 0.1 by default, the color in linear sRGB, units of display white, a muted blue gray, their width in
     *  pixels, 1.25, and how many pixels from a star they stop, 4. */
    constellationOpacity: number;
    constellationColor: readonly [number, number, number];
    constellationWidth: number;
    constellationGap: number;
    /** No star's image, veil included, grows past this radius in pixels, 256 by default. */
    maxRadius: number;
}

/** One star as the last frame drew it, `readStars`: whether it was drawn, where on the target in pixels, its light at
 *  the eye in lux as a luminance, after the air, and the shares of that light its core and its halo show. What is
 *  left, past the knee and not shown by the halo, is not drawn. */
export interface StarImage {
    drawn: boolean;
    pixel: [number, number];
    light: number;
    core: number;
    halo: number;
}

/** A level of the halos' grid, `inspect`: its size in texels, a texel spanning `scale` × 2^level pixels of the target,
 *  the light the bin pass put into it and what it holds added up with the levels above, exposed luminance in units of
 *  display white, four floats a texel, before the halo's logarithmic curve. */
export interface HaloLevel {
    width: number;
    height: number;
    own: Float32Array;
    sum: Float32Array;
}

/** What the last frame left between the passes, `inspect`, with the pass made with `debug`. */
export interface StarsInspection {
    width: number;
    height: number;
    /** The tiles, `columns` by `rows` of `size` pixels: per tile how many stars reach it, more than `capacity` where
     *  it keeps the brightest only, and how many pieces of the constellations' lines, of `lineCapacity` at most. */
    tiles: {
        size: number;
        columns: number;
        rows: number;
        capacity: number;
        stars: Uint32Array;
        lines: Uint32Array;
        lineCapacity: number;
    };
    /** How many stars the pass holds, how many it drew, and how many of those passed the knee into a halo. */
    stars: { count: number; drawn: number; halos: number };
    /** The halos' grid, finest level first, `margin` pixels past the target's edges, and the share each level took;
     *  null where the frame drew no halos. */
    halo: { margin: number; scale: number; weights: number[]; levels: HaloLevel[] } | null;
    /** Milliseconds per pass on the GPU's clock, by name, those that ran: "lines", "bin", "deep", "halo", "compose";
     *  null without "timestamp-query". */
    milliseconds: Record<string, number> | null;
}

export interface EncodeOptions {
    /** The sky behind the stars, in cd/m², the target's size: a float texture with `TEXTURE_BINDING` usage. */
    background?: GPUTexture;
    /** Timestamps around the compose pass, for timing it. */
    timestampWrites?: GPUComputePassTimestampWrites;
}

/** A stars pass: compute passes over the catalog, binning every star's image into the tiles of the target it reaches,
 *  over the deep stars, the constellations' lines and the halos' pyramid, and over the pixels, summing them and the
 *  Milky Way behind, over a background, into a target the caller owns. It creates no device, canvas or context of its
 *  own. */
export interface StarsPass {
    /** Takes the parameters over and writes the uniforms. */
    update(params: Partial<StarsParams>): void;
    /** Records the stars into `target`, which needs `STORAGE_BINDING` usage and the pass' format. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture, options?: EncodeOptions): void;
    /** Replaces the catalog, its stars drawn from the next frame on; the faint and the deep stars stay as made. */
    setCatalog(catalog: StarCatalog | null): void;
    /** The catalog's stars `first` to `first + count` as the last submitted frame drew them. */
    readStars(first?: number, count?: number): Promise<StarImage[]>;
    /** What the last submitted frame left between the passes; with `debug` only. */
    inspect(): Promise<StarsInspection>;
    /** The last submitted frame's milliseconds per pass, as `inspect` has them and nothing else, cheap enough to call
     *  per frame; null without `debug` or without "timestamp-query". */
    timings(): Promise<Record<string, number> | null>;
    destroy(): void;
}

const TONE_CURVES: Record<string, number> = { neutral: 1, agx: 2, aces: 3, clip: 4 };
/** Byte size of ShParams in params.wgsl: a mat4x4, a mat3x3 of three padded columns, eleven vec4-sized rows, the
 *  seeing's two, the white balance, another padded mat3x3, and the halo's twelve weights. */
export const PARAMS_SIZE = (16 + 12 + 44 + 8 + 12 + 12) * 4;
const PIECE_SIZE = 48;
const LINE_PIECES = 8;
const LINE_CAPACITY = 16;
const SPLAT_SIZE = 48;

/** The halo's width, in arcminutes of the viewer's field of view as `viewerFov` sets it: its light falls to a third at
 *  this radius and with the cube of the distance beyond. Fitted to photographs: so narrow that the halo is the finest
 *  level of its grid, some 1.2 pixels, and widens with a star's light alone. Fixed, as the levels a width needs change
 *  in steps a slider would show. */
const HALO_WIDTH = 0.1;

const DEFAULTS: StarsParams = {
    skyRotation: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    years: 0,
    inverseViewProjection: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    projectionDistance: 0,
    ev100: -6,
    whiteBalance: NO_WHITE_BALANCE,
    displayEV100: null,
    horizonZ: -1,
    occluder: null,
    air: null,
    psfPixels: 0.7,
    knee: 1,
    halo: 1,
    seeing: null,
    scintillation: 1,
    time: 0,
    glare: 0,
    viewerFov: 30,
    starLight: 1,
    milkyWay: 1,
    starCompensation: 0,
    milkyWayCompensation: 0,
    magnitudeLimit: 99,
    faintStars: Number.POSITIVE_INFINITY,
    deepStars: Number.POSITIVE_INFINITY,
    threshold: 1 / 2048,
    constellations: [],
    constellationOpacity: 0.1,
    constellationColor: [0.45, 0.6, 0.85],
    constellationWidth: 1.25,
    constellationGap: 4,
    maxRadius: 256,
};

const HALO_SCALE = 2;
const HALO_MARGIN = 64;
const HALO_LEVELS = 12;

/** The halos' grid for a target, as params.wgsl has it: its finest level half the target's size and a margin, and how
 *  many levels it has, each half the one before, rounded up. */
export function haloGrid(width: number, height: number): { width: number; height: number; levels: number } {
    const size = (n: number) => Math.floor((n + 2 * HALO_MARGIN + HALO_SCALE - 1) / HALO_SCALE);
    const [w, h] = [size(width), size(height)];
    return { width: w, height: h, levels: Math.max(1, Math.min(HALO_LEVELS, Math.floor(Math.log2(Math.min(w, h))))) };
}

/** The error function, after Abramowitz and Stegun 7.1.26, within 1.5e-7. */
function erf(x: number): number {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    return Math.sign(x) * (1 - poly * Math.exp(-x * x));
}

/** A halo's width in pixels of a target `height` pixels high, from arcminutes of the viewer's field. */
function haloPixels(params: StarsParams, height: number): number {
    return (HALO_WIDTH * height) / (60 * params.viewerFov);
}

/** How many of the grid's `most` levels a halo `width` pixels wide needs: up to one 64 times as wide, past which some
 *  1.5% of its light lies, which the last level takes, so a narrow halo halves the grid fewer times. */
export function haloLevels(width: number, most: number): number {
    let levels = 1;
    while (levels < most && haloLevelWidth(levels - 1) < 64 * width) levels++;
    return levels;
}

/** How wide a point of light ends up that the halos' grid takes at `level`, in pixels: the standard deviation the
 *  splat, the halvings, the tents and the last lookup add up to. */
export function haloLevelWidth(level: number): number {
    return HALO_SCALE * Math.sqrt((17 * 4 ** level - 5) / 36);
}

/**
 * The share of a halo's light each of the grid's `levels` takes, finest first, for a halo `width` pixels wide: a Moffat
 * profile of β 3/2, (1 + r² / α²)^-3/2, which falls with the cube of the distance as the eye's glare does, written as
 * Gaussians of every width, α² / 2t for t of a gamma distribution of shape 1/2, whose CDF is erf √t. Each level takes
 * those nearest its own width, the finest also all narrower ones, the coarsest all wider ones: the shares add up to 1.
 */
export function haloWeights(width: number, levels: number): Float64Array {
    const weights = new Float64Array(levels);
    let narrower = 1;
    for (let level = 0; level < levels; level++) {
        const edge = level + 1 < levels ? Math.sqrt(haloLevelWidth(level) * haloLevelWidth(level + 1)) : 0;
        const wider = edge > 0 && width > 0 ? erf(width / (Math.SQRT2 * edge)) : 0;
        weights[level] = narrower - wider;
        narrower = wider;
    }
    return weights;
}

/** The flags and sizes the pass sets per frame besides the parameters. */
interface Frame {
    width: number;
    height: number;
    tileSize: number;
    capacity: number;
    stars: boolean;
    milkyWay: number | null;
    /** The stops the Milky Way's map spans, 0 by default, read linear. */
    milkyWayStops?: number;
    /** Whether the pass has lines to draw; false by default. */
    lines?: boolean;
    /** How many faint stars the pass holds; 0 by default. */
    faintStars?: number;
    /** How many of them are drawn, and the magnitude below which, for a compact layout; by default `faintStars` of the
     *  parameters, and 99. */
    faintDrawn?: number;
    faintLimit?: number;
    /** Whether the deep stars' sums hold this frame's light; false by default. */
    deepStars?: boolean;
    /** How many bits a tile entry gives the star's index, `tileIndexBits`; 17 by default. */
    indexBits?: number;
}

/** How many bits a tile entry gives the index of `stars` stars, the rest for their brightness, 8 at least. */
export function tileIndexBits(stars: number): number {
    const bits = Math.max(1, Math.ceil(Math.log2(Math.max(stars, 2))));
    if (bits > 24) throw new Error(`sternenheer: ${stars} stars are more than the tiles can tell apart, 2^24`);
    return bits;
}

const DEEP_PARAMS_SIZE = 32;

type Vec3 = [number, number, number];

/** The ray through a clip-space point, as dunstkreis' `dkProjectRay`: for what the pass culls on the CPU. */
function projectRay(m: Float32Array, x: number, y: number, d: number): Vec3 {
    const unproject = (px: number, py: number): Vec3 => {
        const at = (row: number) =>
            (m[row] ?? 0) * px + (m[4 + row] ?? 0) * py + (m[8 + row] ?? 0) * 0.5 + (m[12 + row] ?? 0);
        const ray = [0, 1, 2].map((row) => at(row) / at(3) - (m[8 + row] ?? 0) / (m[11] ?? 1));
        const length = Math.hypot(...ray);
        return [(ray[0] ?? 0) / length, (ray[1] ?? 0) / length, (ray[2] ?? 0) / length];
    };
    const view = unproject(x, y);
    if (d <= 0) return view;
    const center = unproject(0, 0);
    const along = view[0] * center[0] + view[1] * center[1] + view[2] * center[2];
    const offset = view.map((c, i) => c - (center[i] ?? 0) * along);
    const length = Math.hypot(...offset);
    const k = length / along / (d + 1);
    if (k < 1e-7) return center;
    const cosTheta = (Math.sqrt(1 + k * k * (1 - d * d)) - k * k * d) / (1 + k * k);
    const sinTheta = Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0));
    return [0, 1, 2].map((i) => (center[i] ?? 0) * cosTheta + ((offset[i] ?? 0) / length) * sinTheta) as Vec3;
}

/** The view as a cone: its axis, the angle from it of the target's farthest corner in radians, and the most pixels a
 *  radian of sky spans anywhere on a target `height` pixels high. */
function viewCone(params: StarsParams, height: number): { axis: Vec3; angle: number; pixelsPerRadian: number } {
    const d = Math.min(Math.max(params.projectionDistance, 0), 1);
    const ray = (x: number, y: number) => projectRay(params.inverseViewProjection, x, y, d);
    const between = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    const axis = ray(0, 0);
    const corners: [number, number][] = [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
    ];
    const angle = Math.max(...corners.map(([x, y]) => between(axis, ray(x, y))));
    // Along the radius the image stretches most: rho' = (d + 1)(d cos θ + 1) / (d + cos θ)² times the center's scale.
    const cos = Math.cos(angle);
    const stretch = d + cos > 1e-3 ? ((d + 1) * (d * cos + 1)) / (d + cos) ** 2 : Number.POSITIVE_INFINITY;
    return { axis, angle, pixelsPerRadian: (stretch * 2) / between(axis, ray(0, 4 / height)) };
}

/**
 * The blocks of deep stars a frame draws, into `blocks`: those of the cells that reach into the view's cone and above
 * the horizon, as deep as the magnitude `limit` asks. Returns how many, and the cosine past which no star shows.
 */
export function deepStarBlocks(
    stars: DeepStars,
    params: StarsParams,
    height: number,
    limit: number,
    blocks: Uint32Array,
): { count: number; axis: Vec3; cosCone: number } {
    const view = viewCone(params, height);
    // Room for the air's lift near the horizon, and for a star's image past the target's edge.
    const margin = params.air ? 0.035 : 0.01;
    const cone = view.angle + margin;
    const lowest = Math.asin(Math.max(-1, Math.min(1, params.horizonZ)));
    const horizon = params.air ? Math.min(lowest, (params.air.horizon * Math.PI) / 180) - margin : lowest;
    const step = Math.floor((limit + 2) * 4);
    const [r, cones, [ax, ay, az]] = [params.skyRotation, stars.cellCones, view.axis];
    const at = (array: ArrayLike<number>, i: number) => array[i] ?? 0;
    let count = 0;
    for (let cell = 0; step >= 0 && cell < stars.cellBlocks.length - 1; cell++) {
        const first = at(stars.cellBlocks, cell);
        const drawn =
            step >= DEEP_STEPS
                ? at(stars.cellBlocks, cell + 1) - first
                : at(stars.cellDepths, cell * DEEP_STEPS + step);
        if (drawn === 0) continue;
        const x = at(cones, cell * 4);
        const y = at(cones, cell * 4 + 1);
        const z = at(cones, cell * 4 + 2);
        const radius = at(cones, cell * 4 + 3);
        const east = at(r, 0) * x + at(r, 3) * y + at(r, 6) * z;
        const north = at(r, 1) * x + at(r, 4) * y + at(r, 7) * z;
        const up = at(r, 2) * x + at(r, 5) * y + at(r, 8) * z;
        const off = Math.acos(Math.max(-1, Math.min(1, east * ax + north * ay + up * az)));
        if (off > cone + radius || Math.asin(Math.max(-1, Math.min(1, up))) + radius < horizon) continue;
        for (let block = 0; block < drawn; block++) blocks[count++] = first + block;
    }
    return { count, axis: view.axis, cosCone: cone >= Math.PI ? -2 : Math.cos(cone) };
}

/** Packs `params` as ShParams, for a consumer's own pipeline as much as for the pass. */
export function paramsData(params: StarsParams, frame: Frame): ArrayBuffer {
    const data = new ArrayBuffer(PARAMS_SIZE);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    f.set(params.inverseViewProjection, 0);
    for (let col = 0; col < 3; col++) f.set(params.skyRotation.subarray(col * 3, col * 3 + 3), 16 + col * 4);
    f[28] = 1 / (1.2 * 2 ** params.ev100);
    f[29] = params.horizonZ;
    f[30] = params.years;
    f[31] = params.psfPixels;
    const { air, seeing } = params;
    const twinkle = air !== null && seeing !== null && params.scintillation > 0;
    u[32] = frame.indexBits ?? 17;
    f[33] = params.time;
    f[35] = params.glare;
    f[36] = params.starLight * 2 ** params.starCompensation;
    f[37] = params.milkyWay * 2 ** params.milkyWayCompensation;
    f[38] = params.magnitudeLimit;
    f[39] = params.projectionDistance;
    u[40] =
        (air ? 1 : 0) |
        (frame.milkyWay !== null ? 2 : 0) |
        (frame.stars ? 4 : 0) |
        (frame.deepStars ? 8 : 0) |
        (twinkle ? 16 : 0);
    u[41] = frame.tileSize;
    u[42] = Math.ceil(frame.width / frame.tileSize);
    u[43] = frame.capacity;
    f[44] = params.threshold;
    f[45] = params.maxRadius;
    u[48] = frame.width;
    u[49] = frame.height;
    f[50] = frame.milkyWay ?? 0;
    f[51] = params.viewerFov / frame.height;
    f[52] = 1 / (1.2 * 2 ** (params.displayEV100 ?? params.ev100));
    f[53] = params.knee;
    f[54] = params.halo;
    const width = haloPixels(params, frame.height);
    const levels = haloLevels(width, haloGrid(frame.width, frame.height).levels);
    u[55] = levels;
    const mask = constellationMask(params.constellations);
    const lines = frame.lines === true && mask.some((bits) => bits !== 0);
    f.set(params.constellationColor, 56);
    f[59] = lines ? params.constellationOpacity : 0;
    f[60] = params.constellationWidth;
    f[61] = params.constellationGap;
    u[62] = frame.faintDrawn ?? Math.max(0, Math.min(Math.floor(params.faintStars), frame.faintStars ?? 0));
    f[46] = frame.faintLimit ?? 99;
    f[63] = frame.milkyWayStops ?? 0;
    u.set(mask, 64);
    const { occluder } = params;
    f.set(
        occluder
            ? [...Array.from(occluder.direction), Math.cos((occluder.angularDiameter * Math.PI) / 360)]
            : [0, 0, 1, 2],
        68,
    );
    if (twinkle) {
        f.set(seeing.subarray(0, 8), 72);
        f[73] = (seeing[1] ?? 0) * params.scintillation ** 2;
    }
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = params.whiteBalance;
    f.set([m0, m1, m2, 0, m3, m4, m5, 0, m6, m7, m8], 80);
    f.set(haloWeights(width, levels), 92);
    return data;
}

/** The passes a frame may run, in their order, as `inspect` names their times. */
const PASS_NAMES = ["lines", "bin", "deep", "halo", "compose"] as const;
const LUMINANCE = [0.2126, 0.7152, 0.0722] as const;

/** A half float's bits as a number. */
function fromHalf(bits: number): number {
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    const sign = bits & 0x8000 ? -1 : 1;
    if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
    if (exponent === 31) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

export async function createStarsPass(device: GPUDevice, options: StarsPassOptions): Promise<StarsPass> {
    const {
        format,
        milkyWay = null,
        constellations = null,
        faintStars = null,
        toneMap = "neutral",
        headroom = 1,
        background = true,
        darkAdapted = false,
        tileSize = 16,
        capacity = 64,
        debug = false,
    } = options;
    let catalog = options.catalog ?? null;
    const dither = options.dither ?? false;
    // Bound whatever `dither` says: the binding stays in the layout.
    const blueNoise = options.blueNoise ?? blueNoiseTexture(device);
    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`sternenheer: the pass writes ${format} as a storage texture, which this device cannot`);
    }
    // With `debug`, what the passes leave between them can be copied out.
    const readable = debug ? GPUBufferUsage.COPY_SRC : 0;
    const shared = [wgsl.air, wgsl.seeing, wgsl.params, wgsl.camera, wgsl.glare];
    const binModule = device.createShaderModule({
        label: "sternenheer:bin",
        code: [...shared, wgsl.bin, wgsl.stars].join("\n"),
    });
    const composeModule = device.createShaderModule({
        label: "sternenheer:compose",
        code: [
            wgsl.starsOutput(format),
            ...shared,
            wgsl.whitebalance,
            wgsl.tonemap,
            wgsl.vision,
            wgsl.compose,
            wgsl.stars,
        ].join("\n"),
    });
    const linesModule = device.createShaderModule({
        label: "sternenheer:lines",
        code: [...shared, wgsl.lines, wgsl.stars].join("\n"),
    });
    const haloModule = device.createShaderModule({
        label: "sternenheer:halo",
        code: [wgsl.air, wgsl.seeing, wgsl.params, wgsl.halo].join("\n"),
    });
    const pipeline = (module: GPUShaderModule, entryPoint: string, label = entryPoint) =>
        device.createComputePipelineAsync({
            label: `sternenheer:${label}`,
            layout: "auto",
            compute: { module, entryPoint, ...(module === haloModule ? {} : { constants: layouts }) },
        });
    const deepStars = catalog ? (options.deepStars ?? null) : null;
    if (deepStars && deepStars.blockSize !== 64) throw new Error("sternenheer: deep stars come in blocks of 64");
    // Each catalog's layout, decoded by the branch its constant picks, the other folded away.
    const compactCatalog = catalog?.compact ?? true;
    const compactFaint = faintStars !== null && isCompact(faintStars);
    const layouts = {
        SH_COMPACT_CATALOG: compactCatalog ? 1 : 0,
        SH_COMPACT_FAINT: compactFaint ? 1 : 0,
        SH_COMPACT_DEEP: deepStars?.compact !== false ? 1 : 0,
    };
    const [
        binPipeline,
        preparePipeline,
        placePipeline,
        deepPipeline,
        linesPipeline,
        haloDown,
        haloUp,
        composePipeline,
    ] = await Promise.all([
        pipeline(binModule, "shBin"),
        pipeline(binModule, "shTilePrepare"),
        pipeline(binModule, "shTilePlace"),
        deepStars ? pipeline(binModule, "shDeepSplat", "deep") : null,
        pipeline(linesModule, "shLinePieces", "lines"),
        pipeline(haloModule, "shHaloDown"),
        pipeline(haloModule, "shHaloUp"),
        device.createComputePipelineAsync({
            label: "sternenheer:compose",
            layout: "auto",
            compute: {
                module: composeModule,
                entryPoint: "shCompose",
                constants: {
                    SH_TONE_MAP: toneMap === false ? 0 : (TONE_CURVES[toneMap] ?? 1),
                    SH_HEADROOM: headroom,
                    SH_DITHER: dither ? 1 : 0,
                    SH_BACKGROUND: background ? 1 : 0,
                    SH_DARK_ADAPTED: darkAdapted ? 1 : 0,
                },
            },
        }),
    ]);
    const uniform = device.createBuffer({
        label: "sternenheer:params",
        size: PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Of compact faint stars every place of their blocks, the empty ones too.
    const faintCount = !catalog || !faintStars ? 0 : isCompact(faintStars) ? faintStars.blocks * 64 : faintStars.count;
    const faintBuffer = device.createBuffer({
        label: "sternenheer:faintStars",
        size: Math.max(faintStars && faintCount > 0 ? faintStars.data.byteLength : 0, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (faintStars && faintCount > 0) device.queue.writeBuffer(faintBuffer, 0, faintStars.data);
    const faintColors = device.createBuffer({
        label: "sternenheer:faintColors",
        size: 512 * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(faintColors, 0, packedStarColors());
    // The deep stars, the blocks of them a frame draws, and what else their pass takes.
    const deep = deepStars
        ? {
              stars: device.createBuffer({
                  label: "sternenheer:deepStars",
                  size: deepStars.data.byteLength,
                  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
              }),
              blocks: device.createBuffer({
                  label: "sternenheer:deepBlocks",
                  size: Math.max(deepStars.blocks, 1) * 4,
                  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
              }),
              params: device.createBuffer({
                  label: "sternenheer:deepParams",
                  size: DEEP_PARAMS_SIZE,
                  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
              }),
              list: new Uint32Array(Math.max(deepStars.blocks, 1)),
          }
        : null;
    if (deep && deepStars) device.queue.writeBuffer(deep.stars, 0, deepStars.data);
    // Bound where there are no deep stars, and as the halos' grid where there are no halos: the passes name them
    // whatever the flags say.
    const noSums = device.createBuffer({ label: "sternenheer:noDeepSums", size: 16, usage: GPUBufferUsage.STORAGE });
    let sums: { buffer: GPUBuffer; width: number; height: number } | null = null;
    function sumsFor(width: number, height: number) {
        if (sums && sums.width === width && sums.height === height) return sums.buffer;
        sums?.buffer.destroy();
        sums = {
            width,
            height,
            buffer: device.createBuffer({
                label: "sternenheer:deepSums",
                size: width * height * 12,
                usage: GPUBufferUsage.STORAGE,
            }),
        };
        return sums.buffer;
    }
    /** The blocks of deep stars this frame draws, written for their pass; 0 where the exposure shows none of them. */
    function deepBlocks(height: number): number {
        if (!deep || !deepStars || params.starLight <= 0) return 0;
        const limit = Math.min(params.deepStars, params.magnitudeLimit);
        // Neither the brightest of them alone nor all of the richest cell together, four times over, reach a sixteenth
        // of the threshold: by day, say.
        const exposure =
            (params.starLight * 2 ** params.starCompensation) / (1.2 * 2 ** (params.displayEV100 ?? params.ev100));
        const sigma = Math.max(params.psfPixels, 0.6);
        const peak = viewCone(params, height).pixelsPerRadian ** 2 / (2 * Math.PI * sigma * sigma);
        const shows =
            Math.max(illuminanceFromMagnitude(deepStars.brightest) * peak, 4 * deepStars.luminance) * exposure;
        if (shows < params.threshold / 16) return 0;
        const { count, axis, cosCone } = deepStarBlocks(deepStars, params, height, limit, deep.list);
        if (count === 0) return 0;
        device.queue.writeBuffer(deep.blocks, 0, deep.list, 0, count);
        device.queue.writeBuffer(deep.params, 0, new Float32Array([...axis, cosCone, limit, 0, 0, 0]));
        return count;
    }
    // The catalog and one splat per star, one star at least, so the buffers exist whatever the catalog; the faint stars
    // follow the catalog's.
    let catalogBuffer: GPUBuffer | null = null;
    let splats: GPUBuffer | null = null;
    let count = 0;
    let indexBits = 1;
    function takeCatalog(next: StarCatalog | null) {
        if (next && next.compact !== compactCatalog)
            throw new Error(`sternenheer: the pass was made for a ${compactCatalog ? "compact" : "full"} catalog`);
        catalog = next;
        const words = compactCatalog ? COMPACT_STAR_WORDS : STAR_FIELDS;
        const size = Math.max(next?.count ?? 0, 1) * words * 4;
        if (catalogBuffer?.size !== size) {
            catalogBuffer?.destroy();
            catalogBuffer = device.createBuffer({
                label: "sternenheer:catalog",
                size,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
        }
        if (next) device.queue.writeBuffer(catalogBuffer, 0, next.data, 0, next.count * words);
        count = Math.max(next?.count ?? 0, 1) + faintCount;
        indexBits = tileIndexBits(count);
        if (splats?.size !== count * SPLAT_SIZE) {
            splats?.destroy();
            splats = device.createBuffer({
                label: "sternenheer:splats",
                size: count * SPLAT_SIZE,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            });
        }
    }
    takeCatalog(catalog);
    // Compact faint stars lie by cell, not brightest first: the first so many are those up to a magnitude, all places
    // of the blocks run, the empty ones and the fainter ones skipped. The stars per magnitude code, counted up.
    const faintCodes = new Uint32Array(256);
    if (faintStars && compactFaint)
        for (let slot = 0; slot < faintCount; slot++) {
            const magnitude = packedStarAt(faintStars, slot).magnitude;
            const code = Math.round((magnitude + 2) / 0.0625);
            if (Number.isFinite(magnitude)) faintCodes[code] = (faintCodes[code] ?? 0) + 1;
        }
    function faintFor(wanted: number): { faintDrawn: number; faintLimit: number } {
        const all = Math.max(0, Math.min(Math.floor(wanted), faintCount));
        if (!compactFaint || !faintStars || all === 0) return { faintDrawn: all, faintLimit: 99 };
        if (wanted >= faintStars.count) return { faintDrawn: faintCount, faintLimit: 99 };
        let code = 0;
        for (let sum = faintCodes[0] ?? 0; sum < wanted && code < 255; sum += faintCodes[++code] ?? 0);
        return { faintDrawn: faintCount, faintLimit: code * 0.0625 - 2 + 0.03 };
    }
    // A line at least, as the stars: the compose pass binds the pieces whether or not there are lines.
    const lineCount = Math.max(constellations?.count ?? 0, 1);
    const lineBuffer = device.createBuffer({
        label: "sternenheer:lines",
        size: lineCount * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (constellations) device.queue.writeBuffer(lineBuffer, 0, constellations.data);
    const pieces = device.createBuffer({
        label: "sternenheer:linePieces",
        size: lineCount * LINE_PIECES * PIECE_SIZE,
        usage: GPUBufferUsage.STORAGE,
    });
    // Bound where there is no map, or no background, or no halos: the bindings stay in the layout whatever the flags
    // say.
    const blank = device.createTexture({
        label: "sternenheer:blank",
        size: [1, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const noAir = device.createTexture({
        label: "sternenheer:noAir",
        size: [1, 1],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const noBackground = device.createTexture({
        label: "sternenheer:noBackground",
        size: [1, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const sampler = milkyWay?.sampler ?? device.createSampler({ magFilter: "linear", minFilter: "linear" });
    type Tiles = {
        counts: GPUBuffer;
        placed: GPUBuffer;
        entries: GPUBuffer;
        lineCounts: GPUBuffer;
        lineEntries: GPUBuffer;
        tiles: number;
        width: number;
        height: number;
    };
    let tiles: Tiles | null = null;
    // The halos' grid: the finest level summed by the bin pass, the coarser ones halved from it, and each level added up
    // with those above it, the finest of those what compose reads; and which level each dispatch writes, a uniform's
    // alignment apart. Made when a frame first draws halos, freed when one draws none.
    type Halos = {
        key: string;
        sums: GPUBuffer;
        down: GPUTexture[];
        up: GPUTexture[];
        steps: GPUBuffer;
        levels: number;
    };
    let halos: Halos | null = null;
    const haloSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const STEP = 256;

    function freeHalos() {
        halos?.sums.destroy();
        for (const texture of [...(halos?.down.slice(1) ?? []), ...(halos?.up ?? [])]) texture.destroy();
        halos?.steps.destroy();
        halos = null;
    }
    function halosFor(width: number, height: number): Halos {
        const key = `${width} ${height}`;
        if (halos?.key === key) return halos;
        freeHalos();
        const grid = haloGrid(width, height);
        const size = (level: number) => [Math.ceil(grid.width / 2 ** level), Math.ceil(grid.height / 2 ** level)];
        const usage =
            GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | (debug ? GPUTextureUsage.COPY_SRC : 0);
        const level = (label: string, at: number) =>
            device.createTexture({ label, size: size(at), format: "rgba16float", usage });
        const levels = Array.from({ length: grid.levels }, (_, at) => at);
        const steps = device.createBuffer({
            label: "sternenheer:haloSteps",
            size: STEP * grid.levels,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const numbers = new Uint32Array((STEP / 4) * grid.levels);
        for (const at of levels) numbers[(STEP / 4) * at] = at;
        device.queue.writeBuffer(steps, 0, numbers);
        halos = {
            key,
            levels: grid.levels,
            sums: device.createBuffer({
                label: "sternenheer:haloSums",
                size: grid.width * grid.height * 12,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | readable,
            }),
            // The first level is the sums themselves: no texture of its own to halve from.
            down: levels.map((at) => (at === 0 ? noBackground : level("sternenheer:haloDown", at))),
            up: levels.map((at) => level("sternenheer:haloUp", at)),
            steps,
        };
        return halos;
    }

    /** The halos' grid halved level by level, as far as `levels`, then added back up, each level its share. */
    function encodeHalos(pass: GPUComputePassEncoder, h: Halos, levels: number) {
        const run = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[], target: GPUTexture, at: number) => {
            pass.setPipeline(pipeline);
            const step = { binding: 6, resource: { buffer: h.steps, offset: STEP * at, size: 16 } };
            const layout = pipeline.getBindGroupLayout(0);
            pass.setBindGroup(0, device.createBindGroup({ layout, entries: [...entries, step] }));
            pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
        };
        const common = [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: { buffer: h.sums } },
        ];
        for (let at = 1; at < levels; at++) {
            const target = h.down[at] as GPUTexture;
            run(
                haloDown,
                [
                    ...common,
                    { binding: 2, resource: target.createView() },
                    { binding: 3, resource: (h.down[at - 1] ?? noBackground).createView() },
                ],
                target,
                at,
            );
        }
        for (let at = levels - 1; at >= 0; at--) {
            const target = h.up[at] as GPUTexture;
            run(
                haloUp,
                [
                    ...common,
                    { binding: 2, resource: target.createView() },
                    { binding: 3, resource: (h.down[at] ?? noBackground).createView() },
                    { binding: 4, resource: (h.up[at + 1] ?? noBackground).createView() },
                    { binding: 5, resource: haloSampler },
                ],
                target,
                at,
            );
        }
    }
    const params: StarsParams = { ...DEFAULTS };

    function tilesFor(width: number, height: number) {
        if (tiles && tiles.width === width && tiles.height === height) return tiles;
        tiles?.counts.destroy();
        tiles?.placed.destroy();
        tiles?.entries.destroy();
        tiles?.lineCounts.destroy();
        tiles?.lineEntries.destroy();
        const n = Math.ceil(width / tileSize) * Math.ceil(height / tileSize);
        const counter = (label: string, read = 0) =>
            device.createBuffer({ label, size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | read });
        tiles = {
            width,
            height,
            tiles: n,
            counts: counter("sternenheer:tileCounts", readable),
            placed: counter("sternenheer:tilePlaced"),
            entries: device.createBuffer({
                label: "sternenheer:tileEntries",
                size: n * capacity * 4,
                usage: GPUBufferUsage.STORAGE,
            }),
            lineCounts: counter("sternenheer:lineCounts", readable),
            lineEntries: device.createBuffer({
                label: "sternenheer:lineEntries",
                size: n * LINE_CAPACITY * 4,
                usage: GPUBufferUsage.STORAGE,
            }),
        };
        return tiles;
    }

    // With `debug` and the device's clock: two timestamps per pass, resolved after the last.
    const clock =
        debug && device.features.has("timestamp-query")
            ? {
                  queries: device.createQuerySet({ type: "timestamp", count: PASS_NAMES.length * 2 }),
                  resolved: device.createBuffer({
                      label: "sternenheer:timestamps",
                      size: PASS_NAMES.length * 16,
                      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
                  }),
              }
            : null;
    // What the last frame drew, for `inspect`.
    let last: { width: number; height: number; ran: Set<string>; halos: Halos | null; levels: number } | null = null;

    function begin(encoder: GPUCommandEncoder, name: (typeof PASS_NAMES)[number], ran: Set<string>) {
        ran.add(name);
        const at = PASS_NAMES.indexOf(name) * 2;
        return encoder.beginComputePass({
            label: `sternenheer:${name}`,
            ...(clock
                ? {
                      timestampWrites: {
                          querySet: clock.queries,
                          beginningOfPassWriteIndex: at,
                          endOfPassWriteIndex: at + 1,
                      },
                  }
                : {}),
        });
    }

    async function read(copies: (encoder: GPUCommandEncoder, buffer: GPUBuffer) => void, size: number) {
        const buffer = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder({ label: "sternenheer:read" });
        copies(encoder, buffer);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const bytes = buffer.getMappedRange().slice(0);
        buffer.unmap();
        buffer.destroy();
        return bytes;
    }

    return {
        update(patch) {
            Object.assign(params, patch);
        },
        setCatalog(next) {
            takeCatalog(next);
        },
        async readStars(first = 0, length = 1) {
            const from = Math.max(0, Math.min(first, count));
            const n = Math.max(0, Math.min(length, count - from));
            if (n === 0 || !splats) return [];
            const source = splats;
            const bytes = await read(
                (encoder, buffer) => encoder.copyBufferToBuffer(source, from * SPLAT_SIZE, buffer, 0, n * SPLAT_SIZE),
                n * SPLAT_SIZE,
            );
            const f = new Float32Array(bytes);
            return Array.from({ length: n }, (_, i) => {
                const at = (i * SPLAT_SIZE) / 4;
                const whole = f[at + 8] ?? 0;
                const core = LUMINANCE.reduce((sum, y, c) => sum + y * (f[at + 4 + c] ?? 0), 0) * (f[at + 9] ?? 0);
                const drawn = (f[at + 3] ?? 0) > 0 && whole > 0;
                return {
                    drawn,
                    pixel: [f[at] ?? 0, f[at + 1] ?? 0] as [number, number],
                    light: drawn ? whole : 0,
                    core: drawn ? core / whole : 0,
                    halo: drawn ? (f[at + 11] ?? 0) / whole : 0,
                };
            });
        },
        async timings() {
            if (!clock || !last) return null;
            const { resolved } = clock;
            const ran = last.ran;
            const bytes = await read(
                (encoder, buffer) => encoder.copyBufferToBuffer(resolved, 0, buffer, 0, resolved.size),
                resolved.size,
            );
            const ns = new BigInt64Array(bytes);
            const milliseconds: Record<string, number> = {};
            for (const [i, name] of PASS_NAMES.entries())
                if (ran.has(name)) milliseconds[name] = Number((ns[i * 2 + 1] ?? 0n) - (ns[i * 2] ?? 0n)) / 1e6;
            return milliseconds;
        },
        async inspect() {
            if (!debug) throw new Error("sternenheer: inspect needs a pass made with debug");
            if (!last || !tiles || !splats) throw new Error("sternenheer: no frame drawn to inspect");
            const t = tiles;
            const frame = last;
            const h = frame.halos;
            const starBytes = count * SPLAT_SIZE;
            // What each piece takes of the read-back buffer: textures by rows of 256 bytes.
            const rowBytes = (texture: GPUTexture) => Math.ceil((texture.width * 8) / 256) * 256;
            const used = frame.levels;
            const textures = h ? [...h.down.slice(1, used), ...h.up.slice(0, used)] : [];
            const parts = [t.tiles * 4, t.tiles * 4, starBytes, h ? h.sums.size : 0, clock ? clock.resolved.size : 0];
            const offsets = parts.map((_, i) => parts.slice(0, i).reduce((sum, n) => sum + n, 0));
            let size = parts.reduce((sum, n) => sum + n, 0);
            const textureOffsets = textures.map((texture) => {
                const at = size;
                size += rowBytes(texture) * texture.height;
                return at;
            });
            const source = splats;
            const bytes = await read((encoder, buffer) => {
                encoder.copyBufferToBuffer(t.counts, 0, buffer, offsets[0] ?? 0, t.tiles * 4);
                encoder.copyBufferToBuffer(t.lineCounts, 0, buffer, offsets[1] ?? 0, t.tiles * 4);
                encoder.copyBufferToBuffer(source, 0, buffer, offsets[2] ?? 0, starBytes);
                if (h) encoder.copyBufferToBuffer(h.sums, 0, buffer, offsets[3] ?? 0, h.sums.size);
                if (clock) encoder.copyBufferToBuffer(clock.resolved, 0, buffer, offsets[4] ?? 0, clock.resolved.size);
                for (const [i, texture] of textures.entries()) {
                    const layout = { buffer, offset: textureOffsets[i] ?? 0, bytesPerRow: rowBytes(texture) };
                    encoder.copyTextureToBuffer({ texture }, layout, [texture.width, texture.height]);
                }
            }, size);
            const splat = new Float32Array(bytes, offsets[2], starBytes / 4);
            let [drawn, halosDrawn] = [0, 0];
            for (let i = 0; i < count; i++) {
                if ((splat[i * 12 + 3] ?? 0) <= 0) continue;
                drawn++;
                if ((splat[i * 12 + 11] ?? 0) > 0) halosDrawn++;
            }
            const rgba = (texture: GPUTexture, at: number) => {
                const halves = new Uint16Array(bytes, at, (rowBytes(texture) * texture.height) / 2);
                const out = new Float32Array(texture.width * texture.height * 4);
                for (let y = 0; y < texture.height; y++)
                    for (let x = 0; x < texture.width * 4; x++)
                        out[y * texture.width * 4 + x] = fromHalf(halves[(y * rowBytes(texture)) / 2 + x] ?? 0);
                return out;
            };
            let halo: StarsInspection["halo"] = null;
            if (h) {
                const finest = new Float32Array(bytes, offsets[3], h.sums.size / 4);
                const first = h.up[0] as GPUTexture;
                const own = new Float32Array(first.width * first.height * 4);
                for (let i = 0; i < first.width * first.height; i++) {
                    own.set(finest.subarray(i * 3, i * 3 + 3), i * 4);
                    own[i * 4 + 3] = 1;
                }
                const downs = used - 1;
                halo = {
                    margin: HALO_MARGIN,
                    scale: HALO_SCALE,
                    weights: Array.from(haloWeights(haloPixels(params, frame.height), used)),
                    levels: h.up.slice(0, used).map((texture, level) => ({
                        width: texture.width,
                        height: texture.height,
                        own: level === 0 ? own : rgba(h.down[level] as GPUTexture, textureOffsets[level - 1] ?? 0),
                        sum: rgba(texture, textureOffsets[downs + level] ?? 0),
                    })),
                };
            }
            let milliseconds: Record<string, number> | null = null;
            if (clock) {
                const ns = new BigInt64Array(bytes, offsets[4], PASS_NAMES.length * 2);
                milliseconds = {};
                for (const [i, name] of PASS_NAMES.entries())
                    if (frame.ran.has(name))
                        milliseconds[name] = Number((ns[i * 2 + 1] ?? 0n) - (ns[i * 2] ?? 0n)) / 1e6;
            }
            return {
                width: frame.width,
                height: frame.height,
                tiles: {
                    size: tileSize,
                    columns: Math.ceil(frame.width / tileSize),
                    rows: Math.ceil(frame.height / tileSize),
                    capacity,
                    stars: new Uint32Array(bytes.slice(offsets[0] ?? 0, (offsets[0] ?? 0) + t.tiles * 4)),
                    lines: new Uint32Array(bytes.slice(offsets[1] ?? 0, (offsets[1] ?? 0) + t.tiles * 4)),
                    lineCapacity: LINE_CAPACITY,
                },
                stars: { count: catalog ? count : 0, drawn, halos: halosDrawn },
                halo,
                milliseconds,
            };
        },
        encode(encoder, target, encodeOptions = {}) {
            const { width, height } = target;
            const t = tilesFor(width, height);
            const ran = new Set<string>();
            const { faintDrawn, faintLimit } = faintFor(params.faintStars);
            const deepDrawn = deepBlocks(height);
            device.queue.writeBuffer(
                uniform,
                0,
                paramsData(params, {
                    width,
                    height,
                    tileSize,
                    capacity,
                    stars: catalog !== null,
                    milkyWay: milkyWay?.luminance ?? null,
                    milkyWayStops: milkyWay?.stops ?? 0,
                    lines: catalog !== null && constellations !== null,
                    faintStars: faintCount,
                    faintDrawn,
                    faintLimit,
                    deepStars: deepDrawn > 0,
                    indexBits,
                }),
            );
            const air = { binding: 15, resource: (params.air?.texture ?? noAir).createView() };
            const stars = catalogBuffer as GPUBuffer;
            const splatBuffer = splats as GPUBuffer;
            const drawsLines =
                catalog !== null &&
                constellations !== null &&
                params.constellationOpacity > 0 &&
                (params.constellations === null || params.constellations.length > 0);
            encoder.clearBuffer(t.lineCounts);
            if (drawsLines) {
                const bind = device.createBindGroup({
                    layout: linesPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: uniform } },
                        { binding: 1, resource: { buffer: stars } },
                        { binding: 2, resource: { buffer: lineBuffer } },
                        { binding: 3, resource: { buffer: pieces } },
                        { binding: 4, resource: { buffer: t.lineCounts } },
                        { binding: 5, resource: { buffer: t.lineEntries } },
                        { binding: 6, resource: { buffer: faintBuffer } },
                        air,
                    ],
                });
                const pass = begin(encoder, "lines", ran);
                pass.setPipeline(linesPipeline);
                pass.setBindGroup(0, bind);
                pass.dispatchWorkgroups(Math.ceil((constellations.count * LINE_PIECES) / 64));
                pass.end();
            }
            encoder.clearBuffer(t.counts);
            encoder.clearBuffer(t.placed);
            // The halos only where a frame draws them: none, and nothing of theirs is made or run.
            const h = catalog && params.halo > 0 && params.starLight > 0 ? halosFor(width, height) : null;
            if (!h) freeHalos();
            if (h) encoder.clearBuffer(h.sums);
            const haloSums = h ? h.sums : noSums;
            if (catalog) {
                const buffers: Record<number, GPUBindingResource> = {
                    0: { buffer: uniform },
                    1: { buffer: stars },
                    2: { buffer: splatBuffer },
                    3: { buffer: t.counts },
                    4: { buffer: t.entries },
                    5: { buffer: haloSums },
                    6: { buffer: faintBuffer },
                    7: { buffer: faintColors },
                    12: { buffer: t.placed },
                    15: air.resource,
                };
                const entries = (...bindings: number[]) =>
                    bindings.map((binding) => ({ binding, resource: buffers[binding] as GPUBindingResource }));
                // The tile of each star counted first, so a full one is known before any star is placed into it.
                const steps: [GPUComputePipeline, GPUBindGroupEntry[], number][] = [
                    [binPipeline, entries(0, 1, 2, 3, 5, 6, 7, 15), catalog.count + faintDrawn],
                    [preparePipeline, entries(0, 3, 4), t.tiles],
                    [placePipeline, entries(0, 1, 2, 3, 4, 12), catalog.count + faintDrawn],
                ];
                const pass = begin(encoder, "bin", ran);
                for (const [pipeline, bound, threads] of steps) {
                    pass.setPipeline(pipeline);
                    const layout = pipeline.getBindGroupLayout(0);
                    pass.setBindGroup(0, device.createBindGroup({ layout, entries: bound }));
                    pass.dispatchWorkgroups(Math.ceil(threads / 64));
                }
                pass.end();
            }
            if (deep && deepPipeline && deepDrawn > 0) {
                // The compose pass empties the sums as it reads them: nothing to clear.
                const deepSums = sumsFor(width, height);
                const bind = device.createBindGroup({
                    layout: deepPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: uniform } },
                        { binding: 5, resource: { buffer: haloSums } },
                        { binding: 7, resource: { buffer: faintColors } },
                        { binding: 8, resource: { buffer: deep.params } },
                        { binding: 9, resource: { buffer: deep.stars } },
                        { binding: 10, resource: { buffer: deep.blocks } },
                        { binding: 11, resource: { buffer: deepSums } },
                        air,
                    ],
                });
                const pass = begin(encoder, "deep", ran);
                pass.setPipeline(deepPipeline);
                pass.setBindGroup(0, bind);
                pass.dispatchWorkgroups(deepDrawn);
                pass.end();
            }
            const levels = haloLevels(haloPixels(params, height), haloGrid(width, height).levels);
            if (h) {
                const pass = begin(encoder, "halo", ran);
                encodeHalos(pass, h, levels);
                pass.end();
            }
            // The compose pass reads no catalog, so its layout, derived from the shader, has no binding for it.
            const bind = device.createBindGroup({
                layout: composePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniform } },
                    { binding: 2, resource: { buffer: splatBuffer } },
                    { binding: 3, resource: { buffer: t.counts } },
                    { binding: 4, resource: { buffer: t.entries } },
                    { binding: 5, resource: (milkyWay?.texture ?? blank).createView() },
                    { binding: 6, resource: sampler },
                    { binding: 7, resource: (encodeOptions.background ?? noBackground).createView() },
                    { binding: 8, resource: (h ? (h.up[0] as GPUTexture) : noBackground).createView() },
                    { binding: 9, resource: { buffer: pieces } },
                    { binding: 10, resource: { buffer: t.lineCounts } },
                    { binding: 11, resource: { buffer: t.lineEntries } },
                    { binding: 14, resource: { buffer: deepDrawn > 0 && sums ? sums.buffer : noSums } },
                    air,
                    { binding: 16, resource: blueNoise.createView() },
                ],
            });
            const output = device.createBindGroup({
                layout: composePipeline.getBindGroupLayout(1),
                entries: [{ binding: 0, resource: target.createView() }],
            });
            const pass = encodeOptions.timestampWrites
                ? encoder.beginComputePass({
                      label: "sternenheer:compose",
                      timestampWrites: encodeOptions.timestampWrites,
                  })
                : begin(encoder, "compose", ran);
            pass.setPipeline(composePipeline);
            pass.setBindGroup(0, bind);
            pass.setBindGroup(1, output);
            pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            pass.end();
            if (clock) encoder.resolveQuerySet(clock.queries, 0, PASS_NAMES.length * 2, clock.resolved, 0);
            if (debug) last = { width, height, ran, halos: h, levels };
        },
        destroy() {
            uniform.destroy();
            catalogBuffer?.destroy();
            splats?.destroy();
            tiles?.counts.destroy();
            tiles?.placed.destroy();
            tiles?.entries.destroy();
            tiles?.lineCounts.destroy();
            tiles?.lineEntries.destroy();
            lineBuffer.destroy();
            faintBuffer.destroy();
            faintColors.destroy();
            deep?.stars.destroy();
            deep?.blocks.destroy();
            deep?.params.destroy();
            sums?.buffer.destroy();
            noSums.destroy();
            pieces.destroy();
            freeHalos();
            clock?.queries.destroy();
            clock?.resolved.destroy();
            blank.destroy();
            noAir.destroy();
            noBackground.destroy();
        },
    };
}
