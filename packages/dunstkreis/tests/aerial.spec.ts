import { expect, test } from "@playwright/test";
// From the built package: the passes import their `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import { type AtmosphereLUTs, createSkyPass, precomputeAtmosphere, readTexture } from "../dist/index.js";
import { gpuDevice, wgslSource } from "./gpu.js";

type Vec4 = [number, number, number, number];
interface Query {
    /** 0: dkRaymarchAerialPerspective, 1: dkRaymarchSky without the ground, 2: dkAerialPerspective, the volume's
     *  lookup, in linear sRGB, 3: dkRaymarchAerialPerspective turned into linear sRGB as the volume holds it. */
    mode: 0 | 1 | 2 | 3;
    direction?: readonly [number, number, number];
    distance?: number;
    uv?: readonly [number, number];
}
interface Setting {
    altitudeKm: number;
    sun: readonly [number, number, number];
    samples: number;
    volume?: { luminance: GPUTexture; transmittance: GPUTexture };
}

// The raymarch and the volume's lookup evaluated per query, with the tables bound as a pass would bind them.
async function evaluate(device: GPUDevice, luts: AtmosphereLUTs, setting: Setting, queries: readonly Query[]) {
    const { altitudeKm, sun, samples, volume } = setting;
    const f = (n: number) => n.toFixed(9);
    const march = `dkRaymarchAerialPerspective(
            atmosphere, transmittanceLut, multiScatteringLut, lutSampler, ${f(altitudeKm)}, ray.xyz, sun, ray.w,
            ${samples}u,
        )`;
    const code = `${["atmosphere", "common", "lut", "sampling", "raymarch", "aerial"].map(wgslSource).join("\n")}
@group(0) @binding(0) var<uniform> atmosphere: DkAtmosphere;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var multiScatteringLut: texture_2d<f32>;
@group(0) @binding(3) var lutSampler: sampler;
@group(0) @binding(4) var<storage, read> inputs: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> outputs: array<vec4f>;
@group(0) @binding(6) var luminanceVolume: texture_3d<f32>;
@group(0) @binding(7) var transmittanceVolume: texture_3d<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= ${queries.length}u) { return; }
    let ray = inputs[2u * id.x];
    let lookup = inputs[2u * id.x + 1u];
    let sun = normalize(vec3f(${sun.map(f).join(", ")}));
    var luminance = vec4f(0.0);
    var transmittance = vec4f(1.0);
    if (lookup.z == 0.0) {
        let r = ${march};
        luminance = r.luminance;
        transmittance = r.transmittance;
    } else if (lookup.z == 3.0) {
        let r = ${march};
        luminance = vec4f(dkToRgb(atmosphere, r.luminance), 0.0);
        transmittance = vec4f(dkTransmittanceRgb(atmosphere, r.transmittance), 0.0);
    } else if (lookup.z == 1.0) {
        let r = dkRaymarchSky(
            atmosphere, transmittanceLut, multiScatteringLut, lutSampler, vec3f(0.0, 0.0, 1.0), ${f(altitudeKm)},
            ray.xyz, sun, ${samples}u, false,
        );
        luminance = r.luminance;
        transmittance = r.transmittance;
    } else {
        let p = dkAerialPerspective(luminanceVolume, transmittanceVolume, lutSampler, lookup.xy, ray.w);
        luminance = vec4f(p.luminance, 0.0);
        transmittance = vec4f(p.transmittance, 0.0);
    }
    outputs[2u * id.x] = luminance;
    outputs[2u * id.x + 1u] = transmittance;
}`;
    const module = device.createShaderModule({ code });
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === "error");
    expect(errors.map((m) => `${m.lineNum}: ${m.message}`)).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" },
    });

    const data = new Float32Array(queries.length * 8);
    for (const [i, q] of queries.entries()) {
        data.set([...(q.direction ?? [0, 1, 0]), q.distance ?? 0, ...(q.uv ?? [0, 0]), q.mode, 0], i * 8);
    }
    const input = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(input, 0, data);
    const output = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const read = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const dummy = device.createTexture({
        dimension: "3d",
        size: [1, 1, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
            { binding: 1, resource: luts.transmittance.createView() },
            { binding: 2, resource: luts.multiScattering.createView() },
            { binding: 3, resource: luts.sampler },
            { binding: 4, resource: { buffer: input } },
            { binding: 5, resource: { buffer: output } },
            { binding: 6, resource: (volume?.luminance ?? dummy).createView() },
            { binding: 7, resource: (volume?.transmittance ?? dummy).createView() },
        ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(queries.length / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, data.byteLength);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(read.getMappedRange()).slice();
    read.unmap();
    for (const resource of [input, output, read, dummy]) resource.destroy();
    return queries.map((_, i) => ({
        luminance: [...values.slice(i * 8, i * 8 + 4)] as Vec4,
        transmittance: [...values.slice(i * 8 + 4, i * 8 + 8)] as Vec4,
    }));
}

const near = (actual: readonly number[], expected: readonly number[], relative: number, label = "") => {
    for (const [i, value] of expected.entries()) {
        const difference = Math.abs((actual[i] as number) - value);
        expect(difference, `${label} component ${i}: ${actual[i]} for ${value}`).toBeLessThanOrEqual(
            Math.abs(value) * relative + 1e-6,
        );
    }
};

const degrees = (d: number) => (d * Math.PI) / 180;
// The sun 20 degrees up in the south east.
const sun = [
    Math.cos(degrees(20)) * Math.SQRT1_2,
    -Math.cos(degrees(20)) * Math.SQRT1_2,
    Math.sin(degrees(20)),
] as const;
// Looking north at the horizon.
const north = [0, 1, 0] as const;

test("a segment of no length lets everything through and adds nothing", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const luts = await precomputeAtmosphere(device);
    const directions = [north, [0, 0, 1], [0.6, 0, -0.8]] as const;
    const results = await evaluate(
        device,
        luts,
        { altitudeKm: 0.5, sun, samples: 32 },
        directions.map((direction) => ({ mode: 0, direction, distance: 0 })),
    );
    for (const { luminance, transmittance } of results) {
        expect(luminance).toEqual([0, 0, 0, 0]);
        expect(transmittance).toEqual([1, 1, 1, 1]);
    }
    luts.destroy();
});

test("along the horizon the air's light grows with the distance towards the sky's own", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const luts = await precomputeAtmosphere(device);
    const distances = [0.1, 1, 4, 16, 32, 128];
    const results = await evaluate(device, luts, { altitudeKm: 0.01, sun, samples: 64 }, [
        ...distances.map((distance) => ({ mode: 0 as const, direction: north, distance })),
        // Further than any ray reaches, and the sky along the same ray.
        { mode: 0, direction: north, distance: 10_000 },
        { mode: 1, direction: north },
    ]);
    const segments = results.slice(0, distances.length);
    const [whole, sky] = results.slice(distances.length) as [(typeof results)[0], (typeof results)[0]];
    for (const [i, { luminance, transmittance }] of segments.entries()) {
        const before = i > 0 ? segments[i - 1] : undefined;
        for (let c = 0; c < 4; ++c) {
            expect(luminance[c]).toBeLessThan(sky.luminance[c] as number);
            if (before) {
                expect(luminance[c]).toBeGreaterThan(before.luminance[c] as number);
                expect(transmittance[c]).toBeLessThan(before.transmittance[c] as number);
            }
        }
    }
    // 32 km of the air along the horizon already hold a good part of the sky's light there, from 30% in the red to over
    // half in the blue, which the air scatters on shorter paths; the whole ray is the sky.
    const at32 = segments[4]?.luminance as Vec4;
    for (let c = 0; c < 4; ++c) expect(at32[c]).toBeGreaterThan(0.25 * (sky.luminance[c] as number));
    near(whole.luminance, sky.luminance, 1e-4);
    near(whole.transmittance, sky.transmittance, 1e-4);
    luts.destroy();
});

