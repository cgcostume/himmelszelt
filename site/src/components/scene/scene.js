import { wgsl } from "@himmelszelt/dunstkreis";
import blueNoiseUrl from "./bluenoise.bin?url";
import { GOLDEN_SET_8, GOLDEN_SET_64 } from "./goldenset.js";
import scene from "./scene.comp.wgsl";

// 64x64 texels of blue noise, two channels, from scripts/bluenoise.mjs.
const blueNoise = new Uint8Array(await (await fetch(blueNoiseUrl)).arrayBuffer());

const goldenSet = (name, set) =>
    `var<private> ${name}: array<vec2f, ${set.length}> = array<vec2f, ${set.length}>(` +
    `${set.map(([x, y]) => `vec2f(${x}, ${y})`).join(", ")});`;
const source = [
    goldenSet("goldenSet8", GOLDEN_SET_8),
    goldenSet("goldenSet64", GOLDEN_SET_64),
    wgsl.cube,
    wgsl.sun,
    wgsl.tonemap,
    scene,
].join("\n");

/**
 * A small raytraced scene lit by an environment, for any chapter that makes one: a cube map in cd/m² as the
 * background, nine spherical harmonics coefficients of it as the sky's light, and the sun as a light of its own. It
 * knows nothing of where these come from, the atmosphere's sky or an HDR image.
 */

const DEG = Math.PI / 180;
// Params: 129 scalars, rounded up to a multiple of 16 bytes.
const PARAMS_SIZE = 528;

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

// Each polyhedron turns about its own tilted axis, at its own pace, so they never line up: tetrahedron, cube,
// octahedron, dodecahedron, icosahedron.
const SPINS = [
    { axis: [0.3, 0.2, 0.93], speed: 0.21, start: 0.4 },
    { axis: [-0.2, 0.35, 0.91], speed: -0.17, start: 0.7 },
    { axis: [0.35, 0.3, 0.89], speed: 0.19, start: 1.1 },
    { axis: [-0.3, -0.25, 0.92], speed: -0.14, start: 0.5 },
    { axis: [0.25, -0.3, 0.92], speed: 0.13, start: 0.2 },
];

// The polyhedra on a pentagon around the sphere, 0.7 above the ground, circling it together, each on an orbit tilted a
// few degrees its own way: they rise and sink a little as they go round, and so do their shadows.
const ORBIT = { radius: 1.3, height: 0.7, speed: 0.05, tilt: 6 * DEG };

/** Where each solid is after `seconds`, the five polyhedra and the sphere, as vec4f: 24 floats. */
function centers(seconds) {
    const polyhedra = SPINS.map((_, i) => {
        const angle = (i * 2 * Math.PI) / 5 + ORBIT.speed * seconds;
        const node = i * 2.1;
        const rise = ORBIT.radius * Math.sin(ORBIT.tilt) * Math.sin(angle - node);
        return [ORBIT.radius * Math.cos(angle), ORBIT.radius * Math.sin(angle), ORBIT.height + rise, 0];
    });
    return [...polyhedra, [0, 0, ORBIT.height, 0]].flat();
}
const normalized = (v) => v.map((c) => c / Math.hypot(...v));

/** Where an orbiting `camera` stands and how it is turned: it looks at the solids' center, 0.6 above the ground. */
export function cameraFrame({ yaw, pitch, distance }) {
    const forward = [-Math.cos(pitch) * Math.sin(yaw), -Math.cos(pitch) * Math.cos(yaw), -Math.sin(pitch)];
    const eye = [-forward[0] * distance, -forward[1] * distance, 0.6 - forward[2] * distance];
    const right = normalized([forward[1], -forward[0], 0]);
    const up = [
        right[1] * forward[2] - right[2] * forward[1],
        right[2] * forward[0] - right[0] * forward[2],
        right[0] * forward[1] - right[1] * forward[0],
    ];
    return { eye, forward, right, up };
}

