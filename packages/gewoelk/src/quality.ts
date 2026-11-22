/**
 * Quality as three dials of four levels each, for both models: how far the clouds are seen, how finely they are
 * sampled and stored, and how they change over time. `cloudQuality` turns them into what the passes are made and
 * updated with.
 */
import type { CloudPassOptions } from "./clouds.js";
import type { LayeredQuality } from "./layered.js";
import type { LayerMarchSettings } from "./layerpass.js";

export type QualityLevel = "low" | "medium" | "high" | "ultra";

/** A level for each dial: those left out are "medium". */
export interface CloudQuality {
    /** How far the clouds reach before they thin out to a clear horizon. */
    reach?: QualityLevel;
    /** The share of the frame the clouds are marched at, a ray's steps, and the sizes of the volumes and maps. */
    sampling?: QualityLevel;
    /** How the clouds' shape changes: not at all at "low", where they still drift and billow, to every frame at "ultra". */
    motion?: QualityLevel;
}

// The distance at which the last cloud is gone and from where they thin out, in km, 0 for clouds to the horizon, and
// how far the layers are marched.
const REACH = {
    low: { clearingKm: 40, clearingFromKm: 20, reachKm: 60 },
    medium: { clearingKm: 150, clearingFromKm: 40, reachKm: 160 },
    high: { clearingKm: 0, clearingFromKm: 0, reachKm: 200 },
    ultra: { clearingKm: 0, clearingFromKm: 0, reachKm: 320 },
} as const;

const voxel = (
    scale: number,
    maxSteps: number,
    nearLightSamples: number,
    size: number,
    layers: number,
    detailSize: number,
    mapSize: number,
) => ({
    ...{ scale, maxSteps, nearLightSamples, grid: { size, layers }, detailSize, mapSize },
});
const layered = (scale: number, maxSteps: number, mapSize: number, highMapSize: number): LayeredQuality => ({
    ...{ scale, maxSteps, mapSize, highMapSize },
});
// The voxel pass's options and the layered pass's quality, level by level.
const SAMPLING = {
    low: { voxel: voxel(1 / 3, 128, 1, 128, 32, 64, 256), layered: layered(1 / 3, 64, 256, 512) },
    medium: { voxel: voxel(0.5, 256, 2, 256, 64, 128, 512), layered: layered(0.5, 128, 512, 1024) },
    high: { voxel: voxel(1, 256, 2, 256, 64, 128, 512), layered: layered(1, 256, 1024, 2048) },
    ultra: { voxel: voxel(1, 512, 3, 384, 96, 128, 1024), layered: layered(1, 384, 2048, 2048) },
} as const;

// Whether the shape changes at all, whether the voxel pass builds keyframes and how many build steps it takes a frame,
// and the seconds between two bakes of the layered model's maps, 0 for every frame.
const MOTION = {
    low: { evolves: false, keyframes: false, stepsPerFrame: 0, evolutionEveryS: 0 },
    medium: { evolves: true, keyframes: true, stepsPerFrame: 1, evolutionEveryS: 2 },
    high: { evolves: true, keyframes: true, stepsPerFrame: 4, evolutionEveryS: 0.5 },
    ultra: { evolves: true, keyframes: false, stepsPerFrame: 0, evolutionEveryS: 0 },
} as const;

/** What a quality comes to, for either model. */
export interface ResolvedQuality {
    /** Options for `createCloudPass`. */
    voxel: Pick<
        CloudPassOptions,
        "scale" | "maxSteps" | "nearLightSamples" | "grid" | "detailSize" | "mapSize" | "keyframes"
    >;
    /** The `quality` of `createLayeredCloudPass`, and its march's reach. */
    layered: LayeredQuality;
    march: Pick<LayerMarchSettings, "reachKm">;
    /** The clearing, for the cloudscape's parameters and the layered sky's. */
    clearing: { clearingKm: number; clearingFromKm: number };
    /** Whether the shape evolves: without, pass `evolution: 0`. With keyframes, the build steps to `advance` a frame. */
    evolves: boolean;
    stepsPerFrame: number;
    /** `evolutionEveryS` of the layered model's parameters. */
    evolutionEveryS: number;
}

/** The numbers of `quality`: one level for all three dials, or a level for each. */
export function cloudQuality(quality: QualityLevel | CloudQuality = "medium"): ResolvedQuality {
    const dials = typeof quality === "string" ? { reach: quality, sampling: quality, motion: quality } : quality;
    const { reach = "medium", sampling = "medium", motion = "medium" } = dials;
    const { reachKm, ...clearing } = REACH[reach];
    const { evolves, keyframes, stepsPerFrame, evolutionEveryS } = MOTION[motion];
    return {
        voxel: { ...SAMPLING[sampling].voxel, keyframes },
        layered: SAMPLING[sampling].layered,
        march: { reachKm },
        clearing,
        evolves,
        stepsPerFrame,
        evolutionEveryS,
    };
}
