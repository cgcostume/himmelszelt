import { expect, test } from "@playwright/test";
import {
    createStarsPass,
    type DeepStars,
    deepStarBlocks,
    deepStarsFromBuffer,
    type FaintStar,
    illuminanceFromMagnitude,
    packStars,
    type StarsParams,
} from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

const DEG = Math.PI / 180;
const BLOCK = 64;

/** Cells of stars as `scripts/tycho.mjs` writes them: a header, each cell's count, blocks, middle and reach, the blocks. */
function deepFile(cells: { stars: FaintStar[]; center: [number, number, number]; radius: number }[]): ArrayBuffer {
    const blocks = cells.map(({ stars }) => Math.ceil(stars.length / BLOCK));
    const total = blocks.reduce((a, b) => a + b, 0);
    const buffer = new ArrayBuffer((8 + cells.length * 6 + total * BLOCK * 2) * 4);
    const view = new DataView(buffer);
    const count = cells.reduce((sum, { stars }) => sum + stars.length, 0);
    for (const [i, word] of [0x53444853, 1, count, BLOCK, total, cells.length, 0, 0].entries())
        view.setUint32(i * 4, word, true);
    let at = 32;
    cells.forEach(({ stars, center, radius }, cell) => {
        view.setUint32(at, stars.length, true);
        view.setUint32(at + 4, blocks[cell] ?? 0, true);
        for (const [i, c] of [...center, radius].entries()) view.setFloat32(at + 8 + i * 4, c, true);
        at += 24;
    });
    cells.forEach(({ stars }, cell) => {
        const words = packStars([...stars].sort((a, b) => a.magnitude - b.magnitude)).data;
        for (let i = 0; i < (blocks[cell] ?? 0) * BLOCK * 2; i++)
            view.setUint32(at + i * 4, words[i] ?? 0xffffffff, true);
        at += (blocks[cell] ?? 0) * BLOCK * 8;
    });
    return buffer;
}

// A hundred stars of magnitude 9 to 11 within half a degree of the equinox, and 200 on the far side of the sky.
const cluster = (n: number, rightAscension: number): FaintStar[] =>
    Array.from({ length: n }, (_, i) => ({
        magnitude: 9 + (i % 9) * 0.25,
        rightAscension: (rightAscension + 0.5 * Math.cos(i * 2.4) * Math.sqrt(i / n) + 360) % 360,
        declination: 0.5 * Math.sin(i * 2.4) * Math.sqrt(i / n),
        colorIndex: 0.3 + (i % 5) * 0.2,
    }));
const near = cluster(100, 0);
const stars = deepStarsFromBuffer(
    deepFile([
        { stars: near, center: [1, 0, 0], radius: 0.01 },
        { stars: cluster(200, 180), center: [-1, 0, 0], radius: 0.01 },
    ]),
);

// The identity rotation puts the equinox east on the horizon: a view of 10° towards it.
const [WIDTH, HEIGHT, FOV] = [256, 256, 10 * DEG];
const tangent = Math.tan(FOV / 2);
const east = { inverseViewProjection: new Float32Array([0, -tangent, 0, 0, 0, 0, tangent, 0, 0, 0, 0, 1, 1, 0, 0, 0]) };

test("deep stars read back in blocks by cell, brightest first, with each cell's depth by magnitude", () => {
    expect(stars.count).toBe(300);
    expect(stars.blocks).toBe(2 + 4);
    expect([...stars.cellBlocks]).toEqual([0, 2, 6]);
    expect(stars.brightest).toBe(9);
    // A cell's last block is filled up with empty stars.
    expect(stars.data[100 * 2]).toBe(0xffffffff);
    // Up to magnitude 9.2 the first cell's 12 stars of magnitude 9 lie in one block, all hundred by 11 in two.
    const step = (magnitude: number) => Math.floor((magnitude + 2) * 4);
    expect(stars.cellDepths[step(8.9)]).toBe(0);
    expect(stars.cellDepths[step(9.2)]).toBe(1);
    expect(stars.cellDepths[step(11)]).toBe(2);
});

test("a frame draws the blocks of the cells in view only, as deep as it is asked to", () => {
    const params = {
        ...east,
        skyRotation: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
        projectionDistance: 0,
        horizonZ: -1,
        air: null,
    };
    const blocks = new Uint32Array(stars.blocks);
    const drawn = (limit: number, more: object = {}) =>
        deepStarBlocks(stars, { ...params, ...more } as StarsParams, HEIGHT, limit, blocks).count;
    expect(drawn(99)).toBe(2);
    expect([...blocks.subarray(0, 2)]).toEqual([0, 1]);
    expect(drawn(9.2)).toBe(1);
    expect(drawn(8)).toBe(0);
    // Looking west the other cell's four blocks, and none of a cell under the horizon.
    const west = new Float32Array([0, tangent, 0, 0, 0, 0, tangent, 0, 0, 0, 0, 1, -1, 0, 0, 0]);
    expect(drawn(99, { inverseViewProjection: west })).toBe(4);
    expect(drawn(99, { horizonZ: 0.1 })).toBe(0);
});

test("the deep stars' light adds up on the target, whether or not a star alone shows", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const pass = await createStarsPass(device, {
        format: "rgba32float",
        // One far star, so the pass draws stars at all.
        catalog: { count: 1, data: new Float32Array([20, 180, 0, 0, 0, 1, 1, 1]), compact: false },
        deepStars: stars as DeepStars,
        toneMap: false,
        background: false,
    });
    // Exposed so the brightest reaches a quarter of the threshold, and as a deep night, each one drawn.
    const exposures = [1.6, -6];
    const bytes = WIDTH * HEIGHT * 16;
    const readback = device.createBuffer({
        size: bytes * exposures.length,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    exposures.forEach((displayEV100, i) => {
        const target = device.createTexture({
            size: [WIDTH, HEIGHT],
            format: "rgba32float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        // Written in cd/m²: an exposure of 1.
        pass.update({ ...east, ev100: -Math.log2(1.2), displayEV100, halo: 0 });
        const encoder = device.createCommandEncoder();
        pass.encode(encoder, target);
        encoder.copyTextureToBuffer(
            { texture: target },
            { buffer: readback, offset: i * bytes, bytesPerRow: WIDTH * 16 },
            [WIDTH, HEIGHT],
        );
        device.queue.submit([encoder.finish()]);
    });
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Float32Array(readback.getMappedRange());
    // A pixel's solid angle at the middle of the view, where the stars stand.
    const solidAngle = ((2 * tangent) / HEIGHT) ** 2;
    const lux = near.reduce((sum, { magnitude }) => sum + illuminanceFromMagnitude(Math.round(magnitude * 16) / 16), 0);
    exposures.forEach((_, i) => {
        let sum = 0;
        let lit = 0;
        for (let p = 0; p < WIDTH * HEIGHT; p++) {
            const [r, g, b] = [0, 1, 2].map((c) => pixels[(i * WIDTH * HEIGHT + p) * 4 + c] ?? 0);
            sum += 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
            if ((g ?? 0) > 0) lit++;
        }
        expect(sum * solidAngle).toBeGreaterThan(lux * 0.99);
        expect(sum * solidAngle).toBeLessThan(lux * 1.01);
        // A star under the threshold lights the four pixels around it, one above it nine and more, where none overlap.
        expect(lit).toBeGreaterThan(i === 0 ? 200 : 500);
        expect(lit).toBeLessThan(i === 0 ? 401 : 100 * 49 + 1);
    });
    pass.destroy();
});
