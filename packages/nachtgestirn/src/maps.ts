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
    /** Compress the color map to BC1 on the GPU, where the device has "texture-compression-bc", as desktop GPUs do: an
     *  eighth of its memory, 44.7 MB down to 5.6 for the large maps, for colors a hundredth of a stop off. Off by
     *  default. The relief stays as it is: the shadows are marched through its heights. */
    compress?: boolean;
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
    const compressible = (image: ImageBitmap) =>
        options.compress &&
        device.features.has("texture-compression-bc") &&
        image.width % 4 === 0 &&
        image.height % 4 === 0;
    let colorTexture = upload(color, "nachtgestirn:color", true);
    buildMips(device, colorTexture, "rgba8unorm", true);
    if (compressible(color)) colorTexture = compressBc1(device, colorTexture);
    const relief = heights ? reliefOf(heights, "nachtgestirn") : null;
    let detail: MoonMaps["detail"];
    if (options.detail) {
        let detailColor = upload(options.detail.color, "nachtgestirn:detail:color", true);
        buildMips(device, detailColor, "rgba8unorm", true);
        if (compressible(options.detail.color)) detailColor = compressBc1(device, detailColor);
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
 * 64 texels per degree, by how many texels around: "512", 230 KB, for a disc up to 163 pixels across, "1k", 840 KB, up
 * to 326, "2k", 3.1 MB, up to 652, and "4k", 11.5 MB, beyond, each as far as it gives a texel to a pixel at the disc's
 * middle (`mapWidthFor`). Resolved next to the package's own files, which bundlers that know
 * `new URL(..., import.meta.url)` copy along.
 */
export const MOON_MAPS: Record<"512" | "1k" | "2k" | "4k", MoonMapFiles> = {
    "512": {
        color: new URL("../maps/moon-color-512.webp", import.meta.url),
        heights: new URL("../maps/moon-height-512.webp", import.meta.url),
        width: 512,
        ...SHIPPED,
    },
    "1k": {
        color: new URL("../maps/moon-color-1k.webp", import.meta.url),
        heights: new URL("../maps/moon-height-1k.webp", import.meta.url),
        width: 1024,
        ...SHIPPED,
    },
    "2k": {
        color: new URL("../maps/moon-color-2k.webp", import.meta.url),
        heights: new URL("../maps/moon-height-2k.webp", import.meta.url),
        width: 2048,
        ...SHIPPED,
    },
    "4k": {
        color: new URL("../maps/moon-color-4k.webp", import.meta.url),
        heights: new URL("../maps/moon-height-4k.webp", import.meta.url),
        width: 4096,
        ...SHIPPED,
    },
};

/**
 * Fetches and decodes a set of maps, as a browser does, and uploads them: `createMoonMaps` with the images. The
 * package's own 4K set by default. `onProgress` hears how many bytes of all the files have come, of how many, once
 * every file has said its size.
 */
export async function loadMoonMaps(
    device: GPUDevice,
    files: MoonMapFiles = MOON_MAPS["4k"],
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
    const constants = { NG_RELIEF_NORTH: north, NG_RELIEF_SPAN_U: east - west, NG_RELIEF_SPAN_V: south - north };
    const pipe = pipeline(device, `relief ${region.join(" ")}`, () =>
        compute(
            device,
            "nachtgestirn:relief",
            [wgsl.moonOutput("rgba16float"), wgsl.surface, wgsl.relief].join("\n"),
            "ngRelief",
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
            [wgsl.moonOutput(format), wgsl.surface, wgsl.mips].join("\n"),
            "ngDownsample",
            { NG_MIP_SRGB: srgb ? 1 : 0 },
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

/** The color map with its levels as BC1, encoded on the GPU level by level; the uncompressed one destroyed. */
function compressBc1(device: GPUDevice, texture: GPUTexture): GPUTexture {
    const pipe = pipeline(device, "bc1", () => compute(device, "nachtgestirn:bc1", wgsl.bc1, "ngEncodeBc1"));
    const compressed = device.createTexture({
        label: texture.label,
        size: [texture.width, texture.height],
        format: "bc1-rgba-unorm",
        mipLevelCount: texture.mipLevelCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Each level's blocks, a row padded to 256 bytes, one after the other.
    const levels = Array.from({ length: texture.mipLevelCount }, (_, level) => {
        const across = Math.ceil(Math.max(1, texture.width >> level) / 4);
        const down = Math.ceil(Math.max(1, texture.height >> level) / 4);
        return { level, across, down, row: Math.ceil((across * 8) / 256) * 256 };
    });
    let offset = 0;
    const placed = levels.map((l) => {
        const at = offset;
        offset += l.row * l.down;
        return { ...l, offset: at };
    });
    const blocks = device.createBuffer({
        label: "nachtgestirn:bc1",
        size: offset,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const encoder = device.createCommandEncoder({ label: "nachtgestirn:bc1" });
    for (const { level, across, down, row, offset } of placed) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipe);
        pass.setBindGroup(
            0,
            device.createBindGroup({
                layout: pipe.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }) },
                    { binding: 1, resource: { buffer: blocks, offset, size: row * down } },
                ],
            }),
        );
        pass.dispatchWorkgroups(Math.ceil(across / 8), Math.ceil(down / 8));
        pass.end();
        encoder.copyBufferToTexture(
            { buffer: blocks, offset, bytesPerRow: row, rowsPerImage: down },
            { texture: compressed, mipLevel: level },
            [across * 4, down * 4],
        );
    }
    device.queue.submit([encoder.finish()]);
    blocks.destroy();
    texture.destroy();
    return compressed;
}
