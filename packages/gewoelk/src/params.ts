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
    /** The widest fibers' width across the wind, in km, eight times as long along it, thinner by thirds twice, and
     *  how far they erode the map's patches into strands: 0 leaves the patches, 1 leaves strands alone. */
    fiberKm: number;
    detail: number;
    /** How far ripples across the wind break the sheet into the waves of cirrocumulus, 0 to 1, none by default. */
    ripples?: number;
    /** The noise the sheet is made of, `DEFAULT_SHEET_NOISE` where left out. */
    noise?: Partial<SheetNoise>;
}

/** The layers of noise a sheet is made of, from broad to fine. Sizes in km. */
export interface SheetNoise {
    /** How far the strands sweep along a broad flow, some 15 km across, and curl into hooks, some 3 km: 1 as made. */
    sweep: number;
    hook: number;
    /** How strongly the strands gather into bundles, 0 to 1, and a bundle's width across the wind. */
    bundles: number;
    bundleKm: number;
    /** The fibers' sharpness, the power their ridges are raised to, and how many times as long as wide they start. */
    fiberPower: number;
    fiberStretch: number;
    /** How far flocks of turbulence break the sheet, 0 to 1, and a flock's size. */
    flocks: number;
    flockKm: number;
    /** How far a fine grain, four turned octaves of gradient noise, roughens it, 0 to 1, keeping its density on
     *  average, and the grain's coarsest size. */
    grain: number;
    grainKm: number;
    /** How far it is denser and thinner by turns over a broad field, 0 to 1, and that field's size. */
    broad: number;
    broadKm: number;
}

export const DEFAULT_SHEET_NOISE: SheetNoise = {
    sweep: 1,
    hook: 1,
    bundles: 0.5,
    bundleKm: 3,
    fiberPower: 4,
    fiberStretch: 10,
    flocks: 0.15,
    flockKm: 0.15,
    grain: 0.5,
    grainKm: 0.1,
    broad: 0.4,
    broadKm: 12,
};

/** The voxel volume the low clouds live in: a slab repeating east and north, modeled from the cloud map. */
export interface CloudscapeParams {
    enabled: boolean;
    /** The slab repeats every `extentKm` east and north, lies `baseKm` above the ground and is `heightKm` tall, its ordinary clouds' layer. */
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
    /** How far inside a cloud the dimensional profile reaches 1, and how far outside the distance field reaches, at most
     *  a quarter of the extent. */
    profileDepthKm: number;
    sdfRangeKm: number;
    /** The smallest step inside a cloud, in km, and the growth of steps with the square root of the distance. */
    stepMinKm: number;
    stepGrowth: number;
    /** The phase function's forward and backward lobes, four parts to one, and each further order of scattering's share
     *  of the one before, 0 for single scattering alone: the octaves of Wrenninge and Hillaire, each through
     *  max(0.5, multiScatter) of the depth of the one before, so they keep energy. */
    forwardG: number;
    backwardG: number;
    multiScatter: number;
    /** How far the detail noise erodes the profile: 0 leaves the voxels' shape, 1 is Nubis3's full erosion. */
    detail: number;
    /** Where the clouds have cleared away, in km over the ground from the observer: a clear horizon, under which a low
     *  sun lights them. 0 lets them reach the horizon. Within `clearingFromKm` they are all there, half of
     *  `clearingKm` by default; beyond, they grow fewer steadily towards it. */
    clearingKm?: number;
    clearingFromKm?: number;
    /** How much of the cloudscape grows into towers that rise through the slab and spread at the top, 0 to 1, and how
     *  deep billows heap up its surface, as a share of its height, each about `billowKm` across: 0 keeps the map's
     *  smooth mounds. */
    towers?: number;
    billows?: number;
    billowKm?: number;
    /** How many times taller than `heightKm` the towers may grow, 1 to 4: the slab grows with them, its voxels coarser. */
    towerScale?: number;
    /** How far a broad field of noise thins the clouds out in places, 0 to 1, and its size in km: the volume repeats
     *  every `extentKm`, the gaps the field leaves do not, so the repetition hides towards the horizon. It wanes as
     *  the coverage rises past a half and is gone at full coverage, which stays a closed deck. */
    variation?: number;
    variationKm?: number;
    /** How much larger the clouds are, every length of them but the base's height: 1 as given. Their extinction
     *  falls by as much, so a cloud as a whole lets as much light through. */
    size?: number;
}

