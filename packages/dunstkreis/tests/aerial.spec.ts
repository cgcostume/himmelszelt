import { expect, test } from "@playwright/test";
// From the built package: the passes import their `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import { type AtmosphereLUTs, createSkyPass, precomputeAtmosphere, readTexture } from "../dist/index.js";
import { gpuDevice, wgslSource } from "./gpu.js";

type Vec4 = [number, number, number, number];
interface Query {
    /** 0: dkRaymarchAerialPerspective, 1: dkRaymarchSky without the ground, 2: dkSampleAerialPerspective. */
    mode: 0 | 1 | 2;
    direction?: readonly [number, number, number];
    distance?: number;
    uv?: readonly [number, number];
}
interface Setting {
    altitudeKm: number;
    sun: readonly [number, number, number];
    samples: number;
    volume?: { luminance: GPUTexture; transmittance: GPUTexture; maxDistanceKm: number; scale: number };
}

// The raymarch and the volume's lookup evaluated per query, with the tables bound as a pass would bind them.
async function evaluate(device: GPUDevice, luts: AtmosphereLUTs, setting: Setting, queries: readonly Query[]) {
    const { altitudeKm, sun, samples, volume } = setting;
    const f = (n: number) => n.toFixed(9);
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
        let r = dkRaymarchAerialPerspective(
            atmosphere, transmittanceLut, multiScatteringLut, lutSampler, ${f(altitudeKm)}, ray.xyz, sun, ray.w,
            ${samples}u,
        );
        luminance = r.luminance;
        transmittance = r.transmittance;
    } else if (lookup.z == 1.0) {
        let r = dkRaymarchSky(
            atmosphere, transmittanceLut, multiScatteringLut, lutSampler, vec3f(0.0, 0.0, 1.0), ${f(altitudeKm)},
            ray.xyz, sun, ${samples}u, false,
        );
        luminance = r.luminance;
        transmittance = r.transmittance;
    } else {
        let p = dkSampleAerialPerspective(
            luminanceVolume, transmittanceVolume, lutSampler, lookup.xy, ray.w, ${f(volume?.maxDistanceKm ?? 1)},
            ${f(volume?.scale ?? 1)},
        );
        luminance = p.luminance;
        transmittance = p.transmittance;
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

test("the aerial perspective volume agrees with the raymarch at its froxels, and its lookup with both", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const luts = await precomputeAtmosphere(device);
    const plain = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false });
    expect(plain.aerialPerspective).toBeNull();
    plain.destroy();

    const pass = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false, aerialPerspective: true });
    const volume = pass.aerialPerspective;
    expect(volume?.maxDistanceKm).toBe(32);
    if (!volume) return;
    // From 500 m up, looking north and 5 degrees down, 70 degrees vertical field of view, 16:9.
    const pitch = degrees(-5);
    const ty = Math.tan(degrees(35));
    const aspect = 16 / 9;
    const right = [ty * aspect, 0, 0];
    const up = [0, -Math.sin(pitch) * ty, Math.cos(pitch) * ty];
    const forward = [0, Math.cos(pitch), Math.sin(pitch)];
    // Column-major: the eye at the origin in the third column, the axis in the fourth, as tables.spec.ts' camera.
    const inverseViewProjection = new Float32Array([...right, 0, ...up, 0, 0, 0, 0, 1, ...forward, 0]);
    const altitudeKm = 0.5;
    pass.update({ sunDirection: sun, observerHeightM: altitudeKm * 1000, inverseViewProjection });

    const { width, height, depthOrArrayLayers: depth } = volume.luminance;
    const froxels = [
        [16, 16, 31],
        [16, 16, 8],
        [2, 4, 20],
        [30, 12, 26],
        [16, 30, 31],
        [8, 26, 12],
        [24, 20, 0],
    ] as const;
    const directionAt = (x: number, y: number) => {
        const u = ((x + 0.5) / width) * 2 - 1;
        const v = 1 - ((y + 0.5) / height) * 2;
        const d = [0, 1, 2].map((i) => u * (right[i] as number) + v * (up[i] as number) + (forward[i] as number));
        const length = Math.hypot(...d);
        return d.map((c) => c / length) as [number, number, number];
    };
    const distanceAt = (z: number) => volume.maxDistanceKm * ((z + 0.5) / depth) ** 2;
    const uvAt = (x: number, y: number) => [(x + 0.5) / width, (y + 0.5) / height] as const;
    const results = await evaluate(
        device,
        luts,
        { altitudeKm, sun, samples: 128, volume: { ...volume, scale: pass.skyViewScale } },
        [
            ...froxels.map(([x, y, z]) => ({
                mode: 0 as const,
                direction: directionAt(x, y),
                distance: distanceAt(z),
            })),
            ...froxels.map(([x, y, z]) => ({
                mode: 2 as const,
                uv: uvAt(x, y),
                distance: distanceAt(z),
            })),
            // Right at the camera, nothing in the way.
            { mode: 2, uv: [0.5, 0.5], distance: 0 },
        ],
    );
    for (const [i, [x, y, z]] of froxels.entries()) {
        const slice = await readTexture(device, volume.luminance, z);
        const transmittanceSlice = await readTexture(device, volume.transmittance, z);
        const at = (y * width + x) * 4;
        const luminance = [...slice.data.slice(at, at + 4)].map((v) => v / pass.skyViewScale);
        const transmittance = [...transmittanceSlice.data.slice(at, at + 4)];
        const direct = results[i] as (typeof results)[0];
        const looked = results[froxels.length + i] as (typeof results)[0];
        near(luminance, direct.luminance, 0.03, `froxel ${x},${y},${z} luminance`);
        near(transmittance, direct.transmittance, 0.01, `froxel ${x},${y},${z} transmittance`);
        near(looked.luminance, luminance, 0.01, `lookup ${x},${y},${z} luminance`);
        near(looked.transmittance, transmittance, 0.01, `lookup ${x},${y},${z} transmittance`);
    }
    const origin = results.at(-1) as (typeof results)[0];
    expect(origin.luminance).toEqual([0, 0, 0, 0]);
    expect(origin.transmittance).toEqual([1, 1, 1, 1]);

    pass.destroy();
    luts.destroy();
});
