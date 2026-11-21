import type { StarImage, StarsPass } from "@himmelszelt/sternenheer";
import {
    catalogFromStars,
    colorFromColorIndex,
    createStarsPass,
    illuminanceFromMagnitude,
} from "@himmelszelt/sternenheer";

/**
 * One star drawn by sternenheer's own pass into a small linear target and read back: the pass' pixels, not a model of
 * them. The star stands at the view's center, at magnitude 0 in a one-star catalog of its color, its magnitude set by
 * the pass' `starLight`; no air, no Milky Way, no background. Shared by the chapter's figures that magnify a star.
 */

// The pass writes cd/m² at an exposure of 1: EV100 of -log2(1.2).
const UNIT_EV100 = -Math.log2(1.2);
const FORMAT: GPUTextureFormat = "rgba32float";
const Y = [0.2126, 0.7152, 0.0722] as const;
// The exposed luminance the pass' halo rises towards logarithmically, SH_HALO_KNEE in its params.wgsl.
const HALO_KNEE = 0.25;

export interface PatchStar {
    magnitude: number;
    bv: number;
}

export interface PatchView {
    /** Pixels across the patch, odd to center the star on a pixel. */
    size: number;
    /** Degrees of sky the patch spans across, at its center. */
    fovDegrees: number;
    /** The exposure the image is shown at, for the knee, the halo and the cut-off. */
    ev100: number;
    halo?: number;
    knee?: number;
    psfPixels?: number;
    /** Pixels across the target the pass draws, the patch at its center; `size` by default. A larger one holds more of
     *  the halo's wide wings. */
    target?: number;
    /** Degrees of the viewer's field the target's height spans, as a view of `viewerTarget` pixels would at the pass'
     *  30°; the target's own by default. The halo's width is in the viewer's field, so this sets it in pixels. */
    viewerTarget?: number;
    /** Where the star stands, in pixels right and down from the patch's center. */
    offset?: readonly [number, number];
    /** Also sums the light over the target, and the core alone, which the pass' own numbers for the star give. */
    parts?: boolean;
}

/** Light summed over pixels, each pixel's luminance times its solid angle: illuminance in lux, comparable with the
 *  star's. */
export interface PatchSums {
    /** The pixels as drawn, over the patch and over the whole target. */
    patch: number;
    target: number;
    /** The core alone, the halo off. */
    core: number;
    /** The halo as shown: the target's sum less the core's. */
    halo: number;
    /** The halo before its log curve, undone per pixel: what the target holds of the light the halo spread. */
    haloLinear: number;
}

export interface StarPatch {
    size: number;
    /** Linear luminance per channel in cd/m², row-major from the top left, `size` squared pixels. */
    rgb: Float32Array;
    /** The star's illuminance at the eye in lux, as its luminance. */
    illuminance: number;
    /** The solid angle a pixel spans at the patch's center, in steradians. */
    pixelSolidAngle: number;
    /** Display white per cd/m² at the view's exposure. */
    exposure: number;
    /** Pixels across the target that was drawn. */
    target: number;
    /** What the pass says of the star: its light at the eye and the shares its core and its halo show. */
    split: StarImage;
    sums?: PatchSums;
    /** With `parts`: the core alone, laid out as `rgb`. */
    core?: Float32Array;
}

// One pass for every star, its one-star catalog replaced by the star's color, and one target.
let shared: { device: GPUDevice; pass: Promise<StarsPass>; bv: string } | null = null;
let texture: GPUTexture | null = null;
let readback: GPUBuffer | null = null;
let queue: Promise<unknown> = Promise.resolve();
let released = false;

const catalogOf = (bv: string) =>
    catalogFromStars([
        {
            magnitude: 0,
            rightAscension: 0,
            declination: 0,
            properMotionRightAscension: 0,
            properMotionDeclination: 0,
            color: colorFromColorIndex(Number(bv)),
        },
    ]);

