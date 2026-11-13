import { airTransmittance, clampObserverHeight, refractionAngle } from "@himmelszelt/dunstkreis";
import { liftedDirection, moonEV100, moonOrientation, type Vec3 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg } from "../sternzeit/figure";
import { noGpu } from "./laws";
import { ANY_PLACE, julianDayOf } from "./place";
import { type MoonAt, moonAt, type ToneCurveName } from "./renderer";
import { createTiles, type TileFrame } from "./tiles";

const DEG = Math.PI / 180;
// The face and the size of the full Moon of November 24, 2026, near perigee.
const FULL = julianDayOf("2026-11-24T15:00Z");
const f = (n: number) => n.toFixed(1);
const toward = (azimuth: number, altitude: number): Vec3 => [
    Math.cos(altitude * DEG) * Math.sin(azimuth * DEG),
    Math.cos(altitude * DEG) * Math.cos(azimuth * DEG),
    Math.sin(altitude * DEG),
];
const altitudeOf = (d: readonly number[]) => Math.asin(Math.max(-1, Math.min(1, d[2] ?? 0))) / DEG;
// The air's mean transmittance along a ray seen at `altitude`, or nothing for one that ends on the ground.
const mean = (t: readonly number[] | null) => (t ? ((t[0] ?? 0) + (t[1] ?? 0) + (t[2] ?? 0)) / 3 : 0);

/**
 * A full Moon moved to rise due east, `altitude` degrees truly over the horizon of an observer
 * `heightM` up, the Sun opposite and a degree lower, so the phase is nearly full and the sky just after sunset; the
 * face and the size kept from `base`.
 */
function risingMoon(base: MoonAt, altitude: number, heightM: number): MoonAt {
    const model = base.model;
    const bend = (a: number) => refractionAngle(model, heightM, a);
    const through = (a: number) => airTransmittance(model, heightM, a);
    const trueDirection = toward(90, altitude);
    const sunDirection = toward(270, -altitude - 1);
    const phaseAngle = 2 * altitude + 1;
    return {
        ...base,
        heightM,
        bend,
        through,
        trueDirection,
        direction: liftedDirection(trueDirection, bend),
        sunDirection,
        apparentSunDirection: liftedDirection(sunDirection, bend),
        moonSunDirection: sunDirection,
        phaseAngle,
        lit: (1 + Math.cos(phaseAngle * DEG)) / 2,
        parallacticAngle: 0,
        orientation: moonOrientation({
            direction: trueDirection,
            libration: base.libration,
            positionAngleOfAxis: base.positionAngleOfAxis,
            parallacticAngle: 0,
        }),
        earthShadow: null,
    };
}

/** The rising Moon figure on `root`: the disc above the air and through it, at an altitude and a height the sliders set. */
export function risingFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const outline = find<SVGSVGElement>("[data-field=outline]", root);
    const altitudeSlider = find<HTMLInputElement>("[data-field=altitude]", root);
    const heightSlider = find<HTMLInputElement>("[data-field=height]", root);
    const note = find("[data-field=note]", root);
    const air = find("[data-field=air]", root);
    const above = find("[data-field=above]", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);

    function render() {
        const table = tables();
        if (!table) return;
        const model = table.luts.model;
        const heightM = clampObserverHeight(10 ** Number(heightSlider.value));
        // The altitude over the horizon as seen from up there: the slider's, below the level by the horizon's dip.
        const radiusKm = model.planet.groundRadiusKm;
        const dip = Math.acos(radiusKm / (radiusKm + heightM / 1000)) / DEG;
        const altitude = Number(altitudeSlider.value) - dip;
        const risen = risingMoon(moonAt(FULL, ANY_PLACE, model), altitude, heightM);
        // Both tiles look between where the Moon truly stands and where the air shows it, so both discs are in view;
        // the view's direction is the only use the tiles make of `direction`.
        const shownAt = altitudeOf(risen.direction);
        const m = { ...risen, direction: toward(90, (altitude + shownAt) / 2) };
        for (const slider of [altitudeSlider, heightSlider]) paintRange(slider);
        find("[data-field=altitudeValue]", root).textContent = `${Number(altitudeSlider.value).toFixed(1)}°`;
        find("[data-field=heightValue]", root).textContent =
            heightM < 1000 ? `${heightM.toFixed(0)} m` : `${(heightM / 1000).toFixed(heightM < 10_000 ? 1 : 0)} km`;

        const tileCss = (root.clientWidth || 600) / 2;
        const tilePx = Math.round(tileCss * Math.min(window.devicePixelRatio || 1, 2));
        // One exposure for both, metered on the disc the air lifts, so the sky behind them is the same.
        const ev100 = Math.min(
            Math.max(moonEV100(m.phaseAngle, m.lit, Math.max(mean(m.through(shownAt)), 1e-3)), -6),
            20,
        );
        const common: TileFrame = {
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: "auto",
            ev100,
            albedo: true,
            relief: true,
            shadows: true,
            earthshine: false,
            eclipse: false,
            law: "hapke2012",
            nightVision: false,
            air: true,
        };
        // Without refraction: the same air dims and reddens the disc along straight rays, nothing lifts it; cut where the
        // sky behind it, traced through the bending air, shows the ground.
        const straight: MoonAt = { ...m, bend: (a: number) => (m.bend(a) === null ? null : 0) };
        const frames: TileFrame[] = [{ ...common, moon: straight }, common];
        const across = Math.max(m.angularDiameter * 2.4, (shownAt - altitude) * 1.4 + m.angularDiameter * 1.4);
        tiles?.draw({ count: 2, width: tilePx, degreesAcross: across }, (i) => frames[i] ?? common);
        // Through the air, where the Moon truly stands, dashed: the view's middle lies halfway between the two.
        const scale = tileCss / across;
        const trueY = tileCss / 2 + ((shownAt - altitude) / 2) * scale;
        outline.setAttribute("viewBox", `0 0 ${2 * tileCss} ${tileCss}`);
        drawSvg(
            outline,
            `<circle cx="${f(1.5 * tileCss)}" cy="${f(trueY)}" r="${f((m.angularDiameter / 2) * scale)}" class="figure-outline"/>`,
            1,
        );

        // The limbs where the air shows them: how far it squeezes the disc, and what it lets through of each.
        const r = m.angularDiameter / 2;
        const lower = liftedDirection(toward(90, altitude - r), m.bend);
        const upper = liftedDirection(toward(90, altitude + r), m.bend);
        const squeeze = (altitudeOf(upper) - altitudeOf(lower)) / m.angularDiameter;
        const [tLow, tHigh] = [m.through(altitudeOf(lower)), m.through(altitudeOf(upper))];
        const lifted = (shownAt - altitude) * 60;
        air.textContent = `lifted ${lifted.toFixed(0)}′, squeezed to ${(squeeze * 100).toFixed(0)}%`;
        above.textContent = "dimmed and reddened, not lifted";
        const pct = (t: readonly number[] | null) =>
            t ? t.map((c) => `${(c * 100).toFixed(c < 0.01 ? 1 : 0)}%`).join(" ") : "none";
        note.textContent = `through the air, red green blue: the lower limb ${pct(tLow)}, the upper ${pct(tHigh)}`;
    }

    altitudeSlider.addEventListener("input", requestRender);
    heightSlider.addEventListener("input", requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
