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
    /** log2 of the values plus `MULTI_SCATTERING_LOG2_OFFSET`, so the linear filter interpolates them geometrically. */
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
    /**
     * Inverse view-projection matrix, column-major, used to turn pixels back into rays. Any perspective projection:
     * depth in [0, 1] or [-1, 1], reversed-z, an infinite far plane. Leave the view's translation out, as for a skybox:
     * the sky is at infinity, and f32 would lose the rays' precision to it.
     */
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
     * The EV100s metering may expose with, after compensation, [4, 20] by default. The lower bound keeps night dark:
     * exposed like day, a night sky would look like one. The day meters around 14, a sunset around 12, and twilight
     * follows down to 4, the sun 6° down, the end of civil twilight. Stopped earlier, the twilight sky would be exposed
     * so dark that a tone curve's toe changes its colors.
     */
    autoExposureRange: readonly [number, number];
    /**
     * The metered exposure's ramp over the day: compensations at sun altitudes, for mornings and evenings apart if
     * wanted. `DEFAULT_AUTO_EXPOSURE_KEYS` by default; empty for the meter's reading as it is.
     */
    autoExposureKeys: readonly AutoExposureKey[];
    /** Added to the metered exposure on top of the keys, in EV: +1 is twice as bright. */
    exposureCompensation: number;
    /** Device pixels per CSS pixel, `devicePixelRatio`, so the debug overlay keeps its size on screen. Default 1. */
    pixelRatio: number;
    /** The Sun's apparent angular diameter, in degrees, as `@himmelszelt/sternzeit`'s `sun.apparentAngularDiameter`
     *  returns it. About 0.53. */
    sunAngularDiameter: number;
}

/** A sky cube map's settings, fixed when its pass is made. */
export interface SkyCubeOptions {
    /** rgba16float, or rgba32float, which the sun disc needs, being far brighter than rgba16float holds. */
    format: "rgba16float" | "rgba32float";
    /** Rays per texel, spread over it by the R2 sequence, 1 by default: more smooth the edges a texel straddles, the
     *  horizon's and the sun disc's, and cost as many times the rays. 8 smooths them for a background or export. */
    samples?: number;
    /**
     * Spread the texels evenly over the sphere, as osgHimmel's `CubeMappedHimmel` did: sample it with
     * `dkCubeFromSphere(d)` from `wgsl.cube` rather than d, and make the irradiance pass with `cubified` too.
     */
    cubify?: boolean;
    /** Draw the sun disc into it, for exporting it as one image; off by default, to light a scene with. */
    sunDisc?: boolean;
    /**
     * Write the luminance times `SkyPass.skyViewScale` at the time of `encode`, rather than in cd/m²: a power of two
     * that follows the sun, so rgba16float holds the sky from noon into the night, where cd/m² fall below its normal
     * values in deep twilight. Divide by the same factor to read cd/m², and the irradiance and its coefficients from it
     * too. Off by default.
     */
    scaled?: boolean;
}

/**
 * A pass that writes the sky of its sky pass into a cube map: the luminance in cd/m², or times `skyViewScale` with
 * `scaled`, linear, neither exposed nor tone mapped, indexed by ENU directions, so a y-up engine samples it with (x, -z, y). It reads the sky pass' sky-view
 * table, so it follows its `update()`.
 */
export interface SkyCubePass {
    /**
     * Records the sky into the six faces of `target`: a square 2D texture with six layers, of the pass' format, with
     * `STORAGE_BINDING` usage. One with more than one mip level gets them all, each texel the mean of the four below
     * it, which reads the level above as a cube: it needs `TEXTURE_BINDING` usage too.
     */
    encode(encoder: GPUCommandEncoder, target: GPUTexture): void;
}

/** How a panorama lays the sphere out on one 2D texture, see `wgsl.panorama`. */
export type PanoramaProjection = "equirectangular" | "octahedral" | "fisheye";

/** A sky panorama's settings, fixed when its pass is made. */
export interface SkyPanoramaOptions {
    /**
     * Equirectangular, as HDRIs are shared: 2:1, the azimuth across, north at the left edge and south in the middle,
     * the zenith at the top and the nadir at the bottom. Octahedral: the whole sphere in a square, the zenith in the
     * middle. Fisheye: the upper hemisphere in the square's inscribed circle, as an all-sky camera sees it, the zenith
     * in the middle. Octahedral and fisheye are laid out as a sky chart held overhead: north up, east left.
     */
    projection: PanoramaProjection;
    /** rgba16float, or rgba32float, which the sun disc needs, being far brighter than rgba16float holds. */
    format: "rgba16float" | "rgba32float";
    /** Rays per texel, spread over it by the R2 sequence, 1 by default, as the cube pass' `samples`. */
    samples?: number;
    /** Draw the sun disc into it, for exporting it as one image; off by default, to light a scene with. */
    sunDisc?: boolean;
    /** Write the luminance times `SkyPass.skyViewScale`, as the cube pass' `scaled`. Off by default. */
    scaled?: boolean;
    /** Equirectangular only: the upper half, the horizon at the bottom, 4:1. Off by default. */
    upperHalf?: boolean;
    /**
     * Turns the panorama about the zenith, in degrees: the azimuth at the equirectangular's left edge and at the top of
     * the others, 0 by default, north. 180 puts north in the equirectangular's middle and at the bottom of the others.
     */
    azimuthOffset?: number;
}

