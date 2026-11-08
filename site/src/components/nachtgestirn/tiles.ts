import { viewFrame } from "@himmelszelt/nachtgestirn";
import { displayOutput, gpuDevice, gpu as shared } from "../dunstkreis/atmosphere";
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
export const pxPerRadian = (degreesAcross: number, tilePx: number) => tilePx / (degreesAcross * DEG);

/**
 * A row of Moons in one canvas, for the figures that compare discs: each is rendered by nachtgestirn's pass into a
 * tile of its own, from Earth's center with the Moon's north up and no air, and copied into the canvas side by side.
 * The canvas follows the page's display choice, HDR where the display and the canvas can (`displayOutput`).
 * `requestRender` is called whenever something a tile waited for arrived.
 */
export function createTiles(canvas: HTMLCanvasElement, requestRender: () => void) {
    const context = shared.error ? null : canvas.getContext("webgpu");
    if (!context) return null;
    const device = gpuDevice();
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

    /** The view of one tile: `m` centered, north up, `degreesAcross` of sky across the tile. */
    function view(m: MoonAt, degreesAcross: number, tilePx: number) {
        const { right, up, toward } = tileFrame(m);
        const half = Math.tan((degreesAcross * DEG) / 2);
        return {
            inverseViewProjection: inverseViewProjection(
                toward.map((t) => -t),
                right,
                up,
                half,
                half,
            ),
            discPixels: (m.geocentricDiameter / degreesAcross) * tilePx,
        };
    }

    return {
        /**
         * Draws `count` tiles of `tilePx` square into the canvas, `frame(i)` giving each one's Moon and switches, the
         * view set here. Null while a pass is still being made, which calls `requestRender` when done; else what the
         * renderer returned for each tile.
         */
        draw(
            count: number,
            tilePx: number,
            degreesAcross: number,
            frame: (
                i: number,
            ) => Omit<
                MoonFrame,
                | "width"
                | "height"
                | "inverseViewProjection"
                | "projectionDistance"
                | "discPixels"
                | "air"
                | "pixelRatio"
            >,
        ) {
            if (!context) return null;
            const { format, headroom } = displayOutput();
            configure(format);
            const width = count * tilePx;
            if (canvas.width !== width || canvas.height !== tilePx) Object.assign(canvas, { width, height: tilePx });
            if (!scratch || scratch.width !== tilePx || scratch.format !== format) {
                scratch?.destroy();
                scratch = device.createTexture({
                    label: "sternwarte:moonTile",
                    size: [tilePx, tilePx],
                    format,
                    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
                });
            }
            const results = [];
            const target = context.getCurrentTexture();
            for (let i = 0; i < count; i++) {
                const f = frame(i);
                const drawn = renderer.draw(scratch, {
                    ...f,
                    format,
                    headroom,
                    ...view(f.moon, degreesAcross, tilePx),
                    width: tilePx,
                    height: tilePx,
                    projectionDistance: 0,
                    pixelRatio: 1,
                    air: false,
                });
                if (!drawn) return null;
                results.push(drawn);
                const encoder = device.createCommandEncoder({ label: "sternwarte:moonTileCopy" });
                encoder.copyTextureToTexture({ texture: scratch }, { texture: target, origin: [i * tilePx, 0] }, [
                    tilePx,
                    tilePx,
                ]);
                device.queue.submit([encoder.finish()]);
            }
            return results;
        },
    };
}
