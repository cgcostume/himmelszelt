import { ev100FromLuminance } from "./exposure.js";
import * as wgsl from "./wgsl/index.js";

/** The bins of each of a meter's histograms, `HD_METER_BINS` in meter.comp.wgsl. */
export const METER_BINS = 2048;
/** How finely they tell values apart. */
export const METER_BINS_PER_STOP = 32;
/** The stop bin 0 is centered on: log2 of the value. It also holds all that is darker, and zero. */
export const METER_LOWEST_STOP = -32;
const CHANNELS = 5;
const BYTES = METER_BINS * CHANNELS * 4;

/** What share of the source lies in each bin, each histogram summing to 1. Bin i is centered on stop `lowest + i / perStop`. */
export interface MeterHistogram {
    red: Float64Array;
    green: Float64Array;
    blue: Float64Array;
    luminance: Float64Array;
    /** By each place's brightest channel: the first to clip to white, and the last to clip to black. */
    peak: Float64Array;
}

/** How a histogram is averaged: a floor as a camera's range has one, or a filter as game engines take it. */
export interface MeterAverage {
    /** How far below the brightest percent of the places a place counts at most, in stops, 10 by default. */
    rangeStops?: number;
    /** Instead of that floor, the shares of the darkest and of the brightest to leave out, as `[0.1, 0.9]` keeps the middle. */
    percentiles?: readonly [number, number];
}

/**
 * The geometric mean of a histogram's luminance, one value for a scene of a few bright and many dark places. By default as
 * a camera's averaging meter takes it, each place at most `rangeStops` below the brightest percent of them: a black place
 * would otherwise pull the mean as far as it likes, and a single lamp or Sun would lift that floor over all the rest. With
 * `percentiles`, the mean of what lies between them. Zero when nothing is lit.
 */
export function meteredLuminance(
    { luminance }: Pick<MeterHistogram, "luminance">,
    { rangeStops = 10, percentiles }: MeterAverage = {},
): number {
    const stop = (bin: number) => METER_LOWEST_STOP + bin / METER_BINS_PER_STOP;
    const total = luminance.reduce((sum, share) => sum + share, 0);
    let [sum, mean, weight] = [0, 0, 0];
    if (percentiles) {
        const [from, to] = [percentiles[0] * total, percentiles[1] * total];
        for (let bin = 0; bin < METER_BINS; ++bin) {
            const share = luminance[bin] as number;
            const kept = Math.max(Math.min(sum + share, to) - Math.max(sum, from), 0);
            if (bin > 0) {
                mean += kept * stop(bin);
                weight += kept;
            }
            sum += share;
        }
    } else {
        let bright = 0;
        for (let bin = 0; bin < METER_BINS && sum < 0.99 * total; ++bin) {
            sum += luminance[bin] as number;
            bright = bin;
        }
        if (bright === 0) return 0;
        const floor = stop(bright) - rangeStops;
        for (let bin = 0; bin < METER_BINS; ++bin) {
            mean += (luminance[bin] as number) * Math.max(stop(bin), floor);
            weight += luminance[bin] as number;
        }
    }
    return weight > 0 ? 2 ** (mean / weight) : 0;
}

/** How fast an exposure follows its reading: time constants in seconds, towards a brighter and towards a darker scene. */
export interface MeterAdaptation {
    toBrighter: number;
    toDarker: number;
}

/** An EV100 `seconds` further towards its target, exponentially, so a large change starts fast and a small one stays calm. */
export function adaptEV100(current: number, target: number, seconds: number, adaptation: MeterAdaptation): number {
    const constant = target > current ? adaptation.toBrighter : adaptation.toDarker;
    return target + (current - target) * Math.exp(-seconds / Math.max(constant, 1e-3));
}

export interface MeterPassOptions {
    /**
     * What is metered: "cube" or "equirectangular", the whole sphere of such a map, each texel by its solid angle, or
     * "2d", an image evenly over its area. An equirectangular read as "2d" would count the zenith and the nadir far too much.
     */
    source: "cube" | "2d" | "equirectangular";
}

/**
 * Where a meter looks on a sphere, for what a camera calls center-weighted and spot metering: all of it within
 * `innerAngle` of `direction`, nothing past `outerAngle`, smoothly between, in radians.
 */
export interface MeterFocus {
    direction: readonly [number, number, number];
    innerAngle: number;
    outerAngle: number;
}

/** What one reading weighs and how it averages and adapts. */
export interface MeterReading extends MeterAverage {
    /** Where it looks on a sphere: not for "2d". */
    focus?: MeterFocus;
    /** What counts how much, in the red channel of any float or unorm 2D texture stretched over the source: not for "cube". */
    mask?: GPUTexture;
    /**
     * Counts at most about this many texels across, the rest skipped, each kept one anywhere in its cell, so a small bright
     * place still counts by the area it covers, on average. Every texel by default.
     */
    maxSize?: number;
    /** Follows the last reading over this many seconds, in `result`'s `adapted`. Without it, `adapted` takes this reading. */
    adapt?: MeterAdaptation & { seconds: number };
}

/**
 * A light meter for what never changes or changes rarely, a loaded HDRI or a frame now and then. It counts every texel on
 * the GPU, so a Sun of a few texels counts as much as it covers. A renderer binds `result` in its own shader, with no round
 * trip; the histograms take one to the CPU.
 */
