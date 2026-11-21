/**
 * The layered model's sky as plain numbers: three layers of cloud marched together with no volume built first, low
 * heaps or a deck, deep towers or a front, and a middle layer, under a sheet of high cloud read from a baked map.
 * Lengths in km, angles in degrees. Every kind of cloud has presets, `CLOUD_TYPES`, and a sky names one for each of
 * its four places, see `Weather`.
 */

/** A layer of cloud from `baseKm` up, shaped by a map of its own: scattered heaps or a closed deck, by its coverage. */
export interface CloudLayer {
    /** How much of the sky the layer's clouds cover, 0 to 1: at 0 there is none, so a layer blends in and out. */
    coverage: number;
    baseKm: number;
    /** How deep the layer is: its tallest clouds. */
    depthKm: number;
    /** A cloud's size across, and one tile of the layer's map, which repeats beyond it. */
    sizeKm: number;
    tileKm: number;
    /** Extinction per km at full density. */
    extinction: number;
    /** How far the detail noise's billows heap the surface out, 0 to 1. */
    detail: number;
    /** How hard the map's edges are, 0 to 1. */
    sharpness: number;
    /** How deep the cells on top cut, 0 to 1: the turrets of a heap or a tower, the pillows of a deck. */
    lumps: number;
    /** How far the flanks bulge in and out as they rise, 0 to 1. */
    bulge: number;
}

/** The deep layer: towers with anvils, tiled like the others, or a front, placed in the world and not repeated. */
export interface DeepLayer extends CloudLayer {
    kind: "towers" | "front";
    /** How far the anvils of tall towers stretch downwind, in towers' spacings. */
    anvil: number;
    /** A front's leading edge along its bearing, negative once it has passed overhead, and how far back it reaches. */
    frontKm: number;
    frontDepthKm: number;
    /** Where the front stands, from north through east. */
    frontBearing: number;
}

/** The sheet of high cloud: patches and bands of puffs, ripples, ribs and veil, baked into one map and read once. */
export interface HighSheet {
    /** How much of the sky the sheet's patches and bands cover, 0 to 1: at 0 there is none. */
    coverage: number;
    altitudeKm: number;
    /** The optical depth straight through the sheet where its map reads 1. */
    opticalDepth: number;
    /** One tile of the map, which repeats beyond it: larger tiles, coarser texels. */
    tileKm: number;
    /** A patch's size across, how many times as long as wide it is, a band, and the bands' angle to the wind. */
    patchKm: number;
    bandStretch: number;
    bandAngle: number;
    /** How far a patch thins out towards its edge, where the puffs shrink, 0 to 1. */
    edge: number;
    /** How much of the sheet is puffs, the cells of cirrocumulus and altocumulus, and a puff's size across the wind. */
    puffs: number;
    puffKm: number;
    /** How many times as long along the wind as across the puffs are, and how regular they stand, 0 scattered to 1 in rows. */
    elongation: number;
    rows: number;
    /** How far lumps and a fine grain break each puff, and how far it fades out past its rim, 0 a hard edge. */
    grain: number;
    softness: number;
    /** How deep billows eat into the puffs from their rims, read per pixel, and the largest billows' size. */
    billows: number;
    billowKm: number;
    /** How far lanes of sky across the wind cut the puffs into rows, from crest to crest `rippleKm`, and how far the rows bend. */
    ripples: number;
    rippleKm: number;
    curve: number;
    /** How far billows across a band break it into ribs, each with a sharp front and a tail, and the ribs' spacing. */
    ribs: number;
    ribKm: number;
    /** How much of the sheet is a veil without puffs, how far it is drawn into fine lines along the wind, and how many times as long as wide those are. */
    veil: number;
    striation: number;
    stretch: number;
    /** Steps of combing along the wind, each letting what lies upwind trail a little farther, how slowly a trail fades and how far it bends off the wind. */
    combing: number;
    trails: number;
    trailBend: number;
    /** How far a puff's sunward neighbors shade it, and the forward lobe's asymmetry, Henyey and Greenstein's g. */
    relief: number;
    forwardG: number;
}

/** A sky of the layered model, every number set. */
export interface LayeredSky {
    low: CloudLayer;
    deep: DeepLayer;
    middle: CloudLayer;
    high: HighSheet;
}

