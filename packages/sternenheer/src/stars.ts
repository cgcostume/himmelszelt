import type { ToneCurve } from "@himmelszelt/helldunkel";
import { AIR_SAMPLES, type AirTable, scintillationScales } from "./air.js";
import { type PackedStars, packedStarColors, STAR_FIELDS, type StarCatalog } from "./catalog.js";
import { type ConstellationLines, constellationMask } from "./constellations.js";
import type { MilkyWay } from "./milkyway.js";
import * as wgsl from "./wgsl/index.js";

export interface StarsPassOptions {
    /** Format of the target `encode` writes, with `STORAGE_BINDING` usage: rgba8unorm for a display, bgra8unorm with
     *  "bgra8unorm-storage", rgba16float or rgba32float for linear output, or an HDR canvas. */
    format: GPUTextureFormat;
    /** The stars to draw, `loadCatalog`; without, the Milky Way alone. */
    catalog?: StarCatalog | null;
    /** Faint stars to draw besides the catalog's, packed, `loadFaintStars`: the Hipparcos catalogue's, brightest
     *  first. Drawn with `catalog` only. */
    faintStars?: PackedStars | null;
    /** The constellations' lines, `loadConstellations`, between stars of `catalog`; without, none are drawn. */
    constellations?: ConstellationLines | null;
    /** The Milky Way, `loadMilkyWay`; without, the stars alone. */
    milkyWay?: MilkyWay | null;
    /** Tone map for a display, as dunstkreis' sky pass: "neutral" by default, "agx", "aces", "clip"; `false` writes the
     *  exposed luminance, linear, for a renderer that composes more over it, the Moon say. */
    toneMap?: ToneCurve | false;
    /** How many times SDR white an HDR display shows, 1 by default. */
    headroom?: number;
    /** Dither the tone mapped output against banding, false by default: for an 8-bit target over smooth gradients. */
    dither?: boolean;
    /** Whether `encode` composes over a background in cd/m², true by default. Without, it writes the stars' light
     *  alone, with alpha 0, for a renderer that adds it. */
    background?: boolean;
    /** The stars and the sky behind them as the eye sees them at night rather than a camera, by helldunkel's
     *  `hdDarkAdaptedEye`, on the composed light before the exposure. With a background only; off by default. */
    darkAdapted?: boolean;
    /** The tiles the stars are binned into, 16 pixels by default, and how many stars a tile holds, 64: beyond that
     *  the ones that come later in the catalog are dropped. */
    tileSize?: number;
    capacity?: number;
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
    /** The exposure in EV100 the image is finally shown at, for the cut-off, the knee and the halo, when a later pass
     *  exposes what this one writes linear; null by default, `ev100`. */
    displayEV100: number | null;
    /** The z below which a ray hits the ground; -1 by default, the whole sphere. */
    horizonZ: number;
    /** The air, `airTable`: bends every star and the Milky Way up near the horizon, dims and reddens them, and hides
     *  what lies below the horizon it finds. Null by default, no air. */
    air: AirTable | null;
    /** The width of a star's core on the target, in pixels: the standard deviation of its Gaussian point spread, 0.7
     *  by default. Never under 0.6, so no star falls between pixels. On the sky the core narrows as the view zooms in,
     *  and the star brightens, as it does in a telescope. */
    psfPixels: number;
    /** The exposed luminance, in units of display white, at which a star's core stops brightening, 1 by default: the
     *  core stays a point, and the light beyond goes into its halo. */
    knee: number;
    /** How much of the light beyond the knee goes into the halo, 1 by default, 0 for none. The halo falls as 1 / r²
     *  over the whole target and grows wider with a star's light: a pyramid of blurs, whatever the number of stars. */
    halo: number;
    /** How strongly the stars twinkle, 1 for what the eye sees, 0 for none; and the time in seconds the twinkling
     *  runs on, which a renderer advances per frame. */
    scintillation: number;
    time: number;
    /** The viewer's eye's veil around a bright star, CIE's glare equation by the angle on the viewer's own field of
     *  view, 1 for the eye's own, 0 for none, a camera. */
    glare: number;
    /** How many degrees of the viewer's field of view the target's height spans, for the veil: 30 by default, a
     *  screen at arm's length. */
    viewerFov: number;
    /** What the stars' light is multiplied by, and the Milky Way's, 1 for as measured. */
    starLight: number;
    milkyWay: number;
    /** Stars fainter than this magnitude are left out; 99 by default, all of them. */
    magnitudeLimit: number;
    /** How many of the faint stars are drawn, the brightest first; Infinity by default, all the pass got. */
    faintStars: number;
    /** For how strongly the stars twinkle, `scintillationScales`: Fried's parameter r0 in meters at 550 nm, the
     *  seeing, 0.1 for an arcsecond, and the seconds the eye or an exposure averages over, 0.1 for the eye at night. */
    r0: number;
    integration: number;
    /** The observer's height in meters, 0 by default: only the turbulence above it makes the stars twinkle, none of
     *  it from 30 km up. */
    heightM: number;
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

export interface EncodeOptions {
    /** The sky behind the stars, in cd/m², the target's size: a float texture with `TEXTURE_BINDING` usage. */
    background?: GPUTexture;
    /** Timestamps around the compose pass, for timing it. */
    timestampWrites?: GPUComputePassTimestampWrites;
}

/** A stars pass: two compute passes, one over the catalog binning every star's image into the tiles of the target it
 *  reaches, one over the pixels summing them and the Milky Way behind, over a background, into a target the caller
 *  owns. It creates no device, canvas or context of its own. */
export interface StarsPass {
    /** Takes the parameters over and writes the uniforms. */
    update(params: Partial<StarsParams>): void;
    /** Records the stars into `target`, which needs `STORAGE_BINDING` usage and the pass' format. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture, options?: EncodeOptions): void;
    destroy(): void;
}

const TONE_CURVES: Record<string, number> = { neutral: 1, agx: 2, aces: 3, clip: 4 };
/** Byte size of ShParams in params.wgsl: a mat4x4, a mat3x3 of three padded columns, ten vec4-sized rows, the air's
 *  bends in 32 vec4s and its transmittances in 128. */
export const PARAMS_SIZE = (16 + 12 + 40 + 128 + 512) * 4;
const PIECE_SIZE = 48;
const LINE_PIECES = 8;
const LINE_CAPACITY = 16;
const SPLAT_SIZE = 48;

const DEFAULTS: StarsParams = {
    skyRotation: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    years: 0,
    inverseViewProjection: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    projectionDistance: 0,
    ev100: -6,
    displayEV100: null,
    horizonZ: -1,
    air: null,
    psfPixels: 0.7,
    knee: 1,
    halo: 1,
    scintillation: 0,
    time: 0,
    glare: 0,
    viewerFov: 30,
    starLight: 1,
    milkyWay: 1,
    magnitudeLimit: 99,
    faintStars: Number.POSITIVE_INFINITY,
    r0: 0.1,
    integration: 0.1,
    heightM: 0,
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

/** The halos' grid for a target, as params.wgsl has it: half the target's size and a margin, and its pyramid's levels. */
export function haloGrid(width: number, height: number): { width: number; height: number; levels: number } {
    const size = (n: number) => Math.floor((n + 2 * HALO_MARGIN + HALO_SCALE - 1) / HALO_SCALE);
    const [w, h] = [size(width), size(height)];
    return { width: w, height: h, levels: Math.max(1, Math.min(12, Math.floor(Math.log2(Math.min(w, h))))) };
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
    const { air } = params;
    f[32] = air ? (air.horizon * Math.PI) / 180 : -Math.PI / 2;
    f[33] = params.time;
    f[34] = params.scintillation;
    f[35] = params.glare;
    f[36] = params.starLight;
    f[37] = params.milkyWay;
    f[38] = params.magnitudeLimit;
    f[39] = params.projectionDistance;
    u[40] = (air ? 1 : 0) | (frame.milkyWay !== null ? 2 : 0) | (frame.stars ? 4 : 0);
    u[41] = frame.tileSize;
    u[42] = Math.ceil(frame.width / frame.tileSize);
    u[43] = frame.capacity;
    f[44] = params.threshold;
    f[45] = params.maxRadius;
    const twinkle = scintillationScales(params.r0, params.integration, undefined, params.heightM);
    f[46] = twinkle.variance;
    f[47] = twinkle.steps;
    u[48] = frame.width;
    u[49] = frame.height;
    f[50] = frame.milkyWay ?? 0;
    f[51] = params.viewerFov / frame.height;
    f[52] = 1 / (1.2 * 2 ** (params.displayEV100 ?? params.ev100));
    f[53] = params.knee;
    f[54] = params.halo;
    f[55] = haloGrid(frame.width, frame.height).levels;
    const mask = constellationMask(params.constellations);
    const lines = frame.lines === true && mask.some((bits) => bits !== 0);
    f.set(params.constellationColor, 56);
    f[59] = lines ? params.constellationOpacity : 0;
    f[60] = params.constellationWidth;
    f[61] = params.constellationGap;
    u[62] = Math.max(0, Math.min(Math.floor(params.faintStars), frame.faintStars ?? 0));
    f[63] = frame.milkyWayStops ?? 0;
    u.set(mask, 64);
    if (air) {
        for (let i = 0; i < AIR_SAMPLES; i++) {
            f[68 + i] = ((air.bends[i] ?? 0) * Math.PI) / 180;
            f.set(air.transmittances.subarray(i * 3, i * 3 + 3), 196 + i * 4);
        }
    }
    return data;
}

export async function createStarsPass(device: GPUDevice, options: StarsPassOptions): Promise<StarsPass> {
    const {
        format,
        catalog = null,
        milkyWay = null,
        constellations = null,
        faintStars = null,
        toneMap = "neutral",
        headroom = 1,
        background = true,
        darkAdapted = false,
        tileSize = 16,
        capacity = 64,
    } = options;
    const dither = options.dither ?? false;
    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`sternenheer: the pass writes ${format} as a storage texture, which this device cannot`);
    }
    const shared = [wgsl.params, wgsl.camera, wgsl.glare, wgsl.stars];
    const binModule = device.createShaderModule({
        label: "sternenheer:bin",
        code: [wgsl.params, wgsl.camera, wgsl.glare, wgsl.bin, wgsl.stars].join("\n"),
    });
    const composeModule = device.createShaderModule({
        label: "sternenheer:compose",
        code: [
            wgsl.starsOutput(format),
            ...shared.slice(0, 3),
            wgsl.tonemap,
            wgsl.vision,
            wgsl.compose,
            wgsl.stars,
        ].join("\n"),
    });
    const linesModule = device.createShaderModule({
        label: "sternenheer:lines",
        code: [wgsl.params, wgsl.camera, wgsl.glare, wgsl.lines, wgsl.stars].join("\n"),
    });
    const haloModule = device.createShaderModule({ label: "sternenheer:halo", code: wgsl.halo });
    const pyramidModule = device.createShaderModule({
        label: "sternenheer:haloPyramid",
        code: [wgsl.bloomOutput("rgba16float"), wgsl.bloom].join("\n"),
    });
    const haloStep = (module: GPUShaderModule, entryPoint: string) =>
        device.createComputePipelineAsync({
            label: `sternenheer:${entryPoint}`,
            layout: "auto",
            compute: { module, entryPoint },
        });
    const [haloResolve, haloDown, haloUp] = await Promise.all([
        haloStep(haloModule, "shHaloResolve"),
        haloStep(pyramidModule, "hdBloomDownNext"),
        haloStep(pyramidModule, "hdBloomUp"),
    ]);
    // The chain's parameters: its tent a texel wide, the rest unused here.
    const pyramidParams = device.createBuffer({
        label: "sternenheer:haloPyramid",
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(pyramidParams, 0, new Float32Array([1, 1, 1, 1]));
    const pyramidSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const [binPipeline, linesPipeline, composePipeline] = await Promise.all([
        device.createComputePipelineAsync({
            label: "sternenheer:bin",
            layout: "auto",
            compute: { module: binModule, entryPoint: "shBin" },
        }),
        device.createComputePipelineAsync({
            label: "sternenheer:lines",
            layout: "auto",
            compute: { module: linesModule, entryPoint: "shLinePieces" },
        }),
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
    // One star at least, so the buffers exist whatever the catalog.
    const faintCount = catalog ? (faintStars?.count ?? 0) : 0;
    const count = Math.max(catalog?.count ?? 0, 1) + faintCount;
    const faintBuffer = device.createBuffer({
        label: "sternenheer:faintStars",
        size: Math.max(faintCount, 1) * 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (faintStars && faintCount > 0) device.queue.writeBuffer(faintBuffer, 0, faintStars.data);
    const faintColors = device.createBuffer({
        label: "sternenheer:faintColors",
        size: 256 * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(faintColors, 0, packedStarColors());
    const catalogBuffer = device.createBuffer({
        label: "sternenheer:catalog",
        size: Math.max(catalog?.count ?? 0, 1) * STAR_FIELDS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (catalog) device.queue.writeBuffer(catalogBuffer, 0, catalog.data);
    const splats = device.createBuffer({
        label: "sternenheer:splats",
        size: count * SPLAT_SIZE,
        usage: GPUBufferUsage.STORAGE,
    });
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
    // Bound where there is no map, or no background: the bindings stay in the layout whatever the flags say.
    const blank = device.createTexture({
        label: "sternenheer:blank",
        size: [1, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const noBackground = device.createTexture({
        label: "sternenheer:noBackground",
        size: [1, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const sampler = milkyWay?.sampler ?? device.createSampler({ magFilter: "linear", minFilter: "linear" });
    type Tiles = { counts: GPUBuffer; entries: GPUBuffer; lineCounts: GPUBuffer; lineEntries: GPUBuffer };
    let tiles: (Tiles & { width: number; height: number }) | null = null;
    type Halos = { sums: GPUBuffer; down: GPUTexture; up: GPUTexture; width: number; height: number; levels: number };
    let halos: (Halos & { for: string }) | null = null;

    function halosFor(width: number, height: number) {
        if (halos && halos.for === `${width} ${height}`) return halos;
        halos?.sums.destroy();
        halos?.down.destroy();
        halos?.up.destroy();
        const grid = haloGrid(width, height);
        const chain = (label: string) =>
            device.createTexture({
                label,
                size: [grid.width, grid.height],
                mipLevelCount: grid.levels,
                format: "rgba16float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            });
        halos = {
            ...grid,
            for: `${width} ${height}`,
            sums: device.createBuffer({
                label: "sternenheer:haloSums",
                size: grid.width * grid.height * 12,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            }),
            down: chain("sternenheer:haloDown"),
            up: chain("sternenheer:haloUp"),
        };
        return halos;
    }

    /** The halos' pyramid: the grid into its first level, halved level by level, then added back up. */
    function encodeHalos(encoder: GPUCommandEncoder, h: Halos) {
        const level = (texture: GPUTexture, mip: number) => texture.createView({ baseMipLevel: mip, mipLevelCount: 1 });
        const pass = encoder.beginComputePass({ label: "sternenheer:halo" });
        const run = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[], mip: number) => {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
            const size = (n: number) => Math.ceil(Math.max(1, n >> mip) / 8);
            pass.dispatchWorkgroups(size(h.width), size(h.height));
        };
        run(
            haloResolve,
            [
                { binding: 0, resource: { buffer: h.sums } },
                { binding: 1, resource: level(h.down, 0) },
            ],
            0,
        );
        for (let mip = 1; mip < h.levels; ++mip) {
            run(
                haloDown,
                [
                    { binding: 0, resource: level(h.down, mip - 1) },
                    { binding: 1, resource: pyramidSampler },
                    { binding: 2, resource: level(h.down, mip) },
                    { binding: 4, resource: { buffer: pyramidParams } },
                ],
                mip,
            );
        }
        let below = level(h.down, h.levels - 1);
        for (let mip = h.levels - 2; mip >= 0; --mip) {
            const next = level(h.up, mip);
            run(
                haloUp,
                [
                    { binding: 0, resource: below },
                    { binding: 1, resource: pyramidSampler },
                    { binding: 2, resource: next },
                    { binding: 3, resource: level(h.down, mip) },
                    { binding: 4, resource: { buffer: pyramidParams } },
                ],
                mip,
            );
            below = next;
        }
        pass.end();
        return below;
    }
    const params: StarsParams = { ...DEFAULTS };

    function tilesFor(width: number, height: number) {
        if (tiles && tiles.width === width && tiles.height === height) return tiles;
        tiles?.counts.destroy();
        tiles?.entries.destroy();
        tiles?.lineCounts.destroy();
        tiles?.lineEntries.destroy();
        const n = Math.ceil(width / tileSize) * Math.ceil(height / tileSize);
        tiles = {
            width,
            height,
            counts: device.createBuffer({
                label: "sternenheer:tileCounts",
                size: n * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            }),
            entries: device.createBuffer({
                label: "sternenheer:tileEntries",
                size: n * capacity * 4,
                usage: GPUBufferUsage.STORAGE,
            }),
            lineCounts: device.createBuffer({
                label: "sternenheer:lineCounts",
                size: n * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            }),
            lineEntries: device.createBuffer({
                label: "sternenheer:lineEntries",
                size: n * LINE_CAPACITY * 4,
                usage: GPUBufferUsage.STORAGE,
            }),
        };
        return tiles;
    }

    return {
        update(patch) {
            Object.assign(params, patch);
        },
        encode(encoder, target, encodeOptions = {}) {
            const { width, height } = target;
            const t = tilesFor(width, height);
            const faintDrawn = Math.max(0, Math.min(Math.floor(params.faintStars), faintCount));
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
                }),
            );
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
                        { binding: 1, resource: { buffer: catalogBuffer } },
                        { binding: 2, resource: { buffer: lineBuffer } },
                        { binding: 3, resource: { buffer: pieces } },
                        { binding: 4, resource: { buffer: t.lineCounts } },
                        { binding: 5, resource: { buffer: t.lineEntries } },
                        { binding: 6, resource: { buffer: faintBuffer } },
                    ],
                });
                const pass = encoder.beginComputePass({ label: "sternenheer:lines" });
                pass.setPipeline(linesPipeline);
                pass.setBindGroup(0, bind);
                pass.dispatchWorkgroups(Math.ceil((constellations.count * LINE_PIECES) / 64));
                pass.end();
            }
            encoder.clearBuffer(t.counts);
            const h = halosFor(width, height);
            encoder.clearBuffer(h.sums);
            if (catalog) {
                const bind = device.createBindGroup({
                    layout: binPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: uniform } },
                        { binding: 1, resource: { buffer: catalogBuffer } },
                        { binding: 2, resource: { buffer: splats } },
                        { binding: 3, resource: { buffer: t.counts } },
                        { binding: 4, resource: { buffer: t.entries } },
                        { binding: 5, resource: { buffer: h.sums } },
                        { binding: 6, resource: { buffer: faintBuffer } },
                        { binding: 7, resource: { buffer: faintColors } },
                    ],
                });
                const pass = encoder.beginComputePass({ label: "sternenheer:bin" });
                pass.setPipeline(binPipeline);
                pass.setBindGroup(0, bind);
                pass.dispatchWorkgroups(Math.ceil((catalog.count + faintDrawn) / 64));
                pass.end();
            }
            const haloSum = encodeHalos(encoder, h);
            // The compose pass reads no catalog, so its layout, derived from the shader, has no binding for it.
            const bind = device.createBindGroup({
                layout: composePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniform } },
                    { binding: 2, resource: { buffer: splats } },
                    { binding: 3, resource: { buffer: t.counts } },
                    { binding: 4, resource: { buffer: t.entries } },
                    { binding: 5, resource: (milkyWay?.texture ?? blank).createView() },
                    { binding: 6, resource: sampler },
                    { binding: 7, resource: (encodeOptions.background ?? noBackground).createView() },
                    { binding: 8, resource: haloSum },
                    { binding: 9, resource: { buffer: pieces } },
                    { binding: 10, resource: { buffer: t.lineCounts } },
                    { binding: 11, resource: { buffer: t.lineEntries } },
                ],
            });
            const output = device.createBindGroup({
                layout: composePipeline.getBindGroupLayout(1),
                entries: [{ binding: 0, resource: target.createView() }],
            });
            const pass = encoder.beginComputePass({
                label: "sternenheer:compose",
                ...(encodeOptions.timestampWrites ? { timestampWrites: encodeOptions.timestampWrites } : {}),
            });
            pass.setPipeline(composePipeline);
            pass.setBindGroup(0, bind);
            pass.setBindGroup(1, output);
            pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            pass.end();
        },
        destroy() {
            uniform.destroy();
            catalogBuffer.destroy();
            splats.destroy();
            tiles?.counts.destroy();
            tiles?.entries.destroy();
            tiles?.lineCounts.destroy();
            tiles?.lineEntries.destroy();
            lineBuffer.destroy();
            faintBuffer.destroy();
            faintColors.destroy();
            pieces.destroy();
            halos?.sums.destroy();
            halos?.down.destroy();
            halos?.up.destroy();
            pyramidParams.destroy();
            blank.destroy();
            noBackground.destroy();
        },
    };
}
