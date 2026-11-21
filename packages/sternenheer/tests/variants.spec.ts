import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
    createStarsPass,
    type DeepStars,
    HIPPARCOS,
    loadCatalog,
    loadDeepStars,
    loadFaintStars,
    type PackedStars,
    packedStarAt,
    type StarCatalog,
    type StarImage,
    type StarsParams,
    starAt,
    TYCHO,
} from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

// The loaders fetch; here the package's files come off the disk.
globalThis.fetch = (async (url: string | URL) =>
    new Response(readFileSync(url instanceof URL ? url : new URL(url)))) as typeof fetch;

const DEG = Math.PI / 180;
const SIZE = 512;

/** A view of `fov` towards the east, and the sky turned so the J2000 direction `ra`, `de` (degrees) stands there. */
function towards(ra: number, de: number, fov: number): Partial<StarsParams> {
    const d = [Math.cos(de * DEG) * Math.cos(ra * DEG), Math.cos(de * DEG) * Math.sin(ra * DEG), Math.sin(de * DEG)];
    const across = Math.hypot(d[0] ?? 0, d[1] ?? 0);
    const e2 = [-(d[1] ?? 0) / across, (d[0] ?? 0) / across, 0];
    const e3 = [
        -(d[2] ?? 0) * (e2[1] ?? 0),
        (d[2] ?? 0) * (e2[0] ?? 0),
        (d[0] ?? 0) * (e2[1] ?? 0) - (d[1] ?? 0) * (e2[0] ?? 0),
    ];
    const t = Math.tan(fov / 2);
    return {
        skyRotation: new Float32Array([0, 1, 2].flatMap((j) => [d[j] ?? 0, e2[j] ?? 0, e3[j] ?? 0])),
        inverseViewProjection: new Float32Array([0, -t, 0, 0, 0, 0, t, 0, 0, 0, 0, 1, 1, 0, 0, 0]),
        horizonZ: -1,
        halo: 0,
    };
}

/** Draws a frame of each variant and returns what `read` makes of each pass, or the target's pixels. */
async function both<T>(
    device: GPUDevice,
    variants: [Record<string, unknown>, Record<string, unknown>],
    params: Partial<StarsParams>,
    read: (pass: Awaited<ReturnType<typeof createStarsPass>>, pixels: Float32Array) => Promise<T> | T,
): Promise<T[]> {
    const results: T[] = [];
    for (const options of variants) {
        const pass = await createStarsPass(device, {
            format: "rgba32float",
            toneMap: false,
            background: false,
            ...options,
        });
        const target = device.createTexture({
            size: [SIZE, SIZE],
            format: "rgba32float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        const readback = device.createBuffer({
            size: SIZE * SIZE * 16,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        pass.update(params);
        const encoder = device.createCommandEncoder();
        pass.encode(encoder, target);
        encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: SIZE * 16 }, [SIZE, SIZE]);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        results.push(await read(pass, new Float32Array(readback.getMappedRange().slice(0))));
        readback.destroy();
        target.destroy();
        pass.destroy();
    }
    return results;
}

test("the compact and the full catalog draw the same stars on the GPU, five centuries on, within a sixth of an arcsecond", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const catalogs: [StarCatalog, StarCatalog] = [await loadCatalog("full"), await loadCatalog("compact")];
    let sirius = 0;
    for (let i = 1; i < catalogs[0].count; i++)
        if (starAt(catalogs[0], i).magnitude < starAt(catalogs[0], sirius).magnitude) sirius = i;
    const { rightAscension, declination } = starAt(catalogs[0], sirius);
    const variants = catalogs.map((catalog) => ({ catalog })) as unknown as [
        Record<string, unknown>,
        Record<string, unknown>,
    ];
    // A degree around where Sirius stood in 2000: in 500 years it moves by 11 arcminutes.
    const narrow = { ...towards(rightAscension, declination, 1 * DEG), years: 500, ev100: -20 };
    const [a, b] = await both(device, variants, narrow, (pass) => pass.readStars(sirius, 1));
    const arcsecondsPerPixel = 3600 / SIZE;
    expect(a?.[0]?.drawn && b?.[0]?.drawn).toBe(true);
    const off = Math.hypot(
        (a?.[0]?.pixel[0] ?? 0) - (b?.[0]?.pixel[0] ?? 0),
        (a?.[0]?.pixel[1] ?? 0) - (b?.[0]?.pixel[1] ?? 0),
    );
    expect(off * arcsecondsPerPixel).toBeLessThan(0.21);
    expect(
        Math.hypot((a?.[0]?.pixel[0] ?? 0) - SIZE / 2, (a?.[0]?.pixel[1] ?? 0) - SIZE / 2) * arcsecondsPerPixel,
    ).toBeGreaterThan(600);
    // A wide view of the whole catalog: every star drawn alike, as bright.
    const wide = { ...towards(rightAscension, declination, 120 * DEG), ev100: -20 };
    const [all, compact] = await both(device, variants, wide, (pass) => pass.readStars(0, catalogs[0].count));
    let drawn = 0;
    all?.forEach((star, i) => {
        const other = compact?.[i] as StarImage;
        expect(other.drawn).toBe(star.drawn);
        if (!star.drawn) return;
        drawn++;
        expect(Math.hypot(star.pixel[0] - other.pixel[0], star.pixel[1] - other.pixel[1])).toBeLessThan(0.01);
        expect(Math.abs(other.light / star.light - 1)).toBeLessThan(1e-4);
    });
    expect(drawn).toBeGreaterThan(2000);
});

