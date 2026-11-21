import type { WhiteBalance } from "@himmelszelt/helldunkel";
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
    /** Towards the Moon, its true direction like `sunDirection`, for a sky pass made with `moonlight`. */
    moonDirection: readonly [number, number, number];
    /**
     * The Moon's illuminance above the air, in lux, for a sky pass made with `moonlight`: some 0.3 at full Moon, as
     * `@himmelszelt/nachtgestirn`'s `moonIlluminance` gives it. The sky by moonlight is the sky by day at that share
     * of the Sun's light, from the Moon's direction. 0 by default, none.
     */
    moonIlluminance: number;
    /** The Moon's apparent angular diameter, in degrees: its disc at `moonDirection` hides the sun disc behind it, a
     *  solar eclipse; the sky's light stays as it is. 0 by default, no Moon in the way. */
    moonAngularDiameter: number;
    /**
     * What the debug overlay is drawn in, for a sky pass made with `debugGrid`: 1 by default, white after the tone
     * curve. Without one the pass writes light the renderer exposes itself, and the grid shows white where this is the
     * luminance it exposes as white, 1.2 × 2^EV100 for the pass' `ev100` of -log2(1.2), which writes cd/m².
     */
    gridInk: number;
    /**
     * The luminance in cd/m² the sun disc stops at, its color kept; null by default, none, the disc at its 1.6 billion
     * cd/m². For a pass made with `toneMap` off whose light a later pass exposes: every pixel of the disc's edge is
     * far above white there, however little of it the disc covers, and the edge comes out hard. A ceiling of about
     * twice the luminance that pass shows as white, 2 × 1.2 × 2^EV100, keeps it smooth. The light above it is lost,
     * so leave it off where a bloom or a meter reads the disc.
     */
    sunDiscCeiling: number | null;
    /**
     * A white balance, helldunkel's `whiteBalance(white)`: a 3x3 matrix over linear sRGB, column-major, applied wherever
     * the exposure is, before it, to the sky, the sun disc and the air the aerial perspective pass adds; not to a cube
     * map, which holds cd/m². `NO_WHITE_BALANCE` by default, the identity, D65 as it is.
     */
    whiteBalance: WhiteBalance;
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
     * `rbCubeFromSphere(d)` from `wgsl.cube` rather than d, and make the irradiance pass with `cubified` too.
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

/** The aerial perspective volume's shape, fixed when its sky pass is made. */
export interface AerialPerspectiveOptions {
    /** Froxels across and down the screen, 32 each by default, as Hillaire's. */
    width?: number;
    height?: number;
    /** Slices in depth, 32 by default. */
    depth?: number;
    /**
     * How far the last slice reaches, in km, 32 by default: as far as the geometry does, since a point beyond takes the
     * last slice's air. The slices lie at the square of their number, so a longer reach keeps the near ones thin, and
     * costs no more. Kept as a half float holds it, up to 65504.
     */
    maxDistanceKm?: number;
}

/**
 * Hillaire's aerial perspective volume: the air between the camera and the geometry in front of it, over the camera's
 * frustum, for fading and tinting distant terrain, clouds, anything inside the atmosphere. Froxels follow the screen in
 * x and y, top left first, and the distance in z, slice k at `maxDistanceKm * ((k + 0.5) / depth) ** 2`. In linear
 * sRGB, and it describes itself, so a shader needs the two textures and a linear, clamping sampler, and nothing else of
 * dunstkreis: `dkAerialPerspective` from `wgsl.aerial` looks it up, in a fragment or a compute shader.
 */
export interface AerialPerspectiveVolume {
    /** The light the air adds: rgb times 2^alpha is cd/m², the exponent the same in every froxel and set by `update()`,
     *  so half floats hold noon and a moonlit night alike. A 3D rgba16float texture. */
    readonly luminance: GPUTexture;
    /** What the air lets through of the geometry's own light, per channel, and in alpha `maxDistanceKm`. A 3D
     *  rgba16float texture. */
    readonly transmittance: GPUTexture;
    readonly maxDistanceKm: number;
}

