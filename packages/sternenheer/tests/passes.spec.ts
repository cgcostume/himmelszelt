import { readFileSync } from "node:fs";
import {
    airAt,
    airTable,
    createAirTexture,
    DEFAULT_ATMOSPHERE_MODEL,
    liftedDirection,
    seeingUniformData,
} from "@himmelszelt/dunstkreis";
import { expect, test } from "@playwright/test";
import { createStarsPass, illuminanceFromMagnitude, PARAMS_SIZE, paramsData, type StarsParams } from "../dist/index.js";
import { starsOutput } from "../src/wgsl/output.js";
import { compileWgsl, gpuDevice } from "./gpu.js";

/** A shader by name, this package's or one of the fragments it bundles from the packages that own them. */
function wgslSource(name: string): string {
    const helldunkel = "../../helldunkel/src/wgsl";
    const dunstkreis = "../../dunstkreis/src/wgsl";
    const owner =
        {
            camera: dunstkreis,
            air: dunstkreis,
            seeing: dunstkreis,
            glare: helldunkel,
            whitebalance: helldunkel,
            tonemap: helldunkel,
            vision: helldunkel,
        }[name] ?? "../src/wgsl";
    const read = (file: string) => readFileSync(new URL(`${owner}/${file}`, import.meta.url), "utf8");
    try {
        return read(`${name}.wgsl`);
    } catch {
        return read(`${name}.comp.wgsl`);
    }
}

// Each pass with exactly the fragments its header names, so none grows a dependency it does not declare.
const PASSES: Record<string, readonly string[]> = {
    bin: ["air", "seeing", "params", "camera", "glare", "bin", "stars"],
    compose: ["air", "seeing", "params", "camera", "glare", "whitebalance", "tonemap", "vision", "compose", "stars"],
    halo: ["air", "seeing", "params", "halo"],
    lines: ["air", "seeing", "params", "camera", "lines", "stars"],
};

for (const [name, fragments] of Object.entries(PASSES)) {
    test(`the ${name} pass compiles from its declared fragments`, async () => {
        const device = await gpuDevice();
        test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
        if (!device) return;
        const errors = await compileWgsl(device, [starsOutput("rgba8unorm"), ...fragments.map(wgslSource)].join("\n"));
        expect(errors, `${name}:\n${errors.join("\n")}`).toEqual([]);
    });
}

const DEG = Math.PI / 180;

test("the params pack to the uniform's size with the flags, the tiles' index bits and the seeing where the shader reads them", () => {
    const seeing = seeingUniformData({ speed: 7700 });
    const params = {
        skyRotation: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
        years: 26,
        inverseViewProjection: new Float32Array(16),
        projectionDistance: 0,
        ev100: -6,
        whiteBalance: [1.1, 0, 0, 0, 1, 0, 0.2, 0, 0.9],
        displayEV100: null,
        horizonZ: -0.01,
        occluder: null,
        // The texture is bound by the pass, not packed.
        air: { texture: {} as GPUTexture, horizon: -0.5 },
        psfPixels: 0.8,
        knee: 1,
        halo: 1,
        seeing,
        scintillation: 0.5,
        time: 0,
        glare: 1,
        viewerFov: 30,
        starLight: 1,
        milkyWay: 0.5,
        starCompensation: 1,
        milkyWayCompensation: -1,
        magnitudeLimit: 6.5,
        faintStars: 0,
        deepStars: 0,
        threshold: 1 / 2048,
        constellations: ["Ori", "UMa"],
        constellationOpacity: 0.3,
        constellationColor: [0.45, 0.6, 0.85],
        constellationWidth: 1.25,
        constellationGap: 7,
        maxRadius: 256,
    } satisfies StarsParams;
    const frame = { width: 640, height: 480, tileSize: 16, capacity: 64, stars: true, milkyWay: 1.7e-3, lines: true };
    const data = paramsData(params, { ...frame, indexBits: 14 });
    expect(data.byteLength).toBe(PARAMS_SIZE);
    const u = new Uint32Array(data);
    const f = new Float32Array(data);
    // The air, the Milky Way, the stars and the twinkling.
    expect(u[40]).toBe(1 + 2 + 4 + 16);
    expect(u[32]).toBe(14);
    expect(u[42]).toBe(40);
    expect(f[52]).toBeCloseTo(f[28] ?? 0, 6);
    // 640 by 480 and a margin of 64 either side at half size: 384 by 304, room for eight levels, of which a halo 0.1
    // arcminutes of a 30° field wide, a thirty-eighth of a pixel, needs two.
    expect(u[55]).toBe(2);
    // The artistic offsets in stops on the multipliers: twice the stars, half of half the Milky Way.
    expect([f[36], f[37]]).toEqual([2, 0.25]);
    // The halo's shares, finest level first, all of its light.
    const shares = Array.from(f.subarray(92, 100));
    expect(shares.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 5);
    expect(f[97]).toBe(0);
    expect(u[48]).toBe(640);
    expect(f[28]).toBeCloseTo(1 / (1.2 * 2 ** -6), 4);
    // Orion and the Great Bear, the 60th and the 83rd of the 88: a bit each.
    expect(f[59]).toBeCloseTo(0.3, 6);
    expect(u[65]).toBe(1 << (59 - 32));
    expect(u[66]).toBe(1 << (82 - 64));
    // The seeing as given, its variance by the square of the strength, the speed in orbit.
    expect(f[72]).toBeCloseTo(seeing[0] ?? 0, 9);
    expect(f[73]).toBeCloseTo((seeing[1] ?? 0) * 0.25, 9);
    expect(f[77]).toBe(7700);
    // The white balance in three padded columns.
    expect([f[80], f[84], f[88], f[90], f[83]]).toEqual([Math.fround(1.1), 0, Math.fround(0.2), Math.fround(0.9), 0]);
    // No twinkling without the air, nor without a seeing.
    expect(new Uint32Array(paramsData({ ...params, air: null }, frame))[40]).toBe(2 + 4);
    expect(new Uint32Array(paramsData({ ...params, seeing: null }, frame))[40]).toBe(1 + 2 + 4);
});