export const DEFAULT_LOW_LAYER: CloudLayer = {
    coverage: 0.36,
    baseKm: 1.2,
    depthKm: 1.4,
    sizeKm: 2.5,
    tileKm: 24,
    extinction: 40,
    detail: 0.6,
    sharpness: 0.4,
    lumps: 0.5,
    bulge: 0.4,
};

export const DEFAULT_DEEP_LAYER: DeepLayer = {
    kind: "towers",
    coverage: 0,
    baseKm: 1.2,
    depthKm: 9,
    sizeKm: 14,
    tileKm: 112,
    extinction: 25,
    detail: 0.5,
    sharpness: 0.3,
    lumps: 0.7,
    bulge: 0.6,
    anvil: 0.6,
    frontKm: 12,
    frontDepthKm: 160,
    frontBearing: 20,
};

export const DEFAULT_MIDDLE_LAYER: CloudLayer = {
    coverage: 0.25,
    baseKm: 4.5,
    depthKm: 0.7,
    sizeKm: 1.6,
    tileKm: 28,
    extinction: 10,
    detail: 0.5,
    sharpness: 0.3,
    lumps: 0.6,
    bulge: 0.2,
};

export const DEFAULT_HIGH_SHEET: HighSheet = {
    coverage: 0.8,
    altitudeKm: 7,
    opticalDepth: 1.4,
    tileKm: 32,
    patchKm: 60,
    bandStretch: 2,
    bandAngle: 20,
    edge: 0.6,
    puffs: 1,
    puffKm: 0.32,
    elongation: 1.1,
    rows: 0.7,
    grain: 0.5,
    softness: 0.5,
    billows: 0.5,
    billowKm: 0.14,
    ripples: 0.7,
    rippleKm: 1.1,
    curve: 0.6,
    ribs: 0,
    ribKm: 3.5,
    veil: 0.08,
    striation: 0.3,
    stretch: 10,
    combing: 0,
    trails: 0.3,
    trailBend: 0.1,
    relief: 1,
    forwardG: 0.8,
};

export const DEFAULT_LAYERED_SKY: LayeredSky = {
    low: DEFAULT_LOW_LAYER,
    deep: DEFAULT_DEEP_LAYER,
    middle: DEFAULT_MIDDLE_LAYER,
    high: DEFAULT_HIGH_SHEET,
};