/** The slab's height, in km: the ordinary clouds' layer, times the towers' scale. Of a cloudscape already sized. */
export const slabHeightKm = (c: CloudscapeParams) => c.heightKm * Math.max(1, c.towerScale ?? 1);

/** The cloudscape with every length of its clouds times its `size`, its base and the distances in sight kept, and
 *  its extinction divided by it, so each cloud lets as much light through as before. */
export function sizedCloudscape(c: CloudscapeParams): CloudscapeParams {
    const s = c.size ?? 1;
    if (s === 1) return c;
    return {
        ...c,
        size: 1,
        extentKm: c.extentKm * s,
        heightKm: c.heightKm * s,
        noiseScaleKm: c.noiseScaleKm * s,
        profileDepthKm: c.profileDepthKm * s,
        sdfRangeKm: c.sdfRangeKm * s,
        stepMinKm: c.stepMinKm * s,
        billowKm: (c.billowKm ?? 0.5) * s,
        extinction: c.extinction / s,
    };
}

type Rgb = readonly [number, number, number];

/** Everything that may change per frame. */
export interface CloudParams {
    /** Unit vector towards the sun in the observer's ENU frame, as `@himmelszelt/sternzeit`'s `sun.direction`. */
    sunDirection: readonly [number, number, number];
    /** The sun's illuminance at the observer, per channel in lux, as `SkyPass.sunIlluminance()` of
     *  `@himmelszelt/dunstkreis` gives it: what lights the clouds without a `sunlight` table. */
    sunIlluminance: Rgb;
    /** The sun's illuminance aloft, in lux, at the altitudes and elevations `sunlightRows` names, row after row,
     *  `SUNLIGHT_ENTRIES` each: clouds far towards the sun stay lit after the near ones, reddened, and the planet's
     *  shadow climbs them at dusk. Without it, `sunIlluminance` where the sun clears the horizon, cut off beyond. */
    sunlight?: readonly Rgb[];
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
    backwardG: -0.15,
    multiScatter: 0.7,
    detail: 0.55,
    towers: 0.3,
    billows: 0.12,
    billowKm: 0.5,
};

