import { wgsl } from "@himmelszelt/dunstkreis";
import { find } from "../dom";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { offsetSliders } from "../sternzeit/offset";
import { currentSky, gpu, gpuDevice, onSkyView, onTables, type Sky, tables } from "./atmosphere";
import { plot, type Readout, type Stage } from "./stagesplots";

// From light to pixels, stage by stage: one patch of the sky around the Sun after each of the five stages, drawn by one
// compute pass that composes dunstkreis' own WGSL, reading the sky-view table of the page's sky. A second entry point
// samples the vertical circle through the Sun after every stage, read back for the transfer plot.

const DEG = Math.PI / 180;
const PANELS = 5;
// The patch is this many degrees across: the Sun's disc a quarter of it.
const PATCH_DEG = 2;
// The gap between panels, in CSS pixels.
const GAP = 8;
// The plots' samples: the slice every half degree, the Sun, and the gray chain every eighth of a stop around white.
const SLICE = 181;
const CURVE_STOPS = [-24, 12] as const;
const CURVE = (CURVE_STOPS[1] - CURVE_STOPS[0]) * 8 + 1;
const SAMPLES = SLICE + 1 + CURVE;
const SAMPLE_FLOATS = 20;

const source = `
${wgsl.atmosphere}
${wgsl.common}
${wgsl.lut}
${wgsl.sampling}
${wgsl.sun}
${wgsl.tonemap}

struct Params {
    sun: vec3f,
    h: f32,
    forward: vec3f,
    skyViewScale: f32,
    right: vec3f,
    exposure: f32,
    up: vec3f,
    tanHalf: f32,
    sunRadius: f32,
    panel: f32,
    gap: f32,
    curve: u32,
    gamut: u32,
    dither: u32,
    levels: f32,
    matrix: u32,
}
@group(0) @binding(0) var<uniform> atmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var skyViewLut: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;
@group(0) @binding(5) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(6) var<storage, read_write> samples: array<Sample>;

// One direction after every stage, for the plots: its four wavelengths in cd/m², linear RGB in gamut with the lowest
// channel the matrix gave in w, the exposed light, tone mapped, and the code values over 1, quantized without dither.
struct Sample {
    spectral: vec4f,
    rgb: vec4f,
    exposed: vec4f,
    mapped: vec4f,
    pixel: vec4f,
}

const LUMINANCE = vec3f(0.2126, 0.7152, 0.0722);

// The light along a direction at the four wavelengths, in cd/m²: the sky from the table, and the disc apart, whole,
// with how much of the pixel it covers.
struct Light {
    sky: vec4f,
    disc: vec4f,
    coverage: f32,
}

fn lightAt(direction: vec3f, footprint: f32) -> Light {
    var light: Light;
    let horizon = dkHorizonOf(atmosphere, params.h);
    let ground = dkBelowHorizon(horizon, direction.z);
    var cosAzimuth = 1.0;
    if (length(direction.xy) > 1e-6 && length(params.sun.xy) > 1e-6) {
        cosAzimuth = clamp(dot(normalize(direction.xy), normalize(params.sun.xy)), -1.0, 1.0);
    }
    let size = vec2f(textureDimensions(skyViewLut));
    var uv = dkSkyViewUvAt(horizon, direction.z, cosAzimuth, size);
    let half = 0.5 / size.y;
    uv.y = select(min(uv.y, 0.5 - half), max(uv.y, 0.5 + half), ground);
    light.sky = textureSampleLevel(skyViewLut, lutSampler, uv, 0.0) / params.skyViewScale;
    if (!ground) {
        let transmittance = dkSampleTransmittanceToTop(atmosphere, transmittanceLut, lutSampler, params.h, direction.z);
        // Where the planet hides the sun, not even its edge: no disc rather than a black one.
        let hidden = max(max(transmittance.x, transmittance.y), max(transmittance.z, transmittance.w)) <= 0.0;
        light.coverage = select(dkSunDiscCoverage(direction, params.sun, params.sunRadius, footprint), 0.0, hidden);
        light.disc = transmittance * atmosphere.solarIlluminance / (DK_PI * params.sunRadius * params.sunRadius);
    }
    return light;
}

// Stage 2: the four wavelengths as RGB, by the fitted matrix or the first three taken as they are.
fn matrixed(spectral: vec4f) -> vec3f {
    if (params.matrix == 1u) {
        return spectral.xyz;
    }
    return atmosphere.toRgb * spectral;
}

// ... then into sRGB's gamut: desaturated towards its own gray as dkToRgb does, or each channel cut off at zero.
fn inGamut(rgb: vec3f) -> vec3f {
    if (params.gamut == 1u) {
        return max(rgb, vec3f(0.0));
    }
    let lowest = min(rgb.r, min(rgb.g, rgb.b));
    if (lowest >= 0.0) {
        return rgb;
    }
    let luminance = dot(rgb, LUMINANCE);
    if (luminance <= 0.0) {
        return vec3f(0.0);
    }
    return mix(rgb, vec3f(luminance), -lowest / (luminance - lowest));
}

fn toneMapped(exposed: vec3f) -> vec3f {
    if (params.curve == 2u) {
        return dkToneMapAgx(exposed);
    }
    if (params.curve == 3u) {
        return dkToneMapAces(exposed);
    }
    return dkToneMapNeutral(exposed);
}

fn quantized(mapped: vec3f, offset: f32) -> vec3f {
    let steps = params.levels - 1.0;
    return floor(mapped * steps + offset) / steps;
}

fn noise(p: vec2u) -> f32 {
    var h = p.x * 1664525u + p.y * 1013904223u;
    h = (h ^ (h >> 16u)) * 2246822519u;
    h = h ^ (h >> 13u);
    return f32(h & 0xffffu) / 65535.0;
}

// What panel \`panel\` shows of light at the four wavelengths, in sRGB encoded values. Panel 0 shows wavelength \`band\`.
fn shown(spectral: vec4f, panel: u32, band: u32, pixel: vec2u) -> vec3f {
    if (panel == 0u) {
        // Each wavelength as gray, as bright as a spectrum flat at its value would be.
        let flat = dot(atmosphere.toRgb * vec4f(1.0), LUMINANCE);
        return dkEncodeSrgb(vec3f(spectral[band] * flat * params.exposure));
    }
    let rgb = inGamut(matrixed(spectral));
    if (panel == 1u) {
        // Linear, before any exposure: the table's brightest sky, near 2^10 times its scale, at white.
        return dkEncodeSrgb(rgb * params.skyViewScale / 1024.0);
    }
    let exposed = rgb * params.exposure;
    if (panel == 2u) {
        return dkEncodeSrgb(exposed);
    }
    let mapped = toneMapped(exposed);
    if (panel == 3u) {
        return mapped;
    }
    return quantized(mapped, select(0.5, noise(pixel), params.dither == 1u));
}

fn stagesOf(spectral: vec4f) -> Sample {
    var sample: Sample;
    sample.spectral = spectral;
    let raw = matrixed(spectral);
    sample.rgb = vec4f(inGamut(raw), min(raw.r, min(raw.g, raw.b)));
    sample.exposed = vec4f(sample.rgb.rgb * params.exposure, 0.0);
    sample.mapped = vec4f(toneMapped(sample.exposed.rgb), 0.0);
    sample.pixel = vec4f(quantized(sample.mapped.rgb, 0.5), 0.0);
    return sample;
}

// The plots' samples: the vertical circle through the Sun from the horizon to the zenith, the Sun's own center, and
// the chain for a gray light over exposed stops, whose \`rgb\` holds it linear and sRGB encoded, both cut off at white.
@compute @workgroup_size(64, 1, 1)
fn slice(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i < ${SLICE}u) {
        let altitude = f32(i) / f32(${SLICE - 1}u) * DK_PI / 2.0;
        let azimuth = normalize(select(vec2f(0.0, 1.0), params.forward.xy, length(params.forward.xy) > 1e-6));
        let direction = vec3f(azimuth * cos(altitude), sin(altitude));
        samples[i] = stagesOf(lightAt(direction, 1e-4).sky);
    } else if (i == ${SLICE}u) {
        // The Sun's center, or once that has set, the highest point of its disc still showing, its w whether one does.
        var light = lightAt(params.sun, 1e-4);
        for (var k = 1; k <= 4 && all(light.disc == vec4f(0.0)); k++) {
            light = lightAt(normalize(params.sun + vec3f(0.0, 0.0, params.sunRadius * f32(k) / 4.0)), 1e-4);
        }
        samples[i] = stagesOf(light.sky + light.disc);
        samples[i].exposed.w = select(0.0, 1.0, any(light.disc > vec4f(0.0)));
    } else if (i < ${SAMPLES}u) {
        let stops = mix(${CURVE_STOPS[0]}.0, ${CURVE_STOPS[1]}.0, f32(i - ${SLICE + 1}u) / f32(${CURVE - 1}u));
        let gray = vec3f(exp2(stops));
        var sample: Sample;
        sample.rgb = vec4f(min(gray.r, 1.0), dkEncodeSrgb(gray).r, 0.0, 0.0);
        sample.exposed = vec4f(gray, 0.0);
        sample.mapped = vec4f(toneMapped(gray), 0.0);
        sample.pixel = vec4f(quantized(sample.mapped.rgb, 0.5), 0.0);
        samples[i] = sample;
    }
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let stride = params.panel + params.gap;
    let panel = u32(f32(id.x) / stride);
    let local = vec2f(f32(id.x) - f32(panel) * stride, f32(id.y)) + 0.5;
    if (panel >= ${PANELS}u || local.x > params.panel) {
        textureStore(output, id.xy, vec4f(0.0));
        return;
    }
    // Panel 0 holds the patch four times over, a quarter each, clockwise from the top left.
    var uv = local / params.panel;
    var band = 0u;
    var scale = 1.0;
    if (panel == 0u) {
        let right = uv.x >= 0.5;
        let lower = uv.y >= 0.5;
        band = select(select(0u, 1u, right), select(3u, 2u, right), lower);
        uv = fract(uv * 2.0);
        scale = 2.0;
    }
    let xy = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let direction = normalize(params.forward + (params.right * xy.x + params.up * xy.y) * params.tanHalf);
    let footprint = 2.0 * params.tanHalf * scale / params.panel;
    let light = lightAt(direction, footprint);

    // The disc mixed in after each stage by how much of the pixel it covers, as the sky pass does: mixed before, a
    // pixel it barely touches would turn white.
    var color = shown(light.sky, panel, band, id.xy);
    if (light.coverage > 0.0) {
        color = mix(color, shown(light.sky + light.disc, panel, band, id.xy), light.coverage);
    }
    // Where the matrix gives a channel below zero, a color outside sRGB, hatched.
    if (panel == 1u && params.matrix == 0u) {
        let raw = matrixed(light.sky + light.disc * light.coverage);
        if (min(raw.r, min(raw.g, raw.b)) < 0.0 && ((id.x + id.y) / 3u) % 3u == 0u) {
            color = vec3f(1.0, 0.0, 1.0);
        }
    }
    // Each panel's corners rounded as the page's framed panels are, 6 CSS pixels, three quarters of the gap: premultiplied.
    let half = vec2f(params.panel) * 0.5;
    let radius = 0.75 * params.gap;
    let corner = max(abs(local - half) - (half - radius), vec2f(0.0));
    let inside = clamp(radius + 0.5 - length(corner), 0.0, 1.0);
    textureStore(output, id.xy, vec4f(color * inside, inside));
}
`;