export interface MeterPass {
    /** Records a reading of `source`, of the pass' kind with `TEXTURE_BINDING` usage, in cd/m² or any scale of it. */
    encode(encoder: GPUCommandEncoder, source: GPUTexture, reading?: MeterReading): void;
    /** The reading on the GPU, for a storage binding: three f32, its luminance, its EV100 and the EV100 adapted towards it. */
    readonly result: GPUBuffer;
    /**
     * The counts of the reading recorded last, for a shader that draws them without a round trip: `METER_BINS` u32 each of
     * red, green, blue, luminance and the brightest channel, in that order, in a fixed-point weight.
     */
    readonly counts: GPUBuffer;
    /** The histograms of the reading recorded last, once its commands are submitted. One read at a time. */
    readHistogram(): Promise<MeterHistogram>;
    /** Their average luminance, by `meteredLuminance`, as the reading asked. */
    readLuminance(): Promise<number>;
    /** The same as an EV100. Only for light in cd/m²: an image of relative values reads an EV100 as relative as they are. */
    readEV100(): Promise<number>;
    destroy(): void;
}

/** Creates the meter, its pipeline compiled without blocking. Reads any float format through `textureLoad`. */
export async function createMeterPass(device: GPUDevice, options: MeterPassOptions): Promise<MeterPass> {
    const { source: kind } = options;
    const pipeline = await device.createComputePipelineAsync({
        label: "helldunkel:meter",
        layout: "auto",
        compute: {
            module: device.createShaderModule({ code: [wgsl.meter, wgsl.meterSource(kind)].join("\n") }),
            entryPoint: "hdMeter",
        },
    });
    const resolve = await device.createComputePipelineAsync({
        label: "helldunkel:meterResolve",
        layout: "auto",
        compute: {
            module: device.createShaderModule({ code: [wgsl.meter, wgsl.meterSource(kind)].join("\n") }),
            entryPoint: "hdMeterResolve",
        },
    });
    const result = device.createBuffer({
        label: "helldunkel:meterResult",
        size: 12,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const allCount = device.createTexture({
        size: [1, 1],
        format: "r8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: allCount }, new Uint8Array([255]), { bytesPerRow: 1 }, [1, 1]);
    let average: MeterAverage = {};
    const counts = device.createBuffer({
        label: "helldunkel:meter",
        size: BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const staging = device.createBuffer({ size: BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const params = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const readHistogram = async (): Promise<MeterHistogram> => {
        const encoder = device.createCommandEncoder({ label: "helldunkel:meterReadback" });
        encoder.copyBufferToBuffer(counts, 0, staging, 0, BYTES);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const raw = new Uint32Array(staging.getMappedRange());
        const channel = (c: number) => {
            const bins = Float64Array.from(raw.subarray(c * METER_BINS, (c + 1) * METER_BINS));
            const total = bins.reduce((sum, count) => sum + count, 0) || 1;
            return bins.map((count) => count / total);
        };
        const histogram = {
            red: channel(0),
            green: channel(1),
            blue: channel(2),
            luminance: channel(3),
            peak: channel(4),
        };
        staging.unmap();
        return histogram;
    };
    const readLuminance = async () => meteredLuminance(await readHistogram(), average);

    return {
        counts,
        result,
        encode(encoder, source, reading = {}) {
            const { focus, mask, adapt, maxSize, rangeStops = 10, percentiles } = reading;
            average = percentiles ? { percentiles } : { rangeStops };
            const stride = maxSize ? Math.max(Math.ceil(source.width / maxSize), 1) : 1;
            const texels = (source.width * source.height * (kind === "cube" ? 6 : 1)) / stride ** 2;
            const [x = 0, y = 0, z = 1] = focus?.direction ?? [];
            const length = Math.hypot(x, y, z) || 1;
            device.queue.writeBuffer(
                params,
                0,
                new Float32Array([
                    x / length,
                    y / length,
                    z / length,
                    focus ? Math.cos(focus.innerAngle) : 2,
                    focus ? Math.cos(focus.outerAngle) : 2,
                    Math.floor(2 ** 31 / texels),
                    percentiles ? percentiles[0] : -1,
                    percentiles ? percentiles[1] : 1,
                    rangeStops,
                    adapt?.seconds ?? 0,
                    adapt?.toBrighter ?? 0,
                    adapt?.toDarker ?? 0,
                    stride,
                ]),
            );
            encoder.clearBuffer(counts);
            const pass = encoder.beginComputePass({ label: "helldunkel:meter" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        {
                            binding: 0,
                            resource: source.createView({ dimension: kind === "cube" ? "2d-array" : "2d" }),
                        },
                        { binding: 1, resource: { buffer: params } },
                        { binding: 2, resource: { buffer: counts } },
                        ...(kind === "cube" ? [] : [{ binding: 3, resource: (mask ?? allCount).createView() }]),
                    ],
                }),
            );
            pass.dispatchWorkgroups(
                Math.ceil(source.width / stride / 16),
                Math.ceil(source.height / stride / 16),
                kind === "cube" ? 6 : 1,
            );
            pass.setPipeline(resolve);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: resolve.getBindGroupLayout(0),
                    entries: [
                        { binding: 1, resource: { buffer: params } },
                        { binding: 2, resource: { buffer: counts } },
                        { binding: 4, resource: { buffer: result } },
                    ],
                }),
            );
            pass.dispatchWorkgroups(1);
            pass.end();
        },
        readHistogram,
        readLuminance,
        readEV100: async () => ev100FromLuminance(await readLuminance()),
        destroy() {
            counts.destroy();
            result.destroy();
            allCount.destroy();
            staging.destroy();
            params.destroy();
        },
    };
}
