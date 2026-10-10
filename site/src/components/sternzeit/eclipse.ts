import * as precise from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { drawSvg, svgText, veiledHorizon } from "./figure";
import { arrowAround, offPanelArrowSvg } from "./offpanel";
import { ephemerisDay, onChange, state, update } from "./state";
import "./export";

// Both panels share a 200 x 200 viewBox centered on the origin: the Sun, or the axis of Earth's shadow, sits in the middle.
const HALF = 100;
// Solar panel: the Sun's disc gets this radius, so the discs still fit when they just touch (Moon up to ~7% larger).
const SUN_RADIUS_UNITS = 30;
// Lunar panel: kilometers at the Moon's distance per unit, so the penumbra (~8,200 km) fills most of the panel.
const KM_PER_UNIT = 110;
// How far past the umbra's edge its shading is carried, fading as it goes.
const UMBRA_FADE = 1.09;
// Off-panel bodies get the shared off-panel arrow instead (see offpanel.js), sized in screen pixels.
let unitsPerPx = 1;
// A Sun hidden completely shows its corona: a photograph of the total eclipse of 20 April 2023 from Exmouth, Western
// Australia (modified from one by Phil Hart). Its black disc is laid exactly over the Sun's;
// screen-blended so the photo's black adds nothing to the panel, and faded out towards its edges so the square never shows.
const CORONA_IMAGE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/images/corona-2023-04-20-exmouth.webp`;
// The photo's black disc, measured in its 1254 px original: not quite centered, and a little taller than wide where the
// Moon covered the Sun off-center; its mean diameter is used.
const CORONA_PHOTO_PX = 1254;
const CORONA_DISC_CENTER_PX = [625.5, 606.5];
const CORONA_DISC_DIAMETER_PX = 419;

let idCount = 0;

/** The corona photograph, scaled and centered so its disc covers exactly the Sun's. */
function corona() {
    const scale = (2 * SUN_RADIUS_UNITS) / CORONA_DISC_DIAMETER_PX;
    const size = CORONA_PHOTO_PX * scale;
    const [x, y] = CORONA_DISC_CENTER_PX.map((px) => -px * scale);
    const id = ++idCount;
    return `<radialGradient id="corona-fade-${id}"><stop offset="0.55" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
        <mask id="corona-mask-${id}"><rect x="${f(x)}" y="${f(y)}" width="${f(size)}" height="${f(size)}" fill="url(#corona-fade-${id})"/></mask>
        <image href="${CORONA_IMAGE}" x="${f(x)}" y="${f(y)}" width="${f(size)}" height="${f(size)}" mask="url(#corona-mask-${id})" class="eclipse-corona"/>`;
}
const f = (n: number) => n.toFixed(2);
const circle = (x: number, y: number, r: number, cls: string, extra = "") =>
    `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" class="${cls}" ${extra}/>`;

/** The Moon outside the panel: an arrow towards it on a circle around the center, half the panel across by default. */
function offPanelMoon(dx: number, dy: number, radius = HALF / 2) {
    // Along the direction from the panel's center (the Sun, or the shadow's axis) to the Moon.
    return offPanelArrowSvg(arrowAround({ x: 0, y: 0 }, { x: dx, y: dy }, radius, unitsPerPx), false);
}