const root = find<HTMLElement>("#stages");
const canvas = find<HTMLCanvasElement>('[data-field="canvas"]', root);
const evInput = find<HTMLInputElement>('[data-field="ev"]', root);
const evValue = find<HTMLOutputElement>('[data-field="evValue"]', root);
const PARAMS_SIZE = 96;
const SAMPLES_SIZE = SAMPLES * SAMPLE_FLOATS * 4;

offsetSliders();

const plotSvg = find<SVGSVGElement>(".stages-transfer svg", root);
let readout: Readout | null = null;
const replot = onDemand(() => readout && plot(plotSvg, readout), plotSvg);

/** One sample of the readback, as far as the plot reads it: linear RGB in gamut and the code values. */
function stageAt(data: Float32Array, i: number): Stage {
    const at = (field: number) => [...data.subarray(i * SAMPLE_FLOATS + field * 4, i * SAMPLE_FLOATS + field * 4 + 3)];
    return { rgb: at(1), pixel: at(4) };
}

function readoutOf(data: Float32Array, ev: number, levels: number, curve: number): Readout {
    const curvePoints = Array.from({ length: CURVE }, (_, k) => {
        const s = stageAt(data, SLICE + 1 + k);
        return {
            stops: CURVE_STOPS[0] + (k * (CURVE_STOPS[1] - CURVE_STOPS[0])) / (CURVE - 1),
            linear: s.rgb[0] ?? 0,
            encoded: s.rgb[1] ?? 0,
            pixel: s.pixel[0] ?? 0,
        };
    });
    return {
        slice: Array.from({ length: SLICE }, (_, i) => stageAt(data, i)),
        sun: stageAt(data, SLICE),
        sunShows: (data[SLICE * SAMPLE_FLOATS + 11] ?? 0) > 0,
        curve: curvePoints,
        white: 1.2 * 2 ** ev,
        ev,
        levels,
        toneCurve: (["Neutral", "AgX", "ACES"] as const)[curve - 1] ?? "Neutral",
    };
}

