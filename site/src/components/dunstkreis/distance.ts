import type { SkyPass } from "@himmelszelt/dunstkreis";
import { clampObserverHeight, createSkyPass, wgsl } from "@himmelszelt/dunstkreis";
import { fromJulianDay, julianEphemerisDay, sun } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { onChange, state } from "../sternzeit/state";
import { configureCanvas, gpu, gpuDevice, onTables, quality, SDR, tables } from "./atmosphere";

// Distance in the air: ridges one behind another over the page's sky, faded by dunstkreis' aerial perspective volume.
// The sky pass writes the sky linear into a float texture and builds the volume for the same camera; a second pass,
// the figure's own, draws the ridges over it and applies the volume, as a renderer would to its terrain.

const DEG = Math.PI / 180;
const RIDGES = 4;
// The camera: 70 degrees round from the Sun, so its disc and glow stay out of view, looking just above the horizon.
const AZIMUTH_FROM_SUN = 70 * DEG;
const PITCH = 1.5 * DEG;
const FOV = 14 * DEG;
// The volume reaches past the farthest ridge at the slider's end.
const MAX_DISTANCE_KM = 128;

const composite = `
${wgsl.atmosphere}
${wgsl.aerial}
${wgsl.tonemap}

struct Params {
    forward: vec3f,
    tx: f32,
    right: vec3f,
    ty: f32,
    up: vec3f,
    exposure: f32,
    sun: vec3f,
    h: f32,
    sunIlluminance: vec3f,
    scale: f32,
    nearest: f32,
    maxDistance: f32,
    air: u32,
    pad: f32,
}
@group(0) @binding(0) var<uniform> atmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var sky: texture_2d<f32>;
@group(0) @binding(3) var luminanceVolume: texture_3d<f32>;
@group(0) @binding(4) var transmittanceVolume: texture_3d<f32>;
@group(0) @binding(5) var volumeSampler: sampler;
@group(0) @binding(6) var output: texture_storage_2d<rgba8unorm, write>;

// A ridge's top along the azimuth x, as an angle above the horizontal: a few waves of its own, each ridge peeking out
// over the one in front, however far they are.
fn ridgeTop(i: u32, x: f32) -> f32 {
    let s = f32(i) * 2.3 + 1.0;
    let f = 9.0 + f32(i) * 3.0;
    let wave = 1.0 + 0.3 * sin(x * f + s) + 0.15 * sin(x * f * 2.3 + 2.0 * s) + 0.08 * sin(x * f * 5.1 + 3.0 * s);
    return radians(0.6 + 0.65 * f32(i)) * wave;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let direction = normalize(params.forward + params.right * params.tx * ndc.x + params.up * params.ty * ndc.y);
    // Exposed already, by the same exposure.
    var color = textureLoad(sky, id.xy, 0).rgb;

    // The nearest ridge in front of the pixel, the curvature of the Earth taken off its height.
    let azimuth = atan2(dot(direction, params.right), dot(direction, params.forward));
    let altitude = asin(direction.z);
    for (var i = 0u; i < ${RIDGES}u; i++) {
        let distance = params.nearest * exp2(f32(i));
        if (altitude < ridgeTop(i, azimuth)) {
            // Dark rock and grass, lit by the sun and, a fifth as much, by the sky, without any air in between.
            let albedo = vec3f(0.08, 0.1, 0.07);
            let light = params.sunIlluminance * (max(params.sun.z, 0.0) * 0.8 + 0.2);
            var ridge = albedo / 3.14159265 * light;
            if (params.air == 1u) {
                let along = distance / max(cos(altitude), 1e-3);
                let air = dkSampleAerialPerspective(
                    luminanceVolume, transmittanceVolume, volumeSampler, uv, along, params.maxDistance, params.scale,
                );
                ridge = dkApplyAerialPerspective(atmosphere, ridge, air);
            }
            color = ridge * params.exposure;
            break;
        }
    }
    textureStore(output, id.xy, vec4f(dkToneMapNeutral(color), 1.0));
}
`;

const root = find<HTMLElement>("#distance");
const canvas = find<HTMLCanvasElement>('[data-field="canvas"]', root);
const slider = find<HTMLInputElement>('[data-field="distance"]', root);
const readout = find<HTMLOutputElement>('[data-field="distanceValue"]', root);
const airButton = find<HTMLButtonElement>('[data-field="air"]', root);
const PARAMS_SIZE = 96;
// The slider's 0 to 5 are powers of two: the nearest ridge from 1 to 32 km.
const nearestKm = () => 2 ** Number(slider.value);