export const DEFAULT_SHEET: SheetParams = {
    enabled: true,
    altitudeKm: 9,
    opticalDepth: 0.5,
    coverage: 0.35,
    sharpness: 0.2,
    scaleKm: 120,
    wind: [25, 5],
    evolution: 0,
    seed: 3,
    octaves: 5,
    cells: 4,
    albedo: 1,
    forwardG: 0.85,
    fiberKm: 0.6,
    detail: 0.7,
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
export const PARAMS_SIZE = 528;
export const SUNLIGHT_SIZE = 64 + 128 * 16;
export const CLOUDSCAPE_SIZE = 112;
export const SHEET_SIZE = 128;
export const MODEL_SIZE = 48;
const CLOUDSCAPE_OFFSET = 160;
/** Where the cloudscape's `aerial` lies in `GwParams`, which the pass writes when it encodes. */
export const AERIAL_OFFSET = CLOUDSCAPE_OFFSET + 88;
const SHEETS_OFFSET = 272;
export const MAX_SHEETS = 2;

const wrap = (value: number, period: number) => ((value % period) + period) % period;

/** Where the drift wraps, in km: far beyond any tile, so the noises of other periods never jump, and still within
 *  what 32-bit floats resolve to a meter. At 8 m/s it wraps once in twelve days. */
export const DRIFT_PERIOD_KM = 8192;

/** Where a layer has drifted to with its wind by `timeS`, in km, wrapped by `DRIFT_PERIOD_KM`. */
export function drift(wind: readonly [number, number], timeS: number): [number, number] {
    return [wrap((wind[0] * timeS) / 1000, DRIFT_PERIOD_KM), wrap((wind[1] * timeS) / 1000, DRIFT_PERIOD_KM)];
}

/** The map's third coordinate at `timeS` for a layer evolving at `evolution` changes per hour. */
export const evolutionAt = (evolution: number, timeS: number) => wrap((evolution * timeS) / 3600, EVOLUTION_PERIOD);

/** `GwModel` packed, for the cloud map of `layer`: the cloudscape's or a sheet's shaping. */
export function modelData(
    layer: number,
    model: { coverage: number; sharpness: number; seed: number; octaves: number; cells: number },
    evolution: number,
    offset = 0,
    growth: { towers: number; billows: number; billowCells: number; towerScale?: number } = {
        towers: 0,
        billows: 0,
        billowCells: 1,
    },
): ArrayBuffer {
    const buffer = new ArrayBuffer(MODEL_SIZE);
    const f = new Float32Array(buffer);
    const u = new Uint32Array(buffer);
    f.set([model.coverage, model.sharpness, offset, evolution], 0);
    u.set([model.seed >>> 0, model.octaves, layer, model.cells], 4);
    f.set([growth.towers, growth.billows], 8);
    u[10] = growth.billowCells;
    f[11] = growth.towerScale ?? 1;
    return buffer;
}

/** Entries per row of the sunlight table, evenly over the row's elevations. */
export const SUNLIGHT_ENTRIES = 32;

/** A row of the sunlight table: an altitude, and the sun's elevations above the local horizon it runs over. */
export interface SunlightRow {
    altitudeKm: number;
    fromRad: number;
    toRad: number;
}

/**
 * Where the clouds want the sun's illuminance: four rows, the cloudscape's base and top and each sheet's altitude,
 * over the elevations the sun has above the horizon of anything at that altitude in sight. It stands higher over a
 * cloud towards it, by the angle the planet curves through in between.
 */
export function sunlightRows(p: CloudParams): SunlightRow[] {
    const r = p.planetRadiusKm;
    const elevation = Math.asin(Math.max(-1, Math.min(1, p.sunDirection[2])));
    const observer = Math.sqrt(2 * r * Math.max(p.observerHeightM / 1000, 0));
    const row = (altitudeKm: number, farKm = altitudeKm): SunlightRow => {
        const reach = (observer + Math.sqrt(2 * r * Math.max(farKm, 0.01))) / r;
        const fromRad = Math.max(-Math.PI / 2, elevation - reach);
        return { altitudeKm, fromRad, toRad: Math.min(Math.PI / 2, elevation + reach) };
    };
    const sized = sizedCloudscape(p.cloudscape);
    const top = sized.baseKm + slabHeightKm(sized);
    const sheet = (i: number) => p.sheets[i]?.altitudeKm ?? top;
    return [row(sized.baseKm, top), row(top), row(sheet(0)), row(sheet(1))];
}

/** The sun's illuminance without a table: the observer's, where the sun clears the horizon at that altitude. */
function sunCleared(sun: Rgb, row: SunlightRow, elevation: number, planetRadiusKm: number): Rgb {
    const dip = -Math.acos(planetRadiusKm / (planetRadiusKm + Math.max(row.altitudeKm, 0)));
    const disc = 0.0047;
    const t = Math.max(0, Math.min(1, (elevation - dip + disc) / (2 * disc)));
    const seen = t * t * (3 - 2 * t);
    return [sun[0] * seen, sun[1] * seen, sun[2] * seen];
}

/** `GwSunlight` packed: the rows' elevations and the table, `p.sunlight` or the observer's sun cut off by horizons. */
export function sunlightData(p: CloudParams): ArrayBuffer {
    const buffer = new ArrayBuffer(SUNLIGHT_SIZE);
    const f = new Float32Array(buffer);
    sunlightRows(p).forEach((row, i) => {
        f.set([row.fromRad, row.toRad], i * 4);
        for (let k = 0; k < SUNLIGHT_ENTRIES; k++) {
            const at = i * SUNLIGHT_ENTRIES + k;
            const elevation = row.fromRad + ((row.toRad - row.fromRad) * k) / (SUNLIGHT_ENTRIES - 1);
            const rgb = p.sunlight?.[at] ?? sunCleared(p.sunIlluminance, row, elevation, p.planetRadiusKm);
            f.set(rgb, 16 + at * 4);
        }
    });
    return buffer;
}

/** `GwCloudscape` packed, at `timeS`, its light grid's slices over `lightElevations` radians. */
export function cloudscapeData(
    cloudscape: CloudscapeParams,
    timeS: number,
    lightElevations: readonly [number, number],
): ArrayBuffer {
    const c = sizedCloudscape(cloudscape);
    const buffer = new ArrayBuffer(CLOUDSCAPE_SIZE);
    const f = new Float32Array(buffer);
    const u = new Uint32Array(buffer);
    f.set(drift(c.wind, timeS), 0);
    f.set([c.extentKm, c.baseKm, slabHeightKm(c), c.extinction, c.albedo, c.noiseScaleKm, c.profileDepthKm], 2);
    f.set([c.sdfRangeKm, c.stepMinKm, c.stepGrowth, c.forwardG, c.backwardG, c.multiScatter], 9);
    u[15] = c.enabled ? 1 : 0;
    f[16] = c.detail;
    f.set(lightElevations, 18);
    const clearing = c.clearingKm ?? 0;
    f.set([clearing, Math.min(c.clearingFromKm ?? clearing / 2, clearing)], 20);
    // Less as the coverage closes the sky: a full deck stays full.
    const variation = (c.variation ?? 0) * Math.min(1, 2 * (1 - c.coverage));
    f.set([Math.max(0, variation), c.variationKm ?? 40, c.offset, Math.max(1, c.towerScale ?? 1)], 24);
    return buffer;
}

/** `GwSheet` packed, at `timeS`. */
export function sheetData(s: SheetParams, timeS: number): ArrayBuffer {
    const buffer = new ArrayBuffer(SHEET_SIZE);
    const f = new Float32Array(buffer);
    const u = new Uint32Array(buffer);
    f.set([s.altitudeKm, s.opticalDepth, s.coverage, s.sharpness], 0);
    f.set(drift(s.wind, timeS), 4);
    f.set([s.scaleKm, evolutionAt(s.evolution, timeS), s.albedo, s.forwardG], 6);
    u.set([s.enabled ? 1 : 0, s.seed >>> 0], 10);
    const speed = Math.hypot(s.wind[0], s.wind[1]);
    f.set(
        [speed > 0 ? s.wind[0] / speed : 1, speed > 0 ? s.wind[1] / speed : 0, s.fiberKm, s.detail, s.ripples ?? 0],
        12,
    );
    const k = { ...DEFAULT_SHEET_NOISE, ...s.noise };
    f.set([k.sweep, k.hook, k.bundles, k.bundleKm, k.fiberPower, k.fiberStretch, k.flocks, k.flockKm], 17);
    f.set([k.grain, k.grainKm, k.broad, k.broadKm], 25);
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
    const { fromRad, toRad } = sunlightRows(p)[0] as SunlightRow;
    const cloudscape = cloudscapeData(p.cloudscape, p.timeS, [fromRad, toRad]);
    new Uint8Array(buffer, CLOUDSCAPE_OFFSET).set(new Uint8Array(cloudscape));
    p.sheets.slice(0, MAX_SHEETS).forEach((sheet, i) => {
        const data = sheetData(sheet, p.timeS);
        new Uint8Array(buffer, SHEETS_OFFSET + i * SHEET_SIZE).set(new Uint8Array(data));
    });
    return buffer;
}
