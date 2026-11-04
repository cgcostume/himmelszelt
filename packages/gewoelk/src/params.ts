/**
 * What the clouds are made of and lit by, as plain numbers: a cloudscape of low clouds in a voxel volume, up to two
 * sheets of high cloud, and the light. Lengths in km unless named otherwise, directions ENU (x east, y north, z up),
 * the sun's light in lux, luminance in cd/m².
 */

/** A thin layer of high cloud, read once where a ray crosses its sphere: cirrus, cirrostratus. */
export interface SheetParams {
    enabled: boolean;
    /** Height above the ground, in km: cirrus from 6 to 12. */
    altitudeKm: number;
    /** Optical depth straight through the sheet where its map reads 1: about 1 for cirrostratus, 0.3 for cirrus. */
    opticalDepth: number;
    /** How much of the sky the sheet covers, 0 to 1, and how hard its edges are, 0 soft to 1 hard. */
    coverage: number;
    sharpness: number;
    /** One tile of the map in km; the map repeats beyond it. */
    scaleKm: number;
    /** The wind the sheet drifts with, east and north, in m/s. */
    wind: readonly [number, number];
    /** How fast the shape changes, in map changes per hour; 0 keeps it. */
    evolution: number;
    seed: number;
    /** Octaves of noise and lattice cells of the first across a tile. */
    octaves: number;
    cells: number;
    albedo: number;
    /** The forward lobe's asymmetry, Henyey & Greenstein's g: 0.85 for ice. */
    forwardG: number;
    /** The sun's illuminance at the sheet's altitude, in lux, where it differs from the observer's: reddened at sunset,
     *  and still there when the ground lies in shadow. The frame's `sunIlluminance` otherwise. */
    sunIlluminance?: readonly [number, number, number];
}

/** The voxel volume the low clouds live in: a slab repeating east and north, modeled from the cloud map. */
export interface CloudscapeParams {
    enabled: boolean;
    /** The slab repeats every `extentKm` east and north, lies `baseKm` above the ground and is `heightKm` tall. */
    extentKm: number;
    baseKm: number;
    heightKm: number;
    coverage: number;
    sharpness: number;
    /** The share of the height the bottoms dip below the base level, 0 to 0.9: a quarter keeps them flat. */
    offset: number;
    wind: readonly [number, number];
    evolution: number;
    seed: number;
    octaves: number;
    cells: number;
    /** Extinction per km of full density, 20 to 100 for water clouds, and the single scattering albedo, near 1. */
    extinction: number;
    albedo: number;
    /** One tile of the detail noise, in km. */
    noiseScaleKm: number;
    /** How far inside a cloud the dimensional profile reaches 1, and how far outside the distance field reaches. */
    profileDepthKm: number;
    sdfRangeKm: number;
    /** The smallest step inside a cloud, in km, and the growth of steps with the square root of the distance. */
    stepMinKm: number;
    stepGrowth: number;
    /** The phase function's forward lobe, Nubis3's inner glow's lobe, and each further order of scattering's share of
     *  the one before, 0 for single scattering alone: the octaves of Wrenninge and Hillaire. */
    forwardG: number;
    secondaryG: number;
    multiScatter: number;
    /** How far the detail noise erodes the profile: 0 leaves the voxels' shape, 1 is Nubis3's full erosion. */
    detail: number;
    /** The sun's illuminance at the clouds' altitude, in lux, where it differs from the observer's: from below
     *  around sunset, lighting their undersides. The frame's `sunIlluminance` otherwise. */
    sunIlluminance?: readonly [number, number, number];
}

