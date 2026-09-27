import blueNoiseUrl from "./bluenoise.bin?url";
import { GOLDEN_SET_8, GOLDEN_SET_64 } from "./goldenset.js";
import scene from "./scene.comp.wgsl";

// 64x64 texels of blue noise, two channels, from scripts/bluenoise.mjs.
const blueNoise = new Uint8Array(await (await fetch(blueNoiseUrl)).arrayBuffer());

const goldenSet = (name, set) =>
    `var<private> ${name}: array<vec2f, ${set.length}> = array<vec2f, ${set.length}>(` +
    `${set.map(([x, y]) => `vec2f(${x}, ${y})`).join(", ")});`;
const source = [goldenSet("goldenSet8", GOLDEN_SET_8), goldenSet("goldenSet64", GOLDEN_SET_64), scene].join("\n");

/**
 * A small raytraced scene lit by an environment, for any chapter that makes one: a cube map in cd/m² as the
 * background, nine spherical harmonics coefficients of it as the sky's light, and the sun as a light of its own. It
 * knows nothing of where these come from, the atmosphere's sky or an HDR image.
 */

const DEG = Math.PI / 180;
const PARAMS_SIZE = 320;
/** Frames the running sum of the lighting takes. */
export const SCENE_FRAMES = 64;

/** Rotation about a unit axis by an angle, as a column-major 3x3 matrix padded to WGSL's mat3x3f: 12 floats. */
function rotation([x, y, z], angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    // biome-ignore format: a matrix reads best as one
    return [
        t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
        t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
        t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    ];
}

// Each solid turns about its own tilted axis, at its own pace, so they never line up.
const SPINS = [
    { axis: [0.3, 0.2, 0.93], speed: 0.21, start: 0.4 },
    { axis: [-0.2, 0.35, 0.91], speed: -0.17, start: 0.7 },
    { axis: [0.25, -0.3, 0.92], speed: 0.13, start: 0.2 },
    { axis: [0, 0, 1], speed: 0.1, start: 0 },
];
const normalized = (v) => v.map((c) => c / Math.hypot(...v));

/** Where an orbiting `camera` stands and how it is turned: it looks at the solids' center, 1 above the ground. */
export function cameraFrame({ yaw, pitch, distance }) {
    const forward = [-Math.cos(pitch) * Math.sin(yaw), -Math.cos(pitch) * Math.cos(yaw), -Math.sin(pitch)];
    const eye = [-forward[0] * distance, -forward[1] * distance, 1 - forward[2] * distance];
    const right = normalized([forward[1], -forward[0], 0]);
    const up = [
        right[1] * forward[2] - right[2] * forward[1],
        right[2] * forward[0] - right[0] * forward[2],
        right[0] * forward[1] - right[1] * forward[0],
    ];
    return { eye, forward, right, up };
}

export function createScene(device) {
    const pipeline = device.createComputePipeline({
        label: "sternwarte:scene",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: source }), entryPoint: "render" },
    });
    const params = device.createBuffer({ size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    let sum = null;
    const blueNoiseTexture = device.createTexture({
        label: "sternwarte:blueNoise",
        size: { width: 64, height: 64 },
        format: "rg8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
        { texture: blueNoiseTexture },
        blueNoise,
        { bytesPerRow: 128 },
        { width: 64, height: 64 },
    );
    // Bound in place of a live background when the sky map shows.
    const placeholder = device.createTexture({
        size: { width: 1, height: 1 },
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });

    return {
        /**
         * Records the scene into `target` (rgba8unorm, storage). `camera` orbits the scene's center: yaw from north
         * through east, pitch, distance, vertical field of view, all angles in radians. `seconds` turns the solids.
         * `frame` counts the frames since anything changed, 0 to start the running sum over; `shadowRays` over the sun
         * disc, 8 or 64 for soft shadows, anything else for hard ones. `background`, a texture of the target's size
         * holding the sky in cd/m² through the same camera, replaces the sky map behind the solids. `groundRadius`, in
         * scene units, sizes the round ground, which fades out over its outer half. `sunLight` and `skyLight`, both on
         * by default, switch the direct sunlight and the sky's light from the coefficients.
         */
        encode(
            encoder,
            target,
            { cube, sh, camera, sunDirection, sunAngularDiameter, sunIlluminance, ev100, ...rest },
        ) {
            const { eye, forward, right, up } = cameraFrame(camera);
            const data = new Float32Array(PARAMS_SIZE / 4);
            data.set([...eye, Math.tan(camera.fov / 2)], 0);
            data.set([...forward, target.width / target.height], 4);
            data.set([...right, 1 / (1.2 * 2 ** ev100)], 8);
            data.set([...up, (sunAngularDiameter / 2) * DEG], 12);
            data.set(sunDirection, 16);
            data.set(sunIlluminance, 20);
            const flags = new Uint32Array(data.buffer);
            flags[19] = rest.sunDisc ? 1 : 0;
            flags[23] = rest.occlusionRays ?? 16;
            flags[72] = rest.frame ?? 0;
            flags[73] = rest.shadowRays ?? 0;
            flags[74] = rest.background ? 1 : 0;
            data[75] = rest.groundRadius ?? 72;
            flags[76] = (rest.sunLight === false ? 0 : 1) | (rest.skyLight === false ? 0 : 2);
            const seconds = rest.seconds ?? 0;
            SPINS.forEach(({ axis, speed, start }, i) => {
                data.set(rotation(normalized(axis), start + speed * seconds), 24 + i * 12);
            });
            device.queue.writeBuffer(params, 0, data);
            const bytes = target.width * target.height * 16;
            if (sum?.size !== bytes) {
                sum?.destroy();
                sum = device.createBuffer({ label: "sternwarte:sceneSum", size: bytes, usage: GPUBufferUsage.STORAGE });
            }

            const bindGroup = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: params } },
                    { binding: 1, resource: cube.createView({ dimension: "cube" }) },
                    { binding: 2, resource: sampler },
                    { binding: 3, resource: { buffer: sh } },
                    { binding: 4, resource: target.createView() },
                    { binding: 5, resource: { buffer: sum } },
                    { binding: 6, resource: (rest.background ?? placeholder).createView() },
                    { binding: 7, resource: blueNoiseTexture.createView() },
                ],
            });
            const pass = encoder.beginComputePass({ label: "sternwarte:scene" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
            pass.end();
        },

        destroy() {
            params.destroy();
            sum?.destroy();
            placeholder.destroy();
            blueNoiseTexture.destroy();
        },
    };
}