/** A pass that lays the air over a rendered scene, its settings fixed when it is made. */
export interface AerialPerspectivePassOptions {
    /** Format of the target the pass writes, linear light, with `STORAGE_BINDING` usage. */
    format: "rgba16float" | "rgba32float";
    /** The depth the scene's depth buffer was cleared to, 1 by default, 0 for a reversed one: where it still stands,
     *  nothing was drawn, and the sky behind stays as it is. */
    clearDepth?: number;
    /** Meters per unit of the scene, the space `inverseViewProjection` projects from; 1 by default. */
    metersPerUnit?: number;
}

/** A rendered scene: its color with the sky behind it, linear and exposed as the sky pass exposes its own, in cd/m² for
 *  a sky pass with `toneMap` off and an `ev100` of -log2(1.2), and its depth buffer. Both of the target's size, with
 *  `TEXTURE_BINDING` usage, not multisampled. */
export interface AerialPerspectiveScene {
    color: GPUTexture;
    depth: GPUTexture;
}

/**
 * A pass that lays the aerial perspective over a rendered scene, for a renderer that would rather not touch its
 * shaders: every pixel of the scene seen through the air in front of it, as far away as its depth says, by the sky
 * pass' camera and exposure. It reads the sky pass' volume, so it follows its `update()`.
 */
export interface AerialPerspectivePass {
    /** Records the pass into `encoder`, writing all of `target`. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture, scene: AerialPerspectiveScene): void;
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
    /** The aerial perspective volume, rebuilt by `update()` whenever the camera, the Sun, the Moon or the observer
     *  moved; null unless the pass was made with `aerialPerspective`. */
    readonly aerialPerspective: AerialPerspectiveVolume | null;
    /**
     * The light meter's buffer, for a pass of your own that reads the light on the GPU in the same frame, without a round
     * trip: at byte 0 log2 of the sky's mean luminance (f32), at 16 the Sun's illuminance at the observer and at 32 the
     * Moon's, in lux per channel of linear sRGB (vec3f each), at 48 the sky's irradiance on the ground at the model's
     * four wavelengths (vec4f, `dkToRgb` from `wgsl.atmosphere` turns it into lux), with `groundLight`. Written by
     * `update()` whenever the table is rebuilt. Bind it as read-only storage.
     */
    readonly lightBuffer: GPUBuffer;
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
     * its apparent direction (`apparentDirection`), next to the sky's diffuse light from the cube map.
     */
    sunIlluminance(): Promise<[number, number, number]>;
    /**
     * The Moon's illuminance at the observer, the same way, with `moonlight` on: `moonIlluminance` through the air along
     * `moonDirection`, sunlight's color, zero without. For lighting a night scene by the Moon as a directional light,
     * from where it shows (`apparentDirection`), next to the moonlit sky in the cube map.
     */
    moonIlluminance(): Promise<[number, number, number]>;
    /**
     * The sky's irradiance on the ground, a surface facing up, per channel in lux, read back from the GPU: the sky alone,
     * without the Sun, gathered from the table with `groundLight`, zero without. For a scene's diffuse light without a
     * cube map, or clouds lit from above.
     */
    skyIrradiance(): Promise<[number, number, number]>;
    /**
     * Makes a pass that writes this sky into a cube map, its pipelines compiled without blocking. Without the sun disc,
     * a cube map lights a scene, and shows behind it with the disc drawn over it by `dkSunDisc` from `wgsl.sun`. `@himmelszelt/rundbild` lights a scene by it and lays it out as a panorama.
     */
    createCubePass(options: SkyCubeOptions): Promise<SkyCubePass>;
    /**
     * Makes a pass that lays this sky's aerial perspective over a rendered scene, by its color and depth buffers, its
     * pipeline compiled without blocking. For a sky pass made with `aerialPerspective`. A renderer that shades its
     * geometry itself reads the volume in its own shader instead, with `dkAerialPerspective` from `wgsl.aerial`.
     */
    createAerialPerspectivePass(options: AerialPerspectivePassOptions): Promise<AerialPerspectivePass>;
    /** Records the pass into `encoder`, writing all of `target`, which needs `STORAGE_BINDING` usage and the format
     *  the pass was created for. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture): void;
    destroy(): void;
}
