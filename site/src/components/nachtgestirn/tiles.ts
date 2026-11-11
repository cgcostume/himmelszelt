import { viewFrame } from "@himmelszelt/nachtgestirn";
import { displayOutput, gpuDevice, gpu as shared } from "../dunstkreis/atmosphere";
import { raysOf } from "./rays";
import { createMoonRenderer, inverseViewProjection, type MoonAt, type MoonFrame } from "./renderer";

const DEG = Math.PI / 180;

/**
 * The frame a tile shows `m` in: right across the tile, up towards the Moon's north, and towards the viewer, in ENU.
 * For an overlay drawn over the tile, with `pxPerRadian(degreesAcross, tilePx)` for its scale.
 */
export function tileFrame(m: MoonAt) {
    const { right, up, toward } = viewFrame(m.trueDirection);
    // The screen's up turned from the zenith to the Moon's north: the axis' position angle less the parallactic one.
    const turn = (m.positionAngleOfAxis - m.parallacticAngle) * DEG;
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    return {
        right: right.map((r, i) => r * c + (up[i] ?? 0) * s),
        up: up.map((u, i) => u * c - (right[i] ?? 0) * s),
        toward,
    };
}
/** The frame looking along `direction` with its up leaning to `lean`, as `viewFrame` leans it to the zenith. */
function leaningFrame(direction: readonly number[], lean: readonly number[]) {
    const along = lean.reduce((sum, l, i) => sum + l * (direction[i] ?? 0), 0);
    const up = normalize(lean.map((l, i) => l - along * (direction[i] ?? 0)));
    return { right: cross(direction, up), up, toward: direction.map((d) => -d) };
}
export const pxPerRadian = (degreesAcross: number, tilePx: number) => tilePx / (degreesAcross * DEG);

/**
 * A row of Moons in one canvas, for the figures that compare discs: each is rendered by nachtgestirn's pass into a
 * tile of its own, from Earth's center with the Moon's north up and no air, and copied into the canvas side by side.
 * The canvas follows the page's display choice, HDR where the display and the canvas can (`displayOutput`).
 * `requestRender` is called whenever something a tile waited for arrived.
 */
const normalize = (v: readonly number[]) => {
    const l = Math.hypot(...v) || 1;
    return v.map((c) => c / l);
};
const cross = (a: readonly number[], b: readonly number[]) => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
];

/** What a tile's frame leaves to the row: the view and the target are the tiles' own. */
export type TileFrame = Omit<
    MoonFrame,
    "width" | "height" | "inverseViewProjection" | "projectionDistance" | "discPixels" | "air" | "pixelRatio"
> & {
    /** The view's center off the Moon's, right and up, in degrees: for a close-up of a part of the disc. */
    offset?: readonly [number, number];
    /** This tile's own degrees of sky across its width, where the row's do not hold for it. */
    degreesAcross?: number;
    /** Through the air from the observer, over the sky, the Moon where the air lifts it and the zenith up; none by default. */
    air?: boolean;
    /** With `air`, the direction the tile's up leans to instead of the zenith: to turn on past it without a flip. */
    up?: readonly [number, number, number];
};

export interface TileLayout {
    /** Tiles per row, and rows, 1 by default. */
    count: number;
    rows?: number;
    /** Each tile's width in pixels, and its height, the width by default. */
    width: number;
    height?: number;
    /** Degrees of sky across a tile's width. */
    degreesAcross: number;
    /** Hears the first tile's corner pixel as drawn, display-encoded and clamped to 0..1, once it is read back: the
     *  sky's color, for a page to set around the tiles. */
    probe?: (rgb: readonly [number, number, number]) => void;
}

// Ids for the objects a tile's key stands in for by identity: the tables, the atmosphere model.
const ids = new WeakMap<object, number>();
let nextId = 0;
const idOf = (o: object) => {
    let id = ids.get(o);
    if (id === undefined) {
        id = nextId++;
        ids.set(o, id);
    }
    return id;
};
// Everything a tile's picture depends on, as a string: the frame, its view and the output; tables and models by
// identity, long arrays by their length and a few of their values.
function keyOf(value: unknown) {
    return JSON.stringify(value, (name, v) => {
        if (name === "luts" || name === "model") return v && typeof v === "object" ? `#${idOf(v)}` : v;
        if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
            const a = v as unknown as ArrayLike<number>;
            return a.length > 16 ? `${a.length}:${a[0]}:${a[a.length >> 1]}:${a[a.length - 1]}` : Array.from(a);
        }
        return v;
    });
}

// A half float's value.
function half(h: number) {
    const exponent = (h >> 10) & 31;
    const mantissa = h & 1023;
    const sign = h & 0x8000 ? -1 : 1;
    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 31) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