function renderSolar(jd: number) {
    const time = precise.fromJulianDay(jd);
    const eclipse = precise.eclipse.solar(time, state);
    const sunAltitude = precise.sun.horizontalPosition(time, state).altitude;
    const sunRadiusDeg = precise.sun.apparentAngularDiameter(ephemerisDay(jd)) / 2;
    const moonRadiusDeg = precise.moon.apparentAngularDiameter(ephemerisDay(jd)) / 2;
    const scale = SUN_RADIUS_UNITS / sunRadiusDeg;
    const moonRadius = moonRadiusDeg * scale;

    // Position angle is measured from the zenith towards increasing azimuth, which is to the right for anyone facing the Sun.
    const angle = eclipse.positionAngle * precise.DEG_TO_RAD;
    const distance = eclipse.separation * scale;
    const [mx, my] = [Math.sin(angle) * distance, -Math.cos(angle) * distance];

    const inner = Math.abs(sunRadiusDeg - moonRadiusDeg);
    const outer = sunRadiusDeg + moonRadiusDeg;
    const total = eclipse.separation <= inner && moonRadiusDeg > sunRadiusDeg;

    let svg = "";
    if (total) {
        svg += corona();
    }
    svg += circle(0, 0, SUN_RADIUS_UNITS, "eclipse-sun");
    const onPanel = distance < HALF * Math.SQRT2 + moonRadius;
    if (onPanel) svg += circle(mx, my, moonRadius, "eclipse-moon-new");

    // The Sun sits at the center, so the visible horizon is the Sun's apparent altitude over it below; refraction lifts
    // the Sun, the observer's height lowers the horizon. The ground veils whatever is beneath.
    const sunAbove = precise.earth.apparentAltitude(sunAltitude, { observerHeightM: state.heightM });
    const horizon = sunAbove * scale;
    svg += veiledHorizon(horizon, HALF, unitsPerPx);
    if (!onPanel) svg += offPanelMoon(mx, my);

    let status: string;
    if (eclipse.separation <= inner) status = total ? "total, only the corona is left" : "annular";
    else if (eclipse.separation < outer) {
        const covered = (outer - eclipse.separation) / (2 * sunRadiusDeg);
        status = `partial, ${Math.round(covered * 100)}% of the Sun's diameter covered`;
    } else status = `none, the Moon is ${eclipse.separation.toFixed(1)}° away`;
    return { svg, status };
}

function renderLunar(jd: number) {
    const eclipse = precise.eclipse.lunar(ephemerisDay(jd));
    const moonRadius = precise.moon.MEAN_RADIUS_KM / KM_PER_UNIT;
    const umbra = eclipse.umbraRadiusKm / KM_PER_UNIT;
    const penumbra = eclipse.penumbraRadiusKm / KM_PER_UNIT;

    // Ecliptic position angle, from north through increasing longitude (east), which is to the left on the sky.
    const angle = eclipse.positionAngle * precise.DEG_TO_RAD;
    const distance = eclipse.axisOffsetKm / KM_PER_UNIT;
    const [mx, my] = [-Math.sin(angle) * distance, -Math.cos(angle) * distance];

    const clip = `eclipse-moon-clip-${++idCount}`;
    let svg = circle(0, 0, penumbra, "eclipse-penumbra") + circle(0, 0, umbra, "eclipse-umbra");
    const onPanelLunar = distance < HALF * Math.SQRT2 + moonRadius;
    if (onPanelLunar) {
        svg += `<clipPath id="${clip}">${circle(mx, my, moonRadius, "")}</clipPath>`;
        svg += circle(mx, my, moonRadius, "eclipse-moon-full");
        // The shadow, only where it falls on the Moon: a dimming that deepens across the penumbra, then the umbra's
        // red, darkest at its center, coppery towards its edge where more sunset light reaches in.
        const [pid, uid] = [`eclipse-penumbra-shade-${idCount}`, `eclipse-umbra-red-${idCount}`];
        const edge = (umbra / penumbra).toFixed(3);
        svg += `<radialGradient id="${pid}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${penumbra}">`;
        svg += `<stop offset="${edge}" class="eclipse-penumbra-inner"/><stop offset="1" class="eclipse-penumbra-outer"/></radialGradient>`;
        // Drawn past the umbra's edge and fading out over it: the real shadow has no hard rim either, and the last
        // light to make it round the Earth has been through the ozone layer, which leaves it blue.
        svg += `<radialGradient id="${uid}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${umbra * UMBRA_FADE}">`;
        svg += `<stop offset="0" class="eclipse-umbra-core"/><stop offset="0.42" class="eclipse-umbra-inner"/>`;
        svg += `<stop offset="0.66" class="eclipse-umbra-mid"/><stop offset="0.84" class="eclipse-umbra-rim"/>`;
        svg += `<stop offset="0.93" class="eclipse-umbra-ozone"/><stop offset="1" class="eclipse-umbra-fade"/>`;
        svg += `</radialGradient>`;
        svg += `<g clip-path="url(#${clip})"><circle r="${penumbra}" fill="url(#${pid})"/>`;
        svg += `<circle r="${umbra * UMBRA_FADE}" fill="url(#${uid})"/></g>`;
    }
    // Midway between the umbra's and the penumbra's edge, clear of both.
    const arrow = onPanelLunar ? "" : offPanelMoon(mx, my, (umbra + penumbra) / 2);
    svg += circle(0, 0, penumbra, "eclipse-edge") + circle(0, 0, umbra, "eclipse-edge");
    svg += svgText(0, -umbra + 9, "umbra", "figure-label");
    svg += svgText(0, -penumbra + 9, "penumbra", "figure-label");

    const km = eclipse.axisOffsetKm;
    const moonKm = precise.moon.MEAN_RADIUS_KM;
    let status: string;
    if (km + moonKm <= eclipse.umbraRadiusKm) status = "total, the Moon is entirely inside the umbra";
    else if (km - moonKm < eclipse.umbraRadiusKm) {
        const inside = (eclipse.umbraRadiusKm + moonKm - km) / (2 * moonKm);
        status = `partial, ${Math.round(inside * 100)}% of the Moon's diameter in the umbra`;
    } else if (km - moonKm < eclipse.penumbraRadiusKm) status = "penumbral, the Moon dims only slightly";
    else status = `none, the Moon is ${eclipse.separation.toFixed(1)}° from the shadow axis`;

    // An eclipse happens for everyone at once, but only those with the Moon above their horizon get to see it.
    const moonAltitude = precise.moon.horizontalPosition(precise.fromJulianDay(jd), state).altitude;
    if (precise.earth.apparentAltitude(moonAltitude, { observerHeightM: state.heightM }) < 0) {
        // The panel's frame is the sky's, not the observer's, so a Moon below the horizon veils all of it. The veil says
        // so; the status line does not, as a line that wraps and unwraps would jump the page while the time runs.
        svg += veiledHorizon(-HALF, HALF, unitsPerPx);
    }
    return { svg: svg + arrow, status };
}

