/** Reads a scanline OpenEXR file, a path or its bytes, into interleaved floats of `channels`, red, green, blue by default. */
export function readExr(
    file: string | Uint8Array,
    channels?: readonly string[],
): { width: number; height: number; data: Float32Array };
