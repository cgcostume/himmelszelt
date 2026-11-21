import { BLUE_NOISE_BASE64 } from "./bluenoise-data.js";

/** The blue noise' width and height in texels; it tiles over the image by `pixel % 64`. */
export const BLUE_NOISE_SIZE = 64;

let bytes: Uint8Array | undefined;
const textures = new WeakMap<GPUDevice, GPUTexture>();

/**
 * The blue noise helldunkel dithers by: 64x64 bytes, row by row, each texel's rank among all 4096 by Ulichney's
 * void-and-cluster method, scaled to 0..255. Shared, so not to be written to.
 */
export function blueNoiseData(): Uint8Array {
    bytes ??= Uint8Array.from(atob(BLUE_NOISE_BASE64), (c) => c.charCodeAt(0));
    return bytes;
}

/**
 * The blue noise as an r8unorm texture on `device`, for `hdDitherBlue` and `hdBlueNoise` in `wgsl.tonemap`: made on the
 * first call, the same texture after. Shared by every caller on the device, so never destroyed by one.
 */
export function blueNoiseTexture(device: GPUDevice): GPUTexture {
    let texture = textures.get(device);
    if (!texture) {
        texture = device.createTexture({
            label: "helldunkel:blueNoise",
            size: [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE],
            format: "r8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture }, blueNoiseData(), { bytesPerRow: BLUE_NOISE_SIZE }, [
            BLUE_NOISE_SIZE,
            BLUE_NOISE_SIZE,
        ]);
        textures.set(device, texture);
    }
    return texture;
}