async function passFor(device: GPUDevice, bv: number): Promise<StarsPass> {
    const key = bv.toFixed(2);
    if (shared?.device !== device) {
        const catalog = catalogOf(key);
        shared = {
            device,
            bv: key,
            pass: createStarsPass(device, { format: FORMAT, toneMap: false, background: false, catalog }),
        };
    }
    const pass = await shared.pass;
    if (shared.bv !== key) {
        pass.setCatalog(catalogOf(key));
        shared.bv = key;
    }
    return pass;
}

function textureFor(device: GPUDevice, size: number): GPUTexture {
    if (texture?.width === size) return texture;
    texture?.destroy();
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
    texture = device.createTexture({ size: [size, size], format: FORMAT, usage });
    return texture;
}

function readbackFor(device: GPUDevice, bytes: number): GPUBuffer {
    if (readback && readback.size >= bytes) return readback;
    readback?.destroy();
    readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    return readback;
}

/** Frees the pass, the target and the buffer; the next call makes them again. */
export function releaseStarPatches() {
    shared?.pass.then((p) => p.destroy());
    shared = null;
    texture?.destroy();
    texture = null;
    readback?.destroy();
    readback = null;
}

/** The rotation, column major, that turns the catalog's equinox (1, 0, 0) to `d`, about the axis across both. */
function rotationTo(d: readonly [number, number, number]): Float32Array {
    const [x, y, z] = d;
    // Axis (0, -z, y) / s, angle with cosine x: Rodrigues' formula.
    const s = Math.hypot(y, z);
    if (s < 1e-12) return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const [ay, az, c] = [-z / s, y / s, x];
    const k = 1 - c;
    const m = [
        [c, -az * s, ay * s],
        [az * s, c + ay * ay * k, ay * az * k],
        [-ay * s, ay * az * k, c + az * az * k],
    ];
    return new Float32Array([0, 1, 2].flatMap((col) => [0, 1, 2].map((row) => m[row]?.[col] ?? 0)));
}

/** One star drawn by the pass, its patch read back; calls are queued, so figures may call at once. */
export function renderStarPatch(device: GPUDevice, star: PatchStar, view: PatchView): Promise<StarPatch> {
    const run = queue.then(() => draw(device, star, view));
    queue = run.catch(() => undefined);
    return run;
}

