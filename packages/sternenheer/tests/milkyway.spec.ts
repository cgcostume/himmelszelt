import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import {
    createMilkyWay,
    createStarsPass,
    MILKY_WAY_LUMINANCE,
    MILKY_WAY_MAPS,
    MILKY_WAY_STOPS,
    type MilkyWay,
    type MilkyWayFiles,
    type MilkyWayImage,
} from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

const DEG = Math.PI / 180;

/** A camera looking along `forward` in ENU, a field of view of `fov` radians high and wide. */
function camera(forward: readonly number[], fov: number): Float32Array {
    const [x = 0, y = 0, z = 0] = forward;
    const horizontal = Math.hypot(x, y);
    const right = [y / horizontal, -x / horizontal, 0];
    const up = [-z * (x / horizontal), -z * (y / horizontal), horizontal];
    const t = Math.tan(fov / 2);
    return new Float32Array([...right.map((c) => c * t), 0, ...up.map((c) => c * t), 0, 0, 0, 0, 1, x, y, z, 0]);
}

/** The direction of a right ascension and declination in degrees, under the default rotation: J2000 is ENU. */
const towards = (ra: number, de: number) => [
    Math.cos(de * DEG) * Math.cos(ra * DEG),
    Math.cos(de * DEG) * Math.sin(ra * DEG),
    Math.sin(de * DEG),
];

/** The Milky Way alone, in cd/m², along `forward` over a square `size` pixels across, read back. */
async function drawMilkyWay(
    device: GPUDevice,
    milkyWay: MilkyWay,
    forward: readonly number[],
    fov: number,
    size: number,
) {
    // One star, too faint to show.
    const pass = await createStarsPass(device, {
        format: "rgba32float",
        catalog: { count: 1, data: new Float32Array([30, 0, -89, 0, 0, 1, 1, 1]), compact: false },
        milkyWay,
        toneMap: false,
        background: false,
    });
    pass.update({ ev100: -Math.log2(1.2), halo: 0, inverseViewProjection: camera(forward, fov) });
    const target = device.createTexture({
        size: [size, size],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const read = device.createBuffer({
        size: size * size * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    pass.encode(encoder, target);
    encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: size * 16 }, [size, size]);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const pixels = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    read.destroy();
    target.destroy();
    pass.destroy();
    return pixels;
}

const green = (pixels: Float32Array, size: number, x: number, y: number) => pixels[(y * size + x) * 4 + 1] ?? 0;
const meanGreen = (pixels: Float32Array) =>
    pixels.filter((_, i) => i % 4 === 1).reduce((a, b) => a + b, 0) / (pixels.length / 4);

/** A map's RGBA bytes, black but where `paint` says otherwise. */
function blankMap(width: number, height: number, paint: (x: number, y: number) => number): MilkyWayImage {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const v = paint(x, y);
            if (v > 0) data.fill(v, (y * width + x) * 4, (y * width + x) * 4 + 3);
            data[(y * width + x) * 4 + 3] = 255;
        }
    return { width, height, data };
}

test("a view of a wide sky reads the mean of the light from the mipmaps, not the mean of the logarithms", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    // Columns of value 1 and of black in turn: half the light where many fall into a pixel.
    const map = createMilkyWay(
        device,
        blankMap(2048, 1024, (x) => (x % 2 === 0 ? 255 : 0)),
    );
    const size = 16;
    const wide = await drawMilkyWay(device, map, towards(0, 0), 90 * DEG, size);
    expect(green(wide, size, 8, 8) / MILKY_WAY_LUMINANCE).toBeCloseTo(0.5, 1);
    // Half a texel to a pixel resolves the columns again, read between the texels in logarithms.
    const near = await drawMilkyWay(device, map, towards(0, 0), (360 / 2048) * 8 * DEG, size);
    const lit = Array.from({ length: size }, (_, x) => green(near, size, x, 8) / MILKY_WAY_LUMINANCE);
    expect(Math.max(...lit) / Math.min(...lit)).toBeGreaterThan(30);
    map.destroy();
});

/** A built map's file decoded by sharp into RGBA bytes, null where it is not built. */
async function decode(files: MilkyWayFiles): Promise<MilkyWayImage | null> {
    const path = fileURLToPath(files.url);
    if (!existsSync(path)) return null;
    const { data, info } = await sharp(path, { limitInputPixels: false })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

test("the 8K map, where built, shows the sky the 4K map does, on both sides of its middle", async () => {
    test.setTimeout(120_000);
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const files = MILKY_WAY_MAPS["8k"];
    const image = await decode(files);
    test.skip(image === null, `not built: ${files.build}`);
    const reference = await decode(MILKY_WAY_MAPS.large);
    if (!image || !reference) return;
    const [large, map] = [createMilkyWay(device, reference), createMilkyWay(device, image)];
    expect([map.stops, map.texture.width, map.texture.mipLevelCount]).toEqual([MILKY_WAY_STOPS, files.width, 14]);
    // Around Deneb in the right half, around Canopus' Milky Way in the left, both 4° across at 64 pixels: a pixel
    // spans 3.75 arcminutes, the 4K map's level 0, so both maps blur the same stars away.
    for (const [ra, de] of [
        [310, 42],
        [120, -45],
    ] as const) {
        const view = [towards(ra, de), 4 * DEG, 64] as const;
        const [a, b] = [await drawMilkyWay(device, large, ...view), await drawMilkyWay(device, map, ...view)];
        expect(meanGreen(b) / meanGreen(a)).toBeGreaterThan(0.9);
        expect(meanGreen(b) / meanGreen(a)).toBeLessThan(1.1);
    }
    large.destroy();
    map.destroy();
});