/** The kinds of cloud each place of a sky can hold: what a kind sets, over the place's defaults. */
export const CLOUD_TYPES = {
    low: {
        /** A few small heaps, far apart. */
        few: { coverage: 0.12, depthKm: 0.8, sizeKm: 2, extinction: 40, lumps: 0.5 },
        /** Fair-weather cumulus: small and flat. */
        fair: { coverage: 0.36, depthKm: 0.9, sizeKm: 2.2, extinction: 40, lumps: 0.5 },
        /** Heaps ahead of a front, thinning out under its shield. */
        scattered: { coverage: 0.25, depthKm: 1, sizeKm: 2.5, extinction: 40, lumps: 0.5 },
        /** Swelling cumulus, as between towers on a summer afternoon. */
        heaps: { coverage: 0.42, depthKm: 1.4, sizeKm: 3, extinction: 40, lumps: 0.5 },
        /** A closed deck of stratocumulus, pillows on top. */
        deck: { coverage: 0.9, depthKm: 1.2, sizeKm: 3, extinction: 50, lumps: 0.4 },
    },
    deep: {
        /** Towering cumulus and cumulonimbus, the tallest with anvils. */
        towers: { kind: "towers", coverage: 0.3, depthKm: 9, sizeKm: 14, extinction: 25 },
        /** A front coming on, its leading edge 12 km ahead. */
        frontAhead: {
            kind: "front",
            coverage: 0.8,
            depthKm: 9,
            sizeKm: 10,
            extinction: 30,
            frontKm: 12,
            frontDepthKm: 160,
        },
        /** The same front overhead: its shield from horizon to horizon. */
        frontOverhead: {
            kind: "front",
            coverage: 1,
            depthKm: 8,
            sizeKm: 10,
            extinction: 30,
            frontKm: -50,
            frontDepthKm: 220,
        },
    },
    middle: {
        /** A few flakes of altocumulus. */
        few: { coverage: 0.15, sizeKm: 1.6, lumps: 0.6 },
        /** Patches of altocumulus. */
        patches: { coverage: 0.25, sizeKm: 1.6, lumps: 0.6 },
        /** Altocumulus ahead of a front, in larger fields. */
        fields: { coverage: 0.4, sizeKm: 2.4, lumps: 0.6 },
        /** A sky of altocumulus, small cells apart. */
        altocumulus: { coverage: 0.62, sizeKm: 0.9, lumps: 0.8 },
        /** A closed deck of altostratus. */
        deck: { coverage: 0.8, sizeKm: 3, lumps: 0.6 },
    },
    high: {
        /** A mackerel sky: cirrocumulus, puffs in rows. */
        mackerel: {
            ...{ coverage: 0.8, patchKm: 60, bandStretch: 2, bandAngle: 20, edge: 0.6, puffs: 1, puffKm: 0.32 },
            ...{ rows: 0.7, elongation: 1.1, grain: 0.5, ripples: 0.7, rippleKm: 1.1, curve: 0.6, ribs: 0, veil: 0.08 },
            ...{ striation: 0.3, stretch: 10, combing: 0, trails: 0.3, trailBend: 0.1, opticalDepth: 2.4 },
        },
        /** A patch of fine ripples. */
        ripples: {
            ...{ coverage: 0.5, patchKm: 40, bandStretch: 2.5, bandAngle: 50, edge: 0.8, puffs: 1, puffKm: 0.28 },
            ...{
                rows: 0.85,
                elongation: 1.6,
                grain: 0.3,
                ripples: 0.85,
                rippleKm: 0.7,
                curve: 0.8,
                ribs: 0,
                veil: 0.15,
            },
            ...{ striation: 0.4, stretch: 8, combing: 4, trails: 0.3, trailBend: 0.1, opticalDepth: 1.2 },
        },
        /** A ribbed band: a veil broken into ribs across it. */
        ribbed: {
            ...{ coverage: 0.45, patchKm: 60, bandStretch: 6, bandAngle: 25, edge: 0.5, puffs: 0, puffKm: 0.4 },
            ...{ rows: 0.5, elongation: 1, grain: 0.4, ripples: 0, rippleKm: 1, curve: 0.5, ribs: 0.85, ribKm: 3.5 },
            ...{ veil: 1, striation: 0.8, stretch: 14, combing: 16, trails: 0.6, trailBend: 0.1, opticalDepth: 1.4 },
        },
        /** Puffs under a veil with trails. */
        puffsAndVeil: {
            ...{ coverage: 0.7, patchKm: 50, bandStretch: 2, bandAngle: 70, edge: 0.7, puffs: 0.9, puffKm: 0.4 },
            ...{ rows: 0.35, elongation: 1, grain: 0.5, ripples: 0.3, rippleKm: 1.4, curve: 0.7, ribs: 0, veil: 0.5 },
            ...{ striation: 0.5, stretch: 10, combing: 6, trails: 0.5, trailBend: 0.15, opticalDepth: 1.2 },
        },
        /** A veil of cirrostratus, combed along the wind. */
        veil: {
            ...{ coverage: 0.7, patchKm: 90, bandStretch: 3, bandAngle: 15, edge: 0.9, puffs: 0, ripples: 0, ribs: 0 },
            ...{ veil: 0.8, striation: 0.25, stretch: 16, combing: 8, trails: 0.5, trailBend: 0.05, opticalDepth: 0.7 },
        },
    },
} satisfies {
    low: Record<string, Partial<CloudLayer>>;
    deep: Record<string, Partial<DeepLayer>>;
    middle: Record<string, Partial<CloudLayer>>;
    high: Record<string, Partial<HighSheet>>;
};

type Place = keyof LayeredSky;
type Choice<P extends Place> = keyof (typeof CLOUD_TYPES)[P] | Partial<LayeredSky[P]> | null;

/** A sky as the kind of cloud in each of its places: a kind's name, numbers of its own over the defaults, or none. */
export interface Sky {
    low?: Choice<"low">;
    deep?: Choice<"deep">;
    middle?: Choice<"middle">;
    high?: Choice<"high">;
}