/** Everything that may change per frame. */
export interface CloudParams {
    /** Unit vector towards the sun in the observer's ENU frame, as `@himmelszelt/sternzeit`'s `sun.direction`. */
    sunDirection: readonly [number, number, number];
    /** The sun's illuminance at the observer, per channel in lux, as `SkyPass.sunIlluminance()` of
     *  `@himmelszelt/dunstkreis` gives it; a layer with a `sunIlluminance` of its own takes that instead. */
    sunIlluminance: readonly [number, number, number];
    /** The sky's luminance along the horizon, in cd/m²: what far clouds fade into. */
    horizonLuminance: readonly [number, number, number];
    /** The sky's irradiance on a surface facing up and the lit ground's on one facing down, in lux. */
    skyIrradiance: readonly [number, number, number];
    groundIrradiance: readonly [number, number, number];
    observerHeightM: number;
    /** As `@himmelszelt/dunstkreis`' sky pass takes them: the clouds then sit on the same rays as the sky. */
    inverseViewProjection: Float32Array;
    projectionDistance: number;
    /** Exposure in EV100, applied when the pass composes; the cloud layer itself stays in cd/m². */
    ev100: number;
    /** Seconds, for the wind's drift and the evolution: any epoch, the same every frame. */
    timeS: number;
    /** The distance at which a cloud has faded to 1/e into the sky behind it, in km: the air in between. */
    horizonFadeKm: number;
    planetRadiusKm: number;
    /** How far the first step is jittered, 0 to 1 step, against banding. */
    jitter: number;
    cloudscape: CloudscapeParams;
    /** Up to two. */
    sheets: readonly SheetParams[];
}

export const DEFAULT_CLOUDSCAPE: CloudscapeParams = {
    enabled: true,
    extentKm: 16,
    baseKm: 1.2,
    heightKm: 2.4,
    coverage: 0.42,
    sharpness: 0.35,
    offset: 0.25,
    wind: [8, 2],
    evolution: 0,
    seed: 7,
    octaves: 5,
    cells: 4,
    extinction: 32,
    albedo: 0.97,
    noiseScaleKm: 0.6,
    profileDepthKm: 0.15,
    sdfRangeKm: 2,
    stepMinKm: 0.015,
    stepGrowth: 0.01,
    forwardG: 0.8,
    secondaryG: 0.2,
    multiScatter: 0.7,
    detail: 0.55,
};

export const DEFAULT_SHEET: SheetParams = {
    enabled: true,
    altitudeKm: 9,
    opticalDepth: 0.5,
    coverage: 0.35,
    sharpness: 0.4,
    scaleKm: 40,
    wind: [25, 5],
    evolution: 0,
    seed: 3,
    octaves: 5,
    cells: 4,
    albedo: 0.9,
    forwardG: 0.85,
};

export const DEFAULT_CLOUD_PARAMS: CloudParams = {
    sunDirection: [0, 0.5, 0.866],
    sunIlluminance: [100_000, 100_000, 100_000],
    skyIrradiance: [15_000, 18_000, 25_000],
    horizonLuminance: [5_000, 5_500, 7_000],
    groundIrradiance: [8_000, 8_000, 8_000],
    observerHeightM: 1,
    inverseViewProjection: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    projectionDistance: 0,
    ev100: 14,
    timeS: 0,
    horizonFadeKm: 60,
    planetRadiusKm: 6360,
    jitter: 1,
    cloudscape: DEFAULT_CLOUDSCAPE,
    sheets: [DEFAULT_SHEET],
};

/** The map's evolution coordinate loops at this value: `evolution * hours` wraps by it. */
export const EVOLUTION_PERIOD = 8;

/** Byte sizes of the uniform structs in params.wgsl. */
export const PARAMS_SIZE = 384;
export const CLOUDSCAPE_SIZE = 96;
export const SHEET_SIZE = 64;
export const MODEL_SIZE = 32;
const CLOUDSCAPE_OFFSET = 160;
const SHEETS_OFFSET = 256;
export const MAX_SHEETS = 2;

const wrap = (value: number, period: number) => ((value % period) + period) % period;

/** Where a layer's map has drifted to with its wind by `timeS`, in km, wrapped by the map's tile. */
export function drift(wind: readonly [number, number], timeS: number, tileKm: number): [number, number] {
    return [wrap((wind[0] * timeS) / 1000, tileKm), wrap((wind[1] * timeS) / 1000, tileKm)];
}

