// A small OpenEXR reader for the files NASA's Scientific Visualization Studio publishes: scanline images, uncompressed,
// ZIPS or ZIP compressed, channels of half, float or uint. No tiles, deep data, multiple parts or subsampling.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const COMPRESSIONS = { 0: ["none", 1], 2: ["zips", 1], 3: ["zip", 16] };
const PIXEL_BYTES = [4, 2, 4];

/** Every half float's value, by its bits. */
const HALF = (() => {
    const table = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
        const [sign, exponent, mantissa] = [h >> 15 ? -1 : 1, (h >> 10) & 31, h & 1023];
        table[h] =
            exponent === 0
                ? sign * mantissa * 2 ** -24
                : exponent === 31
                  ? mantissa
                      ? Number.NaN
                      : sign * Number.POSITIVE_INFINITY
                  : sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
    }
    return table;
})();

function header(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 20000630) throw new Error("not an OpenEXR file");
    const flags = view.getUint32(4, true);
    if (flags & 0x1a00) throw new Error("tiled, deep or multi-part OpenEXR files are not supported");
    let at = 8;
    const string = () => {
        const end = bytes.indexOf(0, at);
        const text = bytes.toString("latin1", at, end);
        at = end + 1;
        return text;
    };
    const attributes = {};
    for (let name = string(); name !== ""; name = string()) {
        const type = string();
        const size = view.getInt32(at, true);
        attributes[name] = { type, at: at + 4, size };
        at += 4 + size;
    }
    const channels = [];
    const list = attributes.channels;
    for (at = list.at; bytes[at] !== 0; ) {
        const name = string();
        const [type, xSampling, ySampling] = [
            view.getInt32(at, true),
            view.getInt32(at + 8, true),
            view.getInt32(at + 12, true),
        ];
        if (xSampling !== 1 || ySampling !== 1) throw new Error(`channel ${name} is subsampled`);
        channels.push({ name, type });
        at += 16;
    }
    const box = attributes.dataWindow.at;
    const [xMin, yMin, xMax, yMax] = [0, 4, 8, 12].map((k) => view.getInt32(box + k, true));
    const compression = COMPRESSIONS[bytes[attributes.compression.at]];
    if (!compression) throw new Error(`compression ${bytes[attributes.compression.at]} is not supported`);
    const end = Math.max(...Object.values(attributes).map((a) => a.at + a.size)) + 1;
    return { view, channels, width: xMax - xMin + 1, height: yMax - yMin + 1, yMin, compression, end };
}

/** Undoes the ZIP predictor and the split of every chunk's bytes into their even and odd halves. */
function unpredict(packed) {
    for (let i = 1; i < packed.length; i++) packed[i] = (packed[i - 1] + packed[i] - 128) & 255;
    const out = Buffer.allocUnsafe(packed.length);
    const half = (packed.length + 1) >> 1;
    for (let i = 0, k = 0; i < packed.length; k++) {
        out[i++] = packed[k];
        if (i < packed.length) out[i++] = packed[half + k];
    }
    return out;
}

/**
 * Reads an OpenEXR file, a path or its bytes, into floats: `channels` in that order, interleaved, row after row from the
 * top, as `{ width, height, data }`; by default red, green and blue, whichever order the file stores them in.
 */
export function readExr(file, channels = ["R", "G", "B"]) {
    const bytes =
        typeof file === "string" ? readFileSync(file) : Buffer.from(file.buffer, file.byteOffset, file.length);
    const { view, channels: stored, width, height, yMin, compression, end } = header(bytes);
    const [kind, lines] = compression;
    const places = channels.map((name) => {
        const k = stored.findIndex((channel) => channel.name === name);
        if (k < 0) throw new Error(`no channel ${name}: ${stored.map((channel) => channel.name).join(", ")}`);
        return k;
    });
    const rowBytes = stored.map((channel) => width * PIXEL_BYTES[channel.type]);
    const lineBytes = rowBytes.reduce((a, b) => a + b, 0);
    const data = new Float32Array(width * height * channels.length);
    const chunks = Math.ceil(height / lines);
    for (let c = 0; c < chunks; c++) {
        const offset = Number(view.getBigUint64(end + c * 8, true));
        const y0 = view.getInt32(offset, true) - yMin;
        const size = view.getInt32(offset + 4, true);
        const rows = Math.min(lines, height - y0);
        const packed = bytes.subarray(offset + 8, offset + 8 + size);
        const block =
            kind === "none" || size === rows * lineBytes ? packed : unpredict(Buffer.from(inflateSync(packed)));
        if (block.length !== rows * lineBytes)
            throw new Error(`chunk ${c}: ${block.length} bytes, not ${rows * lineBytes}`);
        const blockView = new DataView(block.buffer, block.byteOffset, block.byteLength);
        for (let r = 0; r < rows; r++) {
            const y = y0 + r;
            places.forEach((k, j) => {
                let at = r * lineBytes + rowBytes.slice(0, k).reduce((a, b) => a + b, 0);
                const type = stored[k].type;
                for (let x = 0, i = y * width * channels.length + j; x < width; x++, i += channels.length) {
                    data[i] =
                        type === 1
                            ? HALF[blockView.getUint16(at, true)]
                            : type === 2
                              ? blockView.getFloat32(at, true)
                              : blockView.getUint32(at, true);
                    at += PIXEL_BYTES[type];
                }
            });
        }
    }
    return { width, height, data };
}