/** What the whole sky is turned by: every layer's coverage and density times these, 1 by default. */
export interface SkyDials {
    coverage?: number;
    density?: number;
}

/**
 * The numbers of `sky`: each place's defaults under its kind of cloud, a place left out or set to none with a coverage
 * of 0, and the dials applied, the coverage kept to 1 at most.
 */
export function layeredSky(sky: Sky, dials: SkyDials = {}): LayeredSky {
    const { coverage = 1, density = 1 } = dials;
    const place = <T extends { coverage: number }>(base: T, kinds: Record<string, Partial<T>>, choice: unknown): T => {
        const set = typeof choice === "string" ? kinds[choice] : (choice as Partial<T> | null | undefined);
        const filled = { ...base, ...set, ...(!set && { coverage: 0 }) };
        return { ...filled, coverage: Math.min(Math.max(filled.coverage * coverage, 0), 1) };
    };
    const thick = <T extends CloudLayer>(layer: T): T => ({ ...layer, extinction: layer.extinction * density });
    const high = place(DEFAULT_HIGH_SHEET, CLOUD_TYPES.high, sky.high);
    return {
        low: thick(place(DEFAULT_LOW_LAYER, CLOUD_TYPES.low, sky.low)),
        deep: thick(place<DeepLayer>(DEFAULT_DEEP_LAYER, CLOUD_TYPES.deep, sky.deep)),
        middle: thick(place(DEFAULT_MIDDLE_LAYER, CLOUD_TYPES.middle, sky.middle)),
        high: { ...high, opticalDepth: high.opticalDepth * density },
    };
}

/**
 * `a` blended towards `b` by `t`, 0 to 1, number by number. Where the deep layers differ in kind, towers cannot turn
 * into a front: the one fades out over the first half and the other in over the second.
 */
export function mixLayeredSky(a: LayeredSky, b: LayeredSky, t: number): LayeredSky {
    const mix = <T extends object>(x: T, y: T): T => {
        const out: Record<string, unknown> = {};
        for (const [key, to] of Object.entries({ ...x, ...y })) {
            const from = (x as Record<string, unknown>)[key];
            out[key] =
                typeof from === "number" && typeof to === "number" ? from + (to - from) * t : t < 0.5 ? from : to;
        }
        return out as T;
    };
    let deep = mix(a.deep, b.deep);
    if (a.deep.kind !== b.deep.kind) {
        deep =
            t < 0.5
                ? { ...a.deep, coverage: a.deep.coverage * (1 - 2 * t) }
                : { ...b.deep, coverage: b.deep.coverage * (2 * t - 1) };
    }
    return { low: mix(a.low, b.low), deep, middle: mix(a.middle, b.middle), high: mix(a.high, b.high) };
}

/** A layered sky and what moves and bounds it. Winds are east and north, in m/s. */
export interface LayeredParams {
    sky: LayeredSky;
    /** The wind the low layer drifts with: the deep clouds at 0.6 of it, the middle ones at 1.8. A front comes on with it. */
    wind: readonly [number, number];
    /** The wind up where the sheet is: its map's x axis runs along it, and it drifts with it. */
    highWind: readonly [number, number];
    /** How far the clouds lean with the wind as they rise, in km per km of height. */
    shear: number;
    /** How fast the maps change, in changes per hour, looping every `EVOLUTION_PERIOD`: 0 keeps them, and nothing is baked again. */
    evolution: number;
    /** Where the evolution stands at time 0, none by default: to go on from where the maps stood. */
    evolutionOffset?: number;
    seed: number;
    /** The distance at which the last cloud is gone, so the horizon stays clear, 0 for clouds all the way, and from where they thin out. */
    clearingKm: number;
    clearingFromKm: number;
    /** The time the drift and the evolution are taken at, in seconds. */
    timeS: number;
}

export const DEFAULT_LAYERED_PARAMS: LayeredParams = {
    sky: DEFAULT_LAYERED_SKY,
    wind: [3.4, 9.4],
    highWind: [18.8, 6.8],
    shear: 0.3,
    evolution: 0,
    seed: 23,
    clearingKm: 0,
    clearingFromKm: 30,
    timeS: 0,
};
