/**
 * The GPU measurements behind README.md here: each table's error against a reference with many more samples or texels,
 * and the passes' GPU time by timestamp queries. Runs the built package (`pnpm build`) in Chromium with WebGPU, from a
 * page of the site's preview server, as WebGPU needs a secure context:
 *
 *     pnpm --filter @himmelszelt/sternwarte build && pnpm --filter @himmelszelt/sternwarte exec astro preview --port 4399
 *     node packages/dunstkreis/research/measure.mjs samples|tables|ground|timing
 *
 * The Chromium flags give a real GPU on Linux with Vulkan; elsewhere drop them or adapt.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const mode = process.argv[2] ?? "samples";
const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"],
});
const page = await browser.newPage();
await page.route("**/dunstkreis-dist/**", (route) =>
    route.fulfill({
        body: readFileSync(dist + route.request().url().split("/dunstkreis-dist/")[1], "utf8"),
        contentType: "text/javascript",
    }),
);
await page.goto("http://localhost:4399/himmelszelt/", { waitUntil: "networkidle" });

const result = await page.evaluate(async (mode) => {
    const dk = await import("/dunstkreis-dist/index.js");
    const adapter = await navigator.gpu.requestAdapter();
    const features = ["subgroups", "timestamp-query"].filter((f) => adapter.features.has(f));
    const device = await adapter.requestDevice({ requiredFeatures: features });
    const D = dk.DEFAULT_TEXTURE_CONFIG;
    const model = dk.DEFAULT_ATMOSPHERE_MODEL;
    const matrix = dk.spectrumToRgb(model);
    const cfg = (o = {}) => ({
        ...structuredClone(D),
        ...o,
        integralSamples: { ...D.integralSamples, ...(o.integralSamples ?? {}) },
    });
    // Suns 1.7° up, 5.7° and 12° down, and 45° up.
    const suns = [
        [0, 0.9995, 0.03],
        [0, 0.995, -0.1],
        [0, 0.978, -0.208],
        [0.5, 0.5, Math.SQRT1_2],
    ];

    // The luminance of a texel's four wavelengths, through the model's matrix; for ratios, of the sunlight through them.
    const luminanceOf = (d, i, ratio) => {
        const s = ratio ? model.solarSpectrum : [1, 1, 1, 1];
        const [r, g, b] = matrix.map((row) => row.reduce((sum, m, j) => sum + m * d[i + j] * s[j], 0));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // Relative luminance errors over the texels brighter than `floor` times the reference's brightest.
    const errors = (a, ref, floor, ratio = false) => {
        let peak = 0;
        for (let i = 0; i < ref.length; i += 4) peak = Math.max(peak, luminanceOf(ref, i, ratio));
        const out = [];
        for (let i = 0; i < ref.length; i += 4) {
            const r = luminanceOf(ref, i, ratio);
            if (r >= floor * peak) out.push(Math.abs(luminanceOf(a, i, ratio) - r) / r);
        }
        return out;
    };
    const stats = (list) => {
        list.sort((a, b) => a - b);
        const pct = (x) => `${(100 * x).toFixed(x < 0.001 ? 4 : 2)}%`;
        const mean = list.reduce((s, e) => s + e, 0) / list.length;
        return `mean ${pct(mean)}  p99 ${pct(list[Math.floor(list.length * 0.99)])}  max ${pct(list.at(-1))}`;
    };
    const worstOf = (lines) =>
        lines.sort((a, b) => Number(b.split("max ")[1].slice(0, -1)) - Number(a.split("max ")[1].slice(0, -1)))[0];

    const tables = async (c) => {
        const luts = await dk.precomputeAtmosphere(device, { config: c });
        const t = (await dk.readTexture(device, luts.transmittance)).data;
        const stored = (await dk.readTexture(device, luts.multiScattering)).data;
        const m = stored.map((v) => 2 ** (v - dk.MULTI_SCATTERING_LOG2_OFFSET));
        return { luts, t, m };
    };
    const skyView = async (luts, c, sun) => {
        const pass = await dk.createSkyPass(device, { luts: { ...luts, config: c }, format: "rgba8unorm" });
        pass.update({ sunDirection: sun, observerHeightM: 10 });
        const { data } = await dk.readTexture(device, pass.skyViewTexture);
        pass.destroy();
        return data;
    };
    // A low-resolution table read bilinearly, as the shaders do, at a reference's texel centers; the sky view's two
    // halves apart, as the sky pass keeps them.
    const resample = (low, w, h, W, H, split = false) => {
        const out = new Float32Array(W * H * 4);
        for (let j = 0; j < H; j++)
            for (let i = 0; i < W; i++) {
                const x = (i / (W - 1)) * (w - 1);
                let y = (j / (H - 1)) * (h - 1);
                if (split) y = j < H / 2 ? Math.min(y, h / 2 - 1) : Math.max(y, h / 2);
                const [x0, y0] = [Math.floor(x), Math.floor(y)];
                const [x1, y1] = [Math.min(x0 + 1, w - 1), Math.min(y0 + 1, h - 1)];
                const [fx, fy] = [x - x0, y - y0];
                for (let c = 0; c < 4; c++) {
                    const at = (xx, yy) => low[(yy * w + xx) * 4 + c];
                    const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
                    const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
                    out[(j * W + i) * 4 + c] = top * (1 - fy) + bottom * fy;
                }
            }
        return out;
    };

    const out = [];
    if (mode === "samples") {
        const ref = await tables(cfg({ integralSamples: { transmittance: 1000, multiScattering: 400 } }));
        for (const s of [20, 40, 64, 100, 128, 256]) {
            const t = await tables(cfg({ integralSamples: { transmittance: s, multiScattering: 400 } }));
            out.push(`transmittance samples ${s}: ${stats(errors(t.t, ref.t, 1e-4, true))}`);
        }
        for (const s of [10, 20, 40, 64, 100]) {
            const t = await tables(cfg({ integralSamples: { transmittance: 1000, multiScattering: s } }));
            out.push(`multiple-scattering samples ${s}: ${stats(errors(t.m, ref.m, 1e-6, true))}`);
        }
        for (const s of [8, 16, 20, 30, 40, 64, 128]) {
            const lines = [];
            for (const sun of suns) {
                const want = await skyView(ref.luts, cfg({ integralSamples: { skyView: 400 } }), sun);
                lines.push(
                    stats(errors(await skyView(ref.luts, cfg({ integralSamples: { skyView: s } }), sun), want, 1e-3)),
                );
            }
            out.push(`sky-view samples ${s}, worst sun: ${worstOf(lines)}`);
        }
    } else if (mode === "ground") {
        // The sky's irradiance on the ground from the sky-view table, as the shader integrates it texel by texel,
        // against brute force: a million points of Vogel's spiral, read bilinearly; and the 1024 points used before.
        const luts = await dk.precomputeAtmosphere(device);
        const { width: W, height: H } = D.skyView;
        const n = (x) => 1 + model.refractivity * Math.exp(-x / model.rayleigh.scaleHeightKm);
        const Rg = model.planet.groundRadiusKm;
        const nr = n(0.01) * (Rg + 0.01);
        const zH = Math.acos(-Math.sqrt(Math.max(nr * nr - (n(0) * Rg) ** 2, 0)) / nr);
        const texel = (d, x, y, c) => d[(y * W + x) * 4 + c];
        const luminance = (v) => luminanceOf(v, 0, false);
        const quadrature = (d) => {
            const sum = [0, 0, 0, 0];
            const clamp = (v, hi) => Math.min(Math.max(v, 0), hi);
            for (let row = 0; row < H / 2; row++)
                for (let column = 0; column < W; column++) {
                    const azimuth =
                        2 *
                        (Math.asin(clamp((column + 0.5) / (W - 1), 1)) - Math.asin(clamp((column - 0.5) / (W - 1), 1)));
                    const mu = [row - 0.5, row + 0.5].map((r) =>
                        Math.max(Math.cos(zH * (1 - (1 - 2 * clamp(r / (H - 1), 0.5)) ** 2)), 0),
                    );
                    const weight = azimuth * (mu[0] ** 2 - mu[1] ** 2);
                    for (let c = 0; c < 4; c++) sum[c] += texel(d, column, row, c) * weight;
                }
            return sum;
        };
        const vogel = (d, count) => {
            const sum = [0, 0, 0, 0];
            for (let i = 0; i < count; i++) {
                const mu = Math.sqrt(1 - (i + 0.5) / count);
                const cosAzimuth = Math.cos(i * 2.399963229728653);
                const y = (1 - Math.sqrt(Math.max((zH - Math.acos(mu)) / zH, 0))) * 0.5 * (H - 1);
                const x = Math.sqrt(Math.min(Math.max(0.5 - cosAzimuth * 0.5, 0), 1)) * (W - 1);
                const [x0, y0] = [Math.floor(x), Math.min(Math.floor(y), H / 2 - 1)];
                const [x1, y1] = [Math.min(x0 + 1, W - 1), Math.min(y0 + 1, H / 2 - 1)];
                const [fx, fy] = [x - x0, Math.min(y - y0, 1)];
                for (let c = 0; c < 4; c++) {
                    const top = texel(d, x0, y0, c) * (1 - fx) + texel(d, x1, y0, c) * fx;
                    const bottom = texel(d, x0, y1, c) * (1 - fx) + texel(d, x1, y1, c) * fx;
                    sum[c] += ((top * (1 - fy) + bottom * fy) * Math.PI) / count;
                }
            }
            return sum;
        };
        for (const sun of suns) {
            const d = await skyView(luts, cfg(), sun);
            const truth = luminance(vogel(d, 1_000_000));
            const pct = (v) => `${((100 * (luminance(v) - truth)) / truth).toFixed(3)}%`;
            out.push(
                `sun z ${sun[2].toFixed(2)}: texel quadrature ${pct(quadrature(d))}, spiral of 1024 ${pct(vogel(d, 1024))}`,
            );
        }
    } else if (mode === "tables") {
        const S = { transmittance: 128, multiScattering: 64, skyView: 30 };
        // The transmittance and multiple-scattering tables by their effect on the sky view, the sky view directly.
        const ref = await tables(
            cfg({
                transmittance: { width: 1024, height: 1024 },
                multiScattering: { width: 256, height: 256 },
                integralSamples: S,
            }),
        );
        const refViews = [];
        for (const sun of suns) refViews.push(await skyView(ref.luts, cfg({ integralSamples: S }), sun));
        const impact = async (c, name) => {
            const t = await tables(c);
            const lines = [];
            for (const [k, sun] of suns.entries())
                lines.push(stats(errors(await skyView(t.luts, cfg({ integralSamples: S }), sun), refViews[k], 1e-3)));
            out.push(`${name}:`, ...lines.map((line, k) => `    sun z ${suns[k][2].toFixed(2)}: ${line}`));
        };
        // Each against the reference with only its own table changed, the other at the reference's size.
        for (const [w, h] of [
            [128, 32],
            [256, 64],
            [512, 128],
            [128, 128],
            [512, 32],
        ])
            await impact(
                cfg({
                    transmittance: { width: w, height: h },
                    multiScattering: { width: 256, height: 256 },
                    integralSamples: S,
                }),
                `transmittance ${w}x${h}`,
            );
        for (const [w, h] of [
            [16, 16],
            [32, 32],
            [64, 64],
            [128, 32],
            [32, 128],
            [128, 64],
            [256, 32],
        ])
            await impact(
                cfg({
                    transmittance: { width: 1024, height: 1024 },
                    multiScattering: { width: w, height: h },
                    integralSamples: S,
                }),
                `multiple scattering ${w}x${h}`,
            );
        const W = 1024;
        const H = 1024;
        for (const [w, h] of [
            [192, 108],
            [256, 144],
            [144, 256],
            [64, 256],
            [128, 256],
            [128, 512],
        ]) {
            const lines = [];
            for (const sun of suns) {
                const want = await skyView(
                    ref.luts,
                    cfg({ skyView: { width: W, height: H }, integralSamples: S }),
                    sun,
                );
                const got = await skyView(ref.luts, cfg({ skyView: { width: w, height: h }, integralSamples: S }), sun);
                lines.push(stats(errors(resample(got, w, h, W, H, true), want, 1e-3)));
            }
            out.push(`sky view ${w}x${h}, worst sun: ${worstOf(lines)}`);
        }
    } else {
        // GPU time of one dispatch, by timestamp queries, the median of 15.
        const querySet = device.createQuerySet({ type: "timestamp", count: 2 });
        const resolve = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        const time = async (record) => {
            const t = [];
            for (let k = 0; k < 15; ++k) {
                const encoder = device.createCommandEncoder();
                const timestampWrites = { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
                const pass = encoder.beginComputePass({ timestampWrites });
                record(pass);
                pass.end();
                const staging = device.createBuffer({
                    size: 16,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
                });
                encoder.resolveQuerySet(querySet, 0, 2, resolve, 0);
                encoder.copyBufferToBuffer(resolve, 0, staging, 0, 16);
                device.queue.submit([encoder.finish()]);
                await staging.mapAsync(GPUMapMode.READ);
                const [a, b] = new BigUint64Array(staging.getMappedRange());
                t.push(Number(b - a) / 1e6);
                staging.destroy();
            }
            return `${t.sort((x, y) => x - y)[7].toFixed(3)} ms`;
        };
        const { wgsl } = dk;
        const luts = await dk.precomputeAtmosphere(device);
        const dispatch = async (code, entryPoint, constants, size, groups, entries) => {
            const module = device.createShaderModule({ code });
            const pipeline = await device.createComputePipelineAsync({
                layout: "auto",
                compute: { module, entryPoint, constants },
            });
            const target = device.createTexture({
                size,
                format: "rgba16float",
                usage: GPUTextureUsage.STORAGE_BINDING,
            });
            const layout = pipeline.getBindGroupLayout(0);
            const bindGroup = device.createBindGroup({ layout, entries: entries(target.createView()) });
            return time((pass) => {
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.dispatchWorkgroups(...groups);
            });
        };
        const atmosphere = { binding: 0, resource: { buffer: luts.atmosphereBuffer } };
        const transmittance = [wgsl.quality, wgsl.atmosphere, wgsl.common, wgsl.lut, wgsl.transmittance].join("\n");
        for (const [w, h, s] of [
            [256, 64, 40],
            [256, 64, 100],
            [256, 64, 128],
            [512, 128, 100],
        ])
            out.push(
                `transmittance ${w}x${h}, ${s} samples: ${await dispatch(transmittance, "dkPrecomputeTransmittance", { DK_SAMPLES_TRANSMITTANCE: s }, [w, h], [Math.ceil(w / 8), Math.ceil(h / 8)], (view) => [atmosphere, { binding: 1, resource: view }])}`,
            );
        const reduce = wgsl.workgroupSum(64, device.features.has("subgroups"));
        const multi = [
            reduce,
            wgsl.quality,
            wgsl.atmosphere,
            wgsl.common,
            wgsl.lut,
            wgsl.sampling,
            wgsl.multiscattering,
        ].join("\n");
        for (const [w, h, s] of [
            [32, 32, 20],
            [32, 32, 40],
            [64, 64, 40],
            [128, 64, 40],
            [128, 64, 64],
        ])
            out.push(
                `multiple scattering ${w}x${h}, ${s} samples: ${await dispatch(multi, "dkPrecomputeMultiScattering", { DK_SAMPLES_MULTI_SCATTERING: s }, [w, h], [w, h], (view) => [atmosphere, { binding: 1, resource: luts.transmittance.createView() }, { binding: 2, resource: luts.sampler }, { binding: 3, resource: view }])}`,
            );
        // The sum over a workgroup without subgroups, in workgroup memory: the same time, the parallelism is what counts.
        const fallback = [wgsl.workgroupSum(64, false), ...multi.split("\n").slice(reduce.split("\n").length)].join(
            "\n",
        );
        out.push(
            `multiple scattering 128x64, 40 samples, without subgroups: ${await dispatch(fallback, "dkPrecomputeMultiScattering", { DK_SAMPLES_MULTI_SCATTERING: 40 }, [128, 64], [128, 64], (view) => [atmosphere, { binding: 1, resource: luts.transmittance.createView() }, { binding: 2, resource: luts.sampler }, { binding: 3, resource: view }])}`,
        );
        const params = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(params, 0, new Float32Array([0, 0.9995, 0.03, 0.01]));
        const view = [
            reduce,
            wgsl.quality,
            wgsl.features,
            wgsl.atmosphere,
            wgsl.common,
            wgsl.lut,
            wgsl.sampling,
            wgsl.raymarch,
            wgsl.frame,
            wgsl.skyview,
        ].join("\n");
        for (const [w, h, s] of [
            [192, 108, 30],
            [128, 256, 15],
            [128, 256, 30],
            [128, 256, 40],
            [128, 512, 30],
        ]) {
            const metering = device.createBuffer({ size: 48 + 4 * h, usage: GPUBufferUsage.STORAGE });
            out.push(
                `sky view ${w}x${h}, ${s} samples: ${await dispatch(view, "dkPrecomputeSkyView", { DK_SAMPLES_SKY_VIEW: s }, [w, h], [Math.ceil(w / 8), Math.ceil(h / 8)], (target) => [atmosphere, { binding: 1, resource: { buffer: params } }, { binding: 2, resource: luts.transmittance.createView() }, { binding: 3, resource: luts.multiScattering.createView() }, { binding: 4, resource: luts.sampler }, { binding: 5, resource: target }, { binding: 6, resource: { buffer: metering } }])}`,
            );
        }
        out.unshift(`${adapter.info?.description || adapter.info?.vendor} ${[...device.features].join(", ")}`);
    }
    return out;
}, mode);
console.log(result.join("\n"));
await browser.close();
