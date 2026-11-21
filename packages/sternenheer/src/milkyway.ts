// The Milky Way's map on the GPU, the ones the package ships and the larger one its data command builds.
import downsample from "./wgsl/milkyway.comp.wgsl";

/** Where a map lies, with its width in texels, the luminance in cd/m² a texel of value 1 stands for, and the stops
 *  below 1 its 8 bits span, each channel's logarithm; 0 or none for an sRGB-encoded map. */
export interface MilkyWayFiles {
    url: string | URL;
    width: number;
    luminance: number;
    stops?: number;
    /** For a map the package does not ship: the command that builds it, named when it is missing. */
    build?: string;
}

/** A texel of value 1 of the package's maps, in cd/m², as `scripts/milkyway.mjs` calibrated it: the map, the shipped
 *  catalog and the shipped Hipparcos stars match the integrated starlight Masana et al. (2021) give for the zenith of
 *  40° N over a year. The Hipparcos stars are a quarter of that light: a sky drawn without them lacks it. The same for
 *  the 8K map, which the script scales by its texels' area. */
export const MILKY_WAY_LUMINANCE = 1.1554e-3;
/** The stops below 1 the package's maps' 8 bits span: 255 steps of 3.3% each, so the dark sky between the clouds
 *  resolves as finely as the clouds. */
export const MILKY_WAY_STOPS = 12;

const SHIPPED = { luminance: MILKY_WAY_LUMINANCE, stops: MILKY_WAY_STOPS };

/**
 * The package's maps, made by `pnpm milkyway` from NASA's Deep Star Maps 2020: the light of the stars fainter than the
 * Hipparcos and Tycho stars, from Gaia DR2, in J2000 equatorial coordinates, plate carrée with right ascension
 * increasing to the left, each channel's logarithm in 8 bits, the stars that stood out as points taken out and their
 * light spread around them. Shipped: `small` 2048 texels around, 810 KB, a texel 10 arcminutes, enough for a view of
 * the whole sky; `large` 4096, 4 MB, for zooming in. Built on request from NASA's 8K map, and absent until then: `8k`,
 * 19 MB, 171 MB on the GPU, for views where a pixel spans less than the 4K map's texel of 5.3 arcminutes. Resolved next
 * to the package's own files, which bundlers that know `new URL(..., import.meta.url)` copy along.
 */
export const MILKY_WAY_MAPS = {
    small: { url: new URL("../data/milkyway-2k.webp", import.meta.url), width: 2048, ...SHIPPED },
    large: { url: new URL("../data/milkyway-4k.webp", import.meta.url), width: 4096, ...SHIPPED },
    "8k": {
        url: new URL("../data/milkyway-8k.webp", import.meta.url),
        width: 8192,
        ...SHIPPED,
        build: "npx @himmelszelt/sternenheer data milkyway --size 8k, or pnpm milkyway --size 8k in the repository",
    },
} as const satisfies Readonly<Record<string, MilkyWayFiles>>;

/** A map uploaded: its texture, the sampler, its luminance and its stops, as `MilkyWayFiles` has them. */
export interface MilkyWay {
    readonly texture: GPUTexture;
    readonly sampler: GPUSampler;
    readonly luminance: number;
    readonly stops: number;
    destroy(): void;
}

/** A decoded map: `createImageBitmap` of its file with `colorSpaceConversion: "none"`, or its texels
 *  as RGBA bytes, row by row, as a decoder outside the browser gives them. */
export type MilkyWayImage = ImageBitmap | { width: number; height: number; data: Uint8Array };

const pipelines = new WeakMap<GPUDevice, Map<number, GPUComputePipeline>>();

/** Fills a logarithmic map's mipmap levels in light, not in logarithms, so a level holds the mean of the light. */
function fillMipmaps(device: GPUDevice, texture: GPUTexture, stops: number): void {
    const cached = pipelines.get(device) ?? new Map<number, GPUComputePipeline>();
    pipelines.set(device, cached);
    let pipeline = cached.get(stops);
    if (!pipeline) {
        const module = device.createShaderModule({ label: "sternenheer:milkyway-mipmaps", code: downsample });
        pipeline = device.createComputePipeline({
            label: "sternenheer:milkyway-mipmaps",
            layout: "auto",
            compute: { module, entryPoint: "shMilkyWayDown", constants: { SH_STOPS: stops } },
        });
        cached.set(stops, pipeline);
    }
    const encoder = device.createCommandEncoder({ label: "sternenheer:milkyway-mipmaps" });
    for (let level = 1; level < texture.mipLevelCount; level++) {
        const view = (baseMipLevel: number) => texture.createView({ baseMipLevel, mipLevelCount: 1 });
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: view(level - 1) },
                { binding: 1, resource: view(level) },
            ],
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(
            Math.ceil(Math.max(1, texture.width >> level) / 8),
            Math.ceil(Math.max(1, texture.height >> level) / 8),
        );
        pass.end();
    }
    device.queue.submit([encoder.finish()]);
}

/** Uploads a decoded map: the package's encoding by default, or the luminance and stops given. An sRGB-encoded map,
 *  `stops` 0, the shader reads linear. A logarithmic map gets mipmaps, a third more memory, so a view of the whole sky
 *  averages its light instead of picking texels. */
export function createMilkyWay(
    device: GPUDevice,
    image: MilkyWayImage,
    { luminance, stops = 0 }: Omit<MilkyWayFiles, "url" | "width"> = SHIPPED,
): MilkyWay {
    const { width, height } = image;
    const mipLevelCount = stops > 0 ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    const texture = device.createTexture({
        label: "sternenheer:milkyway",
        size: [width, height],
        format: stops > 0 ? "rgba8unorm" : "rgba8unorm-srgb",
        mipLevelCount,
        usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT |
            (mipLevelCount > 1 ? GPUTextureUsage.STORAGE_BINDING : 0),
    });
    if ("data" in image)
        device.queue.writeTexture({ texture }, image.data, { bytesPerRow: width * 4 }, [width, height]);
    else device.queue.copyExternalImageToTexture({ source: image }, { texture }, [width, height]);
    if (mipLevelCount > 1) fillMipmaps(device, texture, stops);
    const sampler = device.createSampler({
        label: "sternenheer:milkyway",
        addressModeU: "repeat",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
    });
    return { texture, sampler, luminance, stops, destroy: () => texture.destroy() };
}

/** Fetches, decodes and uploads a map, the small shipped one by default. A map not built yet throws, naming the
 *  command that builds it. */
export async function loadMilkyWay(device: GPUDevice, files: MilkyWayFiles = MILKY_WAY_MAPS.small): Promise<MilkyWay> {
    const response = await fetch(files.url).catch(() => null);
    // A static server's fallback page is no map either.
    if (!response?.ok || response.headers.get("content-type")?.startsWith("text/html"))
        throw new Error(
            `sternenheer: no Milky Way map at ${files.url}${files.build ? `; build it with ${files.build}` : ""}`,
        );
    const image = await createImageBitmap(await response.blob(), {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
    });
    return createMilkyWay(device, image, files);
}
