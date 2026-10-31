import { encodeRgbe } from "@himmelszelt/rundbild";

/** Downloads for the tables and cube maps: PNG as shown, tone mapped, and Radiance HDR with the values themselves. */

export function save(blob: Blob | null, name: string) {
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

/** Saves float RGBA pixels, row after row from the top, as Radiance HDR. */
export function saveHdr(pixels: Float32Array, width: number, height: number, name: string) {
    save(new Blob([encodeRgbe(pixels, width, height)], { type: "image/vnd.radiance" }), `${name}.hdr`);
}

/** A byte count as it reads best: exact, with the binary unit it rounds to. */
export function formatBytes(bytes: number) {
    const units = ["bytes", "KiB", "MiB", "GiB"];
    const unit = Math.min(Math.floor(Math.log2(Math.max(bytes, 1)) / 10), units.length - 1);
    const rounded =
        unit === 0 ? "" : ` (${(bytes / 1024 ** unit).toFixed(bytes % 1024 ** unit ? 1 : 0)} ${units[unit]})`;
    return `${bytes.toLocaleString("en")} bytes${rounded}`;
}