// From 500 m up, looking north and 5 degrees down, 70 degrees vertical field of view, 16:9. Column-major: the eye at
// the origin in the third column, the axis in the fourth, as tables.spec.ts' camera. A point's clip-space depth is one
// over its distance along the axis: a reversed depth buffer without a far plane, the near one a unit away.
const altitudeKm = 0.5;
const pitch = degrees(-5);
const ty = Math.tan(degrees(35));
const right = [(ty * 16) / 9, 0, 0];
const up = [0, -Math.sin(pitch) * ty, Math.cos(pitch) * ty];
const forward = [0, Math.cos(pitch), Math.sin(pitch)];
const inverseViewProjection = new Float32Array([...right, 0, ...up, 0, 0, 0, 0, 1, ...forward, 0]);
// The ray through screen coordinates uv, from the top left, not normalized: its length is the distance per unit of
// distance along the axis.
const rayAt = ([u, v]: readonly [number, number]) =>
    [0, 1, 2].map((i) => (u * 2 - 1) * (right[i] as number) + (1 - v * 2) * (up[i] as number) + (forward[i] as number));
const unit = (d: number[]) => d.map((c) => c / Math.hypot(...d)) as [number, number, number];

const FROXELS = [
    [16, 16, 31],
    [16, 16, 8],
    [2, 4, 20],
    [30, 12, 26],
    [16, 30, 31],
    [8, 26, 12],
    [24, 20, 0],
] as const;

