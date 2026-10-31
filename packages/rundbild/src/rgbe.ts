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
