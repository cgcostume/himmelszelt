import {
    type CubeFromPanoramaPass,
    createCubeFromPanoramaPass,
    createIrradiancePass,
    type IrradiancePass,
    wgsl,
} from "@himmelszelt/rundbild";
import { find } from "../dom";
import { configureCanvas, displayOutput, gpu, gpuDevice, SDR } from "../dunstkreis/atmosphere";
import { hdri, onHdri } from "../environment/hdri";
import { onDemand } from "../frame";
import { cameraFrame, createScene } from "../scene/scene";
import { gpuMissing } from "../webgpu";

const DEG = Math.PI / 180;
const root = find("#grounded");
const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
const canvas = field<HTMLCanvasElement>("canvas");
const camera = { yaw: 150 * DEG, pitch: 12 * DEG, distance: 6, fov: 50 * DEG };

// How many times the levels for a stretch halve the image along u more than along v, a stretch of 64 to 1, and where
// they begin, a few degrees above its horizon so that they fade in before it.
const RIPS = 6;
const BAND = 0.47;
// As good as without end, for the ground's reach and the dome's radius, and over how many degrees either side of a
// lifted horizon the stretch below it goes over into the one above.
const FAR = 1e9;
const LIFT_BLEND = 8 * DEG;

// What the scene shows behind its solids: the image through its camera, in the file's relative units. Where the ground
// or the lifted horizon stretch it, it is read from levels blurred more along u than along v, built for the image's
// lower half, and from its mip levels elsewhere, so that a stretch comes out as an even blur rather than in streaks.
const BACKDROP = /* wgsl */ `
${wgsl.panorama}
${wgsl.ground}
struct Params { right: vec3f, tx: f32, up: vec3f, ty: f32, forward: vec3f, height: f32, eye: vec3f, lift: f32, flat: u32, reach: f32, size: vec2f, band: f32, even: u32, radius: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var coarser: texture_2d<f32>;
${Array.from({ length: RIPS }, (_, k) => `@group(0) @binding(${5 + k}) var rip${k + 1}: texture_2d<f32>;`).join("\n")}

fn lookup(pixel: vec2f, size: vec2f) -> vec3f {
    let uv = pixel / size * 2.0 - 1.0;
    var direction = normalize(params.forward + params.right * (uv.x * params.tx) - params.up * (uv.y * params.ty));
    if (params.flat != 0u) {
        direction = rbGroundedDirection(params.eye, direction, params.height, params.reach, params.radius);
    }
    return rbLiftedHorizonDirection(direction, params.lift, ${LIFT_BLEND});
}

// The image at a mip level, its first level and the coarser ones from half its size on.
fn isotropic(uv: vec2f, lod: f32) -> vec3f {
    let coarse = textureSampleLevel(coarser, imageSampler, uv, lod - 1.0).rgb;
    if (lod >= 1.0) {
        return coarse;
    }
    return mix(textureSampleLevel(image, imageSampler, uv, 0.0).rgb, coarse, lod);
}

// The image at mip levels \`lods\` along u and v, from the level halved k more times along u than along v.
fn layer(k: u32, uv: vec2f, lods: vec2f) -> vec3f {
    if (k == 0u) {
        return isotropic(uv, max(lods.x, lods.y));
    }
    let band = vec2f(uv.x, (uv.y - params.band) / (1.0 - params.band));
    let lod = lods.x - f32(k);
    switch k {
${Array.from({ length: RIPS - 1 }, (_, k) => `        case ${k + 1}u: { return textureSampleLevel(rip${k + 1}, imageSampler, band, lod).rgb; }`).join("\n")}
        default: { return textureSampleLevel(rip${RIPS}, imageSampler, band, lod).rgb; }
    }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2f(textureDimensions(output));
    if (any(vec2f(id.xy) >= size)) {
        return;
    }
    let pixel = vec2f(id.xy) + 0.5;
    let direction = lookup(pixel, size);
    let stretched = rbStretchedLods(direction, lookup(pixel + vec2f(1.0, 0.0), size), lookup(pixel + vec2f(0.0, 1.0), size), params.size);
    // A stretch beyond what the levels hold is left a little sharp along u rather than blurred along v.
    let lods = vec2f(min(stretched.x, stretched.y + ${RIPS}.0), stretched.y);
    let uv = rbEquirectangularUv(direction, 0.0);
    let k = clamp(lods.x - lods.y, 0.0, ${RIPS}.0) * smoothstep(params.band, params.band + 0.02, uv.y);
    let k0 = u32(k);
    var light = layer(k0, uv, lods);
    if (k0 < ${RIPS}u && k > f32(k0)) {
        light = mix(light, layer(k0 + 1u, uv, lods), k - f32(k0));
    }
    if (params.even == 0u) {
        light = textureSampleLevel(image, imageSampler, uv, 0.0).rgb;
    }
    textureStore(output, vec2i(id.xy), vec4f(min(light, vec3f(6e4)), 1.0));
}`;