/** Draws `stars` (magnitude, right ascension, declination, all white) into a float target and reads it back. */
async function drawStars(
    device: GPUDevice,
    stars: readonly (readonly [number, number, number])[],
    size: number,
    options: { capacity?: number; toneMap?: false | "neutral"; dither?: boolean; blueNoise?: GPUTexture },
    params: Partial<StarsParams>,
): Promise<Float32Array> {
    const data = new Float32Array(stars.length * 8);
    for (const [i, [magnitude, ra, de]] of stars.entries()) data.set([magnitude, ra, de, 0, 0, 1, 1, 1], i * 8);
    const pass = await createStarsPass(device, {
        format: "rgba32float",
        catalog: { count: stars.length, data, compact: false },
        toneMap: false,
        background: false,
        ...options,
    });
    // Written in cd/m², an exposure of 1, no halos.
    pass.update({ ev100: -Math.log2(1.2), halo: 0, ...params });
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

/** A camera looking along `forward` in ENU, a field of view of `fov` radians high and wide. */
function camera(forward: readonly number[], fov: number): Float32Array {
    const [x = 0, y = 0, z = 0] = forward;
    const horizontal = Math.hypot(x, y);
    const right = [y / horizontal, -x / horizontal, 0];
    const up = [-z * (x / horizontal), -z * (y / horizontal), horizontal];
    const t = Math.tan(fov / 2);
    return new Float32Array([...right.map((c) => c * t), 0, ...up.map((c) => c * t), 0, 0, 0, 0, 1, x, y, z, 0]);
}

test("a star low over the horizon lands where dunstkreis' table lifts it, dimmed by its transmittance and squeeze", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const table = airTable(DEFAULT_ATMOSPHERE_MODEL, 0);
    const texture = createAirTexture(device, table);
    // A star of magnitude 0 truly 1° up in the east: the identity rotation puts the equinox there on the horizon.
    const truth = [Math.cos(1 * DEG), 0, Math.sin(1 * DEG)] as const;
    const shown = liftedDirection(table, truth);
    const air = airAt(table, Math.asin(shown[2]) / DEG);
    if (!air) throw new Error("the star should show");
    const [size, fov] = [64, 1 * DEG];
    const pixels = await drawStars(
        device,
        [[0, 0, 1]],
        size,
        {},
        {
            inverseViewProjection: camera(shown, fov),
            air: { texture, horizon: table.horizon },
            // Every core whole, none of its light given to a halo.
            knee: 1e30,
            threshold: 1e-9,
            maxRadius: 16,
        },
    );
    let [sum, x, y] = [[0, 0, 0], 0, 0];
    for (let p = 0; p < size * size; p++) {
        const light = [0, 1, 2].map((c) => pixels[p * 4 + c] ?? 0);
        sum = sum.map((s, c) => s + (light[c] ?? 0));
        x += (light[1] ?? 0) * ((p % size) + 0.5);
        y += (light[1] ?? 0) * (Math.floor(p / size) + 0.5);
    }
    // In the middle of the view, within a fifth of a pixel, three arcseconds.
    expect(Math.abs(x / (sum[1] ?? 1) - size / 2)).toBeLessThan(0.2);
    expect(Math.abs(y / (sum[1] ?? 1) - size / 2)).toBeLessThan(0.2);
    const solidAngle = ((2 * Math.tan(fov / 2)) / size) ** 2;
    for (let c = 0; c < 3; c++) {
        const expected = illuminanceFromMagnitude(0) * (air.transmittance[c] ?? 0) * air.dilution;
        // Blue, the linear sRGB of what the air leaves of sunlight's spectrum this low, is none.
        expect(Math.abs((sum[c] ?? 0) * solidAngle - expected)).toBeLessThanOrEqual(expected * 0.02 + 1e-15);
    }
    // A tenth less light than the transmittance alone lets through, from the squeeze 1° up.
    expect(air.dilution).toBeLessThan(0.95);
    texture.destroy();
});

