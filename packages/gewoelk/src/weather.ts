/**
 * Weather as presets of the clouds' shape: what the low clouds and the high sheet look like, without the light, the
 * wind or the time. Numbers only, so two blend into a third: `mixWeather` moves between them, as weather changes. Each
 * also names its sky for the layered model, the kind of cloud in each place: see `layeredSky`.
 */
import { CLOUD_TYPES, type Sky } from "./layers.js";
import type { CloudscapeParams, SheetNoise, SheetParams } from "./params.js";

type Numeric<T> = { [K in keyof T as T[K] extends number | undefined ? K : never]?: number };

/**
 * The shape of a weather: for the voxel model the cloudscape's and the sheet's numbers it sets, its noise's too, the
 * rest left as they are, and for the layered model its sky.
 */
export interface Weather {
    cloudscape: Numeric<CloudscapeParams>;
    sheet: Numeric<SheetParams> & { noise?: Partial<SheetNoise> };
    layers?: Sky;
}

/**
 * A kind of voxel cloudscape: the numbers of its shape, and the volume that holds it without waste, voxels east and
 * north and levels up. A pass is made with one volume: `createCloudPass({ grid })` takes the largest of the kinds it
 * is to show.
 */
export interface CloudscapeType {
    shape: Numeric<CloudscapeParams>;
    grid: { size: number; layers: number };
}

/** Kinds of low cloud for the voxel model, by their genus and species, as `CLOUD_TYPES` holds the layered model's. */
export const CLOUDSCAPE_TYPES = {
    /** Cumulus humilis: small, flat heaps of fair weather. */
    humilis: {
        shape: {
            coverage: 0.32,
            sharpness: 0.45,
            towers: 0.1,
            towerScale: 1.2,
            billows: 0.12,
            baseKm: 1.2,
            heightKm: 1.6,
            offset: 0.2,
        },
        grid: { size: 256, layers: 32 },
    },
    /** Cumulus mediocris: scattered heaps, some of them growing. */
    mediocris: {
        shape: {
            coverage: 0.42,
            sharpness: 0.35,
            towers: 0.3,
            towerScale: 1.5,
            billows: 0.12,
            baseKm: 1.2,
            heightKm: 2.4,
            offset: 0.25,
        },
        grid: { size: 256, layers: 32 },
    },
    /** Cumulus congestus: tall, heaped towers, which need the most levels. */
    congestus: {
        shape: {
            coverage: 0.4,
            sharpness: 0.3,
            towers: 0.8,
            towerScale: 2.5,
            billows: 0.22,
            baseKm: 1,
            heightKm: 2.4,
            offset: 0.2,
        },
        grid: { size: 256, layers: 48 },
    },
    /** Stratocumulus: a closed, lumpy deck, flat enough for half the levels. */
    stratocumulus: {
        shape: {
            coverage: 0.85,
            sharpness: 0.1,
            towers: 0,
            towerScale: 1,
            billows: 0.06,
            baseKm: 0.8,
            heightKm: 1.2,
            offset: 0.1,
        },
        grid: { size: 256, layers: 16 },
    },
    /** Stratus: a low, even layer with next to no relief, which a coarse volume holds. */
    stratus: {
        shape: {
            coverage: 0.95,
            sharpness: 0.05,
            towers: 0,
            towerScale: 1,
            billows: 0.03,
            baseKm: 0.4,
            heightKm: 0.6,
            offset: 0.05,
        },
        grid: { size: 128, layers: 8 },
    },
} satisfies Record<string, CloudscapeType>;

export type CloudscapeTypeName = keyof typeof CLOUDSCAPE_TYPES;

