/**
 * Weather as presets of the clouds' shape: what the low clouds and the high sheet look like, without the light, the
 * wind or the time. Numbers only, so two blend into a third: `mixWeather` moves between them, as weather changes.
 */
import type { CloudscapeParams, SheetNoise, SheetParams } from "./params.js";

type Numeric<T> = { [K in keyof T as T[K] extends number | undefined ? K : never]?: number };

/** The shape of a weather: the cloudscape's and the sheet's numbers it sets, its noise's too, the rest left as they are. */
export interface Weather {
    cloudscape: Numeric<CloudscapeParams>;
    sheet: Numeric<SheetParams> & { noise?: Partial<SheetNoise> };
}

/** Presets, from a clear sky to a closed deck. Coverage 0 stands for none, so a layer blends in and out. */
export const WEATHER = {
    /** Blue sky, a few wisps. */
    clear: {
        cloudscape: { coverage: 0, sharpness: 0.4, towers: 0, towerScale: 1, billows: 0.1, baseKm: 1.2, heightKm: 1.6 },
        sheet: { coverage: 0.1, opticalDepth: 0.3, ripples: 0 },
    },
    /** Fair-weather cumulus: small, flat, spread out. */
    fair: {
        cloudscape: {
            coverage: 0.32,
            sharpness: 0.45,
            towers: 0.1,
            towerScale: 1.2,
            billows: 0.12,
            baseKm: 1.2,
            heightKm: 1.6,
            offset: 0.2,
        },
        sheet: { coverage: 0.15, opticalDepth: 0.3, ripples: 0 },
    },
    /** Scattered cumulus, some of it growing. */
    scattered: {
        cloudscape: {
            coverage: 0.42,
            sharpness: 0.35,
            towers: 0.3,
            towerScale: 1.5,
            billows: 0.12,
            baseKm: 1.2,
            heightKm: 2.4,
            offset: 0.25,
        },
        sheet: { coverage: 0.35, opticalDepth: 0.5, ripples: 0 },
    },
    /** Towering cumulus, congestus: tall, heaped, an afternoon in summer. */
    towering: {
        cloudscape: {
            coverage: 0.4,
            sharpness: 0.3,
            towers: 0.8,
            towerScale: 2.5,
            billows: 0.22,
            baseKm: 1,
            heightKm: 2.4,
            offset: 0.2,
        },
        sheet: { coverage: 0.25, opticalDepth: 0.6, ripples: 0 },
    },
    /** A deck of stratocumulus under a veil of cirrostratus. */
    overcast: {
        cloudscape: {
            coverage: 0.85,
            sharpness: 0.1,
            towers: 0,
            towerScale: 1,
            billows: 0.06,
            baseKm: 0.8,
            heightKm: 1.2,
            offset: 0.1,
        },
        sheet: { coverage: 0.7, opticalDepth: 1.5, ripples: 0 },
    },
    /** A mackerel sky: cirrocumulus in ripples across the wind, over a few low clouds. */
    mackerel: {
        cloudscape: { coverage: 0.1, sharpness: 0.4, towers: 0, towerScale: 1, billows: 0.1, heightKm: 1.4 },
        sheet: { coverage: 0.75, opticalDepth: 1, ripples: 0.9 },
    },
    /** High cloud ahead of a front: cirrus spreading over a few low clouds. */
    cirrus: {
        cloudscape: { coverage: 0.15, sharpness: 0.4, towers: 0, towerScale: 1, billows: 0.1, heightKm: 1.4 },
        sheet: { coverage: 0.65, opticalDepth: 0.8, ripples: 0 },
    },
} satisfies Record<string, Weather>;

export type WeatherName = keyof typeof WEATHER;

/** `a` blended towards `b` by `t`, 0 to 1, number by number; a number only one of them sets is taken as it is. */
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
    return {
        cloudscape: mix(a.cloudscape, b.cloudscape),
        sheet: { ...mix(sa, sb), ...(Object.keys(noise).length ? { noise } : {}) },
    };
}