const RENDERERS = { solar: renderSolar, lunar: renderLunar };
const views = document.querySelectorAll<HTMLElement>(".eclipse-view[data-kind]");

function render() {
    for (const view of views) {
        const panel = find<SVGSVGElement>(".eclipse-panel > svg", view);
        unitsPerPx = (2 * HALF) / (panel.clientWidth || 2 * HALF);
        const { svg, status } = RENDERERS[view.dataset.kind as keyof typeof RENDERERS](state.jd);
        drawSvg(panel, svg, unitsPerPx);
        find('[data-field="status"]', view).textContent = status;
    }
}

// An eclipse needs a new moon (solar) or a full one (lunar), so the search steps from one to the next rather than
// through the days between them (moon.MEAN_SYNODIC_MONTH and moon.MEAN_NEW_MOON); the true phase wanders up to
// about half a day either side of the mean one, which the day around each candidate covers.
const SEARCH_YEARS = 20;
const CANDIDATE_WINDOW = 1;
// The grids a candidate is walked on: three hours to rule it out, ten minutes to find the closest approach, one
// minute to pin it down.
const RULE_OUT_STEP = 1 / 8;
const COARSE_STEP = 1 / 144;
const FINE_STEP = 1 / 1440;
// Geocentric separation under which the Moon may cover the Sun somewhere on Earth: the two discs are about half a
// degree wide, and parallax moves the Moon by up to another degree.
const SOLAR_REACH_DEG = 2.5;

const timeOf = (jd: number) => precise.fromJulianDay(jd);

/** How far the Moon is from what would eclipse it, as seen from Earth's center. */
function geocentricDistance(jd: number, lunar: boolean) {
    if (lunar) return precise.eclipse.lunar(ephemerisDay(jd)).axisOffsetKm;
    const [m, s] = [precise.moon.apparentPosition(ephemerisDay(jd)), precise.sun.apparentPosition(ephemerisDay(jd))];
    return precise.angularSeparation(m.rightAscension, m.declination, s.rightAscension, s.declination);
}

