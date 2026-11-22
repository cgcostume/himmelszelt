import { type CloudPass, createCloudPass, DEFAULT_CLOUD_PARAMS, DEFAULT_CLOUDSCAPE } from "@himmelszelt/gewoelk";
import { HDR, onTables, tables } from "../../dunstkreis/atmosphere";
import { createStarsRenderer, type FrameLight, skyAt } from "../../sternenheer/renderer";
import { bindStarGroups, offsetOf } from "../../sternenheer/stargroups";
import { state } from "../../sternzeit/state";
import { SHOW, type Shown, texturePanel } from "../textures";
import { designerHeight, designerKinds, designerOrbit, designerSwap, designerTime, PATCH } from "./designer";
import { voxelFrom, voxelPreset, voxelPresets, voxelSource } from "./kinds";
import { createLab, type Lab, labPipeline } from "./lab";
import { cloudModel } from "./model";
import shader from "./voxel.comp.wgsl";
import {
    ASSET_SIZE,
    brightest,
    CLOUD_STOPS,
    GROUND_ALBEDO,
    lit,
    MOON_GONE,
    nightStops,
    OVERHEAD,
    PALE,
    PATCH_AIR,
    PATCH_FOV,
    PATCH_FROM,
    PATCH_GROUND,
    PATCH_WHITE,
    SUN_GONE,
    SUNLIGHT,
    sunlightAt,
} from "./weather";

const DEG = Math.PI / 180;
type Rgb = [number, number, number];
// The pass composes over a background that is exposed already: its own exposure is 1, at this EV100, and the light it
// is given is exposed before it.
const UNIT_EV100 = -Math.log2(1.2);
const SLICES = 16;

/**
 * The voxel cloudscape's designer on `root`, a `figure[data-cloud-designer]` whose `data-design` is "voxel": a patch
 * of gewoelk's voxel clouds alone, seen from a camera that orbits it, over the sky and the ground the layered model's
 * designers stand on, at a time of day of its own. The library's weathers give its kinds, the reader saves their own,
 * and the volumes it is marched through stand under it, slice by slice.
 */
