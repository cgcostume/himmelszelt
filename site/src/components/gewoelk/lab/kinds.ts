import {
    CLOUD_TYPES,
    type CloudLayer,
    DEFAULT_LAYERED_SKY,
    type DeepLayer,
    type HighSheet,
    type LayeredSky,
} from "@himmelszelt/gewoelk";
import type { Presets } from "./lab";

/**
 * gewoelk's layered sky and the figures' sliders, one table for both ways: a sky read from the sliders, and the
 * library's kinds of cloud as presets that set them.
 */

export type Place = keyof LayeredSky;
/** What a designer figure designs: a place of the sky, the deep one as its towers or as a front. */
export type Design = "low" | "towers" | "front" | "middle" | "high";
export const placeOf = (design: Design): Place => (design === "towers" || design === "front" ? "deep" : design);

const MARCHED = ["low", "deep", "middle"] as const;
// A marched layer's numbers by their sliders' names, after the layer's "l0." to "l2.".
const LAYER: Record<keyof CloudLayer, string> = {
    coverage: "coverage",
    baseKm: "base",
    depthKm: "depth",
    sizeKm: "feature",
    tileKm: "tile",
    extinction: "extinction",
    detail: "detail",
    sharpness: "sharp",
    lumps: "lumps",
    bulge: "warp",
};
const DEEP: Record<Exclude<keyof DeepLayer, keyof CloudLayer | "kind">, string> = {
    anvil: "anvil",
    frontKm: "front.distance",
    frontDepthKm: "front.depth",
    frontBearing: "front.bearing",
    rain: "rain",
};
const HIGH: Record<keyof HighSheet, string> = {
    coverage: "c.coverage",
    altitudeKm: "c.altitude",
    opticalDepth: "c.opticalDepth",
    tileKm: "c.tile",
    reachKm: "c.reach",
    patchKm: "c.patchKm",
    bandStretch: "c.bandStretch",
    bandAngle: "c.bandAngle",
    edge: "c.edge",
    flakes: "c.flakes",
    flakeKm: "c.flakeKm",
    puffs: "c.cells",
    puffKm: "c.cellKm",
    elongation: "c.elongation",
    rows: "c.rows",
    grain: "c.grain",
    softness: "c.soft",
    billows: "c.billows",
    billowKm: "c.billowKm",
    ripples: "c.ripples",
    rippleKm: "c.rippleKm",
    curve: "c.curve",
    ribs: "c.ribs",
    ribKm: "c.ribKm",
    veil: "c.veil",
    striation: "c.striation",
    stretch: "c.stretch",
    combing: "comb",
    trails: "c.streaks",
    trailBend: "c.bend",
    relief: "c.relief",
    forwardG: "c.forwardG",
};

/** The sliders of `place` by the names of its numbers in the library. */
function sliders(place: Place): Record<string, string> {
    if (place === "high") return HIGH;
    const i = MARCHED.indexOf(place);
    const layer = Object.entries(LAYER).map(([key, name]) => [key, `l${i}.${name}`]);
    return Object.fromEntries(place === "deep" ? [...layer, ...Object.entries(DEEP)] : layer);
}

/** The sky as the sliders have it, read by `value`, the deep layer of `kind`. */
export function skyFrom(value: (param: string) => number, kind: DeepLayer["kind"]): LayeredSky {
    const read = (place: Place) =>
        Object.fromEntries(Object.entries(sliders(place)).map(([key, param]) => [key, value(param)]));
    return {
        low: read("low") as unknown as CloudLayer,
        deep: { ...(read("deep") as unknown as DeepLayer), kind },
        middle: read("middle") as unknown as CloudLayer,
        high: read("high") as unknown as HighSheet,
    };
}

/** The value of the deep layer's kind in the figures' choice. */
export const KIND_VALUE: Record<DeepLayer["kind"], string> = { towers: "2", front: "3" };

/** The names of the library's kinds of cloud a designer of `design` offers. */
export function kindsOf(design: Design): string[] {
    const kinds: Record<string, Partial<DeepLayer>> = CLOUD_TYPES[placeOf(design)];
    const front = (name: string) => kinds[name]?.kind === "front";
    return Object.keys(kinds).filter((name) => placeOf(design) !== "deep" || front(name) === (design === "front"));
}

/** A kind of cloud for `place`, its `numbers` over the place's defaults, as a preset of the sliders. */
export function presetOf(place: Place, numbers: Record<string, unknown>): Record<string, number> {
    const whole: Record<string, unknown> = { ...DEFAULT_LAYERED_SKY[place], ...numbers };
    const preset: Record<string, number> = {};
    for (const [key, param] of Object.entries(sliders(place)))
        if (typeof whole[key] === "number") preset[param] = whole[key];
    if (place === "deep") preset["@kind1"] = Number(KIND_VALUE[whole.kind === "front" ? "front" : "towers"]);
    return preset;
}

/** The library's kinds of cloud for `place` as presets of the sliders: each over the place's defaults, as there. */
export function kindPresets(place: Place): Presets {
    const kinds: Record<string, Record<string, unknown>> = CLOUD_TYPES[place];
    return Object.fromEntries(Object.entries(kinds).map(([name, kind]) => [name, presetOf(place, kind)]));
}

/** What the sliders hold for `place`, as an entry of the library's `CLOUD_TYPES`: every number, rounded to its slider. */
export function kindSource(sky: LayeredSky, place: Place): string {
    const fields = Object.entries(sky[place]).map(
        ([key, value]) => `${key}: ${typeof value === "number" ? Number(value.toFixed(3)) : JSON.stringify(value)}`,
    );
    return `{ ${fields.join(", ")} }`;
}
