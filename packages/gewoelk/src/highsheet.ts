import type { HighSheet, LayeredParams } from "./layers.js";
import { DRIFT_PERIOD_KM, drift, evolutionAt } from "./params.js";
import highmap from "./wgsl/highmap.comp.wgsl";
import highsheet from "./wgsl/highsheet.comp.wgsl";
import { camera, cloudOutput, noise, params as paramsWgsl } from "./wgsl/index.js";

/** What a high sheet's pass is made with. */
export interface HighSheetOptions {
    /** Texels across the map, a power of two, 2048 by default: its levels halve down to one. */
    mapSize?: number;
    /** How fast the billows creep, in m/s, 0.5 by default: free, as the map is not baked again for it. */
    billowSpeed?: number;
    /** The row of the sunlight table with the sun's light at the sheet's altitude, 2 by default: the first sheet's. */
    sunlightRow?: number;
}

/** What an update of the high sheet may take besides its parameters. */
export interface HighSheetUpdateOptions {
    /** Where the observer stands over the ground, in km east and north of where they started, there by default. */
    observerKm?: readonly [number, number];
    /** Timestamps around the bake, where the map is baked. */
    timestampWrites?: GPUComputePassTimestampWrites;
}

/** What the high sheet is read with: the frame's `GwParams` and `GwSunlight` as the voxel passes take them, a size. */
export interface HighSheetEncodeOptions {
    params: GPUBuffer;
    sunlight: GPUBuffer;
    width: number;
    height: number;
    timestampWrites?: GPUComputePassTimestampWrites;
}

/** The sheet of high cloud as a pass of its own: a map baked when its shape changes, read once per pixel. */
export interface HighSheetPass {
    /** The sheet as last read, rgba16float: its light in cd/m² as it reaches the eye, and in alpha what it lets through
     *  of what lies behind, less where its shadow lies on the ground. Another texture after a change of size. */
    readonly texture: GPUTexture;
    /** The baked map with its levels, rgba16float, in the wind's frame: puffs, veil, broad field and billows' noise. */
    readonly map: GPUTexture;
    /** `GwHighSheet` as the sheet is read by, `wgsl.highsheet`'s: for a pass that reads the map itself. */
    readonly uniforms: GPUBuffer;
    /** Bytes of the textures the pass holds: the map with its levels, the one it is combed through, and the output. */
    readonly memoryBytes: number;
    /** Writes the uniforms and records the map's bake into `encoder` where its shape changed; returns whether so. */
    update(params: LayeredParams, encoder: GPUCommandEncoder, options?: HighSheetUpdateOptions): boolean;
    /** Records the sheet's read into `encoder`, into `texture` at the given size. */
    encode(encoder: GPUCommandEncoder, options: HighSheetEncodeOptions): void;
    destroy(): void;
}

/** Byte sizes of `GwHighModel` in highmap.comp.wgsl and `GwHighSheet` in highsheet.comp.wgsl. */
const MODEL_SIZE = 80;
const SHEET_SIZE = 112;
const TEXEL_BYTES = 8;
const dispatch = (n: number) => Math.ceil(n / 8);

/** `GwHighModel` packed: all the map is baked from. */
function modelData(s: HighSheet, p: LayeredParams, combStep: number): ArrayBuffer {
    const buffer = new ArrayBuffer(MODEL_SIZE);
    const f = new Float32Array(buffer);
    f.set([s.tileKm, evolutionAt(p.evolution, p.timeS, p.evolutionOffset)], 0);
    new Uint32Array(buffer)[2] = p.seed >>> 0;
    f.set([combStep, s.puffs, s.puffKm, s.elongation, s.rows, s.grain, s.ripples, s.rippleKm, s.curve], 3);
    f.set([s.ribs, s.ribKm, s.veil, s.striation, s.stretch, s.trails, s.trailBend], 12);
    return buffer;
}

