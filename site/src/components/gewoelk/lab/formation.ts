import { wgsl as gewoelk } from "@himmelszelt/gewoelk";
import { SHOW, type Shown, texturePanel } from "../textures";
import shader from "./formation.comp.wgsl";
import { createLab, floatStruct, type Lab, labPipeline, NOISE, type Presets } from "./lab";

const DEG = Math.PI / 180;
const LAYERS = 3;
const MAP_SIZE = 512;
const DETAIL_SIZE = 128;

// The pass' uniforms, field by field as formation.comp.wgsl reads them: the figure's, and a layer's.
const GLOBAL = floatStruct("FormationLab", [
    ...["phase", "noiseKm", "reachKm", "stepKm", "steps", "stepGrowth", "multiple", "ambient", "fadeKm", "viewMode"],
    ...["mapKm", "shearX", "shearY", "clearFrom", "clearing"],
]);
const LAYER = [
    ...["enabled", "kind", "base", "depth", "coverage", "tile", "feature", "extinction", "detail", "sharp"],
    ...["driftX", "driftY", "a", "b", "c", "seed", "lumps", "anvilX", "anvilY", "warp"],
];
// What a layer's map is made from: a change of anything else leaves it as it is.
const BAKED = ["kind", "coverage", "tile", "feature", "sharp", "seed", "lumps", "anvilX", "anvilY", "c"];
// How fast each layer drifts, as a share of the wind: the deep clouds slower, the middle ones faster.
const WIND_SHARE = [1, 0.6, 1.8];

/** Weathers to start from: each layer's sliders and kind, a coverage of 0 for a layer that is not there. */
export const FORMATION_PRESETS: Presets = {
    fair: {
        ...{ "l0.coverage": 0.36, "l0.depth": 0.9, "l0.feature": 2.2, "l0.extinction": 40, "l0.lumps": 0.5 },
        ...{ "@kind1": 2, "l1.coverage": 0, "l2.coverage": 0.25, "l2.feature": 1.6, "l2.lumps": 0.6 },
    },
    towering: {
        ...{ "l0.coverage": 0.42, "l0.depth": 1.4, "l0.feature": 3, "l0.extinction": 40, "l0.lumps": 0.5 },
        ...{ "@kind1": 2, "l1.coverage": 0.3, "l1.depth": 9, "l1.feature": 14, "l1.extinction": 25, rain: 4 },
        ...{ anvil: 0.6, "l2.coverage": 0.15, "l2.feature": 1.6, "l2.lumps": 0.6 },
    },
    showers: {
        ...{ "l0.coverage": 0.12, "l0.depth": 0.8, "l0.feature": 2, "l0.extinction": 40, "l0.lumps": 0.5 },
        ...{ "@kind1": 2, "l1.coverage": 0.45, "l1.depth": 6, "l1.feature": 7, "l1.extinction": 25, anvil: 0.15 },
        ...{ rain: 6, "l2.coverage": 0 },
    },
    front: {
        ...{ "l0.coverage": 0.25, "l0.depth": 1, "l0.feature": 2.5, "l0.extinction": 40, "l0.lumps": 0.5 },
        ...{ "@kind1": 3, "l1.coverage": 0.8, "l1.depth": 9, "l1.feature": 10, "l1.extinction": 30 },
        ...{ "front.distance": 12, "front.depth": 160, "l2.coverage": 0.4, "l2.feature": 2.4, "l2.lumps": 0.6 },
        rain: 4,
    },
    rain: {
        ...{ "l0.coverage": 0.9, "l0.depth": 1.2, "l0.feature": 3, "l0.extinction": 50, "l0.lumps": 0.4 },
        ...{ "@kind1": 3, "l1.coverage": 1, "l1.depth": 8, "l1.feature": 10, "l1.extinction": 30 },
        ...{ "front.distance": -50, "front.depth": 220, "l2.coverage": 0.8, "l2.feature": 3, "l2.lumps": 0.6 },
        rain: 4,
    },
    alto: {
        ...{ "l0.coverage": 0.12, "l0.depth": 0.8, "l0.feature": 2, "l0.extinction": 40, "l0.lumps": 0.5 },
        ...{ "@kind1": 2, "l1.coverage": 0, "l2.coverage": 0.62, "l2.feature": 0.9, "l2.lumps": 0.8 },
    },
};

