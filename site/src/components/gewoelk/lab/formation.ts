import { wgsl as gewoelk } from "@himmelszelt/gewoelk";
import { SHOW, texturePanel } from "../textures";
import shader from "./formation.comp.wgsl";
import { createLab, floatStruct, type Lab, labPipeline, NOISE, type Presets } from "./lab";

const DEG = Math.PI / 180;
const LAYERS = 3;
const MAP_SIZE = 512;
const DETAIL_SIZE = 128;

// The pass' uniforms, field by field as formation.comp.wgsl reads them: the figure's, and a layer's.
const GLOBAL = floatStruct("FormationLab", [
    ...["phase", "noiseKm", "reachKm", "stepKm", "steps", "stepGrowth", "multiple", "ambient", "fadeKm", "viewMode"],
    "mapKm",
]);
const LAYER = [
    ...["enabled", "kind", "base", "depth", "coverage", "tile", "feature", "extinction", "detail", "sharp"],
    ...["driftX", "driftY", "a", "b", "c", "seed"],
];
// What a layer's map is made from: a change of anything else leaves it as it is.
const BAKED = ["kind", "coverage", "tile", "feature", "sharp", "seed"];
// How fast each layer drifts, as a share of the wind: the deep clouds slower, the middle ones faster.
const WIND_SHARE = [1, 0.6, 1.8];