/** The map's third coordinate at `timeS` for a layer evolving at `evolution` changes per hour. */
export const evolutionAt = (evolution: number, timeS: number) => wrap((evolution * timeS) / 3600, EVOLUTION_PERIOD);

/** `GwModel` packed, for the cloud map of `layer`: the cloudscape's or a sheet's shaping. */
export function modelData(
    layer: number,
    model: { coverage: number; sharpness: number; seed: number; octaves: number; cells: number },
    evolution: number,
    offset = 0,
): ArrayBuffer {
    const buffer = new ArrayBuffer(MODEL_SIZE);
    const f = new Float32Array(buffer);
    const u = new Uint32Array(buffer);
    f.set([model.coverage, model.sharpness, offset, evolution], 0);
    u.set([model.seed >>> 0, model.octaves, layer, model.cells], 4);
    return buffer;
}

type Rgb = readonly [number, number, number];

/** `GwCloudscape` packed, at `timeS`, lit by `sun` unless it has a sun of its own. */
export function cloudscapeData(c: CloudscapeParams, timeS: number, sun: Rgb): ArrayBuffer {
    const buffer = new ArrayBuffer(CLOUDSCAPE_SIZE);
    const f = new Float32Array(buffer);
    const u = new Uint32Array(buffer);
    f.set(drift(c.wind, timeS, c.extentKm), 0);
    f.set([c.extentKm, c.baseKm, c.heightKm, c.extinction, c.albedo, c.noiseScaleKm, c.profileDepthKm], 2);
    f.set([c.sdfRangeKm, c.stepMinKm, c.stepGrowth, c.forwardG, c.secondaryG, c.multiScatter], 9);
    u[15] = c.enabled ? 1 : 0;
    f[16] = c.detail;
    f.set(c.sunIlluminance ?? sun, 20);
    return buffer;
}

/** `GwSheet` packed, at `timeS`, lit by `sun` unless it has a sun of its own. */
export function sheetData(s: SheetParams, timeS: number, sun: Rgb): ArrayBuffer {
    const buffer = new ArrayBuffer(SHEET_SIZE);
    const f = new Float32Array(buffer);
    const u = new Uint32Array(buffer);
    f.set([s.altitudeKm, s.opticalDepth, s.coverage, s.sharpness], 0);
    f.set(drift(s.wind, timeS, s.scaleKm), 4);
    f.set([s.scaleKm, evolutionAt(s.evolution, timeS), s.albedo, s.forwardG], 6);
    u.set([s.enabled ? 1 : 0, s.seed >>> 0], 10);
    f.set(s.sunIlluminance ?? sun, 12);
    return buffer;
}

/** `GwParams` packed: `exposure` is 1 / (1.2 · 2^EV100), `frame` animates the jitter. */
export function paramsData(p: CloudParams, frame: number): ArrayBuffer {
    const buffer = new ArrayBuffer(PARAMS_SIZE);
    const f = new Float32Array(buffer);
    const u = new Uint32Array(buffer);
    f.set([...p.sunDirection, p.observerHeightM / 1000], 0);
    f.set(p.inverseViewProjection, 4);
    f.set([...p.sunIlluminance, p.projectionDistance], 20);
    f.set([...p.skyIrradiance, p.planetRadiusKm], 24);
    f.set([...p.groundIrradiance, 1 / (1.2 * 2 ** p.ev100)], 28);
    f.set([p.horizonFadeKm, p.jitter], 32);
    u.set([frame >>> 0, Math.min(p.sheets.length, MAX_SHEETS)], 34);
    f.set(p.horizonLuminance, 36);
    const cloudscape = cloudscapeData(p.cloudscape, p.timeS, p.sunIlluminance);
    new Uint8Array(buffer, CLOUDSCAPE_OFFSET).set(new Uint8Array(cloudscape));
    p.sheets.slice(0, MAX_SHEETS).forEach((sheet, i) => {
        const data = sheetData(sheet, p.timeS, p.sunIlluminance);
        new Uint8Array(buffer, SHEETS_OFFSET + i * SHEET_SIZE).set(new Uint8Array(data));
    });
    return buffer;
}
