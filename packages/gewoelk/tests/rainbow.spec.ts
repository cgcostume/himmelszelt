import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
    antisolarAngle,
    bowDirection,
    bowRadius,
    bowTop,
    RAINBOW_FROM,
    RAINBOW_TO,
    type RainbowTable,
    rainbowPhase,
    rainbowTable,
    rainDropRadius,
    rainExtinction,
    waterIndex,
} from "../src/rainbow.js";
import { compileWgsl, gpuDevice } from "./gpu.js";

const DEG = Math.PI / 180;
const [RED, GREEN, BLUE, LUMINANCE] = [0, 1, 2, 3];
const table = rainbowTable();

/** The table `degrees` from the antisolar point. */
const around = (degrees: number, of: RainbowTable = table) => rainbowPhase(of, 180 - degrees);

/** Where a channel is brightest between two angles from the antisolar point, to a hundredth of a degree. */
function brightest(channel: number, from: number, to: number, of: RainbowTable = table): number {
    let best = from;
    for (let angle = from; angle <= to; angle += 0.01)
        if ((around(angle, of)[channel] ?? 0) > (around(best, of)[channel] ?? 0)) best = angle;
    return best;
}

/** The table's integral over the sphere in one channel, between two scattering angles. */
function overSphere(channel: number, from = 0, to = 180, of: RainbowTable = table): number {
    const step = (of.to - of.from) / of.width;
    let sum = 0;
    for (let k = 0; k < of.width; ++k) {
        const angle = of.from + (k + 0.5) * step;
        if (angle >= from && angle < to)
            sum += (of.data[k * 4 + channel] ?? 0) * 2 * Math.PI * Math.sin(angle * DEG) * step * DEG;
    }
    return sum;
}

/** What a surface of index `n` reflects of unpolarized light at an incidence in radians, by Fresnel. */
function reflected(n: number, incidence: number): number {
    const refracted = Math.asin(Math.sin(incidence) / n);
    const across = (Math.sin(incidence - refracted) / Math.sin(incidence + refracted)) ** 2;
    const along = (Math.tan(incidence - refracted) / Math.tan(incidence + refracted)) ** 2;
    return (across + along) / 2;
}

test("water's index is that of the tables, against air at 20 °C, and higher in blue light", () => {
    // Fraunhofer's C, D and F lines.
    expect(waterIndex(656.3)).toBeCloseTo(1.33115, 4);
    expect(waterIndex(589.3)).toBeCloseTo(1.33299, 4);
    expect(waterIndex(486.1)).toBeCloseTo(1.33712, 4);
    expect(waterIndex(400)).toBeGreaterThan(waterIndex(700) + 0.012);
});

test("Descartes' rays stand at 42° in red and 40° in violet, the secondary's near 51° with its colors reversed", () => {
    expect(bowRadius(1, 700)).toBeCloseTo(42.5, 1);
    expect(bowRadius(1, 400)).toBeCloseTo(40.6, 1);
    expect(bowRadius(2, 700)).toBeCloseTo(50.1, 1);
    expect(bowRadius(2, 400)).toBeCloseTo(53.5, 1);
    expect(bowRadius()).toBeCloseTo(41.9, 1);
    expect(bowRadius(2)).toBeCloseTo(51.2, 1);
});