/**
 * A pass that writes the sky of its sky pass into a panorama, as the cube pass does into a cube map: the luminance in
 * cd/m², or times `skyViewScale` with `scaled`, linear, neither exposed nor tone mapped. Alpha is the share of a texel
 * the projection covers: 1, but around the fisheye's circle and 0 beyond it, where every texel holds the ground's
 * color, as a cube map holds it at the nadir, so that lookups clamped or filtered there blend into it, not into black;
 * `dkFisheyeUv` sends every direction below the horizon there. It follows the sky pass' `update()`.
 */
export interface SkyPanoramaPass {
    /** Records the sky into mip level 0 of `target`, a 2D texture of any size, of the pass' format, with
     *  `STORAGE_BINDING` usage. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture): void;
}

/** The aerial perspective volume's shape, fixed when its sky pass is made. */
export interface AerialPerspectiveOptions {
    /** Froxels across and down the screen, 32 each by default, as Hillaire's. */
    width?: number;
    height?: number;
    /** Slices in depth, 32 by default. */
    depth?: number;
    /** How far the last slice reaches, in km, 32 by default. */
    maxDistanceKm?: number;
}

/**
 * Hillaire's aerial perspective volume: the air between the camera and the geometry in front of it, over the camera's
 * frustum, for fading and tinting distant terrain. Froxels follow the screen in x and y, top left first, and the
 * distance in z, slice k at `maxDistanceKm * ((k + 0.5) / depth) ** 2`. Look it up with `dkSampleAerialPerspective`
 * and apply it with `dkApplyAerialPerspective`, both from `wgsl.aerial`.
 */
export interface AerialPerspectiveVolume {
    /** The light the air adds at the four wavelengths, times `SkyPass.skyViewScale`, a 3D rgba16float texture. */
    readonly luminance: GPUTexture;
    /** The transmittance of the geometry's own light at the four wavelengths, a 3D rgba16float texture. */
    readonly transmittance: GPUTexture;
    readonly maxDistanceKm: number;
}

/**
 * A sky pass: a compute pass that writes every pixel of a target the caller owns, with no rasterization. It goes
 * first, as the background the moon, stars, clouds and the rest of the frame are drawn over. This package never
 * creates a device, a canvas, a context or a swap chain.
 */
export interface SkyPass {
    /**
     * The table the sky pass reads, rebuilt by `update()`, its values times `skyViewScale`. Exposed so it can be
     * inspected or exported; nothing in a normal render path needs it.
     */
    readonly skyViewTexture: GPUTexture;
    /**
     * What the sky-view table holds luminance in cd/m² multiplied by, and a cube map written with `scaled`: a power of
     * two that follows the sun, set by `update()`, so the table's values sit where half floats resolve them best.
     */
    readonly skyViewScale: number;
    /** The aerial perspective volume, rebuilt by `update()` whenever the camera, the sun or the observer moved; null
     *  unless the pass was made with `aerialPerspective`. */
    readonly aerialPerspective: AerialPerspectiveVolume | null;
    /**
     * Takes the parameters over, writes the uniforms, and, when the sun or the observer moved, rebuilds the sky-view
     * table and meters it, and the aerial perspective volume also when the camera moved: submitted on its own, or
     * recorded into `encoder` to go with the frame's own submission.
     * Above the atmosphere only the meter runs; the sky pass raymarches there and reads no table.
     */
    update(params: Partial<SkyParams>, encoder?: GPUCommandEncoder): void;
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
     * Makes a pass that writes this sky into a cube map, its pipelines compiled without blocking. Without the sun disc,
     * a cube map lights a scene, and shows behind it with the disc drawn over it by `dkSunDisc` from `wgsl.sun`.
     */
    createCubePass(options: SkyCubeOptions): Promise<SkyCubePass>;
    /** Makes a pass that writes this sky into a panorama, its pipeline compiled without blocking. */
    createPanoramaPass(options: SkyPanoramaOptions): Promise<SkyPanoramaPass>;
    /** Records the pass into `encoder`, writing all of `target`, which needs `STORAGE_BINDING` usage and the format
     *  the pass was created for. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture): void;
    destroy(): void;
}