/**
 * The three layers' passes for the figure `lab`: their maps baked when their sliders change, the layers marched
 * together at a share of the frame, and composed over the stand-in sky into the canvas, or left as a texture of their
 * light and what they let through for a figure with a sky of its own.
 */
export async function formationPasses(lab: Lab) {
    const { device } = lab;
    const code = `${NOISE}\n${GLOBAL.wgsl}\n${shader}`;
    const [bake, march, compose, detailPipeline] = await Promise.all([
        ...["formBakeMap", "formMarch", "formCompose"].map((entry) => labPipeline(device, entry, code, entry)),
        device.createComputePipelineAsync({
            layout: "auto",
            compute: {
                module: device.createShaderModule({ code: `${gewoelk.noise}\n${gewoelk.detail}` }),
                entryPoint: "gwDetail",
            },
        }),
    ]);
    if (!bake || !march || !compose || !detailPipeline) return null;

    const uniform = (size: number) =>
        device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const globals = uniform(GLOBAL.size);
    const layers = uniform(LAYERS * LAYER.length * 4);
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const maps = device.createTexture({ size: [MAP_SIZE, MAP_SIZE, LAYERS], format: "rgba16float", usage });
    const mapArray = maps.createView({ dimension: "2d-array" });
    const detail = device.createTexture({
        dimension: "3d",
        size: [DETAIL_SIZE, DETAIL_SIZE, DETAIL_SIZE],
        format: "rgba8unorm",
        usage,
    });
    const repeat = device.createSampler({
        addressModeU: "repeat",
        addressModeV: "repeat",
        addressModeW: "repeat",
        magFilter: "linear",
        minFilter: "linear",
    });
    const clamp = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const group = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[], index = 0) =>
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(index), entries });
    const shared = [
        { binding: 0, resource: { buffer: globals } },
        { binding: 1, resource: { buffer: layers } },
    ];
    const bakeGroups = Array.from({ length: LAYERS }, (_, i) => {
        const which = uniform(16);
        device.queue.writeBuffer(which, 0, new Uint32Array([i, 0, 0, 0]));
        return group(bake, [
            ...shared,
            { binding: 8, resource: { buffer: which } },
            { binding: 9, resource: mapArray },
        ]);
    });
    const marchGroup = group(march, [
        ...shared,
        { binding: 2, resource: { buffer: lab.view } },
        { binding: 3, resource: mapArray },
        { binding: 4, resource: repeat },
        { binding: 5, resource: detail.createView() },
    ]);
    // gewoelk's own detail noise, billows and wisps, made once.
    {
        const encoder = device.createCommandEncoder();
        const timestampWrites = lab.timer.writes("detail");
        const pass = encoder.beginComputePass({ ...(timestampWrites && { timestampWrites }) });
        pass.setPipeline(detailPipeline);
        pass.setBindGroup(0, group(detailPipeline, [{ binding: 0, resource: detail.createView() }]));
        pass.dispatchWorkgroups(DETAIL_SIZE / 4, DETAIL_SIZE / 4, DETAIL_SIZE / 4);
        pass.end();
        device.queue.submit([encoder.finish()]);
    }

    // Each layer's map, and the noise all three are eroded by.
    const channels =
        "Shown is how tall each column of cloud is, as a share of the layer's depth. Three more channels hold the skirt a tall tower's anvil spreads over, how far a front shades what lies under it, and how steep the tops are.";
    let clouds: { texture: GPUTexture; out: GPUBindGroup; compose: GPUBindGroup } | null = null;
    const baked = Array.from({ length: LAYERS }, () => "");
    const outputs = new WeakMap<GPUTexture, GPUBindGroup>();
    let rays = "";

    return {
        /** The rays marched, as the status line names them. */
        get rays() {
            return rays;
        },
        /** The layers' light and what they let through, at the march's share of the frame; null before the first. */
        get clouds() {
            return clouds?.texture ?? null;
        },
        /** The sliders into the uniforms, the maps baked again where they changed, and the layers marched for a frame
         *  `width` by `height` pixels. */
        march(encoder: GPUCommandEncoder, width: number, height: number) {
            const scale = Number(lab.choice("scale")) || 0.5;
            const w = Math.max(1, Math.round(width * scale));
            const h = Math.max(1, Math.round(height * scale));
            rays = `${w} x ${h} rays`;
            if (clouds?.texture.width !== w || clouds.texture.height !== h) {
                clouds?.texture.destroy();
                const texture = device.createTexture({ size: [w, h], format: "rgba16float", usage });
                clouds = {
                    texture,
                    out: group(march, [{ binding: 0, resource: texture.createView() }], 1),
                    compose: group(compose, [
                        ...shared,
                        { binding: 2, resource: { buffer: lab.view } },
                        { binding: 3, resource: mapArray },
                        { binding: 4, resource: repeat },
                        { binding: 6, resource: texture.createView() },
                        { binding: 7, resource: clamp },
                    ]),
                };
            }

            const phase = (lab.value("phase") + (lab.value("change") * lab.clock) / 3600) % 8;
            const windTo = (lab.value("wind.from") + 180) * DEG;
            device.queue.writeBuffer(
                globals,
                0,
                GLOBAL.pack({
                    phase,
                    noiseKm: lab.value("noiseKm"),
                    reachKm: lab.value("reachKm"),
                    stepKm: lab.value("stepKm"),
                    steps: Number(lab.choice("steps")) || 128,
                    stepGrowth: lab.value("stepGrowth"),
                    multiple: lab.value("multiple"),
                    ambient: lab.value("ambient"),
                    fadeKm: lab.value("fadeKm"),
                    viewMode: lab.choice("view") === "top" ? 1 : 0,
                    mapKm: lab.value("mapKm"),
                    shearX: Math.sin(windTo) * lab.value("shear"),
                    shearY: Math.cos(windTo) * lab.value("shear"),
                    clearFrom: lab.value("clearFrom"),
                    clearing: lab.value("clearing"),
                }),
            );
            const moved = (lab.value("wind.speed") * lab.clock) / 1000;
            const data = new Float32Array(LAYERS * LAYER.length);
            const changed: number[] = [];
            for (let i = 0; i < LAYERS; i++) {
                const value = (name: string) => lab.value(`l${i}.${name}`);
                const kind = Number(lab.choice(`kind${i}`)) || 0;
                const tile = value("tile");
                const share = WIND_SHARE[i] ?? 1;
                const fields: Record<string, number> = {
                    enabled: lab.pressed(`l${i}.enabled`) && value("coverage") > 0.005 ? 1 : 0,
                    kind,
                    ...Object.fromEntries(
                        [
                            ...["base", "depth", "coverage", "tile", "feature", "extinction", "detail", "sharp"],
                            ...["lumps", "warp"],
                        ].map((name) => [name, value(name)]),
                    ),
                    driftX: (Math.sin(windTo) * moved * share) % tile,
                    driftY: (Math.cos(windTo) * moved * share) % tile,
                    // A front comes on with the wind: its edge nearer by as much as its layer has drifted.
                    a: lab.value("front.distance") - moved * share,
                    b: lab.value("front.bearing") * DEG,
                    c: lab.value("front.depth"),
                    seed: lab.value("seed"),
                };
                // How far the anvils reach downwind, in the map's cells: a front's map lies along its bearing, twelve
                // cells from its edge to its back.
                const heading = [Math.sin(fields.b ?? 0), Math.cos(fields.b ?? 0)] as const;
                const [east, north] = [Math.sin(windTo), Math.cos(windTo)];
                const cells = Math.max(1, Math.round(tile / Math.max(value("feature"), 1e-3)));
                const [u, v] =
                    kind === 3
                        ? [
                              ((east * heading[0] + north * heading[1]) * 12) / (fields.c ?? 1),
                              ((east * heading[1] - north * heading[0]) * cells) / tile,
                          ]
                        : [east, north];
                const reach = lab.value("anvil") / Math.max(Math.hypot(u, v), 1e-6);
                Object.assign(fields, { anvilX: u * reach, anvilY: v * reach });
                data.set(
                    LAYER.map((name) => fields[name] ?? 0),
                    i * LAYER.length,
                );
                const key = JSON.stringify([BAKED.map((name) => fields[name]), phase]);
                if (key !== baked[i]) {
                    baked[i] = key;
                    changed.push(i);
                }
            }
            device.queue.writeBuffer(layers, 0, data);

            // A pass a map, so each has its own time.
            for (const i of changed) {
                const timestampWrites = lab.timer.writes(`map${i}`);
                const pass = encoder.beginComputePass({ ...(timestampWrites && { timestampWrites }) });
                pass.setPipeline(bake);
                pass.setBindGroup(0, bakeGroups[i] as GPUBindGroup);
                pass.dispatchWorkgroups(MAP_SIZE / 8, MAP_SIZE / 8);
                pass.end();
            }
            const top = lab.choice("view") === "top";
            if (!top) {
                const timestampWrites = lab.timer.writes("march");
                const pass = encoder.beginComputePass({ ...(timestampWrites && { timestampWrites }) });
                pass.setPipeline(march);
                pass.setBindGroup(0, marchGroup);
                pass.setBindGroup(1, (clouds as NonNullable<typeof clouds>).out);
                pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
                pass.end();
            }
        },
        /** The layers over the stand-in sky, or seen from above, into the canvas' texture. */
        compose(encoder: GPUCommandEncoder, target: GPUTexture, width: number, height: number) {
            if (!clouds) return;
            let output = outputs.get(target);
            if (!output) {
                output = group(compose, [{ binding: 1, resource: target.createView() }], 1);
                outputs.set(target, output);
            }
            const pass = encoder.beginComputePass();
            pass.setPipeline(compose);
            pass.setBindGroup(0, clouds.compose);
            pass.setBindGroup(1, output);
            pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            pass.end();
        },
        /** The maps and the noise for the texture panel. */
        shown(): Shown[] {
            return [
                {
                    label: "low map",
                    title: `The low layer's map, one tile from above, north up: heaps a few km across, or with more coverage a deck, cells on top of either. ${channels}`,
                    texture: maps,
                    kind: "array",
                    at: 0,
                    mode: SHOW.red,
                    ms: () => lab.timer.ms.map0,
                },
                {
                    label: "deep map",
                    title: `The deep layer's map: a few towers on a tile many times as large, turrets on top of each, or a front, drawn with its leading edge at the left and its back at the right and placed in the world by its bearing. ${channels}`,
                    texture: maps,
                    kind: "array",
                    at: 1,
                    mode: SHOW.red,
                    ms: () => lab.timer.ms.map1,
                },
                {
                    label: "middle map",
                    title: `The middle layer's map: a thin deck of cells or small heaps several km up. ${channels}`,
                    texture: maps,
                    kind: "array",
                    at: 2,
                    mode: SHOW.red,
                    ms: () => lab.timer.ms.map2,
                },
                {
                    label: "billows",
                    title: "A level slice of gewoelk's detail noise, a 3D texture that tiles, its coarse billows: at every sample it heaps all three layers' smooth shapes out into lumps.",
                    texture: detail,
                    kind: "3d",
                    at: 0.5,
                    mode: SHOW.blue,
                    ms: () => lab.timer.ms.detail,
                    timed: "once",
                },
            ];
        },
    };
}

