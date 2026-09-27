/**
 * Reading a LUT back to the CPU. Not needed to render, but needed to look at one: the site turns these
 * into downloadable images, and the tests assert on actual texel values rather than on a screenshot.
 */

/** Decodes one IEEE 754 binary16 value. WebGPU has no float16 typed array, so the bits arrive as a u16. */
function decodeHalf(bits: number): number {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x3ff;

    // Subnormals, including zero: no implicit leading one, fixed exponent.
    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 31) return mantissa === 0 ? sign * Infinity : Number.NaN;

    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

export interface TexturePixels {
    width: number;
    height: number;
    /** Tightly packed RGBA, four floats per texel, row major. */
    data: Float32Array;
}

/**
 * Copies one layer of an `rgba16float` or `rgba32float` texture back and decodes it, e.g. a face of a cube map. The
 * texture must have been created with `COPY_SRC`; every LUT this package makes is.
 *
 * Rows are padded to 256 bytes in the intermediate buffer, as WebGPU requires, and unpacked here, so the
 * returned data is tightly packed regardless of width.
 */
export async function readTexture(device: GPUDevice, texture: GPUTexture, layer = 0): Promise<TexturePixels> {
    const { width, height } = texture;
    const full = texture.format === "rgba32float";
    const bytesPerTexel = full ? 16 : 8;
    const bytesPerRow = Math.ceil((width * bytesPerTexel) / 256) * 256;

    const buffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = device.createCommandEncoder({ label: "dunstkreis:readback" });
    encoder.copyTextureToBuffer(
        { texture, origin: { x: 0, y: 0, z: layer } },
        { buffer, bytesPerRow },
        { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);

    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = buffer.getMappedRange().slice(0);
    buffer.unmap();
    buffer.destroy();

    const data = new Float32Array(width * height * 4);
    const perRow = bytesPerRow / (full ? 4 : 2);
    const raw = full ? new Float32Array(bytes) : new Uint16Array(bytes);
    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width * 4; ++x) {
            const value = raw[y * perRow + x] as number;
            data[y * width * 4 + x] = full ? value : decodeHalf(value);
        }
    }

    return { width, height, data };
}