// The volume's froxels read back, in cd/m², against the raymarch to their centers and the lookup there.
async function compareFroxels(
    device: GPUDevice,
    luts: AtmosphereLUTs,
    volume: { luminance: GPUTexture; transmittance: GPUTexture; maxDistanceKm: number },
    light: { direction: readonly [number, number, number]; share: number },
) {
    const { width, height, depthOrArrayLayers: depth } = volume.luminance;
    const uvAt = (x: number, y: number) => [(x + 0.5) / width, (y + 0.5) / height] as const;
    const distanceAt = (z: number) => volume.maxDistanceKm * ((z + 0.5) / depth) ** 2;
    const results = await evaluate(device, luts, { altitudeKm, sun: light.direction, samples: 128, volume }, [
        ...FROXELS.map(([x, y, z]) => ({
            mode: 3 as const,
            direction: unit(rayAt(uvAt(x, y))),
            distance: distanceAt(z),
        })),
        ...FROXELS.map(([x, y, z]) => ({ mode: 2 as const, uv: uvAt(x, y), distance: distanceAt(z) })),
        // Right at the camera, nothing in the way.
        { mode: 2, uv: [0.5, 0.5], distance: 0 },
    ]);
    for (const [i, [x, y, z]] of FROXELS.entries()) {
        const slice = await readTexture(device, volume.luminance, z);
        const transmittanceSlice = await readTexture(device, volume.transmittance, z);
        const at = (y * width + x) * 4;
        const exponent = slice.data[at + 3] as number;
        const luminance = [...slice.data.slice(at, at + 3)].map((v) => v * 2 ** exponent);
        const transmittance = [...transmittanceSlice.data.slice(at, at + 3)];
        const direct = results[i] as (typeof results)[0];
        const looked = results[FROXELS.length + i] as (typeof results)[0];
        const marched = direct.luminance.slice(0, 3).map((v) => v * light.share);
        near(luminance, marched, 0.03, `froxel ${x},${y},${z} luminance`);
        near(transmittance, direct.transmittance.slice(0, 3), 0.01, `froxel ${x},${y},${z} transmittance`);
        near(looked.luminance.slice(0, 3), luminance, 0.01, `lookup ${x},${y},${z} luminance`);
        near(looked.transmittance.slice(0, 3), transmittance, 0.01, `lookup ${x},${y},${z} transmittance`);
        // The volume describes itself: its reach in every froxel of the transmittance.
        expect(transmittanceSlice.data[at + 3]).toBe(volume.maxDistanceKm);
        expect(Number.isInteger(exponent)).toBe(true);
    }
    const origin = results.at(-1) as (typeof results)[0];
    expect(origin.luminance.slice(0, 3)).toEqual([0, 0, 0]);
    expect(origin.transmittance.slice(0, 3)).toEqual([1, 1, 1]);
}

