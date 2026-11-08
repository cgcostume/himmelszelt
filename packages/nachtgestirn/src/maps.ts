import type { Vec3 } from "./orientation.js";
import * as wgsl from "./wgsl/index.js";

/** The Moon's maps on the GPU, equirectangular, centered on 0° longitude with east to the right and north up, as NASA's
 *  CGI Moon Kit lays them out: the color map, sRGB-encoded in an rgba8unorm texture with mip levels, the relief, its
 *  height in km and slopes towards east and north in an rgba16float texture with mip levels, or null, and the sampler
 *  to read them with. */
export interface MoonMaps {
    readonly color: GPUTexture;
    readonly relief: GPUTexture | null;
    readonly sampler: GPUSampler;
    /** What the color map is multiplied by to read as normal albedo: the geometric albedo over the map's mean. */
    readonly albedoScale: number;
    /** And per channel: from the map's own mean color to the Moon's. */
    readonly albedoTint: Vec3;
    /** A strip of the Moon at a finer size, read instead of the whole maps where it lies, or none. */
    readonly detail?: {
        readonly color: GPUTexture;
        readonly relief: GPUTexture;
        /** Where it lies in the whole maps' uv: west, north, east and south edges. */
        readonly region: readonly [number, number, number, number];
    };
    destroy(): void;
}

/**
 * The Moon's color, its reflectance per channel of linear sRGB relative to green: redder than the sunlight it reflects,
 * a B-V of 0.92 against the Sun's 0.65, which makes blue 0.78 of green and red, by the same slope, 1.155. Outside the
 * air a full Moon is a warm gray.
 */
export const MOON_COLOR: Vec3 = [1.155, 1, 0.78];

export interface MoonMapsOptions {
    /** The color map, decoded; `createImageBitmap` of its file with `colorSpaceConversion: "none"`. */
    color: ImageBitmap;
    /** The height map, decoded the same way: LOLA's 16-bit half meters, offset by 20,000 over the mean radius, red the
     *  high byte and green the low one. Without, the Moon is shaded by its sphere alone. */
    heights?: ImageBitmap;
    /** The color map's mean reflectance over the near side, linear, as `scripts/maps.mjs` prints it; NASA's map is
     *  balanced to look right, not to measure. With `geometricAlbedo`, 0.12 by default, it scales the map to normal
     *  albedo, so the drawn full Moon averages the real one's brightness. 1 reads the map as is. */
    meanReflectance?: number;
    geometricAlbedo?: number;
    /** The color map's mean color over the near side, linear, as the script prints it: with `moonColor`, `MOON_COLOR`
     *  by default, it tints the map so its mean is the Moon's color while its own variations stay. Without, untinted. */
    meanColor?: Vec3;
    moonColor?: Vec3;
    /** A strip of the Moon at a finer size, from the same sources, decoded the same way, and where it lies in the whole
     *  maps' uv: west, north, east and south edges. The pass reads it instead of the whole maps where it lies, for a
     *  close-up sharper than a whole map the GPU could hold. */
    detail?: { color: ImageBitmap; heights: ImageBitmap; region: readonly [number, number, number, number] };
}

