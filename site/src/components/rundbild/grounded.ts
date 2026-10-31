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

const DEG = Math.PI / 180;
const root = find("#grounded");
const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
const canvas = field<HTMLCanvasElement>("canvas");
const camera = { yaw: 150 * DEG, pitch: 12 * DEG, distance: 6, fov: 50 * DEG };

// What the scene shows behind its solids: the image through its camera, in the file's relative units.
const BACKDROP = /* wgsl */ `
${wgsl.panorama}
${wgsl.ground}
struct Params { right: vec3f, tx: f32, up: vec3f, ty: f32, forward: vec3f, height: f32, eye: vec3f, lift: f32, flat: u32, blend: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var output: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (any(id.xy >= size)) {
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size) * 2.0 - 1.0;
    var direction = normalize(params.forward + params.right * (uv.x * params.tx) - params.up * (uv.y * params.ty));
    if (params.flat != 0u) {
        direction = rbFlatGroundDirection(params.eye, direction, params.height, params.blend);
    }
    direction = rbLiftedHorizonDirection(direction, params.lift, params.blend);
    let light = textureSampleLevel(image, imageSampler, rbEquirectangularUv(direction, 0.0), 0.0).rgb;
    textureStore(output, vec2i(id.xy), vec4f(min(light, vec3f(6e4)), 1.0));
}`;

// A cube map only for the nine coefficients, which need no more.
const CUBE_SIZE = 256;

function setPitch(pitch: number) {
    camera.pitch = Math.max(Math.asin(Math.max(-1, -0.55 / camera.distance)), Math.min(89 * DEG, pitch));
}

if (gpu.error) {
    canvas.replaceWith(Object.assign(document.createElement("p"), { textContent: gpu.error }));
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
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "repeat" });
    const params = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
    Promise.all([createCubeFromPanoramaPass(device, { samples: 4 }), createIrradiancePass(device)]).then((made) => {
        passes = made;
        request();
    });

    const slider = (name: string) => Number(field<HTMLInputElement>(name).value);
    const flat = () => field("flat").getAttribute("aria-pressed") === "true";

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
        }
        const { eye, forward, right, up } = cameraFrame(camera);
        const ty = Math.tan(camera.fov / 2);
        const data = new ArrayBuffer(80);
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
        new Uint32Array(data)[16] = flat() ? 1 : 0;
        new Float32Array(data)[17] = slider("blend") * DEG;
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
        field("blendReading").textContent = `${slider("blend").toFixed(0)}°`;
    }
    const request = onDemand(render, canvas);

    onHdri(request);
    new ResizeObserver(request).observe(canvas);
    for (const name of ["height", "lift", "blend"]) field(name).addEventListener("input", request);
    field("flat").addEventListener("click", () => {
        field("flat").setAttribute("aria-pressed", String(!flat()));
        request();
    });
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