// Halves a level into the next by its four texels, clamped at an odd edge.
const HALVE = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var halved: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(halved))) {
        return;
    }
    let last = textureDimensions(source) - 1u;
    var sum = vec4f(0.0);
    for (var i = 0u; i < 4u; i++) {
        sum += min(textureLoad(source, min(id.xy * 2u + vec2u(i & 1u, i >> 1u), last), 0), vec4f(6e4));
    }
    textureStore(halved, id.xy, sum * 0.25);
}`;

// Halves a level along u alone, from the source's row \`top\` on.
const HALVE_U = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var halved: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> top: u32;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(halved))) {
        return;
    }
    let last = textureDimensions(source).x - 1u;
    let a = textureLoad(source, vec2u(min(id.x * 2u, last), id.y + top), 0);
    let b = textureLoad(source, vec2u(min(id.x * 2u + 1u, last), id.y + top), 0);
    textureStore(halved, id.xy, (min(a, vec4f(6e4)) + min(b, vec4f(6e4))) * 0.5);
}`;

// A cube map only for the nine coefficients, which need no more.
const CUBE_SIZE = 256;

function setPitch(pitch: number) {
    camera.pitch = Math.max(Math.asin(Math.max(-1, -0.55 / camera.distance)), Math.min(89 * DEG, pitch));
}

