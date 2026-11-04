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
    const colorTexture = upload(color, "nachtgestirn:color", true);
    buildMips(device, colorTexture, "rgba8unorm", true);
    let relief: GPUTexture | null = null;
    if (heights) {
        const packed = upload(heights, "nachtgestirn:heights", false);
        relief = device.createTexture({
            label: "nachtgestirn:relief",
            size: [heights.width, heights.height],
            format: "rgba16float",
            mipLevelCount: mipLevels(heights.width, heights.height),
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
        decodeRelief(device, packed, relief);
        buildMips(device, relief, "rgba16float", false);
        packed.destroy();
    }
    const sampler = device.createSampler({
        label: "nachtgestirn:maps",
        addressModeU: "repeat",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
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
        destroy() {
            colorTexture.destroy();
            relief?.destroy();
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
 * package's own large set by default.
 */
export async function loadMoonMaps(
    device: GPUDevice,
    files: MoonMapFiles = MOON_MAPS.large,
    options: Omit<MoonMapsOptions, "color" | "heights"> = {},
): Promise<MoonMaps> {
    const decode = async (url: string | URL) =>
        createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const [color, heights] = await Promise.all([decode(files.color), files.heights ? decode(files.heights) : null]);
    const meanReflectance = options.meanReflectance ?? files.meanReflectance;
    const meanColor = options.meanColor ?? files.meanColor;
    return createMoonMaps(device, {
        color,
        ...(heights ? { heights } : {}),
        ...options,
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

function decodeRelief(device: GPUDevice, packed: GPUTexture, relief: GPUTexture) {
    const pipe = pipeline(device, "relief", () =>
        compute(
            device,
            "nachtgestirn:relief",
            [wgsl.moonOutput("rgba16float"), wgsl.params, wgsl.surface, wgsl.relief].join("\n"),
            "nbRelief",
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