/** Presets, from a clear sky to a closed deck. Coverage 0 stands for none, so a layer blends in and out. */
export const WEATHER = {
    /** Blue sky, a few wisps. */
    clear: {
        cloudscape: { coverage: 0, sharpness: 0.4, towers: 0, towerScale: 1, billows: 0.1, baseKm: 1.2, heightKm: 1.6 },
        sheet: { coverage: 0.1, opticalDepth: 0.3, ripples: 0 },
        layers: { high: { ...CLOUD_TYPES.high.veil, coverage: 0.15, opticalDepth: 0.3 } },
    },
    /** Fair-weather cumulus: small, flat, spread out. */
    fair: {
        cloudscape: CLOUDSCAPE_TYPES.humilis.shape,
        sheet: { coverage: 0.15, opticalDepth: 0.3, ripples: 0 },
        layers: { low: "fair", middle: "patches", high: "mackerel" },
    },
    /** Scattered cumulus, some of it growing. */
    scattered: {
        cloudscape: CLOUDSCAPE_TYPES.mediocris.shape,
        sheet: { coverage: 0.35, opticalDepth: 0.5, ripples: 0 },
        layers: { low: "heaps", middle: "few", high: "puffsAndVeil" },
    },
    /** Towering cumulus, congestus: tall, heaped, an afternoon in summer. */
    towering: {
        cloudscape: CLOUDSCAPE_TYPES.congestus.shape,
        sheet: { coverage: 0.25, opticalDepth: 0.6, ripples: 0 },
        layers: { low: "heaps", deep: "towers", middle: "few", high: "mackerel" },
    },
    /** A deck of stratocumulus under a veil of cirrostratus. */
    overcast: {
        cloudscape: CLOUDSCAPE_TYPES.stratocumulus.shape,
        sheet: { coverage: 0.7, opticalDepth: 1.5, ripples: 0 },
        layers: { low: "deck", middle: "deck", high: "veil" },
    },
    /** A mackerel sky: cirrocumulus in ripples across the wind, over a few low clouds. */
    mackerel: {
        cloudscape: { coverage: 0.1, sharpness: 0.4, towers: 0, towerScale: 1, billows: 0.1, heightKm: 1.4 },
        sheet: { coverage: 0.75, opticalDepth: 1, ripples: 0.9 },
        layers: { low: "few", high: "mackerel" },
    },
    /** High cloud ahead of a front: cirrus spreading over a few low clouds. */
    cirrus: {
        cloudscape: { coverage: 0.15, sharpness: 0.4, towers: 0, towerScale: 1, billows: 0.1, heightKm: 1.4 },
        sheet: { coverage: 0.65, opticalDepth: 0.8, ripples: 0 },
        layers: { low: "few", high: "ribbed" },
    },
    /** A sky of altocumulus over a few low heaps. */
    altocumulus: {
        cloudscape: { coverage: 0.12, sharpness: 0.4, towers: 0, towerScale: 1, billows: 0.1, heightKm: 1.4 },
        sheet: { coverage: 0.6, opticalDepth: 1, ripples: 0.6 },
        layers: { low: "few", middle: "altocumulus", high: "ripples" },
    },
    /** Showers under an open sky: rain under every tower, and its bows where a low sun behind the observer reaches it. */
    showers: {
        cloudscape: {
            coverage: 0.35,
            sharpness: 0.3,
            towers: 0.7,
            towerScale: 2,
            billows: 0.2,
            baseKm: 1,
            heightKm: 2.2,
        },
        sheet: { coverage: 0, opticalDepth: 0.6, ripples: 0 },
        layers: { low: "few", deep: "showers" },
    },
    /** A front coming on: its shield ahead, the low clouds thinning out under it. */
    frontAhead: {
        cloudscape: {
            coverage: 0.3,
            sharpness: 0.35,
            towers: 0.2,
            towerScale: 1.5,
            billows: 0.12,
            baseKm: 1,
            heightKm: 2,
        },
        sheet: { coverage: 0.8, opticalDepth: 1.2, ripples: 0 },
        layers: { low: "scattered", deep: "frontAhead", middle: "fields", high: "veil" },
    },
    /** Under the front: a closed, dark sky, ragged cloud hanging low. */
    underFront: {
        cloudscape: {
            coverage: 0.9,
            sharpness: 0.1,
            towers: 0,
            towerScale: 1,
            billows: 0.06,
            baseKm: 0.6,
            heightKm: 1.4,
            offset: 0.1,
        },
        sheet: { coverage: 0.9, opticalDepth: 2, ripples: 0 },
        layers: { low: "deck", deep: "frontOverhead", middle: "deck", high: "veil" },
    },
} satisfies Record<string, Weather>;

export type WeatherName = keyof typeof WEATHER;

/**
 * `a` blended towards `b` by `t`, 0 to 1, number by number; a number only one of them sets is taken as it is. The
 * layered model's sky is names, not numbers: the nearer one's is kept, and `mixLayeredSky` blends two once resolved.
 */
export function mixWeather(a: Weather, b: Weather, t: number): Weather {
    const mix = <T extends Record<string, number | undefined>>(x: T, y: T): T => {
        const out: Record<string, number> = {};
        for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
            const from = x[key] ?? y[key] ?? 0;
            const to = y[key] ?? from;
            out[key] = from + (to - from) * t;
        }
        return out as T;
    };
    const { noise: na = {}, ...sa } = a.sheet;
    const { noise: nb = {}, ...sb } = b.sheet;
    const noise = mix<Partial<SheetNoise>>(na, nb);
    const layers = t < 0.5 ? a.layers : b.layers;
    return {
        cloudscape: mix(a.cloudscape, b.cloudscape),
        sheet: { ...mix(sa, sb), ...(Object.keys(noise).length ? { noise } : {}) },
        ...(layers && { layers }),
    };
}