export function createScene(device) {
    // One pipeline per output format, rgba8unorm or rgba16float for an HDR canvas, made when first drawn into.
    const pipelines = new Map();
    const pipelineFor = (format) => {
        if (!pipelines.has(format)) {
            const code = source.replace("OUTPUT_FORMAT", format);
            const module = device.createShaderModule({ label: "sternwarte:scene", code });
            const layout = "auto";
            const compute = { module, entryPoint: "render" };
            pipelines.set(format, device.createComputePipeline({ label: "sternwarte:scene", layout, compute }));
        }
        return pipelines.get(format);
    };
    const params = device.createBuffer({ size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
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
         * Records the scene into `target` (rgba8unorm, or rgba16float for an HDR canvas, storage). `camera` orbits the scene's center: yaw from north
         * through east, pitch, distance, vertical field of view, all angles in radians. `seconds` turns the solids and
         * moves them along their orbits. `shadowRays` over the sun disc, 8 or 64 for soft shadows, 0 for none, anything else for hard ones. `background`, a texture of the target's size
         * holding the sky in cd/m² through the same camera, replaces the sky map behind the solids. `cubified` for a sky map written cubified, `skyScale` for one written scaled, which its light and coefficients are divided by. `groundRadius`, in
         * scene units, sizes the round ground, which fades out over its outer half. `sunLight` and `skyLight`, both on
         * by default, switch the direct sunlight and the sky's light from the coefficients. `ground` is "floor" by
         * default, a round floor of the scene's own; "backdrop" shows the backdrop's ground with the solids' shadows.
         * `bloom`, 0 to 1, how strong the sun's veil is, `godRaySamples`, 8 or 64, haze lit by the sun
         * with the solids' shadows through it, 0 for none. `airDensity` and `hazeDensity`, around the camera relative to
         * the ground's, 1 by default, thin the veil and the haze. `discDirection` and `discIlluminance`, the sun as the
         * camera sees it from its own height, the sun's by default, place and light the disc and its veil; `horizonZ`,
         * the planet's horizon as the camera sees it, hides the disc below it, -1 by default for none. `dither`, on by
         * default, dithers the 8-bit output against banding. `toneCurve`, "neutral" by default, "agx", "aces" or "clip", as dunstkreis'.
         * `headroom`, 1 by default, how many times SDR white an HDR display shows, which Neutral and "clip" go up to.
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
            flags[23] = rest.occlusionRays ?? 8;
            const seconds = rest.seconds ?? 0;
            SPINS.forEach(({ axis, speed, start }, i) => {
                data.set(rotation(normalized(axis), start + speed * seconds), 24 + i * 12);
            });
            data.set(centers(seconds), 84);
            flags[108] = rest.shadowRays ?? 0;
            flags[109] = rest.background ? 1 : 0;
            data[110] = rest.groundRadius ?? 36;
            flags[111] = (rest.sunLight === false ? 0 : 1) | (rest.skyLight === false ? 0 : 2);
            flags[112] = rest.ground === "backdrop" ? 1 : 0;
            data[113] = rest.bloom ?? 0;
            flags[114] = rest.godRaySamples ?? 0;
            data[115] = rest.airDensity ?? 1;
            data[116] = rest.hazeDensity ?? 1;
            flags[117] = rest.cubified ? 1 : 0;
            flags[118] = rest.dither === false ? 0 : 1;
            flags[119] = { neutral: 1, agx: 2, aces: 3, clip: 4 }[rest.toneCurve ?? "neutral"];
            data.set(rest.discDirection ?? sunDirection, 120);
            data[123] = rest.horizonZ ?? -1;
            data.set(rest.discIlluminance ?? sunIlluminance, 124);
            data[127] = rest.skyScale ?? 1;
            data[128] = rest.headroom ?? 1;
            device.queue.writeBuffer(params, 0, data);

            const pipeline = pipelineFor(target.format);
            const bindGroup = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: params } },
                    { binding: 1, resource: cube.createView({ dimension: "cube" }) },
                    { binding: 2, resource: sampler },
                    { binding: 3, resource: { buffer: sh } },
                    { binding: 4, resource: target.createView() },
                    { binding: 5, resource: (rest.background ?? placeholder).createView() },
                    { binding: 6, resource: blueNoiseTexture.createView() },
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
            placeholder.destroy();
            blueNoiseTexture.destroy();
        },
    };
}
