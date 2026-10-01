import { DEFAULT_TEXTURE_CONFIG, type PrecomputedTextureConfig } from "./model.js";

/** What a renderer is going to use, to tell what its device needs. */
export interface RequirementOptions {
    /** The sky pass' output format; none for the tables and a sky cube map alone. */
    format?: GPUTextureFormat;
    /** The largest output, in pixels along either edge. */
    outputSize?: number;
    /** The tables' sizes, `DEFAULT_TEXTURE_CONFIG` by default. */
    config?: PrecomputedTextureConfig;
    /** A sky cube map: its format, its edge in texels, and whether it feeds the irradiance pass. */
    cube?: { format: "rgba16float" | "rgba32float"; size?: number; irradiance?: boolean };
}

/** Features and limits to request a device with, as `adapter.requestDevice(skyRequirements(options))` takes them. */
export interface DeviceRequirements {
    requiredFeatures: GPUFeatureName[];
    requiredLimits: Record<string, number>;
}

/**
 * The device features and limits the tables, the sky pass and a sky cube map need. Every limit is within WebGPU's
 * defaults, and all but the irradiance pass' workgroup memory within its compatibility mode's: a device made without
 * asking for more has them. Only bgra8unorm output needs a feature.
 */
export function skyRequirements(options: RequirementOptions = {}): DeviceRequirements {
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
        // The light meter's workgroup, and its sums in workgroup memory.
        maxComputeInvocationsPerWorkgroup: 128,
        maxComputeWorkgroupSizeX: 128,
        maxComputeWorkgroupStorageSize: 1024,
        maxTextureDimension2D: Math.max(outputSize, cube?.size ?? 0, ...tables),
    };
    if (cube) requiredLimits.maxTextureArrayLayers = 6;
    // The irradiance pass sums nine coefficients over 64 threads in workgroup memory.
    if (cube?.irradiance) requiredLimits.maxComputeWorkgroupStorageSize = 9216;
    const requiredFeatures: GPUFeatureName[] = format === "bgra8unorm" ? ["bgra8unorm-storage"] : [];
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