if (gpu.device) {
    const device = gpuDevice();
    const context = canvas.getContext("webgpu");
    if (context) configureCanvas(context, SDR);
    const pipeline = device.createComputePipeline({
        label: "sternwarte:distance",
        layout: "auto",
        compute: {
            module: device.createShaderModule({ label: "sternwarte:distance", code: composite }),
            entryPoint: "main",
        },
    });
    const paramsBuffer = device.createBuffer({
        size: PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    let pass: SkyPass | null = null;
    let passFor: unknown = null;
    let skyTexture: GPUTexture | null = null;
    // Read back from the pass after a frame, and drawn with on the next: the meter's EV100 and the sunlight's lux.
    let ev = 12;
    let sunlight: [number, number, number] = [50_000, 50_000, 50_000];

    const draw = onDemand(() => {
        const table = tables();
        if (!context || !table) return;
        if (passFor !== table.luts) {
            passFor = table.luts;
            const luts = table.luts;
            createSkyPass(device, {
                luts,
                format: "rgba16float",
                toneMap: false,
                sunDisc: false,
                groundLight: quality.groundLight,
                aerialPerspective: { maxDistanceKm: MAX_DISTANCE_KM },
            }).then((next) => {
                if (passFor !== luts) return next.destroy();
                pass?.destroy();
                pass = next;
                draw();
            });
        }
        if (!pass?.aerialPerspective) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
        if (!skyTexture || skyTexture.width !== width || skyTexture.height !== height) {
            skyTexture?.destroy();
            skyTexture = device.createTexture({
                size: [width, height],
                format: "rgba16float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            });
        }

        const time = fromJulianDay(state.jd);
        const sunDirection = sun.direction(time, state);
        const sunAngularDiameter = sun.apparentAngularDiameter(julianEphemerisDay(time));
        const yaw = Math.atan2(sunDirection[0], sunDirection[1]) + AZIMUTH_FROM_SUN;
        const forward = [Math.cos(PITCH) * Math.sin(yaw), Math.cos(PITCH) * Math.cos(yaw), Math.sin(PITCH)];
        const right = [Math.cos(yaw), -Math.sin(yaw), 0];
        const up = [
            (right[1] ?? 0) * (forward[2] ?? 0) - (right[2] ?? 0) * (forward[1] ?? 0),
            (right[2] ?? 0) * (forward[0] ?? 0) - (right[0] ?? 0) * (forward[2] ?? 0),
            (right[0] ?? 0) * (forward[1] ?? 0) - (right[1] ?? 0) * (forward[0] ?? 0),
        ];
        const ty = Math.tan(FOV / 2);
        const tx = (ty * width) / height;
        const heightM = clampObserverHeight(state.heightM);
        const encoder = device.createCommandEncoder();
        pass.update(
            {
                sunDirection,
                sunAngularDiameter,
                observerHeightM: heightM,
                ev100: ev,
                inverseViewProjection: new Float32Array([
                    ...right.map((c) => c * tx),
                    0,
                    ...up.map((c) => c * ty),
                    0,
                    0,
                    0,
                    0,
                    1,
                    ...forward,
                    0,
                ]),
            },
            encoder,
        );
        pass.encode(encoder, skyTexture);

        const data = new ArrayBuffer(PARAMS_SIZE);
        const f = new Float32Array(data);
        f.set([...forward, tx, ...right, ty, ...up, 1 / (1.2 * 2 ** ev), ...sunDirection, heightM / 1000], 0);
        f.set([...sunlight, pass.skyViewScale, nearestKm(), MAX_DISTANCE_KM], 16);
        new Uint32Array(data)[22] = airButton.getAttribute("aria-pressed") === "true" ? 1 : 0;
        device.queue.writeBuffer(paramsBuffer, 0, data);

        const volume = pass.aerialPerspective;
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: table.luts.atmosphereBuffer } },
                { binding: 1, resource: { buffer: paramsBuffer } },
                { binding: 2, resource: skyTexture.createView() },
                { binding: 3, resource: volume.luminance.createView() },
                { binding: 4, resource: volume.transmittance.createView() },
                { binding: 5, resource: table.luts.sampler },
                { binding: 6, resource: context.getCurrentTexture().createView() },
            ],
        });
        const compute = encoder.beginComputePass();
        compute.setPipeline(pipeline);
        compute.setBindGroup(0, bindGroup);
        compute.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        compute.end();
        device.queue.submit([encoder.finish()]);

        // The exposure and the sunlight for the next frame, drawn again only if they moved.
        const drawn = pass;
        Promise.all([drawn.meteredEV100(), drawn.sunIlluminance()]).then(([metered, lux]) => {
            const moved =
                Math.abs(metered - ev) > 0.05 || lux.some((v, i) => Math.abs(v - (sunlight[i] ?? 0)) > 0.01 * v + 1);
            ev = metered;
            sunlight = lux;
            if (moved) draw();
        });
    }, canvas);

    const show = () => {
        readout.textContent = `${Math.round(nearestKm() * 10) / 10} km`;
        draw();
    };
    slider.addEventListener("input", show);
    airButton.addEventListener("click", () => {
        airButton.setAttribute("aria-pressed", String(airButton.getAttribute("aria-pressed") !== "true"));
        draw();
    });
    onChange(draw);
    onTables(draw);
    new ResizeObserver(draw).observe(canvas);
    show();
}
