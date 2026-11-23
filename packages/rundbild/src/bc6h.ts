import * as wgsl from "./wgsl/index.js";

/** A BC6H pass' settings, fixed when it is made. */
export interface Bc6hPassOptions {
    /**
     * "high" by default: mode 11, one line through each block, and the best fitting of the 32 two-line partitions in
     * modes 2 and 6, whichever comes closer. "fast": mode 11 alone, about ten times faster, blockier at edges.
     */
    quality?: "fast" | "high";
}

/** Which image of the source to encode and where in the target it goes. */
export interface Bc6hEncodeOptions {
    /** The array layer read from the source and written in the target, a cube map's face, 0 by default. */
    layer?: number;
    /** The mip level read from the source and written in the target, 0 by default. */
    level?: number;
}

/**
 * A pass that compresses HDR images to BC6H on the GPU, after Narkowicz's real-time encoder, unsigned: negative values
 * become 0. Its blocks go through a buffer of its own into a texture the caller makes.
 */
export interface Bc6hPass {
    /**
     * Records `source`, rgba16float or rgba32float with `TEXTURE_BINDING` usage, into `target`, bc6h-rgb-ufloat with
     * `COPY_DST` usage, at the same layer and level. A BC6H texture's size is a multiple of 4, so the caller rounds it up:
     * texels past the source's edge repeat its last row and column. The device needs "texture-compression-bc".
     */
    encode(encoder: GPUCommandEncoder, source: GPUTexture, target: GPUTexture, options?: Bc6hEncodeOptions): void;
    /** Frees the pass' block buffer, once the work recorded with it is done. */
    destroy(): void;
}

const WORKGROUP = 8;

/** Creates the pass, its pipeline compiled without blocking. */
export async function createBc6hPass(device: GPUDevice, options: Bc6hPassOptions = {}): Promise<Bc6hPass> {
    const { quality = "high" } = options;
    if (quality !== "fast" && quality !== "high") throw new Error(`rundbild: no BC6H quality ${quality}`);
    const layout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
    });
    const pipeline = await device.createComputePipelineAsync({
        label: "rundbild:bc6h",
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: {
            module: device.createShaderModule({ code: wgsl.bc6h }),
            entryPoint: "rbEncodeBc6h",
            constants: { RB_BC6H_QUALITY: quality === "high" ? 1 : 0 },
        },
    });
    // Grown, never shrunk; one outgrown stays alive as long as an encoder still refers to it.
    let blocks: GPUBuffer | undefined;

    return {
        encode(encoder, source, target, { layer = 0, level = 0 } = {}) {
            if (source.format !== "rgba16float" && source.format !== "rgba32float") {
                throw new Error(`rundbild: BC6H is encoded from rgba16float or rgba32float, not ${source.format}`);
            }
            if (target.format !== "bc6h-rgb-ufloat") {
                throw new Error(`rundbild: this pass writes bc6h-rgb-ufloat, not ${target.format}`);
            }
            if (!(target.usage & GPUTextureUsage.COPY_DST)) throw new Error("rundbild: the BC6H target needs COPY_DST");
            const width = Math.max(1, source.width >> level);
            const height = Math.max(1, source.height >> level);
            const across = Math.ceil(width / 4);
            const down = Math.ceil(height / 4);
            const fits = (size: number, count: number) => Math.ceil(Math.max(1, size >> level) / 4) === count;
            if (!fits(target.width, across) || !fits(target.height, down)) {
                throw new Error(`rundbild: a ${width}x${height} level needs a BC6H level of ${across * 4}x${down * 4}`);
            }
            const row = Math.ceil((across * 16) / 256) * 256;
            const size = row * down;
            if (!blocks || blocks.size < size) {
                blocks = device.createBuffer({
                    label: "rundbild:bc6h",
                    size,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
                });
            }
            const view = source.createView({
                dimension: "2d",
                baseArrayLayer: layer,
                arrayLayerCount: 1,
                baseMipLevel: level,
                mipLevelCount: 1,
            });
            const pass = encoder.beginComputePass({ label: "rundbild:bc6h" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout,
                    entries: [
                        { binding: 0, resource: view },
                        { binding: 1, resource: { buffer: blocks, size } },
                    ],
                }),
            );
            pass.dispatchWorkgroups(Math.ceil(across / WORKGROUP), Math.ceil(down / WORKGROUP));
            pass.end();
            encoder.copyBufferToTexture(
                { buffer: blocks, bytesPerRow: row, rowsPerImage: down },
                { texture: target, mipLevel: level, origin: [0, 0, layer] },
                [across * 4, down * 4],
            );
        },
        destroy() {
            blocks?.destroy();
            blocks = undefined;
        },
    };
}