if (gpu.device) {
    const device = gpuDevice();
    const context = canvas.getContext("webgpu");
    context?.configure({
        device,
        format: "rgba8unorm",
        usage: GPUTextureUsage.STORAGE_BINDING,
        alphaMode: "premultiplied",
    });
    const module = device.createShaderModule({ label: "sternwarte:stages", code: source });
    const pipeline = device.createComputePipeline({
        label: "sternwarte:stages",
        layout: "auto",
        compute: { module, entryPoint: "main" },
    });
    const slicePipeline = device.createComputePipeline({
        label: "sternwarte:stages slice",
        layout: "auto",
        compute: { module, entryPoint: "slice" },
    });
    const paramsBuffer = device.createBuffer({
        size: PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const samplesBuffer = device.createBuffer({
        label: "sternwarte:stages samples",
        size: SAMPLES_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readBuffer = device.createBuffer({
        label: "sternwarte:stages readback",
        size: SAMPLES_SIZE,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const choice = { matrix: 0, gamut: 0, curve: 1, levels: 256, dither: 1 };
    let sky: Sky | null = currentSky();
    let exposedByHand = false;
    // One readback at a time: a draw while one is under way reads again once it is done.
    let reading = false;
    let again = false;

    const draw = onDemand(() => {
        const table = tables();
        if (!context || !sky || !table) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const gap = Math.round(GAP * dpr);
        const width = Math.max(PANELS, Math.round(canvas.clientWidth * dpr));
        const panel = Math.floor((width - (PANELS - 1) * gap) / PANELS);
        if (canvas.width !== width || canvas.height !== panel) Object.assign(canvas, { width, height: panel });

        // Centered on the Sun where it shows, kept to the horizon once it has set.
        const [x, y, z] = sky.apparentSun;
        const forward = normalize([x, y, Math.max(z, -0.02)]);
        const yaw = Math.atan2(forward[0], forward[1]);
        const right = [Math.cos(yaw), -Math.sin(yaw), 0];
        const up = cross(right, forward);
        const ev = Number(evInput.value);
        evValue.textContent = ev.toFixed(1);

        const data = new ArrayBuffer(PARAMS_SIZE);
        const f = new Float32Array(data);
        const u = new Uint32Array(data);
        f.set([...sky.apparentSun, sky.observerHeightM / 1000], 0);
        f.set([...forward, sky.pass.skyViewScale], 4);
        f.set([...right, 1 / (1.2 * 2 ** ev)], 8);
        f.set([...up, Math.tan((PATCH_DEG / 2) * DEG)], 12);
        f.set([(sky.sunAngularDiameter / 2) * DEG, panel, gap], 16);
        u[19] = choice.curve;
        u[20] = choice.gamut;
        u[21] = choice.dither;
        f[22] = choice.levels;
        u[23] = choice.matrix;
        device.queue.writeBuffer(paramsBuffer, 0, data);

        const shared = [
            { binding: 0, resource: { buffer: table.luts.atmosphereBuffer } },
            { binding: 1, resource: { buffer: paramsBuffer } },
            { binding: 2, resource: table.luts.transmittance.createView() },
            { binding: 3, resource: sky.pass.skyViewTexture.createView() },
            { binding: 4, resource: table.luts.sampler },
        ];
        const texture = context.getCurrentTexture();
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [...shared, { binding: 5, resource: texture.createView() }],
        });
        const sliceGroup = device.createBindGroup({
            layout: slicePipeline.getBindGroupLayout(0),
            entries: [...shared, { binding: 6, resource: { buffer: samplesBuffer } }],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(panel / 8));
        if (!reading) {
            pass.setPipeline(slicePipeline);
            pass.setBindGroup(0, sliceGroup);
            pass.dispatchWorkgroups(Math.ceil(SAMPLES / 64));
        }
        pass.end();
        if (reading) {
            again = true;
            device.queue.submit([encoder.finish()]);
            return;
        }
        encoder.copyBufferToBuffer(samplesBuffer, 0, readBuffer, 0, SAMPLES_SIZE);
        device.queue.submit([encoder.finish()]);
        reading = true;
        const from = { ev, levels: choice.levels, curve: choice.curve };
        readBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const samples = new Float32Array(readBuffer.getMappedRange().slice(0));
            readBuffer.unmap();
            reading = false;
            readout = readoutOf(samples, from.ev, from.levels, from.curve);
            replot();
            if (again) {
                again = false;
                draw();
            }
        });
    }, canvas);

    onSkyView((next) => {
        sky = next;
        // The exposure follows what the page's sky metered, moment by moment, until the reader sets one.
        if (!exposedByHand) {
            next.pass.meteredEV100().then((ev) => {
                if (exposedByHand || sky !== next) return;
                evInput.value = String(Math.round(ev * 10) / 10);
                paintRange(evInput);
                draw();
            });
        }
        draw();
    });
    onTables(draw);
    evInput.addEventListener("input", () => {
        exposedByHand = true;
        draw();
    });
    // Each group of buttons is one choice: the pressed one is it.
    for (const [key, attribute] of [
        ["matrix", "data-matrix"],
        ["gamut", "data-gamut"],
        ["curve", "data-curve"],
        ["levels", "data-bits"],
    ] as const) {
        const buttons = [...root.querySelectorAll<HTMLButtonElement>(`[${attribute}]`)];
        for (const button of buttons) {
            button.addEventListener("click", () => {
                for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
                const value = button.getAttribute(attribute) ?? "";
                choice[key] = {
                    matrix: () => (value === "samples" ? 1 : 0),
                    gamut: () => (value === "clip" ? 1 : 0),
                    curve: () => Number(value),
                    levels: () => 2 ** Number(value),
                }[key]();
                draw();
            });
        }
    }
    const dither = find<HTMLButtonElement>('[data-field="dither"]', root);
    dither.addEventListener("click", () => {
        choice.dither = 1 - choice.dither;
        dither.setAttribute("aria-pressed", String(choice.dither === 1));
        draw();
    });
    new ResizeObserver(draw).observe(canvas);
    new ResizeObserver(replot).observe(plotSvg);
    draw();
}

function normalize([x, y, z]: number[]): number[] {
    const length = Math.hypot(x ?? 0, y ?? 0, z ?? 0);
    return [(x ?? 0) / length, (y ?? 0) / length, (z ?? 0) / length];
}

function cross([ax = 0, ay = 0, az = 0]: number[], [bx = 0, by = 0, bz = 0]: number[]): number[] {
    return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}
