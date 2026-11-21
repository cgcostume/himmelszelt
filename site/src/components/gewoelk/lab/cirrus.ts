import { SHOW, texturePanel } from "../textures";
import shader from "./cirrus.comp.wgsl";
import { createLab, floatStruct, type Lab, labPipeline, NOISE, type Presets } from "./lab";

const DEG = Math.PI / 180;

// The pass' uniform, field by field as cirrus.comp.wgsl reads them.
const FIELDS = [
    ...["altitude", "opticalDepth", "tile", "windTo", "drift", "coverage", "patchKm", "bandStretch", "bandAngle"],
    ...["edge", "cells", "cellKm", "rows", "elongation", "grain", "ripples", "rippleKm", "curve", "ribs", "ribKm"],
    ...["veil", "striation", "stretch", "streaks", "bend", "combStep", "relief", "forwardG", "phase", "seed"],
    ...["mapSize", "viewMode", "billows", "billowKm", "billowShift", "soft"],
] as const;
// What is read per pixel and not baked: a change of these leaves the map as it is.
const UNBAKED = new Set<string>([
    ...["altitude", "opticalDepth", "windTo", "drift", "coverage", "patchKm", "bandStretch", "bandAngle", "edge"],
    ...["relief", "forwardG", "viewMode", "billows", "billowKm", "billowShift", "soft"],
]);
const STRUCT = floatStruct("CirrusLab", FIELDS);

/** Skies to start from, after photographs: the sliders they set, the rest left as they stand. */
export const CIRRUS_PRESETS: Presets = {
    mackerel: {
        ...{ "c.coverage": 0.8, "c.patchKm": 60, "c.bandStretch": 2, "c.bandAngle": 20, "c.edge": 0.6 },
        ...{ "c.cells": 1, "c.cellKm": 0.32, "c.rows": 0.7, "c.elongation": 1.1, "c.grain": 0.5 },
        ...{ "c.ripples": 0.7, "c.rippleKm": 1.1, "c.curve": 0.6, "c.ribs": 0, "c.veil": 0.08, "c.striation": 0.3 },
        ...{ "c.stretch": 10, comb: 0, "c.streaks": 0.3, "c.bend": 0.1, "c.opticalDepth": 2.4 },
    },
    ripples: {
        ...{ "c.coverage": 0.5, "c.patchKm": 40, "c.bandStretch": 2.5, "c.bandAngle": 50, "c.edge": 0.8 },
        ...{ "c.cells": 1, "c.cellKm": 0.28, "c.rows": 0.85, "c.elongation": 1.6, "c.grain": 0.3 },
        ...{ "c.ripples": 0.85, "c.rippleKm": 0.7, "c.curve": 0.8, "c.ribs": 0, "c.veil": 0.15, "c.striation": 0.4 },
        ...{ "c.stretch": 8, comb: 4, "c.streaks": 0.3, "c.bend": 0.1, "c.opticalDepth": 1.2 },
    },
    ribbed: {
        ...{ "c.coverage": 0.45, "c.patchKm": 60, "c.bandStretch": 6, "c.bandAngle": 25, "c.edge": 0.5 },
        ...{ "c.cells": 0, "c.cellKm": 0.4, "c.rows": 0.5, "c.elongation": 1, "c.grain": 0.4 },
        ...{ "c.ripples": 0, "c.rippleKm": 1, "c.curve": 0.5, "c.ribs": 0.85, "c.ribKm": 3.5, "c.veil": 1 },
        ...{ "c.striation": 0.8, "c.stretch": 14, comb: 16, "c.streaks": 0.6, "c.bend": 0.1, "c.opticalDepth": 1.4 },
    },
    mixed: {
        ...{ "c.coverage": 0.7, "c.patchKm": 50, "c.bandStretch": 2, "c.bandAngle": 70, "c.edge": 0.7 },
        ...{ "c.cells": 0.9, "c.cellKm": 0.4, "c.rows": 0.35, "c.elongation": 1, "c.grain": 0.5 },
        ...{ "c.ripples": 0.3, "c.rippleKm": 1.4, "c.curve": 0.7, "c.ribs": 0, "c.veil": 0.5, "c.striation": 0.5 },
        ...{ "c.stretch": 10, comb: 6, "c.streaks": 0.5, "c.bend": 0.15, "c.opticalDepth": 1.2 },
    },
    veil: {
        ...{ "c.coverage": 0.7, "c.patchKm": 90, "c.bandStretch": 3, "c.bandAngle": 15, "c.edge": 0.9 },
        ...{ "c.cells": 0, "c.ripples": 0, "c.ribs": 0, "c.veil": 0.8, "c.striation": 0.25, "c.stretch": 16 },
        ...{ comb: 8, "c.streaks": 0.5, "c.bend": 0.05, "c.opticalDepth": 0.7 },
    },
};