if (gpu.error) {
    gpuMissing(canvas, "sky-error");
} else {
    const device = gpuDevice();
    const context = canvas.getContext("webgpu");
    if (context) configureCanvas(context, SDR);
    const scene = createScene(device);
    const backdrop = device.createComputePipeline({
        label: "sternwarte:groundedBackdrop",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: BACKDROP }), entryPoint: "main" },
    });
    const halve = device.createComputePipeline({
        label: "sternwarte:groundedHalve",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: HALVE }), entryPoint: "main" },
    });
    const halveU = device.createComputePipeline({
        label: "sternwarte:groundedHalveU",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: HALVE_U }), entryPoint: "main" },
    });
    const tops = [0, 0].map(() =>
        device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    );
    const sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "repeat",
    });
    const params = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const cube = device.createTexture({
        label: "sternwarte:groundedCube",
        size: [CUBE_SIZE, CUBE_SIZE, 6],
        mipLevelCount: Math.log2(CUBE_SIZE) + 1,
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        textureBindingViewDimension: "cube",
    });
    let target: GPUTexture | null = null;
    let passes: [CubeFromPanoramaPass, IrradiancePass] | null = null;
    let litBy: GPUTexture | null = null;
    let levels: GPUTexture[] = [];
    let top = 0;
    Promise.all([createCubeFromPanoramaPass(device, { samples: 4 }), createIrradiancePass(device)]).then((made) => {
        passes = made;
        request();
    });

    const slider = (name: string) => Number(field<HTMLInputElement>(name).value);
    // The dome's radius from 5 to 500 and the ground's reach from 3 to 300 on logarithmic sliders, the last step of
    // each without end. The dome holds the scene whatever the height, and the ground reaches as far as the library
    // lets it, about half the dome's radius.
    const far = (name: string, from: number) => (slider(name) >= 100 ? FAR : from * 100 ** (slider(name) / 99));
    const domeRadius = () => Math.max(far("radius", 5), 2.5 * slider("height"));
    const groundReach = () => Math.min(far("reach", 3), Math.sqrt(domeRadius() ** 2 / 4 - slider("height") ** 2));
    const reading = (length: number) => (length >= FAR ? "∞" : length.toFixed(length < 10 ? 1 : 0));
    const pressed = (name: string) => field(name).getAttribute("aria-pressed") === "true";

    const texture = (label: string, width: number, height: number) =>
        device.createTexture({
            label,
            size: [width, height],
            mipLevelCount: Math.floor(Math.log2(Math.max(width, height))) + 1,
            format: "rgba16float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
    const level = (texture: GPUTexture, baseMipLevel: number) => texture.createView({ baseMipLevel, mipLevelCount: 1 });

    function halving(
        pass: GPUComputePassEncoder,
        pipeline: GPUComputePipeline,
        source: GPUTextureView,
        target: GPUTexture,
        mip: number,
        extra: GPUBindGroupEntry[] = [],
    ) {
        pass.setPipeline(pipeline);
        pass.setBindGroup(
            0,
            device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: source }, { binding: 1, resource: level(target, mip) }, ...extra],
            }),
        );
        pass.dispatchWorkgroups(
            Math.ceil(Math.max(1, target.width >> mip) / 8),
            Math.ceil(Math.max(1, target.height >> mip) / 8),
        );
    }

    /**
     * The image's mip levels from half its size on, and for its lower half the levels halved 1 to RIPS times along u
     * alone, each with mip levels of its own.
     */
    function build(encoder: GPUCommandEncoder, image: GPUTexture) {
        for (const old of levels) old.destroy();
        top = Math.floor(image.height * BAND);
        device.queue.writeBuffer(tops[1] as GPUBuffer, 0, new Uint32Array([top]));
        const coarser = texture(
            "sternwarte:groundedCoarser",
            Math.max(1, image.width >> 1),
            Math.max(1, image.height >> 1),
        );
        const rips = Array.from({ length: RIPS }, (_, k) =>
            texture(`sternwarte:groundedRip${k + 1}`, Math.max(1, image.width >> (k + 1)), image.height - top),
        );
        const pass = encoder.beginComputePass({ label: "sternwarte:groundedLevels" });
        halving(pass, halve, image.createView(), coarser, 0);
        for (let k = 0; k < RIPS; ++k) {
            const source = k === 0 ? image.createView() : level(rips[k - 1] as GPUTexture, 0);
            halving(pass, halveU, source, rips[k] as GPUTexture, 0, [
                { binding: 2, resource: { buffer: tops[k === 0 ? 1 : 0] as GPUBuffer } },
            ]);
        }
        for (const target of [coarser, ...rips]) {
            for (let mip = 1; mip < target.mipLevelCount; ++mip)
                halving(pass, halve, level(target, mip - 1), target, mip);
        }
        pass.end();
        levels = [coarser, ...rips];
    }

    function render() {
        if (!context || !hdri.texture || !passes) return;
        const width = Math.max(1, Math.round(canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 2)));
        const height = Math.max(1, Math.round(canvas.clientHeight * Math.min(window.devicePixelRatio || 1, 2)));
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
        if (target?.width !== width || target.height !== height) {
            target?.destroy();
            target = device.createTexture({
                label: "sternwarte:groundedBackdrop",
                size: [width, height],
                format: "rgba16float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            });
        }
        const { format, headroom } = displayOutput();
        if (context.getConfiguration()?.format !== format) configureCanvas(context, format);

        const encoder = device.createCommandEncoder({ label: "sternwarte:grounded" });
        const [toCube, ibl] = passes;
        if (litBy !== hdri.texture) {
            toCube.encode(encoder, hdri.texture, cube);
            ibl.encode(encoder, cube);
            litBy = hdri.texture;
            build(encoder, hdri.texture);
        }
        if (pressed("flat")) camera.distance = Math.min(camera.distance, 0.8 * domeRadius());
        const { eye, forward, right, up } = cameraFrame(camera);
        const ty = Math.tan(camera.fov / 2);
        const data = new ArrayBuffer(96);
        new Float32Array(data).set([
            ...right,
            ty * (width / height),
            ...up,
            ty,
            ...forward,
            slider("height"),
            ...eye,
            slider("lift") * DEG,
        ]);
        new Uint32Array(data)[16] = pressed("flat") ? 1 : 0;
        new Float32Array(data)[17] = groundReach();
        new Float32Array(data).set([hdri.texture.width, hdri.texture.height, top / hdri.texture.height], 18);
        new Uint32Array(data)[21] = pressed("even") ? 1 : 0;
        new Float32Array(data)[22] = domeRadius();
        device.queue.writeBuffer(params, 0, data);
        const pass = encoder.beginComputePass({ label: "sternwarte:groundedBackdrop" });
        pass.setPipeline(backdrop);
        pass.setBindGroup(
            0,
            device.createBindGroup({
                layout: backdrop.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: params } },
                    { binding: 1, resource: hdri.texture.createView() },
                    { binding: 2, resource: sampler },
                    { binding: 3, resource: target.createView() },
                    ...levels.map((texture, i) => ({ binding: 4 + i, resource: texture.createView() })),
                ],
            }),
        );
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
        scene.encode(encoder, context.getCurrentTexture(), {
            background: target,
            cube,
            sh: ibl.sh,
            camera,
            sunDirection: [0, 0, 1],
            sunAngularDiameter: 0.5,
            sunIlluminance: [0, 0, 0],
            ev100: hdri.ev100,
            sunLight: false,
            occlusionRays: 64,
            dither: format === SDR,
            headroom,
        });
        device.queue.submit([encoder.finish()]);
        field("heightReading").textContent = slider("height").toFixed(1);
        field("liftReading").textContent = `${slider("lift").toFixed(1)}°`;
        field("reachReading").textContent = reading(groundReach());
        field("radiusReading").textContent = reading(domeRadius());
    }
    const request = onDemand(render, canvas);

    onHdri(request);
    new ResizeObserver(request).observe(canvas);
    for (const name of ["height", "lift", "reach", "radius"]) field(name).addEventListener("input", request);
    for (const name of ["flat", "even"]) {
        field(name).addEventListener("click", () => {
            field(name).setAttribute("aria-pressed", String(!pressed(name)));
            request();
        });
    }
    canvas.addEventListener("pointerdown", (event) => {
        canvas.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
        const move = (e: PointerEvent) => {
            const perPixel = camera.fov / canvas.clientHeight;
            camera.yaw = start.yaw + (e.clientX - start.x) * perPixel;
            setPitch(start.pitch + (e.clientY - start.y) * perPixel);
            request();
        };
        canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", () => canvas.removeEventListener("pointermove", move), { once: true });
    });
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            camera.distance = Math.max(1.5, Math.min(100, camera.distance * Math.exp(event.deltaY * 0.002)));
            setPitch(camera.pitch);
            request();
        },
        { passive: false },
    );
    request();
}
