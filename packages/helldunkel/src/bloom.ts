import * as wgsl from "./wgsl/index.js";

const FORMAT = "rgba16float";
const STRIDE = 16;

export interface BloomPassOptions {
    /** Halvings of the image at most, 6 by default: more reach further. Fewer on a small image. */
    levels?: number;
    /** Over how many texels of its level each step up spreads, 1 by default. */
    radius?: number;
    /**
     * What the light counts as at most on its way into the blur, in exposed units where 1 saturates, 1024 by default: a Sun's
     * disc is thousands of times beyond white, and would otherwise be all the bloom shows.
     */
    ceiling?: number;
    /**
     * Weight the first level by Karis' average, off by default: a small, very bright place then cannot flicker as it moves
     * across texels, for a scene of many such, at the price of hardly blooming at all.
     */
    karis?: boolean;
}

/**
 * Bloom over a linear, exposed image, to go before the tone curve. It moves light rather than adding it: an even image
 * stays as it is.
 */
export interface BloomPass {
    /**
     * Records the bloom of `source` into `target`, both rgba16float of one size: `source` with `TEXTURE_BINDING`, `target`
     * with `STORAGE_BINDING` usage, and not the same texture. `strength` is the blurred image's share, 0.04 by default.
     */
    encode(encoder: GPUCommandEncoder, source: GPUTexture, target: GPUTexture, strength?: number): void;
    destroy(): void;
}

/** Creates the pass, its pipelines compiled without blocking. It keeps two chains of half floats, of the last size. */
export async function createBloomPass(device: GPUDevice, options: BloomPassOptions = {}): Promise<BloomPass> {
    const { levels: most = 6, radius = 1, ceiling = 1024, karis = false } = options;
    const module = device.createShaderModule({ code: [wgsl.bloomOutput(FORMAT), wgsl.bloom].join("\n") });
    const pipeline = (entryPoint: string) =>
        device.createComputePipelineAsync({
            label: `helldunkel:${entryPoint}`,
            layout: "auto",
            compute: { module, entryPoint, constants: { HD_BLOOM_KARIS: karis ? 1 : 0 } },
        });
    const [downFirst, downNext, up, mix] = (await Promise.all(
        ["hdBloomDownFirst", "hdBloomDownNext", "hdBloomUp", "hdBloomMix"].map(pipeline),
    )) as [GPUComputePipeline, GPUComputePipeline, GPUComputePipeline, GPUComputePipeline];
    const sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });
    const params = device.createBuffer({
        label: "helldunkel:bloom",
        size: STRIDE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    let chains: { width: number; height: number; levels: number; down: GPUTexture; up: GPUTexture } | null = null;

    const chainsFor = (width: number, height: number) => {
        if (chains?.width === width && chains.height === height) return chains;
        chains?.down.destroy();
        chains?.up.destroy();
        const halvings = Math.floor(Math.log2(Math.max(Math.min(width, height), 1)));
        const levels = Math.max(1, Math.min(most, halvings));
        const chain = (label: string) =>
            device.createTexture({
                label,
                size: [Math.max(1, width >> 1), Math.max(1, height >> 1)],
                mipLevelCount: levels,
                format: FORMAT,
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            });
        chains = { width, height, levels, down: chain("helldunkel:bloomDown"), up: chain("helldunkel:bloomUp") };
        return chains;
    };
    const level = (texture: GPUTexture, mip: number) => texture.createView({ baseMipLevel: mip, mipLevelCount: 1 });
    const size = (n: number, mip: number) => Math.max(1, n >> (mip + 1));

    return {
        encode(encoder, source, target, strength = 0.04) {
            if (source === target) throw new Error("helldunkel: bloom reads its source and writes its target apart");
            if (source.width !== target.width || source.height !== target.height) {
                throw new Error("helldunkel: bloom's source and target are of one size");
            }
            if (source.format !== FORMAT || target.format !== FORMAT) {
                throw new Error(`helldunkel: bloom reads and writes ${FORMAT}`);
            }
            const { width, height } = source;
            const { levels, down, up: rising } = chainsFor(width, height);
            device.queue.writeBuffer(params, 0, new Float32Array([strength, radius, ceiling, levels]));
            const pass = encoder.beginComputePass({ label: "helldunkel:bloom" });
            const step = (
                pipe: GPUComputePipeline,
                from: GPUTextureView,
                to: GPUTextureView,
                x: number,
                y: number,
                other?: GPUTextureView,
            ) => {
                const entries: GPUBindGroupEntry[] = [
                    { binding: 0, resource: from },
                    { binding: 1, resource: sampler },
                    { binding: 2, resource: to },
                    { binding: 4, resource: { buffer: params } },
                ];
                if (other) entries.push({ binding: 3, resource: other });
                pass.setPipeline(pipe);
                pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries }));
                pass.dispatchWorkgroups(Math.ceil(x / 8), Math.ceil(y / 8));
            };
            step(downFirst, source.createView(), level(down, 0), size(width, 0), size(height, 0));
            for (let mip = 1; mip < levels; ++mip) {
                step(downNext, level(down, mip - 1), level(down, mip), size(width, mip), size(height, mip));
            }
            // The lowest level as it is, then each one above adding to it.
            let below = level(down, levels - 1);
            for (let mip = levels - 2; mip >= 0; --mip) {
                const next = level(rising, mip);
                step(up, below, next, size(width, mip), size(height, mip), level(down, mip));
                below = next;
            }
            step(mix, source.createView(), target.createView(), width, height, below);
            pass.end();
        },
        destroy() {
            chains?.down.destroy();
            chains?.up.destroy();
            params.destroy();
        },
    };
}