async function draw(device: GPUDevice, star: PatchStar, view: PatchView): Promise<StarPatch> {
    if (!released) {
        released = true;
        addEventListener("pagehide", releaseStarPatches);
    }
    const size = Math.max(1, Math.round(view.size));
    // As many pixels around the patch on each side, so the star stays on its pixel.
    const target = size + 2 * Math.max(0, Math.round(((view.target ?? size) - size) / 2));
    const pass = await passFor(device, star.bv);
    // A pinhole looking east at the equinox: right is south, up is up. `w` is a pixel's width on the image plane.
    const w = (2 * Math.tan((view.fovDegrees * Math.PI) / 360)) / size;
    const t = (w * target) / 2;
    const forward = [1, 0, 0];
    const right = [0, -1, 0];
    const up = [0, 0, 1];
    const inverseViewProjection = new Float32Array([
        ...right.map((c) => c * t),
        0,
        ...up.map((c) => c * t),
        0,
        0,
        0,
        0,
        1,
        ...forward,
        0,
    ]);
    const [dx, dy] = view.offset ?? [0, 0];
    const at = [1, -dx * w, -dy * w];
    const length = Math.hypot(...at);
    const direction = at.map((c) => c / length) as [number, number, number];
    const illuminance = illuminanceFromMagnitude(star.magnitude);
    const sigma = Math.max(view.psfPixels ?? 0.7, 0.6);
    pass.update({
        skyRotation: rotationTo(direction),
        inverseViewProjection,
        projectionDistance: 0,
        ev100: UNIT_EV100,
        displayEV100: view.ev100,
        starLight: illuminance / illuminanceFromMagnitude(0),
        knee: view.knee ?? 1,
        halo: view.halo ?? 1,
        viewerFov: (30 * target) / (view.viewerTarget ?? target),
        psfPixels: sigma,
        maxRadius: Math.max(256, target),
    });
    const exposure = 1 / (1.2 * 2 ** view.ev100);
    const drawnTo = textureFor(device, target);
    const rowBytes = Math.ceil((target * 16) / 256) * 256;
    const bytes = rowBytes * target;
    const buffer = readbackFor(device, bytes);
    const encoder = device.createCommandEncoder({ label: "starpatch" });
    pass.encode(encoder, drawnTo);
    encoder.copyTextureToBuffer({ texture: drawnTo }, { buffer, bytesPerRow: rowBytes }, [target, target]);
    device.queue.submit([encoder.finish()]);
    const [split] = await pass.readStars(0, 1);
    await buffer.mapAsync(GPUMapMode.READ, 0, bytes);
    const all = new Float32Array(buffer.getMappedRange(0, bytes).slice(0));
    buffer.unmap();
    const stride = rowBytes / 4;
    const first = (target - size) >> 1;
    const cut = (source: Float32Array) => {
        const rgb = new Float32Array(size * size * 3);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const from = (first + y) * stride + (first + x) * 4;
                rgb.set(source.subarray(from, from + 3), (y * size + x) * 3);
            }
        }
        return rgb;
    };
    const none: StarImage = { drawn: false, pixel: [0, 0], light: 0, core: 0, halo: 0 };
    const image = split ?? none;
    const patch: StarPatch = {
        size,
        rgb: cut(all),
        illuminance,
        pixelSolidAngle: w * w,
        exposure,
        target,
        split: image,
    };
    if (view.parts) {
        // The core alone, a Gaussian of the light the pass says it shows, at its color: the brightest channel of the
        // pixel at its center, scaled to the star's luminance.
        const color = colorFromColorIndex(Number(star.bv.toFixed(2)));
        const lum = (v: ArrayLike<number>, o = 0) =>
            Y[0] * (v[o] ?? 0) + Y[1] * (v[o + 1] ?? 0) + Y[2] * (v[o + 2] ?? 0);
        const core = new Float32Array(target * stride);
        const [cx, cy] = image.pixel;
        const peak = (image.light * image.core) / (2 * Math.PI * sigma * sigma * w * w);
        // The core whitens as far as it passes the knee, as bin.comp.wgsl has it: its color between the star's and
        // white by the share the knee leaves its brightest channel.
        const top = Math.max(...color);
        const kept = Math.min(
            1,
            (view.knee ?? 1) / ((image.light * top * exposure) / (2 * Math.PI * sigma * sigma * w * w)),
        );
        const tint = color.map((c) => top * (1 - kept) + c * kept);
        const tintLum = lum(tint);
        let [patchSum, whole, coreSum, linear] = [0, 0, 0, 0];
        for (let y = 0; y < target; y++) {
            for (let x = 0; x < target; x++) {
                const o = y * stride + x * 4;
                const fall = Math.exp(-((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / (2 * sigma * sigma));
                for (let c = 0; c < 3; c++) core[o + c] = (peak * fall * (tint[c] ?? 0)) / Math.max(tintLum, 1e-12);
                // A pinhole's pixel spans w² cos³θ.
                const [px, py] = [(x + 0.5 - target / 2) * w, (y + 0.5 - target / 2) * w];
                const omega = w * w * (1 + px * px + py * py) ** -1.5;
                const shown = [0, 1, 2].map((c) => Math.max((all[o + c] ?? 0) - (core[o + c] ?? 0), 0));
                const l = lum(all, o) * omega;
                whole += l;
                if (x >= first && x < first + size && y >= first && y < first + size) patchSum += l;
                coreSum += lum(core, o) * omega;
                // The halo's log curve undone: m = K ln(1 + b / K) of the exposed brightest channel.
                const m = Math.max(...shown) * exposure;
                const scale = m > 1e-12 ? (HALO_KNEE * Math.expm1(Math.min(m / HALO_KNEE, 80))) / m : 1;
                linear += lum(shown) * scale * omega;
            }
        }
        patch.core = cut(core);
        patch.sums = { patch: patchSum, target: whole, core: coreSum, halo: whole - coreSum, haloLinear: linear };
    }
    return patch;
}