/** The formation research figure on `root`, a `figure[data-formation-lab]`: three layers' maps baked when their
 *  sliders change, marched together at a share of the frame and composed over a stand-in sky. */
export async function formationFigure(root: HTMLElement) {
    let draw: (lab: Lab) => void = () => {};
    const lab = createLab(root, (current) => draw(current), {
        presets: FORMATION_PRESETS,
        camera: { yaw: 20 * DEG, pitch: 14 * DEG, fov: 80 * DEG },
    });
    if (!lab) return;
    const { device } = lab;
    const passes = await formationPasses(lab);
    if (!passes) return;
    const textures = texturePanel(root, device);
    lab.timed = textures.refresh;
    textures.show(passes.shown());

    lab.status = () => {
        const ms = (name: string) => (lab.timer.ms[name] === undefined ? "?" : lab.timer.ms[name]?.toFixed(2));
        return `${passes.rays}, march ${ms("march")} ms on the GPU`;
    };

    draw = () => {
        const { width, height } = lab.size();
        const encoder = device.createCommandEncoder({ label: "sternwarte:formationLab" });
        passes.march(encoder, width, height);
        passes.compose(encoder, lab.target(), width, height);
        textures.encode(encoder, lab.pressed("textures.on"));
        lab.timer.resolve(encoder);
        device.queue.submit([encoder.finish()]);
        lab.present();
        lab.timer.read();
    };
    lab.request();
}
