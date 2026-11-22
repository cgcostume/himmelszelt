import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { cloudOutput } from "../src/wgsl/output.js";
import { compileWgsl, composedSource, gpuDevice } from "./gpu.js";

/** A shader by name, this package's or one of the fragments it bundles from the packages that own them. */
function wgslSource(name: string): string {
    const composed = composedSource(name);
    if (composed) return composed;
    const dunstkreis = "../../dunstkreis/src/wgsl";
    const owners: Record<string, string> = {
        camera: dunstkreis,
        aerial: dunstkreis,
        atmosphere: dunstkreis,
        common: dunstkreis,
        lut: dunstkreis,
        sampling: dunstkreis,
        tonemap: "../../helldunkel/src/wgsl",
        whitebalance: "../../helldunkel/src/wgsl",
    };
    const owner = owners[name] ?? "../src/wgsl";
    const read = (file: string) => readFileSync(new URL(`${owner}/${file}`, import.meta.url), "utf8");
    try {
        return read(`${name}.wgsl`);
    } catch {
        return read(`${name}.comp.wgsl`);
    }
}

// Each pass with exactly the fragments its header names, so none grows a dependency it does not declare.
const PASSES: Record<string, readonly string[]> = {
    cloudmap: ["noise", "params", "cloudmap"],
    voxel: ["noise", "params", "voxel"],
    detail: ["noise", "detail"],
    light: ["params", "light"],
    morph: ["morph"],
    clouds: ["noise", "params", "camera", "aerial", "sheet", "layerread", "clouds"],
    compose: ["noise", "params", "camera", "aerial", "sheet", "corona", "whitebalance", "tonemap", "compose"],
    sunlight: ["atmosphere", "common", "lut", "sampling", "sunlight"],
};
const OUTPUTS: Record<string, string> = { clouds: cloudOutput("rgba16float"), compose: cloudOutput("rgba8unorm") };

for (const [name, fragments] of Object.entries(PASSES)) {
    test(`the ${name} pass compiles from its declared fragments`, async () => {
        const device = await gpuDevice();
        test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
        if (!device) return;
        const errors = await compileWgsl(device, [OUTPUTS[name] ?? "", ...fragments.map(wgslSource)].join("\n"));
        expect(errors, `${name}:\n${errors.join("\n")}`).toEqual([]);
    });
}

test("with dunstkreis' tables, the pass computes its sunlight table on the GPU without a validation error", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { precomputeAtmosphere } = await import("@himmelszelt/dunstkreis");
    const { createCloudPass, DEFAULT_CLOUD_PARAMS } = await import("../dist/index.js");
    const luts = await precomputeAtmosphere(device);
    device.pushErrorScope("validation");
    const pass = await createCloudPass(device, { format: "rgba16float", background: false, atmosphere: luts });
    pass.update({ ...DEFAULT_CLOUD_PARAMS, sunDirection: [0, 0.9986, 0.0523] });
    pass.update({ sunlight: null });
    expect(await device.popErrorScope()).toBeNull();
    pass.destroy();
    luts.destroy();
});