/** `GwHighSheet` packed: all the sheet is read by, pixel by pixel. */
function sheetData(s: HighSheet, p: LayeredParams, observerKm: readonly [number, number], billowSpeed: number) {
    const f = new Float32Array(SHEET_SIZE / 4);
    const [east, north] = p.highWind;
    const speed = Math.hypot(east, north);
    const drifted = drift(p.highWind, p.timeS);
    f.set([s.altitudeKm, s.opticalDepth, s.tileKm, s.coverage], 0);
    f.set([speed > 0 ? east / speed : 1, speed > 0 ? north / speed : 0], 4);
    f.set([observerKm[0] - drifted[0], observerKm[1] - drifted[1]], 6);
    f.set([s.patchKm, s.bandStretch, (s.bandAngle * Math.PI) / 180, s.edge, s.softness, s.billows, s.billowKm], 8);
    const crept = ((billowSpeed * p.timeS) / 1000) % DRIFT_PERIOD_KM;
    f.set(
        [crept, s.relief, s.forwardG, p.clearingKm, p.clearingFromKm, s.flakes, s.flakeKm, s.striation, s.stretch],
        15,
    );
    f[24] = s.reachKm;
    f.set(p.clearingCenterKm ?? [0, 0], 26);
    return f;
}

/** The pass of the high sheet of a layered sky on `device`: `update` it with the sky, then `encode` it for a frame. */
export async function createHighSheet(device: GPUDevice, options: HighSheetOptions = {}): Promise<HighSheetPass> {
    const { mapSize = 2048, billowSpeed = 0.5, sunlightRow = 2 } = options;
    if (!Number.isInteger(Math.log2(mapSize))) throw new Error("gewoelk: the high sheet's map is a power of two");

    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const levels = Math.log2(mapSize) + 1;
    const map = device.createTexture({
        label: "gewoelk:highMap",
        size: [mapSize, mapSize],
        format: "rgba16float",
        usage,
        mipLevelCount: levels,
    });
    // What the map is combed into and back from.
    const combed = device.createTexture({
        label: "gewoelk:highMapCombed",
        size: [mapSize, mapSize],
        format: "rgba16float",
        usage,
    });
    const sampler = device.createSampler({
        addressModeU: "repeat",
        addressModeV: "repeat",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
    });
    const uniform = (label: string, size: number) =>
        device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const model = uniform("gewoelk:highModel", MODEL_SIZE);
    const sheet = uniform("gewoelk:highSheet", SHEET_SIZE);

    const mapModule = device.createShaderModule({ label: "gewoelk:highMap", code: [noise, highmap].join("\n") });
    const sheetModule = device.createShaderModule({
        label: "gewoelk:highSheet",
        code: [paramsWgsl, camera, cloudOutput("rgba16float"), highsheet].join("\n"),
    });
    const pipeline = (module: GPUShaderModule, entryPoint: string, constants?: Record<string, number>) =>
        device.createComputePipelineAsync({
            label: `gewoelk:${entryPoint}`,
            layout: "auto",
            compute: { module, entryPoint, ...(constants ? { constants } : {}) },
        });
    const [bakePipeline, combPipeline, mipPipeline, sheetPipeline] = await Promise.all([
        pipeline(mapModule, "gwHighMapBake"),
        pipeline(mapModule, "gwHighMapComb"),
        pipeline(mapModule, "gwHighMapMip"),
        pipeline(sheetModule, "gwHighSheet", { GW_HIGH_SUNLIGHT_ROW: sunlightRow }),
    ]);

    const bindGroup = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[], group = 0) =>
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(group), entries });
    const level = (i: number) => map.createView({ baseMipLevel: i, mipLevelCount: 1 });
    const modelEntry = { binding: 0, resource: { buffer: model } };
    const bakeGroup = bindGroup(bakePipeline, [modelEntry, { binding: 1, resource: level(0) }]);
    // There and back: an even number of steps ends in the map.
    const combGroups = [
        [level(0), combed.createView()],
        [combed.createView(), level(0)],
    ].map(([read, written]) =>
        bindGroup(combPipeline, [
            modelEntry,
            { binding: 1, resource: written as GPUTextureView },
            { binding: 2, resource: read as GPUTextureView },
            { binding: 3, resource: sampler },
        ]),
    );
    const mipGroups = Array.from({ length: levels - 1 }, (_, i) =>
        bindGroup(mipPipeline, [
            { binding: 1, resource: level(i + 1) },
            { binding: 2, resource: level(i) },
        ]),
    );
    const mapView = map.createView();

    const createOutput = (width: number, height: number) =>
        device.createTexture({ label: "gewoelk:highSheet", size: [width, height], format: "rgba16float", usage });
    let output = createOutput(1, 1);
    let outputGroup: GPUBindGroup | null = null;
    // The group that takes the frame's uniforms, remade only when the caller hands in other buffers.
    let frameBuffers: readonly [GPUBuffer, GPUBuffer] | null = null;
    let frameGroup: GPUBindGroup | null = null;
    let baked = "";

    return {
        get texture() {
            return output;
        },
        map,
        uniforms: sheet,
        get memoryBytes() {
            let texels = mapSize * mapSize + output.width * output.height;
            for (let i = 0; i < levels; i++) texels += (mapSize >> i) ** 2;
            return texels * TEXEL_BYTES;
        },

        update(p, encoder, updateOptions = {}) {
            const { observerKm = [0, 0], timestampWrites } = updateOptions;
            const s = p.sky.high;
            device.queue.writeBuffer(sheet, 0, sheetData(s, p, observerKm, billowSpeed));
            // No sheet, no map: it is baked once there is one to read it.
            if (!(s.coverage > 0)) return false;
            const data = modelData(s, p, (3 * mapSize) / 2048);
            const combs = 2 * Math.max(0, Math.round(s.combing / 2));
            const key = `${new Uint32Array(data).join()},${combs}`;
            if (key === baked) return false;
            baked = key;
            device.queue.writeBuffer(model, 0, data);
            const pass = encoder.beginComputePass({
                label: "gewoelk:highMap",
                ...(timestampWrites ? { timestampWrites } : {}),
            });
            pass.setPipeline(bakePipeline);
            pass.setBindGroup(0, bakeGroup);
            pass.dispatchWorkgroups(dispatch(mapSize), dispatch(mapSize));
            pass.setPipeline(combPipeline);
            for (let i = 0; i < combs; i++) {
                pass.setBindGroup(0, combGroups[i % 2] as GPUBindGroup);
                pass.dispatchWorkgroups(dispatch(mapSize), dispatch(mapSize));
            }
            pass.setPipeline(mipPipeline);
            mipGroups.forEach((group, i) => {
                pass.setBindGroup(0, group);
                pass.dispatchWorkgroups(dispatch(mapSize >> (i + 1)), dispatch(mapSize >> (i + 1)));
            });
            pass.end();
            return true;
        },

        encode(encoder, { params, sunlight, width, height, timestampWrites }) {
            const [across, down] = [Math.max(1, Math.round(width)), Math.max(1, Math.round(height))];
            if (output.width !== across || output.height !== down) {
                output.destroy();
                output = createOutput(across, down);
                outputGroup = null;
            }
            outputGroup ??= bindGroup(sheetPipeline, [{ binding: 0, resource: output.createView() }], 1);
            if (!frameGroup || frameBuffers?.[0] !== params || frameBuffers[1] !== sunlight) {
                frameBuffers = [params, sunlight];
                frameGroup = bindGroup(sheetPipeline, [
                    { binding: 0, resource: { buffer: params } },
                    { binding: 1, resource: { buffer: sunlight } },
                    { binding: 2, resource: { buffer: sheet } },
                    { binding: 3, resource: mapView },
                    { binding: 4, resource: sampler },
                ]);
            }
            const pass = encoder.beginComputePass({
                label: "gewoelk:highSheet",
                ...(timestampWrites ? { timestampWrites } : {}),
            });
            pass.setPipeline(sheetPipeline);
            pass.setBindGroup(0, frameGroup);
            pass.setBindGroup(1, outputGroup);
            pass.dispatchWorkgroups(dispatch(across), dispatch(down));
            pass.end();
        },

        destroy() {
            for (const texture of [map, combed, output]) texture.destroy();
            for (const buffer of [model, sheet]) buffer.destroy();
        },
    };
}