/** Weathers to start from: each layer's sliders and kind, a coverage of 0 for a layer that is not there. */
export const FORMATION_PRESETS: Presets = {
    fair: {
        ...{ "@kind0": 0, "l0.coverage": 0.36, "l0.depth": 0.9, "l0.feature": 2.2, "l0.extinction": 40 },
        ...{ "@kind1": 2, "l1.coverage": 0, "@kind2": 1, "l2.coverage": 0.25, "l2.feature": 1.6 },
    },
    towering: {
        ...{ "@kind0": 0, "l0.coverage": 0.42, "l0.depth": 1.4, "l0.feature": 3, "l0.extinction": 40 },
        ...{ "@kind1": 2, "l1.coverage": 0.3, "l1.depth": 9, "l1.feature": 14, "l1.extinction": 25 },
        ...{ "@kind2": 1, "l2.coverage": 0.15, "l2.feature": 1.6 },
    },
    front: {
        ...{ "@kind0": 0, "l0.coverage": 0.25, "l0.depth": 1, "l0.feature": 2.5, "l0.extinction": 40 },
        ...{ "@kind1": 3, "l1.coverage": 0.8, "l1.depth": 9, "l1.feature": 10, "l1.extinction": 30 },
        ...{ "front.distance": 12, "front.depth": 160, "@kind2": 1, "l2.coverage": 0.4, "l2.feature": 2.4 },
    },
    rain: {
        ...{ "@kind0": 1, "l0.coverage": 0.9, "l0.depth": 1.2, "l0.feature": 3, "l0.extinction": 50 },
        ...{ "@kind1": 3, "l1.coverage": 1, "l1.depth": 8, "l1.feature": 10, "l1.extinction": 30 },
        ...{ "front.distance": -50, "front.depth": 220, "@kind2": 1, "l2.coverage": 0.8, "l2.feature": 3 },
    },
    alto: {
        ...{ "@kind0": 0, "l0.coverage": 0.12, "l0.depth": 0.8, "l0.feature": 2, "l0.extinction": 40 },
        ...{ "@kind1": 2, "l1.coverage": 0, "@kind2": 1, "l2.coverage": 0.62, "l2.feature": 0.9 },
    },
};

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
    if (!bake || !march || !compose || !detailPipeline) return;

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
        "Shown is how tall each column of cloud is, as a share of the layer's depth. Two more channels hold the skirt a tall tower's anvil spreads over and the noise the map was cut from.";
    const textures = texturePanel(root, device);
    lab.timed = textures.refresh;
    textures.show([
        {
            label: "low map",
            title: `The low layer's map, one tile from above, north up: heaps a few km across, or a deck. ${channels}`,
            texture: maps,
            kind: "array",
            at: 0,
            mode: SHOW.red,
            ms: () => lab.timer.ms.map0,
        },
        {
            label: "deep map",
            title: `The deep layer's map: a few towers on a tile many times as large, or a front, drawn with its leading edge at the left and its back at the right and placed in the world by its bearing. ${channels}`,
            texture: maps,
            kind: "array",
            at: 1,
            mode: SHOW.red,
            ms: () => lab.timer.ms.map1,
        },
        {
            label: "middle map",
            title: `The middle layer's map: a thin deck or small heaps several km up. ${channels}`,
            texture: maps,
            kind: "array",
            at: 2,
            mode: SHOW.red,
            ms: () => lab.timer.ms.map2,
        },
        {
            label: "billows",
            title: "A level slice of gewoelk's detail noise, a 3D texture that tiles, its coarse billows: at every sample it erodes all three layers' smooth shapes into lumps.",
            texture: detail,
            kind: "3d",
            at: 0.5,
            mode: SHOW.blue,
            ms: () => lab.timer.ms.detail,
            timed: "once",
        },
    ]);
    let clouds: { texture: GPUTexture; out: GPUBindGroup; compose: GPUBindGroup } | null = null;
    const baked = Array.from({ length: LAYERS }, () => "");
    const outputs = new WeakMap<GPUTexture, GPUBindGroup>();
    let rays = "";

    lab.status = () => {
        const ms = (name: string) => (lab.timer.ms[name] === undefined ? "?" : lab.timer.ms[name]?.toFixed(2));
        return `${rays}, march ${ms("march")} ms on the GPU`;
    };

    draw = () => {
        const { width, height } = lab.size();
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
            }),
        );
        const windTo = (lab.value("wind.from") + 180) * DEG;
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
                    ["base", "depth", "coverage", "tile", "feature", "extinction", "detail", "sharp"].map((name) => [
                        name,
                        value(name),
                    ]),
                ),
                driftX: (Math.sin(windTo) * moved * share) % tile,
                driftY: (Math.cos(windTo) * moved * share) % tile,
                // A front comes on with the wind: its edge nearer by as much as its layer has drifted.
                a: lab.value("front.distance") - moved * share,
                b: lab.value("front.bearing") * DEG,
                c: lab.value("front.depth"),
                seed: lab.value("seed"),
            };
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

        const encoder = device.createCommandEncoder({ label: "sternwarte:formationLab" });
        // A pass a map, so each has its own time.
        for (const i of changed) {
            const timestampWrites = lab.timer.writes(`map${i}`);
            const pass = encoder.beginComputePass({ ...(timestampWrites && { timestampWrites }) });
            pass.setPipeline(bake);
            pass.setBindGroup(0, bakeGroups[i] as GPUBindGroup);
            pass.dispatchWorkgroups(MAP_SIZE / 8, MAP_SIZE / 8);
            pass.end();
        }
        const target = lab.context.getCurrentTexture();
        let output = outputs.get(target);
        if (!output) {
            output = group(compose, [{ binding: 1, resource: target.createView() }], 1);
            outputs.set(target, output);
        }
        const top = lab.choice("view") === "top";
        if (!top) {
            const timestampWrites = lab.timer.writes("march");
            const pass = encoder.beginComputePass({ ...(timestampWrites && { timestampWrites }) });
            pass.setPipeline(march);
            pass.setBindGroup(0, marchGroup);
            pass.setBindGroup(1, clouds.out);
            pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
            pass.end();
        }
        const pass = encoder.beginComputePass();
        pass.setPipeline(compose);
        pass.setBindGroup(0, clouds.compose);
        pass.setBindGroup(1, output);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
        textures.encode(encoder, lab.pressed("textures.on"));
        lab.timer.resolve(encoder);
        device.queue.submit([encoder.finish()]);
        lab.timer.read();
    };
    lab.request();
}
