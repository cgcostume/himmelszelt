/**
 * Float RGBA pixels, row after row from the top, as the bytes of a Radiance HDR file: RGBE, a shared exponent for the
 * three channels, in flat scanlines, which every reader takes. Alpha is dropped.
 */
export function encodeRgbe(pixels: Float32Array, width: number, height: number): Uint8Array<ArrayBuffer> {
    const header = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
    const bytes = new Uint8Array(header.length + width * height * 4);
    bytes.set(header);
    for (let i = 0, o = header.length; i < width * height * 4; i += 4, o += 4) {
        const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]].map((c = 0) => Math.max(c, 0)) as [
            number,
            number,
            number,
        ];
        const top = Math.max(r, g, b);
        if (!(top > 1e-32)) continue;
        // The exponent e with top / 2^e in [0.5, 1), as frexp gives it.
        let e = Math.floor(Math.log2(top)) + 1;
        if (top / 2 ** e >= 1) e += 1;
        const scale = 256 / 2 ** e;
        bytes.set([r * scale, g * scale, b * scale, e + 128], o);
    }
    return bytes;
}

/** Decoded pixels: rgba floats, row after row from the top, alpha 1. */
export interface RgbeImage {
    width: number;
    height: number;
    pixels: Float32Array<ArrayBuffer>;
}

/**
 * The pixels of a Radiance HDR file, flat or run-length encoded by scanline, as HDRIs are shared. Only the usual layout,
 * rows from the top and columns from the left. The file's `EXPOSURE` lines are left out of it, as most tools do.
 */
export function decodeRgbe(file: ArrayBuffer | Uint8Array): RgbeImage {
    const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
    let at = 0;
    const line = () => {
        const start = at;
        while (at < bytes.length && bytes[at] !== 10) at += 1;
        at += 1;
        return new TextDecoder().decode(bytes.subarray(start, at - 1));
    };
    if (!line().startsWith("#?")) throw new Error("rundbild: not a Radiance HDR file");
    let format = "";
    for (let text = line(); text !== ""; text = line()) {
        if (at >= bytes.length) throw new Error("rundbild: a Radiance HDR file without pixels");
        if (text.startsWith("FORMAT=")) format = text.slice(7).trim();
    }
    if (format !== "32-bit_rle_rgbe")
        throw new Error(`rundbild: Radiance HDR format ${format || "unnamed"} is not RGBE`);
    const size = /^-Y (\d+) \+X (\d+)$/.exec(line().trim());
    if (!size) throw new Error("rundbild: only Radiance HDR rows from the top and columns from the left");
    const height = Number(size[1]);
    const width = Number(size[2]);
    const pixels = new Float32Array(width * height * 4);
    const scanline = new Uint8Array(width * 4);
    for (let y = 0; y < height; ++y) {
        const rle =
            width >= 8 &&
            width < 32768 &&
            bytes[at] === 2 &&
            bytes[at + 1] === 2 &&
            ((bytes[at + 2] as number) << 8) + (bytes[at + 3] as number) === width;
        if (rle) {
            at += 4;
            // Four runs, one channel after the other.
            for (let channel = 0; channel < 4; ++channel) {
                for (let x = 0; x < width; ) {
                    const count = bytes[at++] as number;
                    if (count > 128) {
                        scanline.fill(bytes[at++] as number, channel * width + x, channel * width + x + count - 128);
                        x += count - 128;
                    } else {
                        scanline.set(bytes.subarray(at, at + count), channel * width + x);
                        at += count;
                        x += count;
                    }
                }
            }
        }
        for (let x = 0; x < width; ++x) {
            const channel = (c: number) => (rle ? scanline[c * width + x] : bytes[at + x * 4 + c]) as number;
            const e = channel(3);
            const scale = e === 0 ? 0 : 2 ** (e - 136);
            const o = (y * width + x) * 4;
            pixels[o] = (channel(0) + (e ? 0.5 : 0)) * scale;
            pixels[o + 1] = (channel(1) + (e ? 0.5 : 0)) * scale;
            pixels[o + 2] = (channel(2) + (e ? 0.5 : 0)) * scale;
            pixels[o + 3] = 1;
        }
        if (!rle) at += width * 4;
    }
    return { width, height, pixels };
}