/** The cirrus research figure on `root`, a `figure[data-cirrus-lab]`: the map baked when its sliders change, the
 *  sheet read from it per pixel over a stand-in sky. */
export async function cirrusFigure(root: HTMLElement) {
    let draw: (lab: Lab) => void = () => {};
    const lab = createLab(root, (current) => draw(current), {
        presets: CIRRUS_PRESETS,
        camera: { yaw: 20 * DEG, pitch: 48 * DEG, fov: 85 * DEG },
    });
    if (!lab) return;
    const { device } = lab;
    const code = `${NOISE}\n${STRUCT.wgsl}\n${shader}`;
    const [bake, comb, mip, sky] = await Promise.all(
        ["cirrusBake", "cirrusComb", "cirrusMip", "cirrusSky"].map((entry) => labPipeline(device, entry, code, entry)),
    );
    if (!bake || !comb || !mip || !sky) return;
    const uniform = device.createBuffer({ size: STRUCT.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({
        addressModeU: "repeat",
        addressModeV: "repeat",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
    });
    const group = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[]) =>
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const params = { binding: 0, resource: { buffer: uniform } };
    const view = { binding: 4, resource: { buffer: lab.view } };

    // The map with its levels, a second texture to comb into and back, and the groups that walk them.
    function createMap(size: number) {
        const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
        const levels = Math.floor(Math.log2(size)) + 1;
        const map = device.createTexture({ size: [size, size], format: "rgba16float", usage, mipLevelCount: levels });
        const other = device.createTexture({ size: [size, size], format: "rgba16float", usage });
        const level = (i: number) => map.createView({ baseMipLevel: i, mipLevelCount: 1 });
        const linear = { binding: 3, resource: sampler };
        return {
            size,
            levels,
            textures: [map, other],
            bake: group(bake as GPUComputePipeline, [params, { binding: 1, resource: level(0) }]),
            comb: [
                [level(0), other.createView()],
                [other.createView(), level(0)],
            ].map(([from, to]) =>
                group(comb as GPUComputePipeline, [
                    params,
                    { binding: 1, resource: to as GPUTextureView },
                    { binding: 2, resource: from as GPUTextureView },
                    linear,
                ]),
            ),
            mips: Array.from({ length: levels - 1 }, (_, i) =>
                group(mip as GPUComputePipeline, [
                    { binding: 1, resource: level(i + 1) },
                    { binding: 2, resource: level(i) },
                ]),
            ),
            sky: group(sky as GPUComputePipeline, [params, linear, view, { binding: 5, resource: map.createView() }]),
        };
    }
    const textures = texturePanel(root, device);
    lab.timed = textures.refresh;
    let map: ReturnType<typeof createMap> | null = null;
    let baked = "";
    const outputs = new WeakMap<GPUTexture, GPUBindGroup>();

    lab.status = () => {
        const ms = (name: string) => (lab.timer.ms[name] === undefined ? "?" : lab.timer.ms[name]?.toFixed(2));
        return `map ${map?.size ?? 0}², bake ${ms("bake")} ms, sheet ${ms("sheet")} ms on the GPU`;
    };

    draw = () => {
        const { width, height } = lab.size();
        const size = Number(lab.choice("size")) || 2048;
        if (map?.size !== size) {
            for (const texture of map?.textures ?? []) texture.destroy();
            map = createMap(size);
            baked = "";
        }
        const values: Record<string, number> = { mapSize: size, combStep: (3 * size) / 2048 };
        for (const field of FIELDS) {
            const input = root.querySelector<HTMLInputElement>(`input[data-param="c.${field}"]`);
            if (input) values[field] = Number(input.value);
        }
        const tile = values.tile ?? 32;
        values.windTo = (lab.value("wind.from") + 180) * DEG;
        values.drift = ((lab.value("wind.speed") * lab.clock) / 1000) % tile;
        values.bandAngle = (values.bandAngle ?? 0) * DEG;
        values.phase = (lab.value("phase") + (lab.value("change") * lab.clock) / 3600) % 8;
        values.viewMode = lab.choice("view") === "map" ? 1 : 0;
        values.billowShift = (lab.value("billowSpeed") * lab.clock) / 1000;
        device.queue.writeBuffer(uniform, 0, STRUCT.pack(values));

        const encoder = device.createCommandEncoder({ label: "sternwarte:cirrusLab" });
        // Combed an even number of times, so the last step lands in the map.
        const combs = 2 * Math.round(lab.value("comb") / 2);
        const key = JSON.stringify([FIELDS.filter((f) => !UNBAKED.has(f)).map((f) => values[f]), combs]);
        if (key !== baked) {
            baked = key;
            const timestampWrites = lab.timer.writes("bake");
            const pass = encoder.beginComputePass({
                label: "cirrusLab:bake",
                ...(timestampWrites && { timestampWrites }),
            });
            const across = Math.ceil(size / 8);
            pass.setPipeline(bake as GPUComputePipeline);
            pass.setBindGroup(0, map.bake);
            pass.dispatchWorkgroups(across, across);
            pass.setPipeline(comb as GPUComputePipeline);
            for (let i = 0; i < combs; i++) {
                pass.setBindGroup(0, map.comb[i % 2] as GPUBindGroup);
                pass.dispatchWorkgroups(across, across);
            }
            pass.setPipeline(mip as GPUComputePipeline);
            map.mips.forEach((mips, i) => {
                const level = Math.ceil((size >> (i + 1)) / 8);
                pass.setBindGroup(0, mips);
                pass.dispatchWorkgroups(level, level);
            });
            pass.end();
        }
        const target = lab.context.getCurrentTexture();
        let output = outputs.get(target);
        if (!output) {
            output = device.createBindGroup({
                layout: (sky as GPUComputePipeline).getBindGroupLayout(1),
                entries: [{ binding: 0, resource: target.createView() }],
            });
            outputs.set(target, output);
        }
        const timestampWrites = lab.timer.writes("sheet");
        const pass = encoder.beginComputePass({
            label: "cirrusLab:sheet",
            ...(timestampWrites && { timestampWrites }),
        });
        pass.setPipeline(sky as GPUComputePipeline);
        pass.setBindGroup(0, map.sky);
        pass.setBindGroup(1, output);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
        const [texture] = map.textures;
        if (texture) {
            // One bake fills all four channels, combs them and halves the levels.
            const common = { texture, kind: "2d" as const, ms: () => lab.timer.ms.bake, timed: "all four" };
            textures.show([
                {
                    ...common,
                    label: "puffs",
                    title: "The baked map's red channel, an eighth of a tile across, in the wind's frame, the wind along x: the puffs and their trails as a height, 0 at a rim and 1 in the middle. The sky reads it once per pixel, eats the billows out of it and softens what is left into a density.",
                    mode: SHOW.red,
                    at: 0.125,
                },
                {
                    ...common,
                    label: "veil",
                    title: "Green, a quarter of a tile across: the veil with its striations, ribs and trails, the thin cloud between and under the puffs. Read with the puffs, in the same lookup.",
                    mode: SHOW.green,
                    at: 0.25,
                },
                {
                    ...common,
                    label: "broad field",
                    title: "Blue, the whole tile: a broad field. The sky reads it a second time, at the patches' size and angle, to decide where the sheet stands and where the sky shows through, so the tile's repetition hides.",
                    mode: SHOW.blue,
                },
                {
                    ...common,
                    label: "billows",
                    title: "Alpha, a quarter of a tile across: the billows' noise, bright between lumps of three sizes. The sky reads it twice per pixel, at the billows' size and creeping two ways, and eats that much into the puffs from their rims: nothing is baked again when the billows move.",
                    mode: SHOW.alpha,
                    at: 0.25,
                },
            ]);
        }
        textures.encode(encoder, lab.pressed("textures.on"));
        lab.timer.resolve(encoder);
        device.queue.submit([encoder.finish()]);
        lab.timer.read();
    };
    lab.request();
}
