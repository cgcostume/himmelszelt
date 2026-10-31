import * as wgsl from "./wgsl/index.js";

/** How a panorama lays the sphere out on one 2D texture, see `wgsl.panorama`. */
export type PanoramaProjection = "equirectangular" | "octahedral" | "fisheye" | "sphere";

/** A panorama's settings, fixed when its pass is made. */
export interface PanoramaPassOptions {
    /**
     * Equirectangular, as HDRIs are shared: 2:1, the azimuth across, north at the left edge and south in the middle,
     * the zenith at the top and the nadir at the bottom. Octahedral: the whole sphere in a square, the zenith in the
     * middle. Fisheye: the upper hemisphere in the square's inscribed circle, as an all-sky camera sees it, the zenith
     * in the middle. Sphere, the sphere map: the whole sphere in the inscribed circle, as a mirror ball shows it, the
     * zenith in the middle and the nadir all round the rim, equal in area. Octahedral, fisheye and sphere map are laid
     * out as a sky chart held overhead: north up, east left.
     */
    projection: PanoramaProjection;
    /** The panorama's format. */
    format: "rgba16float" | "rgba32float";
    /** Lookups per texel, spread over it by the R2 sequence, 1 by default. */
    samples?: number;
    /**
     * Turns the panorama about the zenith, in degrees: the azimuth at the equirectangular's left edge and at the top of
     * the others, 0 by default, north. 180 puts north in the equirectangular's middle and at the bottom of the others.
     */
    azimuthOffset?: number;
    /** Whether the source cube maps are cubified. */
    cubified?: boolean;
    /**
     * The source cube maps' format, rgba16float by default. rgba32float is read through a nearest sampler unless the
     * device has the "float32-filterable" feature.
     */
    sourceFormat?: GPUTextureFormat;
}

/**
 * A pass that lays a cube map out as a panorama, in the units the cube map holds. Alpha is the share of a texel the
 * projection covers: 1, but around the fisheye's and the sphere map's circle and 0 beyond it. There the texels hold what
 * lies at the rim, the horizon at their azimuth for the fisheye and the nadir for the sphere map, so that a lookup
 * filtered across the rim blends into it rather than into black. The fisheye's top left corner texel holds the nadir:
 * `rbFisheyeUv` sends every direction below the horizon there.
 */
export interface PanoramaPass {
    /**
     * Records `source`, a cube map of the pass' source format with `TEXTURE_BINDING` usage, into mip level 0 of `target`,
     * a 2D texture of any size, of the pass' format, with `STORAGE_BINDING` usage.
     */
    encode(encoder: GPUCommandEncoder, source: GPUTexture, target: GPUTexture): void;
}

const WORKGROUP = 8;
const PROJECTIONS = { equirectangular: 1, octahedral: 2, fisheye: 3, sphere: 4 } as const;

/** Creates the pass, its pipeline compiled without blocking. Source cube maps are sampled linearly, so any size works. */
export async function createPanoramaPass(device: GPUDevice, options: PanoramaPassOptions): Promise<PanoramaPass> {
    const { projection, format, samples = 1, azimuthOffset = 0, cubified = false } = options;
    const { sourceFormat = "rgba16float" } = options;
    if (format !== "rgba16float" && format !== "rgba32float") {
        throw new Error(`rundbild: a panorama is rgba16float or rgba32float, not ${format}`);
    }
    const number = PROJECTIONS[projection];
    if (!number) throw new Error(`rundbild: no panorama projection ${projection}`);
    if (!Number.isInteger(samples) || samples < 1) throw new Error("rundbild: at least 1 lookup per texel");
    const filterable = sourceFormat !== "rgba32float" || device.features.has("float32-filterable");
    // The source's layout spelled out, since "auto" would take any float texture as filterable.
    const sourceLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                texture: { sampleType: filterable ? "float" : "unfilterable-float", viewDimension: "cube" },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                sampler: { type: filterable ? "filtering" : "non-filtering" },
            },
        ],
    });
    const outputLayout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { format } }],
    });
    const pipeline = await device.createComputePipelineAsync({
        label: "rundbild:panorama",
        layout: device.createPipelineLayout({ bindGroupLayouts: [sourceLayout, outputLayout] }),
        compute: {
            module: device.createShaderModule({
                code: [wgsl.cube, wgsl.panorama, wgsl.panoramaOutput(format), wgsl.panoramaPass].join("\n"),
            }),
            entryPoint: "rbPanorama",
            constants: {
                RB_PROJECTION: number,
                RB_AZIMUTH_OFFSET: (azimuthOffset * Math.PI) / 180,
                RB_SAMPLES: samples,
                RB_SOURCE_CUBIFIED: cubified ? 1 : 0,
            },
        },
    });
    const linear = filterable ? "linear" : "nearest";
    const sampler = device.createSampler({ magFilter: linear, minFilter: linear });

    return {
        encode(encoder, source, target) {
            if (source.format !== sourceFormat) {
                throw new Error(`rundbild: this panorama pass reads ${sourceFormat}, not ${source.format}`);
            }
            if (target.dimension !== "2d" || target.depthOrArrayLayers !== 1) {
                throw new Error("rundbild: a panorama is a 2D texture of one layer");
            }
            if (target.format !== format) {
                throw new Error(`rundbild: this panorama pass writes ${format}, not ${target.format}`);
            }
            if (!(target.usage & GPUTextureUsage.STORAGE_BINDING)) {
                throw new Error("rundbild: the panorama needs STORAGE_BINDING usage");
            }
            const pass = encoder.beginComputePass({ label: "rundbild:panorama" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: sourceLayout,
                    entries: [
                        { binding: 0, resource: source.createView({ dimension: "cube" }) },
                        { binding: 1, resource: sampler },
                    ],
                }),
            );
            pass.setBindGroup(
                1,
                device.createBindGroup({
                    layout: outputLayout,
                    entries: [{ binding: 0, resource: target.createView({ mipLevelCount: 1 }) }],
                }),
            );
            pass.dispatchWorkgroups(Math.ceil(target.width / WORKGROUP), Math.ceil(target.height / WORKGROUP));
            pass.end();
        },
    };
}
