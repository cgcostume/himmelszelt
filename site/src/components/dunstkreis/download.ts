/** Downloads for the tables and cube maps: PNG as shown, tone mapped, and Radiance HDR with the values themselves. */

function save(blob: Blob | null, name: string) {
    if (!blob) return;
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

/** Saves 8-bit RGBA pixels, row after row from the top, as a PNG. */
export function savePng(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, name: string) {
    const canvas = Object.assign(document.createElement("canvas"), { width, height });
    canvas.getContext("2d")?.putImageData(new ImageData(pixels, width, height), 0, 0);
    canvas.toBlob((blob) => save(blob, `${name}.png`), "image/png");
}

/**
 * Saves float RGBA pixels, row after row from the top, as Radiance HDR: RGBE, a shared exponent for the three channels,
 * in flat scanlines, which every reader takes. Alpha is dropped.
 */
export function saveHdr(pixels: Float32Array, width: number, height: number, name: string) {
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
    save(new Blob([bytes], { type: "image/vnd.radiance" }), `${name}.hdr`);
}

/** A byte count as it reads best: exact, with the binary unit it rounds to. */
export function formatBytes(bytes: number) {
    const units = ["bytes", "KiB", "MiB", "GiB"];
    const unit = Math.min(Math.floor(Math.log2(Math.max(bytes, 1)) / 10), units.length - 1);
    const rounded =
        unit === 0 ? "" : ` (${(bytes / 1024 ** unit).toFixed(bytes % 1024 ** unit ? 1 : 0)} ${units[unit]})`;
    return `${bytes.toLocaleString("en")} bytes${rounded}`;
}