export function createTiles(canvas: HTMLCanvasElement, requestRender: () => void) {
    const context = shared.error ? null : canvas.getContext("webgpu");
    if (!context) return null;
    const device = gpuDevice();
    // The figure's supersampling switch, where it has one, for every tile.
    const rays = raysOf(canvas, requestRender);
    let configured: GPUTextureFormat | null = null;
    function configure(format: GPUTextureFormat) {
        if (configured === format) return;
        configured = format;
        context?.configure({
            device,
            format,
            alphaMode: "opaque",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
            toneMapping: { mode: format === "rgba16float" ? "extended" : "standard" },
        });
    }
    const renderer = createMoonRenderer(device, requestRender);
    let scratch: GPUTexture | null = null;

    /**
     * The view of one tile: `m` centered, north up, `degreesAcross` of sky across the tile's width, the tile `aspect`
     * times as wide as high. `offset` moves the view's center off the Moon's, right and up, in degrees.
     */
    function view(
        m: MoonAt,
        degreesAcross: number,
        widthPx: number,
        aspect: number,
        offset?: readonly [number, number],
        air = false,
        lean?: readonly [number, number, number],
    ) {
        const frame = air ? (lean ? leaningFrame(m.direction, lean) : viewFrame(m.direction)) : tileFrame(m);
        let { right, up } = frame;
        let forward = frame.toward.map((t) => -t);
        if (offset) {
            const [ox, oy] = [Math.tan(offset[0] * DEG), Math.tan(offset[1] * DEG)];
            forward = normalize(forward.map((f, i) => f + (right[i] ?? 0) * ox + (up[i] ?? 0) * oy));
            right = normalize(cross(forward, up));
            up = cross(right, forward);
        }
        const half = Math.tan((degreesAcross * DEG) / 2);
        return {
            inverseViewProjection: inverseViewProjection(forward, right, up, half, half / aspect),
            discPixels: (m.geocentricDiameter / degreesAcross) * widthPx,
        };
    }

    let atlas: GPUTexture | null = null;
    let keys: string[] = [];

    // One pixel read back at a time: a probe asked for while one is on its way waits for the next draw.
    let probing = false;
    function probe(texture: GPUTexture, format: GPUTextureFormat, hear: NonNullable<TileLayout["probe"]>) {
        if (probing) return;
        probing = true;
        const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder({ label: "sternwarte:moonTileProbe" });
        encoder.copyTextureToBuffer({ texture, origin: [1, 1] }, { buffer, bytesPerRow: 256 }, [1, 1]);
        device.queue.submit([encoder.finish()]);
        buffer.mapAsync(GPUMapMode.READ).then(() => {
            const clamp = (v: number) => Math.max(0, Math.min(1, v));
            let rgb: [number, number, number];
            if (format === "rgba16float") {
                const h = new Uint16Array(buffer.getMappedRange(), 0, 3);
                rgb = [clamp(half(h[0] ?? 0)), clamp(half(h[1] ?? 0)), clamp(half(h[2] ?? 0))];
            } else {
                const b = new Uint8Array(buffer.getMappedRange(), 0, 4);
                const [x, y, z] = [(b[0] ?? 0) / 255, (b[1] ?? 0) / 255, (b[2] ?? 0) / 255];
                rgb = format === "bgra8unorm" ? [z, y, x] : [x, y, z];
            }
            buffer.destroy();
            probing = false;
            hear(rgb);
        });
    }

    return {
        /**
         * Draws the tiles of `layout` into the canvas, row by row, `frame(i)` giving each one's Moon and switches, the
         * view set here. Null while a pass is still being made, which calls `requestRender` when done; else what the
         * renderer returned for each tile.
         */
        draw(layout: TileLayout, frame: (i: number) => TileFrame) {
            if (!context) return null;
            const { count, rows = 1, width: tileW, height: tileH = layout.width, degreesAcross } = layout;
            const { format, headroom } = displayOutput();
            configure(format);
            const width = count * tileW;
            const height = rows * tileH;
            if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
            if (!scratch || scratch.width !== tileW || scratch.height !== tileH || scratch.format !== format) {
                scratch?.destroy();
                scratch = device.createTexture({
                    label: "sternwarte:moonTile",
                    size: [tileW, tileH],
                    format,
                    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
                });
            }
            // The tiles as last drawn, kept: a tile whose key has not changed is not drawn again, only copied.
            if (!atlas || atlas.width !== width || atlas.height !== height || atlas.format !== format) {
                atlas?.destroy();
                atlas = device.createTexture({
                    label: "sternwarte:moonTiles",
                    size: [width, height],
                    format,
                    usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
                });
                keys = [];
            }
            const results = [];
            let complete = true;
            for (let i = 0; i < count * rows; i++) {
                const f = frame(i);
                // The figure's switch for the rays, unless the frame sets its own.
                const tile = {
                    ...rays(),
                    ...f,
                    format,
                    headroom,
                    ...view(f.moon, f.degreesAcross ?? degreesAcross, tileW, tileW / tileH, f.offset, f.air, f.up),
                    width: tileW,
                    height: tileH,
                    projectionDistance: 0,
                    pixelRatio: 1,
                    air: f.air ?? false,
                };
                const key = `${renderer.bound()} ${keyOf(tile)}`;
                if (keys[i] === key) continue;
                const drawn = renderer.draw(scratch, tile);
                // A pass still being made: the tiles kept are shown meanwhile, and all is drawn when it is done.
                if (!drawn) {
                    complete = false;
                    break;
                }
                results.push(drawn);
                keys[i] = key;
                const encoder = device.createCommandEncoder({ label: "sternwarte:moonTileCopy" });
                encoder.copyTextureToTexture(
                    { texture: scratch },
                    { texture: atlas, origin: [(i % count) * tileW, Math.floor(i / count) * tileH] },
                    [tileW, tileH],
                );
                device.queue.submit([encoder.finish()]);
            }
            const encoder = device.createCommandEncoder({ label: "sternwarte:moonTilesShow" });
            encoder.copyTextureToTexture({ texture: atlas }, { texture: context.getCurrentTexture() }, [width, height]);
            device.queue.submit([encoder.finish()]);
            if (layout.probe) probe(atlas, format, layout.probe);
            if (!complete) return null;
            return results;
        },
    };
}
