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
 * Smallest observer height above the ground, in meters, that the passes will use. At exactly ground level the horizon
 * is exactly horizontal and every downward ray hits the ground at distance zero. The shaders take the altitude rather
 * than the radius, which f32 resolves to only ~0.5 m, so a millimeter is enough.
 */
export const MIN_OBSERVER_HEIGHT_M = 0.001;

/** Everything that can change per frame. */
export interface SkyParams {
    /**
     * Unit vector towards the sun in the observer's ENU frame (x east, y north, z up), as `@himmelszelt/sternzeit`'s
     * `sun.direction` returns it. The shaders only rely on `z` being up; the rest has to match the view rays.
     * The true (geometric) direction: the pass bends the view rays by the model's refractivity, and an already
     * refracted direction would lift the sun twice.
     */
    sunDirection: readonly [number, number, number];
    /** Observer height above the ground, in meters, at least `MIN_OBSERVER_HEIGHT_M`. Above the atmosphere, the sky is
     *  raymarched per pixel instead of looked up, and the planet shows, lit by the sun. */
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
    /** Records the pass into `encoder`, writing all of `target`, which needs `STORAGE_BINDING` usage and the format
     *  the pass was created for. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture): void;
    destroy(): void;
}
