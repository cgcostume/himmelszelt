import type { AtmosphereModel, PrecomputedTextureConfig } from "./model.js";

/**
 * The precomputed lookup tables, owned by this package. Recomputed only when the model parameters change, not
 * per frame. Which textures are present depends on the variant that produced them.
 */
export interface AtmosphereLUTs {
    readonly model: AtmosphereModel;
    readonly config: PrecomputedTextureConfig;
    readonly transmittance: GPUTexture;
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
    /** Tone mapping exposure, applied to the physical radiance the model outputs. */
    exposure: number;
    /** The Sun's apparent angular diameter, in degrees, as `@himmelszelt/sternzeit`'s `sun.apparentAngularDiameter`
     *  returns it. About 0.53. */
    sunAngularDiameter: number;
    /** osgHimmel's artistic blue-hour tint: linear RGB plus an intensity, 0 by default. Not physical: the ozone already
     *  turns twilight blue. */
    lHeureBleue: { color: readonly [number, number, number]; intensity: number };
}

/**
 * A sky pass. Records into a render pass the *caller* owns and has already begun, so that the sky composes
 * with whatever else is being drawn (moon, stars, clouds) under the caller's own blending and depth rules.
 * This package never creates a device, a canvas, a context, a render pass or a swap chain.
 */
export interface SkyPass {
    /**
     * The table the render pass reads, rebuilt by `update()`. Exposed so it can be inspected or exported;
     * nothing in a normal render path needs it.
     */
    readonly skyViewTexture: GPUTexture;
    update(params: Partial<SkyParams>): void;
    encode(pass: GPURenderPassEncoder): void;
    destroy(): void;
}