test("the table is finite and nowhere negative, over all angles", () => {
    expect(table.width).toBe(1440);
    expect(table.data.length).toBe(1440 * 4);
    expect([table.from, table.to]).toEqual([RAINBOW_FROM, RAINBOW_TO]);
    expect(table.data.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    for (const options of [{ dropRadiusMm: 0.1, spread: 0 }, { dropRadiusMm: 2, sunDiameter: 0 }, { texels: 360 }]) {
        const other = rainbowTable(options);
        expect(other.data.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
        expect(overSphere(LUMINANCE, 0, 180, other)).toBeCloseTo(0.997, 2);
    }
});

test("the primary bow is brightest near 42° in red and nearer 40° in blue, red on its outside", () => {
    const peaks = [RED, GREEN, BLUE].map((channel) => brightest(channel, 36, 46));
    expect(peaks[RED]).toBeGreaterThan(41.6);
    expect(peaks[RED]).toBeLessThan(42.4);
    expect(peaks[GREEN]).toBeGreaterThan(41.2);
    expect(peaks[GREEN]).toBeLessThan(41.9);
    expect(peaks[BLUE]).toBeGreaterThan(40.5);
    expect(peaks[BLUE]).toBeLessThan(41.3);
    expect(peaks[RED]).toBeGreaterThan((peaks[GREEN] ?? 0) + 0.2);
    expect(peaks[GREEN]).toBeGreaterThan((peaks[BLUE] ?? 0) + 0.4);
    // At its outer rim the bow is red and nothing else, at its inner rim more blue than red.
    const [outer, inner] = [around(42.1), around(40.8)];
    expect(outer[RED]).toBeGreaterThan(3 * (outer[GREEN] ?? 0));
    expect(outer[GREEN]).toBeGreaterThan(outer[BLUE] ?? 0);
    expect(inner[BLUE]).toBeGreaterThan(1.5 * (inner[RED] ?? 0));
});

test("the secondary bow stands near 51°, red on its inside, an eighth as bright as the primary", () => {
    const peaks = [RED, GREEN, BLUE].map((channel) => brightest(channel, 47, 58));
    expect(peaks[RED]).toBeGreaterThan(50.6);
    expect(peaks[RED]).toBeLessThan(51.6);
    expect(peaks[BLUE]).toBeGreaterThan(52.4);
    expect(peaks[BLUE]).toBeLessThan(53.4);
    expect(peaks[GREEN]).toBeGreaterThan((peaks[RED] ?? 0) + 0.3);
    expect(peaks[BLUE]).toBeGreaterThan((peaks[GREEN] ?? 0) + 0.6);
    const share =
        (around(brightest(LUMINANCE, 47, 58))[LUMINANCE] ?? 0) / (around(brightest(LUMINANCE, 36, 46))[LUMINANCE] ?? 1);
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.2);
});

test("Alexander's band is darker than the sky inside the primary and outside the secondary", () => {
    const [inside, band, outside] = [around(38), around(46.5), around(56)];
    expect((inside[LUMINANCE] ?? 0) / (band[LUMINANCE] ?? 1)).toBeGreaterThan(15);
    expect((outside[LUMINANCE] ?? 0) / (band[LUMINANCE] ?? 1)).toBeGreaterThan(3);
    // Between the bows only the drops' outsides send light, and that is gray: Fresnel's share over the sphere.
    const mirrored = reflected(waterIndex(550), (46.5 / 2) * DEG) / (4 * Math.PI);
    for (const channel of [RED, GREEN, BLUE, LUMINANCE]) expect((band[channel] ?? 0) / mirrored).toBeCloseTo(1, 1);
});

test("the table holds all that a drop scatters but the 0.3 % of three and more reflections inside", () => {
    for (const channel of [RED, GREEN, BLUE, LUMINANCE]) expect(overSphere(channel)).toBeCloseTo(0.9968, 3);
    // The rays' own shares: let through 88 % and reflected outside 7 %, the primary bow 4 %, the secondary 0.6 %.
    expect(overSphere(LUMINANCE, 0, 90)).toBeCloseTo(0.939, 2);
    expect(overSphere(LUMINANCE, 90, 180)).toBeCloseTo(0.058, 2);
    // Straight on, the light let through the drop's middle and the grazing light off its outside, in closed form.
    const n = waterIndex(550);
    const through = (1 - ((n - 1) / (n + 1)) ** 2) ** 2;
    const forward = (through * n * n) / (4 * Math.PI * (n - 1) ** 2) + 1 / (4 * Math.PI);
    expect((rainbowPhase(table, 0)[LUMINANCE] ?? 0) / forward).toBeCloseTo(1, 2);
});

test("small drops of nearly one size draw supernumerary bows, and smaller ones a paler bow farther in", () => {
    const fine = rainbowTable({ dropRadiusMm: 0.15, spread: 0.1 });
    // Green's first supernumerary inside its bow: Ai² has its first two crests 2.23 apart, 1.5° for these drops.
    const first = brightest(GREEN, 36, 46, fine);
    const second = brightest(GREEN, 36, first - 0.8, fine);
    const size = (2 * Math.PI * 150_000) / 550;
    const incidence = Math.acos(Math.sqrt((waterIndex(550) ** 2 - 1) / 3));
    const pace = Math.cbrt((2 * size * size * Math.cos(incidence) ** 2) / (1.5 * Math.tan(incidence))) * DEG;
    expect(first - second).toBeCloseTo((3.2482 - 1.0188) / pace, 1);
    const gap = Math.min(...[0.2, 0.4, 0.6, 0.8].map((t) => around(first - t * (first - second), fine)[GREEN] ?? 0));
    expect(gap).toBeLessThan(0.3 * (around(second, fine)[GREEN] ?? 0));
    // A shower's drops draw none: from its crest inwards the bow only fades.
    const crest = brightest(GREEN, 36, 46);
    for (let angle = 36; angle < crest - 0.25; angle += 0.25)
        expect(around(angle)[GREEN] ?? 0).toBeLessThan(around(angle + 0.25)[GREEN] ?? 0);
    // The smaller the drops, the wider their bow, the fainter its crest and the farther inside Descartes' ray.
    const mist = rainbowTable({ dropRadiusMm: 0.05 });
    const [pale, bright] = [brightest(LUMINANCE, 36, 46, mist), brightest(LUMINANCE, 36, 46)];
    expect(around(pale, mist)[LUMINANCE]).toBeLessThan(0.75 * (around(bright)[LUMINANCE] ?? 0));
    expect(pale).toBeLessThan(bright - 0.7);
});

test("a bow's points stand its radius from the antisolar point, its top that much less the sun's height up", () => {
    const sun = [0, -Math.cos(20 * DEG), Math.sin(20 * DEG)];
    for (const turn of [0, 37, 90, 180, -120])
        expect(antisolarAngle(bowDirection(sun, 42, turn), sun)).toBeCloseTo(42, 9);
    // With the sun in the south the top stands in the north, and a quarter turn clockwise leads east.
    const top = bowDirection(sun, 42);
    expect(top[0]).toBeCloseTo(0, 12);
    expect(Math.asin(top[2]) / DEG).toBeCloseTo(22, 9);
    expect(bowDirection(sun, 42, 90)[0]).toBeCloseTo(Math.sin(42 * DEG), 12);
    expect(antisolarAngle([0, 1, 0], sun)).toBeCloseTo(20, 9);
    expect(bowTop(20)).toBeCloseTo(21.9, 1);
    expect(bowTop(43)).toBeLessThan(0);
    expect(bowTop(43, 2)).toBeGreaterThan(0);
});

test("a shower of 5 mm/h has drops of half a millimeter and takes two fifths of the light per km", () => {
    expect(rainDropRadius(5)).toBeCloseTo(0.52, 2);
    expect(rainExtinction(5)).toBeCloseTo(0.5, 1);
    expect(rainExtinction(50)).toBeGreaterThan(4 * rainExtinction(5));
});

/** The table as rgba16float texels: a format every device may filter. */
function halfFloats(data: Float32Array): Uint16Array {
    const [float, bits] = [new Float32Array(1), new Uint32Array(1)];
    const view = new Uint32Array(float.buffer);
    return Uint16Array.from(data, (value) => {
        float[0] = value;
        bits[0] = view[0] ?? 0;
        const exponent = ((bits[0] >>> 23) & 0xff) - 112;
        if (exponent <= 0) return 0;
        return ((bits[0] >>> 16) & 0x8000) + (exponent << 10) + (((bits[0] & 0x7fffff) + 0x1000) >>> 13);
    });
}

test("rainbow.wgsl compiles on its own, maps angles as the table lays them out and reads it as its TypeScript twin", async () => {
    const source = readFileSync(new URL("../src/wgsl/rainbow.wgsl", import.meta.url), "utf8");
    expect(Number(source.match(/const GW_RAINBOW_FROM: f32 = ([\d.]+);/)?.[1])).toBe(RAINBOW_FROM);
    expect(Number(source.match(/const GW_RAINBOW_TO: f32 = ([\d.]+);/)?.[1])).toBe(RAINBOW_TO);
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const angles = [0.01, 30, 100, 128.7, 133, 137.9, 138.4, 139.2, 150, 179.99];
    const code = `${source}
@group(0) @binding(0) var table: texture_2d<f32>;
@group(0) @binding(1) var tableSampler: sampler;
@group(0) @binding(2) var<storage, read_write> results: array<vec4f, ${angles.length + 1}>;
@compute @workgroup_size(1)
fn main() {
${angles.map((angle, i) => `    results[${i}] = vec4f(gwRainbowPhase(cos(radians(${angle})), table, tableSampler), 0.0);`).join("\n")}
    let sun = vec3f(0.0, -cos(radians(20.0)), sin(radians(20.0)));
    let top = vec3f(0.0, cos(radians(22.0)), sin(radians(22.0)));
    results[${angles.length}] = vec4f(gwRainbowOf(top, sun, vec3f(100000.0), 0.25, table, tableSampler), 0.0);
}`;
    expect(await compileWgsl(device, code)).toEqual([]);
    const texture = device.createTexture({
        size: [table.width, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, halfFloats(table.data), {}, [table.width, 1]);
    const size = (angles.length + 1) * 16;
    const buffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ code });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
        0,
        device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: texture.createView() },
                // Repeating, as the layers' sampler is: the fragment keeps within the row.
                {
                    binding: 1,
                    resource: device.createSampler({
                        magFilter: "linear",
                        minFilter: "linear",
                        addressModeU: "repeat",
                    }),
                },
                { binding: 2, resource: { buffer } },
            ],
        }),
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(staging.getMappedRange().slice(0));
    staging.destroy();
    buffer.destroy();
    texture.destroy();
    for (const [i, angle] of angles.entries()) {
        const expected = rainbowPhase(table, angle);
        for (const channel of [RED, GREEN, BLUE])
            expect(Math.abs((values[i * 4 + channel] ?? 0) - (expected[channel] ?? 0))).toBeLessThan(
                0.02 * (expected[channel] ?? 0) + 2e-4,
            );
    }
    // The top of the primary bow under a sun of 100,000 lux through rain of optical depth 0.25: thousands of cd/m².
    const crest = around(42);
    for (const channel of [RED, GREEN])
        expect((values[angles.length * 4 + channel] ?? 0) / (25_000 * (crest[channel] ?? 1))).toBeCloseTo(1, 1);
    expect(values[angles.length * 4 + RED]).toBeGreaterThan(2500);
});
