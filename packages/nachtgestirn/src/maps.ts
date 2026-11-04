import * as wgsl from "./wgsl/index.js";

/** The Moon's maps on the GPU, equirectangular, centered on 0° longitude with east to the right and north up, as NASA's
 *  CGI Moon Kit lays them out: the color map, sRGB-encoded in an rgba8unorm texture with mip levels, the normal map,
 *  east, north and up in its tangent frame in rgb, or null, and the sampler to read them with. */
export interface MoonMaps {
    readonly color: GPUTexture;
    readonly normals: GPUTexture | null;
    readonly sampler: GPUSampler;
    /** What the color map is multiplied by to read as normal albedo: the geometric albedo over the map's mean. */
    readonly albedoScale: number;
    destroy(): void;
}

export interface MoonMapsOptions {
    /** The color map, decoded; `createImageBitmap` of its file with `colorSpaceConversion: "none"`. */
    color: ImageBitmap;
    /** The normal map, decoded the same way; without, the Moon is shaded by its sphere alone. */
    normals?: ImageBitmap;
    /** The color map's mean reflectance over the near side, linear, as `scripts/maps.mjs` prints it; NASA's map is
     *  balanced to look right, not to measure. With `geometricAlbedo`, 0.12 by default, it scales the map to normal
     *  albedo, so the drawn full Moon averages the real one's brightness. 1 reads the map as is. */
    meanReflectance?: number;
    geometricAlbedo?: number;
}

const mipLevels = (width: number, height: number) => Math.floor(Math.log2(Math.max(width, height))) + 1;

/** Uploads the maps and builds their mip levels on the GPU, so the disc stays smooth at any size on screen. */
export function createMoonMaps(device: GPUDevice, options: MoonMapsOptions): MoonMaps {
    const { color, normals, meanReflectance = 1, geometricAlbedo = 0.12 } = options;
    // Copied into from an image, which needs the render attachment usage too, and written level by level by the mip pass.
    const usage =
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT;
    const upload = (image: ImageBitmap, label: string) => {
        const texture = device.createTexture({
            label,
            size: [image.width, image.height],
            format: "rgba8unorm",
            mipLevelCount: mipLevels(image.width, image.height),
            usage,
        });
        device.queue.copyExternalImageToTexture({ source: image }, { texture }, [image.width, image.height]);
        return texture;
    };
    const colorTexture = upload(color, "nachtgestirn:color");
    const normalTexture = normals ? upload(normals, "nachtgestirn:normals") : null;
    const sampler = device.createSampler({
        label: "nachtgestirn:maps",
        addressModeU: "repeat",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
    });
    buildMips(device, colorTexture, true);
    if (normalTexture) buildMips(device, normalTexture, false);
    return {
        color: colorTexture,
        normals: normalTexture,
        sampler,
        albedoScale: geometricAlbedo / meanReflectance,
        destroy() {
            colorTexture.destroy();
            normalTexture?.destroy();
        },
    };
}

/** Fetches and decodes the maps' files, as a browser does, and uploads them: `createMoonMaps` with the images. */
export async function loadMoonMaps(
    device: GPUDevice,
    urls: { color: string; normals?: string },
    options: Omit<MoonMapsOptions, "color" | "normals"> = {},
): Promise<MoonMaps> {
    const decode = async (url: string) =>
        createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const [color, normals] = await Promise.all([decode(urls.color), urls.normals ? decode(urls.normals) : null]);
    return createMoonMaps(device, { color, ...(normals ? { normals } : {}), ...options });
}

const pipelines = new WeakMap<GPUDevice, Map<string, GPUComputePipeline>>();

function mipPipeline(device: GPUDevice, srgb: boolean) {
    const byDevice = pipelines.get(device) ?? new Map<string, GPUComputePipeline>();
    pipelines.set(device, byDevice);
    const key = srgb ? "srgb" : "linear";
    let pipeline = byDevice.get(key);
    if (!pipeline) {
        const code = [wgsl.moonOutput("rgba8unorm"), wgsl.params, wgsl.surface, wgsl.mips].join("\n");
        pipeline = device.createComputePipeline({
            label: "nachtgestirn:mips",
            layout: "auto",
            compute: {
                module: device.createShaderModule({ label: "nachtgestirn:mips", code }),
                entryPoint: "nbDownsample",
                constants: { NB_MIP_SRGB: srgb ? 1 : 0 },
            },
        });
        byDevice.set(key, pipeline);
    }
    return pipeline;
}

function buildMips(device: GPUDevice, texture: GPUTexture, srgb: boolean) {
    const pipeline = mipPipeline(device, srgb);
    const encoder = device.createCommandEncoder({ label: "nachtgestirn:mips" });
    for (let level = 1; level < texture.mipLevelCount; level++) {
        const source = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
        const target = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
            0,
            device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: source }],
            }),
        );
        pass.setBindGroup(
            1,
            device.createBindGroup({
                layout: pipeline.getBindGroupLayout(1),
                entries: [{ binding: 0, resource: target }],
            }),
        );
        const width = Math.max(1, texture.width >> level);
        const height = Math.max(1, texture.height >> level);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
    }
    device.queue.submit([encoder.finish()]);
}