const mipLevels = (width: number, height: number) => Math.floor(Math.log2(Math.max(width, height))) + 1;
const luminance = ([r, g, b]: Vec3) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Uploads the maps and builds their mip levels on the GPU, so the disc stays smooth at any size on screen. */
export function createMoonMaps(device: GPUDevice, options: MoonMapsOptions): MoonMaps {
    const { color, heights, meanReflectance = 1, geometricAlbedo = 0.12, meanColor, moonColor = MOON_COLOR } = options;
    // Copied into from an image, which needs the render attachment usage too, and written level by level by the mip pass.
    const usage =
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT;
    const upload = (image: ImageBitmap, label: string, mips: boolean) => {
        const texture = device.createTexture({
            label,
            size: [image.width, image.height],
            format: "rgba8unorm",
            mipLevelCount: mips ? mipLevels(image.width, image.height) : 1,
            usage,
        });
        device.queue.copyExternalImageToTexture({ source: image }, { texture }, [image.width, image.height]);
        return texture;
    };
    const reliefOf = (image: ImageBitmap, label: string, region?: readonly [number, number, number, number]) => {
        const packed = upload(image, `${label}:heights`, false);
        const relief = device.createTexture({
            label: `${label}:relief`,
            size: [image.width, image.height],
            format: "rgba16float",
            mipLevelCount: mipLevels(image.width, image.height),
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
        decodeRelief(device, packed, relief, region);
        buildMips(device, relief, "rgba16float", false);
        packed.destroy();
        return relief;
    };
    const colorTexture = upload(color, "nachtgestirn:color", true);
    buildMips(device, colorTexture, "rgba8unorm", true);
    const relief = heights ? reliefOf(heights, "nachtgestirn") : null;
    let detail: MoonMaps["detail"];
    if (options.detail) {
        const detailColor = upload(options.detail.color, "nachtgestirn:detail:color", true);
        buildMips(device, detailColor, "rgba8unorm", true);
        detail = {
            color: detailColor,
            relief: reliefOf(options.detail.heights, "nachtgestirn:detail", options.detail.region),
            region: options.detail.region,
        };
    }
    const sampler = device.createSampler({
        label: "nachtgestirn:maps",
        addressModeU: "repeat",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        // Up to sixteen taps along a footprint's long axis, at the poles and the limb.
        maxAnisotropy: 16,
    });
    // The tint keeps the luminance: the albedo scale alone sets the brightness.
    const tint = meanColor
        ? (moonColor.map(
              (c, i) => c / luminance(moonColor) / ((meanColor[i] ?? 1) / luminance(meanColor)),
          ) as unknown as Vec3)
        : ([1, 1, 1] as const);
    return {
        color: colorTexture,
        relief,
        sampler,
        albedoScale: geometricAlbedo / meanReflectance,
        albedoTint: tint,
        ...(detail ? { detail } : {}),
        destroy() {
            colorTexture.destroy();
            relief?.destroy();
            detail?.color.destroy();
            detail?.relief.destroy();
        },
    };
}

/** Where a set of maps lies, and the color map's mean reflectance and color over the near side, `MoonMapsOptions`'. */
export interface MoonMapFiles {
    color: string | URL;
    heights?: string | URL;
    /** The color map's width in texels, to choose a set by `mapWidthFor`. */
    width?: number;
    meanReflectance?: number;
    meanColor?: Vec3;
    /** A strip at a finer size, and where it lies in the whole maps' uv: west, north, east and south edges. */
    detail?: { color: string | URL; heights: string | URL; region: readonly [number, number, number, number] };
}

/** `loadMoonMaps`' options besides the maps': how far the files have come, in bytes, as they come. */
export interface LoadMoonMapsOptions extends Omit<MoonMapsOptions, "color" | "heights" | "detail"> {
    onProgress?: (loaded: number, total: number) => void;
}

// The near side's mean, as `pnpm maps` printed it for the shipped maps.
const SHIPPED = { meanReflectance: 0.396, meanColor: [0.4125, 0.3924, 0.3828] as Vec3 };

/**
 * The maps the package ships, made by `pnpm maps` from NASA's CGI Moon Kit: the color map and the heights from LOLA's
 * 64 texels per degree, 512, 1024 or 4096 texels around, `small` 230 KB, for a disc up to some 160 pixels across,
 * `medium` 840 KB, up to some 330, `large` 11.5 MB, for zooming in (see `mapWidthFor`). Resolved next to the package's
 * own files, which bundlers that know `new URL(..., import.meta.url)` copy along.
 */
export const MOON_MAPS: { small: MoonMapFiles; medium: MoonMapFiles; large: MoonMapFiles } = {
    small: {
        color: new URL("../maps/moon-color-512.webp", import.meta.url),
        heights: new URL("../maps/moon-height-512.webp", import.meta.url),
        width: 512,
        ...SHIPPED,
    },
    medium: {
        color: new URL("../maps/moon-color-1k.webp", import.meta.url),
        heights: new URL("../maps/moon-height-1k.webp", import.meta.url),
        width: 1024,
        ...SHIPPED,
    },
    large: {
        color: new URL("../maps/moon-color-4k.webp", import.meta.url),
        heights: new URL("../maps/moon-height-4k.webp", import.meta.url),
        width: 4096,
        ...SHIPPED,
    },
};

/**
 * Fetches and decodes a set of maps, as a browser does, and uploads them: `createMoonMaps` with the images. The
 * package's own large set by default. `onProgress` hears how many bytes of all the files have come, of how many, once
 * every file has said its size.
 */
export async function loadMoonMaps(
    device: GPUDevice,
    files: MoonMapFiles = MOON_MAPS.large,
    options: LoadMoonMapsOptions = {},
): Promise<MoonMaps> {
    const { onProgress, ...rest } = options;
    const urls = [files.color, files.heights, files.detail?.color, files.detail?.heights];
    const loaded = urls.map(() => 0);
    const sizes = urls.map((url) => (url ? Number.NaN : 0));
    const report = () => {
        const total = sizes.reduce((a, b) => a + b, 0);
        if (onProgress && Number.isFinite(total))
            onProgress(
                Math.min(
                    loaded.reduce((a, b) => a + b, 0),
                    total,
                ),
                total,
            );
    };
    const decode = async (url: string | URL | undefined, i: number) => {
        if (!url) return null;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`nachtgestirn: ${url} gave ${response.status}`);
        const type = response.headers.get("content-type") ?? "";
        sizes[i] = Number(response.headers.get("content-length")) || 0;
        let blob: Blob;
        if (onProgress && response.body) {
            const pieces: Uint8Array[] = [];
            const reader = response.body.getReader();
            for (let piece = await reader.read(); !piece.done; piece = await reader.read()) {
                pieces.push(piece.value);
                loaded[i] = (loaded[i] ?? 0) + piece.value.length;
                report();
            }
            blob = new Blob(pieces as BlobPart[], { type });
        } else {
            blob = await response.blob();
        }
        return createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    };
    const [color, heights, detailColor, detailHeights] = await Promise.all(urls.map(decode));
    if (!color) throw new Error("nachtgestirn: no color map");
    const meanReflectance = rest.meanReflectance ?? files.meanReflectance;
    const meanColor = rest.meanColor ?? files.meanColor;
    return createMoonMaps(device, {
        color,
        ...(heights ? { heights } : {}),
        ...(files.detail && detailColor && detailHeights
            ? { detail: { color: detailColor, heights: detailHeights, region: files.detail.region } }
            : {}),
        ...rest,
        ...(meanReflectance === undefined ? {} : { meanReflectance }),
        ...(meanColor === undefined ? {} : { meanColor }),
    });
}

const pipelines = new WeakMap<GPUDevice, Map<string, GPUComputePipeline>>();

function pipeline(device: GPUDevice, key: string, make: () => GPUComputePipeline) {
    const byDevice = pipelines.get(device) ?? new Map<string, GPUComputePipeline>();
    pipelines.set(device, byDevice);
    let found = byDevice.get(key);
    if (!found) {
        found = make();
        byDevice.set(key, found);
    }
    return found;
}

const compute = (device: GPUDevice, label: string, code: string, entryPoint: string, constants = {}) =>
    device.createComputePipeline({
        label,
        layout: "auto",
        compute: { module: device.createShaderModule({ label, code }), entryPoint, constants },
    });

function dispatch(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    pipe: GPUComputePipeline,
    source: GPUTextureView,
    target: GPUTextureView,
    width: number,
    height: number,
) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipe);
    const group = (index: number, resource: GPUTextureView) =>
        device.createBindGroup({ layout: pipe.getBindGroupLayout(index), entries: [{ binding: 0, resource }] });
    pass.setBindGroup(0, group(0, source));
    pass.setBindGroup(1, group(1, target));
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
}