test("the compact Hipparcos stars draw as the full ones on the GPU, and the brightest so many as deep", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    test.skip(!existsSync(fileURLToPath(HIPPARCOS.compact)), "no Hipparcos stars: pnpm data:hipparcos makes them");
    if (!device) return;
    const catalog = await loadCatalog();
    const faint: [PackedStars, PackedStars] = [await loadFaintStars("full"), await loadFaintStars("compact")];
    const slots = [faint[0].count, (faint[1] as DeepStars).blocks * 64];
    const variants = faint.map((faintStars) => ({ catalog, faintStars })) as unknown as [
        Record<string, unknown>,
        Record<string, unknown>,
    ];
    const drawnOf = async (faintStars: number) => {
        const params = { ...towards(84, -1, 60 * DEG), ev100: -20, faintStars };
        let k = 0;
        return both(device, variants, params, async (pass) => {
            const stars = await pass.readStars(catalog.count, slots[k++] ?? 0);
            return stars.filter((star) => star.drawn);
        });
    };
    const [a, b] = await drawnOf(Number.POSITIVE_INFINITY);
    expect(b?.length).toBe(a?.length);
    expect(a?.length).toBeGreaterThan(5000);
    // Each compact star where a full one is, as bright: 0.6 arcseconds are a 700th of a pixel here.
    const byLight = new Map<string, StarImage[]>();
    for (const star of a ?? [])
        byLight.get(star.light.toPrecision(5))?.push(star) ?? byLight.set(star.light.toPrecision(5), [star]);
    for (const star of b ?? []) {
        const near = (byLight.get(star.light.toPrecision(5)) ?? []).some(
            (other) => Math.hypot(other.pixel[0] - star.pixel[0], other.pixel[1] - star.pixel[1]) < 0.01,
        );
        expect(near).toBe(true);
    }
    // The brightest 2,000: the compact ones by magnitude, the ties of the last one's included.
    const [first, upTo] = await drawnOf(2000);
    const last = packedStarAt(faint[0], 1999).magnitude;
    let ties = 0;
    for (let i = 2000; i < faint[0].count && packedStarAt(faint[0], i).magnitude === last; i++) ties++;
    expect(upTo?.length).toBeGreaterThanOrEqual(first?.length ?? 0);
    expect(upTo?.length).toBeLessThanOrEqual((first?.length ?? 0) + ties);
});

test("the compact Tycho-2 stars light the target as the full ones do", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    test.skip(!existsSync(fileURLToPath(TYCHO.compact)), "no Tycho-2 stars: pnpm data:tycho makes them");
    if (!device) return;
    const catalog = await loadCatalog();
    const deep = [await loadDeepStars("full"), await loadDeepStars("compact")];
    const variants = deep.map((deepStars) => ({ catalog, deepStars })) as unknown as [
        Record<string, unknown>,
        Record<string, unknown>,
    ];
    // Ten degrees in Cygnus, as a deep night, in cd/m².
    const params = { ...towards(305, 40, 10 * DEG), ev100: -Math.log2(1.2), displayEV100: -9 };
    const [a, b] = await both(device, variants, params, (_, pixels) => pixels);
    let [sum, other, apart] = [0, 0, 0];
    for (let p = 0; p < SIZE * SIZE * 4; p += 4) {
        sum += a?.[p + 1] ?? 0;
        other += b?.[p + 1] ?? 0;
        apart += Math.abs((a?.[p + 1] ?? 0) - (b?.[p + 1] ?? 0));
    }
    expect(sum).toBeGreaterThan(0);
    expect(Math.abs(other / sum - 1)).toBeLessThan(1e-3);
    // A pixel spans 70 arcseconds: a star 0.6 of one away shifts a hundredth of its light at most.
    expect(apart / sum).toBeLessThan(0.02);
});
