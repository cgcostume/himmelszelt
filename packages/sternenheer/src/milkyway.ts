// The Milky Way's map on the GPU, and the one the package ships.

/** Where a map lies, with its width in texels and the luminance in cd/m² a texel of value 1 stands for. */
export interface MilkyWayFiles {
    url: string | URL;
    width: number;
    luminance: number;
}

/** A texel of value 1 of the shipped maps, in cd/m², as `scripts/milkyway.mjs` calibrated it: the map plus the
 *  shipped catalog match the integrated starlight Masana et al. (2021) give for the zenith of 40° N over a year. */
export const MILKY_WAY_LUMINANCE = 1.7561e-3;

/**
 * The maps the package ships, made by `pnpm milkyway` from NASA's Deep Star Maps 2020: the light of the stars fainter
 * than the Hipparcos and Tycho stars, from Gaia DR2, in J2000 equatorial coordinates, plate carrée with right ascension
 * increasing to the left, sRGB-encoded. `small` 2048 texels around, 490 KB, a texel 10 arcminutes, enough for a view
 * of the whole sky; `large` 4096, 2.6 MB, for zooming in. Resolved next to the package's own files, which bundlers that
 * know `new URL(..., import.meta.url)` copy along.
 */
export const MILKY_WAY_MAPS: { small: MilkyWayFiles; large: MilkyWayFiles } = {
    small: { url: new URL("../data/milkyway-2k.webp", import.meta.url), width: 2048, luminance: MILKY_WAY_LUMINANCE },
    large: { url: new URL("../data/milkyway-4k.webp", import.meta.url), width: 4096, luminance: MILKY_WAY_LUMINANCE },
};

/** A map uploaded: its texture, sRGB-encoded so the shader reads it linear, the sampler and its luminance. */
export interface MilkyWay {
    readonly texture: GPUTexture;
    readonly sampler: GPUSampler;
    readonly luminance: number;
    destroy(): void;
}

/** Uploads a decoded map, `createImageBitmap` of its file with `colorSpaceConversion: "none"`. */
export function createMilkyWay(device: GPUDevice, image: ImageBitmap, luminance = MILKY_WAY_LUMINANCE): MilkyWay {
    const texture = device.createTexture({
        label: "sternenheer:milkyway",
        size: [image.width, image.height],
        format: "rgba8unorm-srgb",
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
    return { texture, sampler, luminance, destroy: () => texture.destroy() };
}

/** Fetches, decodes and uploads a map, the small shipped one by default. */
export async function loadMilkyWay(device: GPUDevice, files: MilkyWayFiles = MILKY_WAY_MAPS.small): Promise<MilkyWay> {
    const blob = await (await fetch(files.url)).blob();
    const image = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    return createMilkyWay(device, image, files.luminance);
}