export async function voxelFigure(root: HTMLElement) {
    let draw: (lab: Lab) => void = () => {};
    const orbit = designerOrbit("voxel");
    const time = designerTime(root, () => lab?.request());
    const lookAt = designerHeight(root, orbit, () => lab?.request());
    designerSwap(root);
    const lab = createLab(root, (current) => draw(current), {
        presets: voxelPresets(),
        camera: { yaw: 230 * DEG, pitch: 16 * DEG, fov: PATCH_FOV * DEG },
        orbit,
        speed: time.speed,
    });
    if (!lab) return;
    const { device } = lab;
    const [stage, tone] = await Promise.all([
        labPipeline(device, "voxelStage", shader, "voxelStage"),
        labPipeline(device, "voxelTone", shader, "voxelTone"),
    ]);
    const renderer = createStarsRenderer(device, () => lab.request());
    const textures = texturePanel(root, device, ASSET_SIZE, () => lab.request());
    lab.timed = textures.refresh;
    const frame = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    // The sky with its ground as a stage, which the pass composes over, and what it composed.
    let behind: GPUTexture | null = null;
    let composed: GPUTexture | null = null;
    const outputs = new WeakMap<GPUTexture, GPUBindGroup>();
    let exposure = "";
    let darker = 0;
    bindStarGroups(root, () => lab.request(), false);

    // The pass of the chosen share of the frame and steps, made when first asked for.
    const passes = new Map<string, CloudPass | Promise<CloudPass>>();
    const quality = () => ({ scale: Number(lab.choice("scale")) || 0.5, maxSteps: Number(lab.choice("steps")) || 256 });
    const clouds = () => {
        const chosen = quality();
        const key = JSON.stringify(chosen);
        const made = passes.get(key);
        if (made && !(made instanceof Promise)) return made;
        if (!made) {
            // Seen from close by, the voxels show: twice the levels the library builds by default, as the chapter's sky has.
            const grid = { layers: 64 };
            const making = createCloudPass(device, { format: "rgba16float", toneMap: false, grid, ...chosen });
            passes.set(key, making);
            making.then((pass) => {
                passes.set(key, pass);
                lab.request();
            });
        }
        return null;
    };

    const numbers = () => voxelFrom(lab.value);
    const model = cloudModel(root, "voxel");
    designerKinds(root, "voxel", lab, numbers, voxelPreset);
    const copy = root.querySelector<HTMLButtonElement>("button[data-copy-kind]");
    copy?.addEventListener("click", async () => {
        await navigator.clipboard.writeText(voxelSource(numbers()));
        copy.textContent = "copied";
        setTimeout(() => (copy.textContent = "copy"), 1200);
    });

    lab.status = () => {
        const march = lab.timer.ms.march;
        const { scale } = quality();
        const rays = composed
            ? `${Math.round(composed.width * scale)} x ${Math.round(composed.height * scale)} rays`
            : "";
        return `${rays}, clouds ${march === undefined ? "?" : march.toFixed(2)} ms on the GPU${exposure}`;
    };

    draw = () => {
        const table = tables();
        const pass = clouds();
        if (!table || !pass) return;
        const held = numbers();
        const { radiusKm } = PATCH.voxel;
        orbit.heightKm = held.baseKm + held.heightKm / 2;
        model?.update(held, lab.value("wind.from"), lab.value("wind.speed"));
        lookAt.sync();
        const { width, height, dpr, heightM, headroom, inverseViewProjection, projectionDistance } = lab.size();
        if (behind?.width !== width || behind.height !== height) {
            behind?.destroy();
            composed?.destroy();
            behind = device.createTexture({ size: [width, height], format: "rgba16float", usage });
            composed = device.createTexture({ size: [width, height], format: "rgba16float", usage });
        }
        const [staged, layer] = [behind, composed as GPUTexture];
        const seen = skyAt(time.jd(lab.clock), { ...state, heightM }, table.luts.model);
        const centerKm: [number, number] = [orbit.center.east - lab.flown.east, orbit.center.north - lab.flown.north];

        const step = (encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, from: GPUTexture, to: GPUTexture) => {
            let output = outputs.get(to);
            if (!output) {
                output = device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(1),
                    entries: [{ binding: 0, resource: to.createView() }],
                });
                outputs.set(to, output);
            }
            const computing = encoder.beginComputePass({ label: `voxelDesigner:${pipeline.label}` });
            computing.setPipeline(pipeline);
            computing.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: lab.view } },
                        { binding: 1, resource: from.createView() },
                        { binding: 2, resource: { buffer: frame } },
                    ],
                }),
            );
            computing.setBindGroup(1, output);
            computing.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            computing.end();
        };

        // The clouds over the frame: lit by the Sun while it reaches them, by the Moon after.
        const overFrame = (encoder: GPUCommandEncoder, exposed: GPUTexture, target: GPUTexture, light: FrameLight) => {
            const sunUp = seen.sunDirection[2] > SUN_GONE;
            const moonUp = seen.moonDirection[2] > MOON_GONE;
            const scale = sunUp ? 1 : moonUp ? seen.moonIlluminance / SUNLIGHT : 0;
            const sun = sunUp || !moonUp ? seen.sunDirection : seen.moonDirection;
            const luminance = Math.max(light.skyLuminance, 1e-6);
            const elevation = Math.asin(Math.min(Math.max(sun[2] ?? 0, -1), 1));
            const onGround = sunlightAt(0, elevation, scale);
            const fromSky = lit(OVERHEAD, luminance * Math.PI);
            // The frame is exposed for the cloud where the Sun's or the Moon's light on it outshines the sky.
            const top = { coverage: 1, illuminance: sunlightAt(held.baseKm + held.heightKm, elevation, scale) };
            const cloud = Math.max(brightest([top]), 1e-9);
            const stops = Math.log2(cloud / (1.2 * 2 ** light.ev100 * PATCH_WHITE));
            const outshines = Math.min(Math.max(Math.log2(cloud / luminance) / 2, 0), 1);
            darker = nightStops(light.skyLuminance);
            darker += (Math.min(Math.max(stops, -CLOUD_STOPS), CLOUD_STOPS) - darker) * outshines;
            device.queue.writeBuffer(frame, 0, new Float32Array([2 ** -darker, PATCH_GROUND]));
            const exposedBy = 1 / (1.2 * 2 ** light.ev100);
            const dim = (color: readonly number[]) => color.map((c) => c * exposedBy) as Rgb;
            const windTo = (lab.value("wind.from") + 180) * DEG;
            const speed = lab.value("wind.speed");
            pass.update(
                {
                    ...DEFAULT_CLOUD_PARAMS,
                    sunDirection: [sun[0] ?? 0, sun[1] ?? 0, sun[2] ?? 1],
                    sunIlluminance: dim(onGround),
                    skyIrradiance: dim(fromSky),
                    horizonLuminance: dim(lit(PALE, luminance)),
                    groundIrradiance: dim(
                        onGround.map((e, i) => GROUND_ALBEDO * (e * Math.max(sun[2] ?? 0, 0) + (fromSky[i] ?? 0))),
                    ),
                    corona: false,
                    observerHeightM: heightM,
                    inverseViewProjection,
                    projectionDistance,
                    ev100: UNIT_EV100,
                    timeS: lab.clock,
                    horizonFadeKm: PATCH_AIR * radiusKm,
                    planetRadiusKm: table.luts.model.planet.groundRadiusKm,
                    sheets: [],
                    cloudscape: {
                        ...DEFAULT_CLOUDSCAPE,
                        ...held,
                        wind: [Math.sin(windTo) * speed, Math.cos(windTo) * speed],
                        evolution: lab.value("change"),
                        evolutionOffset: lab.value("phase"),
                        seed: lab.value("seed"),
                        driftOffsetKm: [-lab.flown.east, -lab.flown.north],
                        clearingKm: radiusKm,
                        clearingFromKm: PATCH_FROM * radiusKm,
                        clearingCenterKm: centerKm,
                    },
                },
                encoder,
            );
            step(encoder, stage, exposed, staged);
            const march = lab.timer.writes("march");
            pass.encode(encoder, layer, { background: staged, ...(march && { timestampWrites: march }) });
            step(encoder, tone, layer, target);

            const volume = { kind: "3d" as const, at: 0.3, slices: SLICES };
            const shown: Shown[] = [
                {
                    label: "heights",
                    group: "cloud map",
                    title: "One tile from above, north up: how tall each column of cloud is, after coverage and sharpness. Everything else is built from this map.",
                    texture: pass.mapTexture,
                    kind: "array",
                    at: 0,
                    mode: SHOW.red,
                },
                {
                    ...volume,
                    label: "a level slice",
                    group: "shape and distance",
                    title: "A level slice of the voxels. Inside a cloud, warm to white, how deep a point lies under the surface: the shape the detail noise erodes. Outside, in blues, the distance to the nearest cloud: how far a ray may step without missing one.",
                    texture: pass.modelingTexture,
                    mode: SHOW.modeling,
                },
                {
                    ...volume,
                    label: "towards the Sun",
                    group: "light",
                    title: "The same slice of the light grid: how much cloud lies between each voxel and the Sun, summed once per place of the Sun, bright where it reaches and dark in shadow. The march reads it in place of a second ray.",
                    texture: pass.lightTexture,
                    mode: SHOW.shade,
                    scale: 8,
                    channel: 1,
                },
                {
                    ...volume,
                    label: "from the sky",
                    group: "the sky's light",
                    title: "The same slice of the ambient grid, at half the resolution: how much of the sky's light reaches a voxel through the clouds around it.",
                    texture: pass.ambientTexture,
                    mode: SHOW.red,
                },
                {
                    ...volume,
                    at: 0.5,
                    label: "billows",
                    group: "detail noise",
                    title: "A level slice of the detail noise, which tiles: its coarse billows, which round the voxels' shape into lumps at every step.",
                    texture: pass.detailTexture,
                    mode: SHOW.blue,
                },
                {
                    kind: "3d",
                    at: 0.5,
                    label: "wisps",
                    group: "detail noise",
                    title: "The middle slice of the detail noise, its coarse wisps: where the air around eats into a cloud and leaves webs and curls.",
                    texture: pass.detailTexture,
                    mode: SHOW.red,
                },
            ];
            textures.show(shown);
            textures.encode(encoder, true);
            lab.timer.resolve(encoder);
        };
        const drawn = renderer.draw(lab.target(), {
            sky: seen,
            luts: table.luts,
            format: HDR,
            headroom,
            toneMap: "neutral",
            width,
            height,
            inverseViewProjection,
            projectionDistance,
            pixelRatio: dpr,
            ev100: null,
            stars: offsetOf(root, "stars").light > 0,
            faintStars: true,
            deepStars: false,
            milkyWay: offsetOf(root, "milkyWay").light > 0,
            starCompensation: offsetOf(root, "stars").stops,
            milkyWayCompensation: offsetOf(root, "milkyWay").stops,
            maps: "auto",
            air: true,
            twinkle: false,
            time: 0,
            glare: true,
            darkAdapted: false,
            moon: true,
            constellations: [],
            ground: lab.pressed("ground.grid") ? lab.flown : null,
            over: overFrame,
        });
        if (!drawn) return;
        lab.present();
        exposure = `, exposed at EV100 ${(drawn.ev100 + darker).toFixed(1)}`;
        lab.timer.read();
        if (drawn.adapting) requestAnimationFrame(() => lab.request());
    };
    onTables(() => lab.request());
    lab.request();
}
