import { DEFAULT_TEXTURE_CONFIG, type PrecomputedTextureConfig } from "./model.js";

/** What a renderer is going to use, to tell what its device needs. */
export interface RequirementOptions {
    /** The sky pass' output format; none for the tables and a sky cube map alone. */
    format?: GPUTextureFormat;
    /** The largest output, in pixels along either edge. */
    outputSize?: number;
    /** The tables' sizes, `DEFAULT_TEXTURE_CONFIG` by default. */
    config?: PrecomputedTextureConfig;
    /** A sky cube map: its format and its edge in texels. */
    cube?: { format: "rgba16float" | "rgba32float"; size?: number };
}

/** Features and limits to request a device with, as `adapter.requestDevice(skyRequirements(options))` takes them. */
export interface DeviceRequirements {
    requiredFeatures: GPUFeatureName[];
    requiredLimits: Record<string, number>;
}

/** Features the passes use where a device has them, and do without otherwise. */
const OPTIONAL_FEATURES: GPUFeatureName[] = ["subgroups", "float32-filterable"];

/**
 * The device features and limits the tables, the sky pass and a sky cube map need. Every limit is within WebGPU's
 * defaults and its compatibility mode's: a device made without asking for more has them. Only bgra8unorm output needs
 * a feature. Given the `adapter`, the features the passes are faster or finer with are asked for too, where it has them:
 * "subgroups" for the sums over a workgroup, "float32-filterable" for an rgba32float cube map in the irradiance pass.
 */
export function skyRequirements(options: RequirementOptions = {}, adapter?: GPUAdapter): DeviceRequirements {
    const { format, outputSize = 0, config = DEFAULT_TEXTURE_CONFIG, cube } = options;
    const tables = [config.transmittance, config.multiScattering, config.skyView].flatMap(({ width, height }) => [
        width,
        height,
    ]);
    const requiredLimits: Record<string, number> = {
        maxBindGroups: 2,
        // The sky-view pass' highest binding is 7.
        maxBindingsPerBindGroup: 8,
        maxUniformBuffersPerShaderStage: 2,
        maxSampledTexturesPerShaderStage: 3,
        maxSamplersPerShaderStage: 1,
        maxStorageBuffersPerShaderStage: 1,
        maxStorageTexturesPerShaderStage: 1,
        // The light meter's workgroup, and its sums in workgroup memory without subgroups.
        maxComputeInvocationsPerWorkgroup: 128,
        maxComputeWorkgroupSizeX: 128,
        maxComputeWorkgroupStorageSize: 2048,
        maxTextureDimension2D: Math.max(outputSize, cube?.size ?? 0, ...tables),
    };
    if (cube) requiredLimits.maxTextureArrayLayers = 6;
    const requiredFeatures: GPUFeatureName[] = format === "bgra8unorm" ? ["bgra8unorm-storage"] : [];
    for (const feature of OPTIONAL_FEATURES) if (adapter?.features.has(feature)) requiredFeatures.push(feature);
    return { requiredFeatures, requiredLimits };
}

/**
 * What an adapter or a device lacks for `options`, in words, empty when it has everything: check an adapter before
 * requesting a device from it with `skyRequirements(options)`, or a device made elsewhere before handing it over.
 */
export function unmetRequirements(gpu: GPUAdapter | GPUDevice, options: RequirementOptions = {}): string[] {
    const unmet: string[] = [];
    const { format } = options;
    if (format && !["rgba8unorm", "bgra8unorm", "rgba16float", "rgba32float"].includes(format)) {
        unmet.push(`the sky pass writes rgba8unorm, bgra8unorm, rgba16float or rgba32float, not ${format}`);
    }
    const { requiredFeatures, requiredLimits } = skyRequirements(options);
    for (const feature of requiredFeatures) {
        if (!gpu.features.has(feature)) unmet.push(`the "${feature}" feature, to write ${format} from a compute pass`);
    }
    const limits = gpu.limits as unknown as Record<string, number>;
    for (const [name, value] of Object.entries(requiredLimits)) {
        if ((limits[name] ?? 0) < value) unmet.push(`${name} of at least ${value}, not ${limits[name]}`);
    }
    return unmet;
}