test("the aerial perspective volume agrees with the raymarch at its froxels, and its lookup with both", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const luts = await precomputeAtmosphere(device);
    const plain = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false });
    expect(plain.aerialPerspective).toBeNull();
    await expect(plain.createAerialPerspectivePass({ format: "rgba16float" })).rejects.toThrow(/aerialPerspective/);
    plain.destroy();

    const pass = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false, aerialPerspective: true });
    const volume = pass.aerialPerspective;
    expect(volume?.maxDistanceKm).toBe(32);
    if (!volume) return;
    pass.update({ sunDirection: sun, observerHeightM: altitudeKm * 1000, inverseViewProjection });
    await compareFroxels(device, luts, volume, { direction: sun, share: 1 });
    // The luminance's exponent undoes the sky-view table's scale.
    const exponent = (await readTexture(device, volume.luminance, 0)).data[3];
    expect(exponent).toBe(-Math.log2(pass.skyViewScale));

    pass.destroy();
    luts.destroy();
});

test("a reach a half float does not hold is rounded to one, and the volume is filled and read to that", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const luts = await precomputeAtmosphere(device);
    const pass = await createSkyPass(device, {
        luts,
        format: "rgba16float",
        toneMap: false,
        aerialPerspective: { maxDistanceKm: 123.456 },
    });
    const volume = pass.aerialPerspective;
    expect(volume?.maxDistanceKm).toBe(123.4375);
    if (!volume) return;
    pass.update({ sunDirection: sun, observerHeightM: altitudeKm * 1000, inverseViewProjection });
    await compareFroxels(device, luts, volume, { direction: sun, share: 1 });

    pass.destroy();
    luts.destroy();
});

test("by night the volume holds the Moon's light in the air, and next to nothing without a Moon", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const luts = await precomputeAtmosphere(device);
    const options = { luts, format: "rgba16float", toneMap: false, aerialPerspective: true } as const;
    const pass = await createSkyPass(device, { ...options, moonlight: true });
    const volume = pass.aerialPerspective;
    if (!volume) return;
    // The Sun 30 degrees down in the north, the Moon 40 degrees up in the south east, a little short of full.
    const night = [0, Math.cos(degrees(-30)), Math.sin(degrees(-30))] as const;
    const moon = [
        Math.cos(degrees(40)) * Math.SQRT1_2,
        -Math.cos(degrees(40)) * Math.SQRT1_2,
        Math.sin(degrees(40)),
    ] as const;
    const moonIlluminance = 0.25;
    const frame = { sunDirection: night, observerHeightM: altitudeKm * 1000, inverseViewProjection };
    pass.update({ ...frame, moonDirection: moon, moonIlluminance });
    const share = moonIlluminance / luts.model.solarIlluminance;
    await compareFroxels(device, luts, volume, { direction: moon, share });
    const last = volume.luminance.depthOrArrayLayers - 1;
    const center = (16 * volume.luminance.width + 16) * 4;
    const green = async () => {
        const { data } = await readTexture(device, volume.luminance, last);
        return (data[center + 1] as number) * 2 ** (data[center + 3] as number);
    };
    const moonlit = await green();
    // Some thousandths of a cd/m², 32 km of air under a gibbous Moon.
    expect(moonlit).toBeGreaterThan(1e-4);
    expect(moonlit).toBeLessThan(1e-1);

    // The Moon gone, the volume is rebuilt, with the last of the Sun's twilight alone.
    pass.update({ ...frame, moonIlluminance: 0 });
    expect(await green()).toBeLessThan(moonlit / 1000);
    // And a pass made without moonlight ignores the Moon.
    const sunOnly = await createSkyPass(device, options);
    sunOnly.update({ ...frame, moonDirection: moon, moonIlluminance });
    const { data } = await readTexture(device, sunOnly.aerialPerspective?.luminance as GPUTexture, last);
    expect((data[center + 1] as number) * 2 ** (data[center + 3] as number)).toBeLessThan(moonlit / 1000);

    sunOnly.destroy();
    pass.destroy();
    luts.destroy();
});

