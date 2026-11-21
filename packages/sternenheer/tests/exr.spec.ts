import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { readExr } from "../scripts/exr.mjs";

const CACHE = fileURLToPath(new URL("../node_modules/.cache/sternenheer/", import.meta.url));

/** SHA-256 of the floats ImageMagick 7.1.2 (Q16 HDRI) decoded from NASA's files, rounded to half floats and back. */
const MAGICK = {
    "milkyway_2020_4k.exr": "95cae6db3bbbe9c9bd16c86268b50a912dfc6457d075b2b01aa7ab5ead45b1c3",
    "milkyway_2020_8k.exr": "50d1d2ddc4dc4071925e7cb8ae67fe70d767286fc221a621bb6ab5e11fb1979e",
    "hiptyc_2020_4k.exr": "5af32da3f882f220e5eecbd8e8e8f0aa43dcc131d1c5cdca242709835433efb4",
};

for (const [name, sha] of Object.entries(MAGICK)) {
    test(`${name} decodes to ImageMagick's half floats, bit for bit`, () => {
        test.setTimeout(120_000);
        test.skip(!existsSync(CACHE + name), `${name} is not in the download cache`);
        const { data } = readExr(CACHE + name);
        expect(createHash("sha256").update(new Uint8Array(data.buffer)).digest("hex")).toBe(sha);
    });
}

/** An OpenEXR file of half floats, ZIP compressed as NASA's are, written here the way OpenEXR does. */
function writeExr(width: number, height: number, channels: Record<string, Uint16Array>): Uint8Array {
    const names = Object.keys(channels).sort();
    const parts: Buffer[] = [Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0])];
    const attribute = (name: string, type: string, value: Buffer) => {
        const size = Buffer.alloc(4);
        size.writeInt32LE(value.length);
        parts.push(Buffer.from(`${name}\0${type}\0`, "latin1"), size, value);
    };
    const int32 = (...values: number[]) => Buffer.from(new Int32Array(values).buffer);
    attribute(
        "channels",
        "chlist",
        Buffer.concat([...names.flatMap((n) => [Buffer.from(`${n}\0`), int32(1, 0, 1, 1)]), Buffer.from([0])]),
    );
    attribute("compression", "compression", Buffer.from([3]));
    attribute("dataWindow", "box2i", int32(0, 0, width - 1, height - 1));
    attribute("displayWindow", "box2i", int32(0, 0, width - 1, height - 1));
    attribute("lineOrder", "lineOrder", Buffer.from([0]));
    attribute("pixelAspectRatio", "float", Buffer.from(new Float32Array([1]).buffer));
    parts.push(Buffer.from([0]));
    const chunks: Buffer[] = [];
    for (let y0 = 0; y0 < height; y0 += 16) {
        const rows = Math.min(16, height - y0);
        const raw = Buffer.alloc(rows * names.length * width * 2);
        for (let r = 0, at = 0; r < rows; r++)
            for (const n of names)
                for (let x = 0; x < width; x++, at += 2)
                    raw.writeUInt16LE(channels[n]?.[(y0 + r) * width + x] ?? 0, at);
        const split = Buffer.alloc(raw.length);
        const half = (raw.length + 1) >> 1;
        for (let i = 0; i < raw.length; i++) split[(i & 1 ? half : 0) + (i >> 1)] = raw[i] ?? 0;
        for (let i = split.length - 1; i > 0; i--) split[i] = ((split[i] ?? 0) - (split[i - 1] ?? 0) + 128 + 256) & 255;
        const packed = deflateSync(split);
        chunks.push(Buffer.concat([int32(y0, packed.length), packed]));
    }
    const header = Buffer.concat(parts);
    const table = Buffer.alloc(8 * chunks.length);
    let offset = header.length + table.length;
    chunks.forEach((chunk, i) => {
        table.writeBigUInt64LE(BigInt(offset), 8 * i);
        offset += chunk.length;
    });
    return Buffer.concat([header, table, ...chunks]);
}

test("a ZIP compressed EXR of half floats reads back every value, normals, subnormals, infinities and signs", () => {
    const [width, height] = [37, 21];
    const bits = (k: number) =>
        Uint16Array.from({ length: width * height }, (_, i) => (i * 2654435761 + k * 977) >>> 16);
    const channels = { R: bits(1), G: bits(2), B: bits(3), A: bits(4) };
    const { width: w, height: h, data } = readExr(writeExr(width, height, channels), ["R", "G", "B"]);
    expect([w, h, data.length]).toEqual([width, height, width * height * 3]);
    const half = (b: number) => {
        const [e, m] = [(b >> 10) & 31, b & 1023];
        const v =
            e === 0
                ? m * 2 ** -24
                : e === 31
                  ? m
                      ? Number.NaN
                      : Number.POSITIVE_INFINITY
                  : (1 + m / 1024) * 2 ** (e - 15);
        return b & 0x8000 ? -v : v;
    };
    for (let i = 0; i < width * height; i++)
        for (const [k, c] of [channels.R, channels.G, channels.B].entries())
            expect(
                Object.is(data[i * 3 + k], half(c[i] ?? 0)) ||
                    (Number.isNaN(data[i * 3 + k]) && Number.isNaN(half(c[i] ?? 0))),
            ).toBe(true);
});