/** Whether `jd` is close enough to be worth walking minute by minute. */
function mayEclipse(jd: number, lunar: boolean) {
    if (!lunar) return geocentricDistance(jd, false) < SOLAR_REACH_DEG;
    const shadow = precise.eclipse.lunar(ephemerisDay(jd));
    return shadow.axisOffsetKm < 2 * shadow.penumbraRadiusKm;
}

/**
 * How far the Moon is from the Sun in this place's own sky, or null while the Sun is down: an eclipse no one here
 * can see is not one to jump to, and skipping the night is what makes the search quick.
 */
function separationHere(jd: number) {
    const time = timeOf(jd);
    const s = precise.sun.horizontalPosition(time, state);
    if (s.altitude <= 0) return null;
    const m = precise.moon.horizontalPosition(time, state);
    return precise.angularSeparation(s.azimuth, s.altitude, m.azimuth, m.altitude);
}

/** The deepest moment within `window` of `middle`, walked coarsely and then refined, or null if there is none. */
function deepest(middle: number, lunar: boolean) {
    const distance = lunar
        ? (jd: number): number | null => precise.eclipse.lunar(ephemerisDay(jd)).axisOffsetKm
        : separationHere;
    let best: { jd: number; value: number } | null = null;
    for (let jd = middle - CANDIDATE_WINDOW; jd <= middle + CANDIDATE_WINDOW; jd += COARSE_STEP) {
        const value = distance(jd);
        if (value !== null && (!best || value < best.value)) best = { jd, value };
    }
    if (!best) return null;
    for (let jd = best.jd - COARSE_STEP; jd <= best.jd + COARSE_STEP; jd += FINE_STEP) {
        const value = distance(jd);
        if (value !== null && value < best.value) best = { jd, value };
    }
    if (lunar) {
        const shadow = precise.eclipse.lunar(ephemerisDay(best.jd));
        return shadow.axisOffsetKm - precise.moon.MEAN_RADIUS_KM < shadow.umbraRadiusKm ? best.jd : null;
    }
    return precise.eclipse.solar(timeOf(best.jd), state).phase < 1 ? best.jd : null;
}

/**
 * The nearest eclipse before or after `from`, searched rather than looked up: one candidate per lunation, ruled out
 * in a few calls unless the two bodies really do come close. Penumbral lunar eclipses are left out, there is nothing
 * to see in them, and solar ones are answered for the chosen place, which is why they are rarer than the almanac's.
 */
function nearestEclipse(from: number, direction: number, lunar: boolean) {
    const { MEAN_NEW_MOON, MEAN_SYNODIC_MONTH } = precise.moon;
    const offset = lunar ? 0.5 : 0;
    const k0 = (from - MEAN_NEW_MOON) / MEAN_SYNODIC_MONTH - offset;
    const months = Math.round((SEARCH_YEARS * 365.25) / MEAN_SYNODIC_MONTH);
    for (let i = 0; i <= months; i++) {
        const k = direction > 0 ? Math.floor(k0) + i : Math.ceil(k0) - i;
        const middle = MEAN_NEW_MOON + (k + offset) * MEAN_SYNODIC_MONTH;
        let near = false;
        for (let jd = middle - CANDIDATE_WINDOW; jd <= middle + CANDIDATE_WINDOW && !near; jd += RULE_OUT_STEP) {
            near = mayEclipse(jd, lunar);
        }
        if (!near) continue;
        const found = deepest(middle, lunar);
        if (found !== null && (direction > 0 ? found > from : found < from)) return found;
    }
    return null;
}

for (const button of document.querySelectorAll<HTMLElement>(".eclipse-view [data-jump]")) {
    button.addEventListener("click", () => {
        const view = button.closest(".eclipse-view") ?? document;
        const status = find('[data-field="status"]', view);
        const jd = nearestEclipse(state.jd, Number(button.dataset.step), button.dataset.jump === "lunar");
        if (jd === null) status.textContent = `none within ${SEARCH_YEARS} years of this moment`;
        else update({ jd, live: false, animate: false });
    });
}

onChange(render);
// The arrows are sized in screen pixels, so a resized panel redraws them.
const [first] = views;
if (first) new ResizeObserver(render).observe(first);
render();
