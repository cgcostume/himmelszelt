// The Milky Way's map on the GPU, and the one the package ships.

/** Where a map lies, with its width in texels, the luminance in cd/m² a texel of value 1 stands for, and the stops
 *  below 1 its 8 bits span, each channel's logarithm; 0 or none for an sRGB-encoded map. */
export interface MilkyWayFiles {
    url: string | URL;
    width: number;
    luminance: number;
    stops?: number;
}

/** A texel of value 1 of the shipped maps, in cd/m², as `scripts/milkyway.mjs` calibrated it: the map, the shipped
 *  catalog and the shipped Hipparcos stars match the integrated starlight Masana et al. (2021) give for the zenith of
 *  40° N over a year. The Hipparcos stars are a quarter of that light: a sky drawn without them lacks it. */
export const MILKY_WAY_LUMINANCE = 1.1554e-3;
/** The stops below 1 the shipped maps' 8 bits span: 255 steps of 3.3% each, so the dark sky between the clouds
 *  resolves as finely as the clouds. */
export const MILKY_WAY_STOPS = 12;

const SHIPPED = { luminance: MILKY_WAY_LUMINANCE, stops: MILKY_WAY_STOPS };

/**
 * The maps the package ships, made by `pnpm milkyway` from NASA's Deep Star Maps 2020: the light of the stars fainter
 * than the Hipparcos and Tycho stars, from Gaia DR2, in J2000 equatorial coordinates, plate carrée with right ascension
 * increasing to the left, each channel's logarithm in 8 bits, the stars that stood out as points taken out and their
 * light spread around them. `small` 2048 texels around, 810 KB, a texel 10 arcminutes, enough for a view of the whole
 * sky; `large` 4096, 4 MB, for zooming in. Resolved next to the package's own files, which bundlers that know
 * `new URL(..., import.meta.url)` copy along.
 */
export const MILKY_WAY_MAPS: { small: MilkyWayFiles; large: MilkyWayFiles } = {
    small: { url: new URL("../data/milkyway-2k.webp", import.meta.url), width: 2048, ...SHIPPED },
    large: { url: new URL("../data/milkyway-4k.webp", import.meta.url), width: 4096, ...SHIPPED },
};

/** A map uploaded: its texture, the sampler, its luminance and its stops, as `MilkyWayFiles` has them. */
export interface MilkyWay {
    readonly texture: GPUTexture;
    readonly sampler: GPUSampler;
    readonly luminance: number;
    readonly stops: number;
    destroy(): void;
}

/** Uploads a decoded map, `createImageBitmap` of its file with `colorSpaceConversion: "none"`: the shipped maps'
 *  encoding by default, or the luminance and stops given. An sRGB-encoded map, `stops` 0, the shader reads linear. */
export function createMilkyWay(
    device: GPUDevice,
    image: ImageBitmap,
    { luminance, stops = 0 }: Omit<MilkyWayFiles, "url" | "width"> = SHIPPED,
): MilkyWay {
    const texture = device.createTexture({
        label: "sternenheer:milkyway",
        size: [image.width, image.height],
        format: stops > 0 ? "rgba8unorm" : "rgba8unorm-srgb",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: image }, { texture }, [image.width, image.height]);
    const sampler = device.createSampler({
        label: "sternenheer:milkyway",
        addressModeU: "repeat",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
    });
    return { texture, sampler, luminance, stops, destroy: () => texture.destroy() };
}

/** Fetches, decodes and uploads a map, the small shipped one by default. */
export async function loadMilkyWay(device: GPUDevice, files: MilkyWayFiles = MILKY_WAY_MAPS.small): Promise<MilkyWay> {
    const blob = await (await fetch(files.url)).blob();
    const image = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    return createMilkyWay(device, image, files);
}