test("the clouds take the aerial perspective of dunstkreis' sky pass as it is", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { createSkyPass, precomputeAtmosphere, readTexture } = await import("@himmelszelt/dunstkreis");
    const { createCloudPass, DEFAULT_CLOUD_PARAMS } = await import("../dist/index.js");
    const luts = await precomputeAtmosphere(device);
    device.pushErrorScope("validation");
    const reach = 400;
    const sky = await createSkyPass(device, {
        luts,
        format: "rgba16float",
        toneMap: false,
        aerialPerspective: { maxDistanceKm: reach },
    });
    const volume = sky.aerialPerspective;
    if (!volume) return;
    const clouds = await createCloudPass(device, { format: "rgba16float", toneMap: false, background: false });
    // Looking north along the horizon from 5 km up, over an overcast deck from 1 to 3 km that no light reaches: all
    // the light there is, is the air's in front of it.
    const dark: [number, number, number] = [0, 0, 0];
    const frame = {
        sunDirection: [0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number],
        observerHeightM: 5000,
        inverseViewProjection: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    };
    const unlit = { sunIlluminance: dark, skyIrradiance: dark, groundIrradiance: dark, sheets: [] };
    const cloudscape = { ...DEFAULT_CLOUD_PARAMS.cloudscape, coverage: 1, baseKm: 1, heightKm: 2, towers: 0 };
    const size = 64;
    const target = device.createTexture({
        size: [size, size],
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    // The clouds alone, premultiplied, in cd/m², at a pixel that looks 27 degrees down at the deck.
    const [px, py] = [32, 48];
    const render = async (aerialPerspective?: typeof volume) => {
        const encoder = device.createCommandEncoder();
        sky.update(frame, encoder);
        clouds.update({ ...DEFAULT_CLOUD_PARAMS, ...frame, ...unlit, cloudscape, ev100: -Math.log2(1.2) }, encoder);
        clouds.encode(encoder, target, aerialPerspective ? { aerialPerspective } : {});
        device.queue.submit([encoder.finish()]);
        const { data } = await readTexture(device, target);
        return [...data.slice((py * size + px) * 4, (py * size + px) * 4 + 4)] as number[];
    };
    const through = await render(volume);
    const faded = await render();
    expect(await device.popErrorScope()).toBeNull();

    // The volume's own light at the pixel, `distance` km out: its froxels read back and filtered as the lookup does.
    const { width, height, depthOrArrayLayers: depth } = volume.luminance;
    const slices = await Promise.all([2, 3, 4, 5].map((z) => readTexture(device, volume.luminance, z)));
    const corners = [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => [i, j, k] as const)));
    const air = (distance: number) => {
        const [x, y] = [((px + 0.5) / size) * width - 0.5, ((py + 0.5) / size) * height - 0.5];
        const z = Math.sqrt(distance / reach) * depth - 0.5;
        const [x0, y0, z0] = [Math.floor(x), Math.floor(y), Math.floor(z)];
        return [0, 1, 2].map((c) => {
            let sum = 0;
            for (const [dx, dy, dz] of corners) {
                const weight = Math.abs(1 - dx - (x - x0)) * Math.abs(1 - dy - (y - y0)) * Math.abs(1 - dz - (z - z0));
                const { data } = slices[z0 + dz - 2] as (typeof slices)[0];
                const at = ((y0 + dy) * width + x0 + dx) * 4;
                sum += weight * (data[at + c] as number) * 2 ** (data[at + 3] as number);
            }
            return sum;
        });
    };
    // The ray enters the deck's slab 4.4 km out and would leave it 8.7 km out: it is spent somewhere in between.
    const [nearest, farthest] = [air(4.3), air(8.8)];
    expect(through[3]).toBeLessThan(0.02);
    for (let c = 0; c < 3; ++c) {
        expect(through[c]).toBeGreaterThan(nearest[c] as number);
        expect(through[c]).toBeLessThan(farthest[c] as number);
    }
    // Some hundreds of cd/m², and bluer than the fade into the default horizon, which is taken without a volume.
    expect(through[2]).toBeGreaterThan(100);
    expect((through[2] as number) / (through[0] as number)).toBeGreaterThan(
        (faded[2] as number) / (faded[0] as number),
    );
    target.destroy();
    clouds.destroy();
    sky.destroy();
    luts.destroy();
});

test("a keyframe builds step by step, is promoted and blended without a validation error", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { createCloudPass, DEFAULT_CLOUD_PARAMS } = await import("../dist/index.js");
    device.pushErrorScope("validation");
    const grid = { size: 64, layers: 16 };
    const pass = await createCloudPass(device, { format: "rgba16float", background: false, keyframes: true, grid });
    const keyframes = pass.keyframes;
    expect(keyframes).not.toBeNull();
    if (!keyframes) return;
    // The first update builds the first keyframe at once: nothing is stale after it.
    expect(pass.update(DEFAULT_CLOUD_PARAMS)).toBe(true);
    expect(keyframes.stale).toBe(false);
    expect(keyframes.begin()).toBe(true);

    // A new coverage is a new map and volume, built over as many calls as it has steps.
    const cloudscape = { ...DEFAULT_CLOUD_PARAMS.cloudscape, coverage: 0.7 };
    pass.update({ cloudscape });
    expect(keyframes.stale).toBe(true);
    // The build that runs is of the clouds before the change, all copies: it has to finish and be promoted first.
    expect(keyframes.begin()).toBe(false);
    expect(keyframes.advance(Number.POSITIVE_INFINITY).every((name) => name.startsWith("copy:"))).toBe(true);
    keyframes.promote();
    expect(keyframes.begin()).toBe(true);
    const steps = keyframes.pending;
    expect(keyframes.advance(1)).toEqual(["cloudMap"]);
    expect(keyframes.ready).toBe(false);
    const rest = keyframes.advance(Number.POSITIVE_INFINITY);
    expect(rest.length).toBe(steps - 1);
    expect(rest.at(-1)).toBe("deck");
    expect(keyframes.ready).toBe(true);
    keyframes.promote();
    expect(keyframes.stale).toBe(false);
    keyframes.blend(0.5);

    // A new sun keeps the map and the volume, copied, and sums the light again.
    pass.update({ sunDirection: [0.5, 0, 0.866] });
    expect(keyframes.begin()).toBe(true);
    const names = keyframes.advance(Number.POSITIVE_INFINITY);
    expect(names).toEqual(["copy:map", "copy:modeling", "copy:ambient", "light", "deck"]);
    keyframes.promote();
    keyframes.blend(1);
    await device.queue.onSubmittedWorkDone();
    expect(await device.popErrorScope()).toBeNull();
    pass.destroy();
});