test("the aerial perspective pass lays the air over a scene by its depth, and leaves the sky behind alone", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const luts = await precomputeAtmosphere(device);
    const sky = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false, aerialPerspective: true });
    const volume = sky.aerialPerspective;
    if (!volume) return;
    const ev100 = 10;
    sky.update({ sunDirection: sun, observerHeightM: altitudeKm * 1000, inverseViewProjection, ev100 });
    // A scene in units of a kilometer, on a reversed depth buffer.
    const air = await sky.createAerialPerspectivePass({ format: "rgba32float", clearDepth: 0, metersPerUnit: 1000 });

    const [width, height] = [16, 8];
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const color = device.createTexture({ size: [width, height], format: "rgba32float", usage });
    const scene = [0.5, 0.25, 0.125, 0.75];
    device.queue.writeTexture(
        { texture: color },
        new Float32Array(Array.from({ length: width * height }, () => scene).flat()),
        { bytesPerRow: width * 16 },
        [width, height],
    );
    // A wall over the left half of the view, 4 km down the camera's axis; nothing in the right half.
    const wallDepth = 0.25;
    const depth = device.createTexture({
        size: [width, height],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const wall = await device.createRenderPipelineAsync({
        layout: "auto",
        vertex: {
            module: device.createShaderModule({
                code: `@vertex fn wall(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let corners = array(vec2f(-1.0, -1.0), vec2f(0.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(0.0, -1.0), vec2f(0.0, 1.0));
    return vec4f(corners[i], ${wallDepth}, 1.0);
}`,
            }),
            entryPoint: "wall",
        },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
    });
    const target = device.createTexture({
        size: [width, height],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const encoder = device.createCommandEncoder();
    const draw = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: 0,
            depthLoadOp: "clear",
            depthStoreOp: "store",
        },
    });
    draw.setPipeline(wall);
    draw.draw(6);
    draw.end();
    air.encode(encoder, target, { color, depth });
    device.queue.submit([encoder.finish()]);
    const seen = await readTexture(device, target);

    // What the lookup gives for the wall's pixels, at their distances from the eye.
    const pixels = [
        [0, 0],
        [3, 5],
        [7, 7],
        [5, 2],
    ] as const;
    const uvAt = ([x, y]: readonly [number, number]) => [(x + 0.5) / width, (y + 0.5) / height] as const;
    const looked = await evaluate(
        device,
        luts,
        { altitudeKm, sun, samples: 1, volume },
        pixels.map((pixel) => ({ mode: 2, uv: uvAt(pixel), distance: Math.hypot(...rayAt(uvAt(pixel))) / wallDepth })),
    );
    const exposure = 1 / (1.2 * 2 ** ev100);
    for (const [i, [x, y]] of pixels.entries()) {
        const { luminance, transmittance } = looked[i] as (typeof looked)[0];
        const expected = [0, 1, 2].map(
            (c) => (scene[c] as number) * (transmittance[c] as number) + (luminance[c] as number) * exposure,
        );
        const at = (y * width + x) * 4;
        near([...seen.data.slice(at, at + 3)], expected, 1e-4, `pixel ${x},${y}`);
        expect(seen.data[at + 3]).toBe(scene[3]);
        // The air is in the way, up to the wall or to the ground before it: the wall's own light dimmed, the air's added.
        expect(transmittance[2]).toBeLessThan(0.98);
        expect(luminance[2]).toBeGreaterThan(100);
    }
    for (const [x, y] of [
        [8, 0],
        [15, 7],
        [12, 3],
    ] as const) {
        const at = (y * width + x) * 4;
        expect([...seen.data.slice(at, at + 4)]).toEqual(scene);
    }

    for (const texture of [color, depth, target]) texture.destroy();
    sky.destroy();
    luts.destroy();
});
