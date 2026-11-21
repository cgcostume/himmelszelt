import { expect, test } from "@playwright/test";
import {
    CLOUD_TYPES,
    DEFAULT_DEEP_LAYER,
    DEFAULT_HIGH_SHEET,
    DEFAULT_LOW_LAYER,
    layeredSky,
    mixLayeredSky,
} from "../src/layers.js";
import { WEATHER } from "../src/weather.js";

test("a place left out or set to none has no clouds, and keeps its defaults", () => {
    const sky = layeredSky({ low: "fair", deep: null });
    expect(sky.low).toEqual({ ...DEFAULT_LOW_LAYER, ...CLOUD_TYPES.low.fair });
    expect(sky.deep).toEqual({ ...DEFAULT_DEEP_LAYER, coverage: 0 });
    expect(sky.middle.coverage).toBe(0);
    expect(sky.high).toEqual({ ...DEFAULT_HIGH_SHEET, coverage: 0 });
});

test("numbers of its own stand over a place's defaults", () => {
    const sky = layeredSky({ low: { coverage: 0.5, baseKm: 2 } });
    expect(sky.low).toEqual({ ...DEFAULT_LOW_LAYER, coverage: 0.5, baseKm: 2 });
});

test("the dials turn every layer's coverage and density, the coverage to 1 at most", () => {
    const plain = layeredSky(WEATHER.towering.layers);
    const turned = layeredSky(WEATHER.towering.layers, { coverage: 3, density: 0.5 });
    expect(turned.low.coverage).toBe(1);
    expect(turned.deep.coverage).toBeCloseTo(0.9, 12);
    expect(turned.deep.extinction).toBe(plain.deep.extinction / 2);
    expect(turned.high.opticalDepth).toBe(plain.high.opticalDepth / 2);
    expect(turned.low.depthKm).toBe(plain.low.depthKm);
});

test("every weather names a sky whose kinds exist", () => {
    for (const [name, weather] of Object.entries(WEATHER)) {
        const sky = layeredSky(weather.layers);
        for (const layer of [sky.low, sky.deep, sky.middle, sky.high]) {
            for (const [key, value] of Object.entries(layer)) {
                expect(value, `${name}: ${key}`).not.toBeUndefined();
                if (typeof value === "number") expect(Number.isFinite(value), `${name}: ${key}`).toBe(true);
            }
        }
    }
});

test("two skies blend number by number, and meet their ends", () => {
    const a = layeredSky(WEATHER.fair.layers);
    const b = layeredSky(WEATHER.overcast.layers);
    expect(mixLayeredSky(a, b, 0)).toEqual(a);
    expect(mixLayeredSky(a, b, 1)).toEqual(b);
    const half = mixLayeredSky(a, b, 0.5);
    expect(half.low.coverage).toBeCloseTo((a.low.coverage + b.low.coverage) / 2, 12);
    expect(half.high.veil).toBeCloseTo((a.high.veil + b.high.veil) / 2, 12);
});

test("towers fade out before a front fades in", () => {
    const towers = layeredSky(WEATHER.towering.layers);
    const front = layeredSky(WEATHER.frontAhead.layers);
    const early = mixLayeredSky(towers, front, 0.25);
    expect(early.deep.kind).toBe("towers");
    expect(early.deep.coverage).toBeCloseTo(towers.deep.coverage / 2, 12);
    expect(mixLayeredSky(towers, front, 0.5).deep.coverage).toBe(0);
    const late = mixLayeredSky(towers, front, 0.75);
    expect(late.deep.kind).toBe("front");
    expect(late.deep.frontKm).toBe(front.deep.frontKm);
    expect(late.deep.coverage).toBeCloseTo(front.deep.coverage / 2, 12);
});