function decodeRelief(
    device: GPUDevice,
    packed: GPUTexture,
    relief: GPUTexture,
    region: readonly [number, number, number, number] = [0, 0, 1, 1],
) {
    const [west, north, east, south] = region;
    const constants = { NB_RELIEF_NORTH: north, NB_RELIEF_SPAN_U: east - west, NB_RELIEF_SPAN_V: south - north };
    const pipe = pipeline(device, `relief ${region.join(" ")}`, () =>
        compute(
            device,
            "nachtgestirn:relief",
            [wgsl.moonOutput("rgba16float"), wgsl.params, wgsl.surface, wgsl.relief].join("\n"),
            "nbRelief",
            constants,
        ),
    );
    const encoder = device.createCommandEncoder({ label: "nachtgestirn:relief" });
    const target = relief.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    dispatch(device, encoder, pipe, packed.createView(), target, relief.width, relief.height);
    device.queue.submit([encoder.finish()]);
}

function buildMips(device: GPUDevice, texture: GPUTexture, format: GPUTextureFormat, srgb: boolean) {
    const pipe = pipeline(device, `mips ${format} ${srgb}`, () =>
        compute(
            device,
            "nachtgestirn:mips",
            [wgsl.moonOutput(format), wgsl.params, wgsl.surface, wgsl.mips].join("\n"),
            "nbDownsample",
            { NB_MIP_SRGB: srgb ? 1 : 0 },
        ),
    );
    const encoder = device.createCommandEncoder({ label: "nachtgestirn:mips" });
    for (let level = 1; level < texture.mipLevelCount; level++) {
        const source = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
        const target = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
        const width = Math.max(1, texture.width >> level);
        const height = Math.max(1, texture.height >> level);
        dispatch(device, encoder, pipe, source, target, width, height);
    }
    device.queue.submit([encoder.finish()]);
}