test("a full tile keeps its brightest stars, whichever order they come in", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    // Forty stars of distinct magnitudes within 3 pixels of a tile's middle, the pixel (40, 40) of 64 over a degree
    // looking east, each drawn no further than 4 pixels: they all fall into that one tile.
    const [size, fov] = [64, 1 * DEG];
    const scale = 1 / size;
    const stars = Array.from({ length: 40 }, (_, i) => {
        const [dx, dy] = [8 + 3 * Math.cos(i * 2.4) * Math.sqrt(i / 40), 8 + 3 * Math.sin(i * 2.4) * Math.sqrt(i / 40)];
        return [1 + ((i * 7) % 40) * 0.1, (360 - dx * scale) % 360, -dy * scale] as const;
    });
    const brightest = [...stars].sort((a, b) => a[0] - b[0]).slice(0, 8);
    const view = { inverseViewProjection: camera([1, 0, 0], fov), maxRadius: 4, threshold: 1e-6 };
    const draw = (list: typeof stars, capacity: number) => drawStars(device, list, size, { capacity }, view);
    const full = await draw(stars, 8);
    const reversed = await draw([...stars].reverse(), 8);
    const alone = await draw(brightest, 64);
    const all = await draw(stars, 64);
    const differs = (a: Float32Array, b: Float32Array) =>
        a.reduce(
            (most, value, i) => Math.max(most, Math.abs(value - (b[i] ?? 0)) / Math.max(Math.abs(value), 1e-12)),
            0,
        );
    expect(differs(full, reversed)).toBeLessThan(1e-6);
    expect(differs(full, alone)).toBeLessThan(1e-6);
    expect(differs(full, all)).toBeGreaterThan(1e-3);
});

test("without dither the noise is never read; with it, no channel moves by a step or more", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const white = device.createTexture({
        size: [64, 64],
        format: "r8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: white }, new Uint8Array(64 * 64).fill(255), { bytesPerRow: 64 }, [64, 64]);
    const size = 64;
    // A star of magnitude 2 in the middle, its glow falling off over the frame.
    const draw = (dither: boolean, blueNoise?: GPUTexture) =>
        drawStars(
            device,
            [[2, 0, 0]],
            size,
            { toneMap: "neutral", dither, ...(blueNoise ? { blueNoise } : {}) },
            { inverseViewProjection: camera([1, 0, 0], 1 * DEG), ev100: -6, threshold: 1e-9, maxRadius: 32 },
        );
    const plain = await draw(false);
    expect(new Uint32Array((await draw(false, white)).buffer)).toEqual(new Uint32Array(plain.buffer));
    const dithered = await draw(true);
    let moved = 0;
    for (let i = 0; i < plain.length; ++i) {
        const step = Math.abs((dithered[i] ?? 0) - (plain[i] ?? 0)) * 255;
        expect(step).toBeLessThan(1);
        if (step > 0.25) ++moved;
    }
    expect(moved).toBeGreaterThan(0);
    white.destroy();
});
