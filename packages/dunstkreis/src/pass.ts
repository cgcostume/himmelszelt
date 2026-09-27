import type { AutoExposureKey } from "./exposure.js";
import type { AtmosphereModel, PrecomputedTextureConfig } from "./model.js";

/**
 * The precomputed lookup tables, owned by this package. Recomputed only when the model parameters change, not
 * per frame.
 */
export interface AtmosphereLUTs {
    readonly model: AtmosphereModel;
    readonly config: PrecomputedTextureConfig;
    readonly transmittance: GPUTexture;
    readonly multiScattering: GPUTexture;
    /** The sampler the tables are read with, and the model packed as the shaders take it, for the passes to reuse. */
    readonly sampler: GPUSampler;
    readonly atmosphereBuffer: GPUBuffer;
    destroy(): void;
}

/**
 * Lowest observer height above the ground, in meters, that the passes will use: eye level, give or take. Right at the
 * ground the horizon is exactly horizontal, every downward ray ends at once, and the sky looks nothing like the one
 * a person sees.
 */
export const MIN_OBSERVER_HEIGHT_M = 1;

/** Highest observer height, in meters: the International Space Station's orbit, some 408 km up. */
export const MAX_OBSERVER_HEIGHT_M = 408_000;

/** An observer height in meters, held within `MIN_OBSERVER_HEIGHT_M` and `MAX_OBSERVER_HEIGHT_M`. */
export function clampObserverHeight(heightM: number): number {
    return Math.min(Math.max(heightM, MIN_OBSERVER_HEIGHT_M), MAX_OBSERVER_HEIGHT_M);
}

/** Everything that can change per frame. */
export interface SkyParams {
    /**
     * Unit vector towards the sun in the observer's ENU frame (x east, y north, z up), as `@himmelszelt/sternzeit`'s
     * `sun.direction` returns it. The shaders only rely on `z` being up; the rest has to match the view rays.
     * The true (geometric) direction: the pass bends the view rays by the model's refractivity, and an already
     * refracted direction would lift the sun twice.
     */
    sunDirection: readonly [number, number, number];
    /** Observer height above the ground, in meters, held within 1 m and 408 km (`clampObserverHeight`). Above the
     *  atmosphere, the sky is raymarched per pixel instead of looked up, and the planet shows, lit by the sun. */
    observerHeightM: number;
    /** Inverse view-projection matrix, column-major, used to turn fragment coordinates back into rays. */
    inverseViewProjection: Float32Array;
    /**
     * Bends the matrix's projection towards a fisheye: 0 keeps its own perspective, 1 is stereographic, which shows
     * the whole sky as a disc looking up and a small planet looking down. The matrix still gives the camera's axis and
     * scale; widen its field of view along with this.
     */
    projectionDistance: number;
    /**
     * Exposure in EV100, for the sky in cd/m²: about 15 for a sunny day, 10 overcast, 0 in twilight, -6 by moonlight.
     * The same scale as a camera's or another engine's, so a scene exposed alike looks alike. Unused when metered.
     */
    ev100: number;
    /**
     * Expose by a light meter instead: the geometric mean luminance of the sky above the horizon, measured on the GPU
     * whenever the sky-view table is rebuilt, and read by the sky pass without a round trip to the CPU. For a renderer
     * without its own exposure, or to follow day into night.
     */
    autoExposure: boolean;
    /**
     * The EV100s metering may expose with, after compensation, [8, 20] by default. The lower bound keeps night dark:
     * exposed like day, a night sky would look like one. The day meters around 14, a sunset around 12, and twilight
     * follows down to 8.
     */
    autoExposureRange: readonly [number, number];
    /**
     * The metered exposure's ramp over the day: compensations at sun altitudes, for mornings and evenings apart if
     * wanted. `DEFAULT_AUTO_EXPOSURE_KEYS` by default; empty for the meter's reading as it is.
     */
    autoExposureKeys: readonly AutoExposureKey[];
    /** Added to the metered exposure on top of the keys, in EV: +1 is twice as bright. */
    exposureCompensation: number;
    /** The Sun's apparent angular diameter, in degrees, as `@himmelszelt/sternzeit`'s `sun.apparentAngularDiameter`
     *  returns it. About 0.53. */
    sunAngularDiameter: number;
    /** osgHimmel's artistic blue-hour tint: linear RGB plus an intensity, 0 by default. Not physical: the ozone already
     *  turns twilight blue. */
    lHeureBleue: { color: readonly [number, number, number]; intensity: number };
}

/**
 * A sky pass: a compute pass that writes every pixel of a target the caller owns, with no rasterization. It goes
 * first, as the background the moon, stars, clouds and the rest of the frame are drawn over. This package never
 * creates a device, a canvas, a context or a swap chain.
 */
export interface SkyPass {
    /**
     * The table the sky pass reads, rebuilt by `update()`. Exposed so it can be inspected or exported;
     * nothing in a normal render path needs it.
     */
    readonly skyViewTexture: GPUTexture;
    update(params: Partial<SkyParams>): void;
    /** The EV100 `autoExposure` exposes with: the light meter's latest reading, read back from the GPU, compensated and
     *  held within `autoExposureRange`. */
    meteredEV100(): Promise<number>;
    /**
     * The sun's illuminance at the observer, per channel in lux, read back from the GPU: the sunlight left after the
     * air, zero once the planet hides the sun. For lighting a scene by the sun as a directional light of its own, from
     * its apparent direction (`apparentDirection`), next to the sky's diffuse light from `createIrradiancePass`.
     */
    sunIlluminance(): Promise<[number, number, number]>;
    /**
     * Records the sky into the six faces of `target`, a cube map: a square 2D texture with six layers, rgba16float or
     * rgba32float, with `STORAGE_BINDING` usage. It holds the luminance in cd/m², linear, neither exposed nor tone
     * mapped, indexed by ENU directions: a y-up engine samples it with (x, -z, y). Without the sun disc by default, to
     * light a scene with; with `sunDisc`, for a background, which needs rgba32float. `samples` per texel, 1, 8 or 64,
     * spread by the golden sets, smooth the edges a texel straddles: the horizon's, and the sun disc's.
     */
    encodeCube(
        encoder: GPUCommandEncoder,
        target: GPUTexture,
        options?: { sunDisc?: boolean; samples?: 1 | 8 | 64 },
    ): void;
    /** Records the pass into `encoder`, writing all of `target`, which needs `STORAGE_BINDING` usage and the format
     *  the pass was created for. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture): void;
    destroy(): void;
}
