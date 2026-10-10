import * as precise from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { drawSvg, escapeText, sunGlow, svgText, veiledHorizon } from "./figure";
import { arrowAround, offPanelArrowSvg } from "./offpanel";
import { offsetSliders } from "./offset";
import { ephemerisDay, onChange, state, update } from "./state";
import { clock } from "./zone";
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
// A Sun hidden completely shows its corona: a photograph of the total eclipse of April 20, 2023, from Exmouth, Western
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
// The corona fades in as totality nears, from this much of the Sun's diameter covered: first its innermost ring,
// faint, then all of it once the Sun is gone.
const CORONA_FROM = 0.97;
const CORONA_GROWTH = 0.2;
// The added copies are lifted by this much, so the edge of the Moon glares.
const CORONA_GAIN = 1.5;
// The falloff's exponent, and how many stops draw it.
const CORONA_FALLOFF = 1.8;
const CORONA_FALLOFF_STOPS = 8;
// Copies of the photograph laid over each other and added, each weighted by its strength over all of theirs, so the
// corona is at its brightest only where all of them are bright (see .eclipse-corona-layer); each turning on its own, continuously about the Sun's
// center, in seconds a turn, so the streamers drift through each other while it shows. The first slow, the second
// mirrored, smaller, so the two never line up, and fast: their periods apart by the golden ratio cubed, an irrational
// ratio, so they never come back into the same phase. A third, full size and half as strong, starts at a random angle
// and turns at a random pace, new on every visit. Not for a reader who prefers less motion.
const GOLDEN = (1 + Math.sqrt(5)) / 2;
type CoronaLayer = { seconds: number; size: number; mirrored: boolean; strength: number; offset: number };
const CORONA_LAYERS: CoronaLayer[] = [
    { seconds: 360, size: 1, mirrored: false, strength: 1, offset: 0 },
    { seconds: -360 / GOLDEN ** 3, size: 0.8, mirrored: true, strength: 1, offset: 0 },
    {
        seconds: (Math.random() < 0.5 ? -1 : 1) * (120 + Math.random() * 300),
        size: 1,
        mirrored: Math.random() < 0.5,
        strength: 0.5,
        offset: Math.random() * 360,
    },
];
const CORONA_STRENGTH = CORONA_LAYERS.reduce((sum, layer) => sum + layer.strength, 0);
const stillCorona = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The corona photograph at `amount` of the way to totality, 0 to 1, scaled and centered so its disc covers the Sun's. */
function corona(amount: number) {
    // Redrawn on every change, so each turn picks up where the clock has it rather than starting over.
    const now = performance.now() / 1000;
    // It grows on the way, its disc from a fifth smaller than the Sun's, hidden behind it, to exactly the Sun's at
    // totality, where the corona starts right at the Moon's edge.
    const scale = ((2 * SUN_RADIUS_UNITS) / CORONA_DISC_DIAMETER_PX) * (1 - CORONA_GROWTH * (1 - amount));
    const size = CORONA_PHOTO_PX * scale;
    const [x, y] = CORONA_DISC_CENTER_PX.map((px) => -px * scale);
    const id = ++idCount;
    // The mask opens outward as totality nears, from the photograph's disc to its edge at totality, falling off as the
    // real corona does: brightest at the Moon's edge, dropping fast, then a long faint tail.
    const [inner, outer] = [0.34, 0.45 + 0.55 * amount];
    const fade = Array.from({ length: CORONA_FALLOFF_STOPS + 1 }, (_, k) => {
        const t = k / CORONA_FALLOFF_STOPS;
        const level = Math.round(255 * (1 - t) ** CORONA_FALLOFF);
        return `<stop offset="${f(inner + (outer - inner) * t)}" stop-color="rgb(${level},${level},${level})"/>`;
    }).join("");
    return `<radialGradient id="corona-fade-${id}">${fade}</radialGradient>
        <mask id="corona-mask-${id}"><rect x="${f(x)}" y="${f(y)}" width="${f(size)}" height="${f(size)}" fill="url(#corona-fade-${id})"/></mask>
        <g class="eclipse-corona" opacity="${f(amount ** 1.5)}" style="filter: brightness(${CORONA_GAIN})">${CORONA_LAYERS.map(
            ({ seconds, size: scaled, mirrored, strength, offset }) => {
                const image = `<image href="${CORONA_IMAGE}" x="${f(x)}" y="${f(y)}" width="${f(size)}" height="${f(size)}" mask="url(#corona-mask-${id})"/>`;
                const [from, to] = [offset, offset + (seconds < 0 ? -360 : 360)];
                const turn = stillCorona
                    ? ""
                    : `<animateTransform attributeName="transform" type="rotate" from="${f(from)} 0 0" to="${f(to)} 0 0" dur="${f(Math.abs(seconds))}s" begin="-${f(now % Math.abs(seconds))}s" repeatCount="indefinite"/>`;
                const still = stillCorona ? ` transform="rotate(${f(offset)})"` : "";
                return `<g class="eclipse-corona-layer" opacity="${f(strength / CORONA_STRENGTH)}"${still}>${turn}<g transform="scale(${f(mirrored ? -scaled : scaled)}, ${f(scaled)})">${image}</g></g>`;
            },
        ).join("")}</g>`;
}
const f = (n: number) => n.toFixed(2);
const circle = (x: number, y: number, r: number, cls: string, extra = "") =>
    `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" class="${cls}" ${extra}/>`;

/** The Moon outside the panel: an arrow towards it on a circle around the center, half the panel across by default. */
function offPanelMoon(dx: number, dy: number, radius = HALF / 2) {
    // Along the direction from the panel's center (the Sun, or the shadow's axis) to the Moon.
    return offPanelArrowSvg(arrowAround({ x: 0, y: 0 }, { x: dx, y: dy }, radius, unitsPerPx), false);
}

// Where on Earth this eclipse is greatest: the point the line from the Sun through the Moon passes closest to Earth's
// center, at the moment it does, as Meeus' greatest eclipse. Found from the two positions alone, Earth flattened by
// stretching its axis to a sphere's, and told as how far, which way and how many degrees from the chosen place.
const FLATTENING = 1 / 298.257;
const EQUATORIAL_KM = precise.earth.EQUATORIAL_RADIUS_KM;
type Vec = [number, number, number];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// Equatorial coordinates to kilometers, z stretched so the flattened Earth becomes a sphere of the equator's radius.
const toVec = ({ rightAscension, declination }: precise.EquatorialCoords, km: number): Vec => {
    const [a, d] = [rightAscension * precise.DEG_TO_RAD, declination * precise.DEG_TO_RAD];
    return [km * Math.cos(d) * Math.cos(a), km * Math.cos(d) * Math.sin(a), (km * Math.sin(d)) / (1 - FLATTENING)];
};

function shadowAxis(jd: number) {
    const t = ephemerisDay(jd);
    const sun = toVec(precise.sun.apparentPosition(t), precise.sun.distance(t));
    const moon = toVec(precise.moon.apparentPosition(t), precise.moon.distance(t));
    const along: Vec = [moon[0] - sun[0], moon[1] - sun[1], moon[2] - sun[2]];
    const length = Math.hypot(...along);
    const d: Vec = [along[0] / length, along[1] / length, along[2] / length];
    const s = -dot(moon, d);
    const closest: Vec = [moon[0] + d[0] * s, moon[1] + d[1] * s, moon[2] + d[2] * s];
    return { moon, d, s, closest, miss: Math.hypot(...closest) };
}

const GREATEST_WINDOW = 0.25;
const GREATEST_STEP = 1 / 1440;
let greatest: { jd: number; latitude: number; longitude: number } | null = null;

/** The greatest eclipse around `jd`, or null when the Moon is nowhere near the Sun or its shadow misses Earth. */
function greatestAround(jd: number) {
    if (greatest && Math.abs(greatest.jd - jd) < GREATEST_WINDOW) return greatest;
    const t = ephemerisDay(jd);
    const [m, sn] = [precise.moon.apparentPosition(t), precise.sun.apparentPosition(t)];
    if (precise.angularSeparation(m.rightAscension, m.declination, sn.rightAscension, sn.declination) > SOLAR_REACH_DEG)
        return null;
    let best = { jd, miss: Number.POSITIVE_INFINITY };
    for (let at = jd - GREATEST_WINDOW; at <= jd + GREATEST_WINDOW; at += GREATEST_STEP) {
        const { miss } = shadowAxis(at);
        if (miss < best.miss) best = { jd: at, miss };
    }
    // Past about one and a half Earth radii even the penumbra misses: no eclipse anywhere.
    if (best.miss > 1.55 * EQUATORIAL_KM) return null;
    const { moon, d, s, closest, miss } = shadowAxis(best.jd);
    // Where the axis meets Earth, the near side; when it misses, the point of Earth closest to it.
    const reach = miss < EQUATORIAL_KM ? s - Math.sqrt(EQUATORIAL_KM ** 2 - miss ** 2) : s;
    const point: Vec =
        miss < EQUATORIAL_KM
            ? [moon[0] + d[0] * reach, moon[1] + d[1] * reach, moon[2] + d[2] * reach]
            : [
                  closest[0] * (EQUATORIAL_KM / miss),
                  closest[1] * (EQUATORIAL_KM / miss),
                  closest[2] * (EQUATORIAL_KM / miss),
              ];
    const [x, y, z] = [point[0], point[1], point[2] * (1 - FLATTENING)];
    const geocentric = Math.atan2(z, Math.hypot(x, y));
    const latitude = Math.atan(Math.tan(geocentric) / (1 - FLATTENING) ** 2) / precise.DEG_TO_RAD;
    const sidereal = precise.apparentSiderealTime(precise.fromJulianDay(best.jd));
    const longitude = ((((Math.atan2(y, x) / precise.DEG_TO_RAD - sidereal + 180) % 360) + 360) % 360) - 180;
    greatest = { jd: best.jd, latitude, longitude };
    return greatest;
}

const COMPASS_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const MEAN_EARTH_KM = 6371;
// The note's two lines this far apart, in screen pixels, with air between them.
const NOTE_LINE_PX = 19;

/**
 * Two lines over the solar panel: what the greatest eclipse is, its magnitude there as the catalogs give it (for a
 * central eclipse the ratio of the diameters, otherwise the share of the Sun's diameter covered), and how far away;
 * then how far in degrees and when.
 */
function greatestNote(jd: number) {
    const found = greatestAround(jd);
    if (!found) return "";
    const time = precise.fromJulianDay(found.jd);
    const observer = { latitude: found.latitude, longitude: found.longitude };
    const there = precise.eclipse.solar(time, observer);
    const sunR = precise.sun.apparentAngularDiameter(ephemerisDay(found.jd)) / 2;
    const moonR = precise.moon.topocentricAngularDiameter(time, observer) / 2;
    const central = there.separation <= Math.abs(moonR - sunR);
    const kind = central ? (moonR > sunR ? "total" : "annular") : "partial";
    const [p1, p2] = [state.latitude * precise.DEG_TO_RAD, found.latitude * precise.DEG_TO_RAD];
    const dl = (found.longitude - state.longitude) * precise.DEG_TO_RAD;
    const km =
        MEAN_EARTH_KM *
        Math.acos(Math.min(1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl)));
    const bearing = Math.atan2(
        Math.sin(dl) * Math.cos(p2),
        Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl),
    );
    const direction = COMPASS_16[Math.round(((bearing / precise.DEG_TO_RAD + 360) % 360) / 22.5) % 16];
    const dLongitude = ((((found.longitude - state.longitude + 180) % 360) + 360) % 360) - 180;
    const signed = (n: number) => `${n < 0 ? "\u2212" : "+"}${Math.abs(n).toFixed(1)}°`;
    const where = km < 30 ? "here" : `${Math.round(km).toLocaleString("en-US")} km ${direction}`;
    const when = clock(precise.dateFromJulianDay(found.jd), { timeStyle: "short" }).text;
    const y = -HALF + 22;
    // The second line, the way there, takes the reader there: the place and the moment of the greatest eclipse.
    const what = `greatest eclipse, ${kind}, ${Math.round((central ? moonR / sunR : there.magnitude) * 100)}%: ${where}`;
    const detail = `${signed(found.latitude - state.latitude)} latitude, ${signed(dLongitude)} longitude, at ${when}`;
    const goto = `<text x="0" y="${f(y + NOTE_LINE_PX * unitsPerPx)}" class="figure-label eclipse-goto" data-goto="${found.jd},${found.latitude},${found.longitude}"><title>Go to the greatest eclipse, that place and moment</title>${escapeText(detail)}</text>`;
    return svgText(0, y, what, "figure-note") + goto;
}

function renderSolar(jd: number) {
    const time = precise.fromJulianDay(jd);
    const eclipse = precise.eclipse.solar(time, state);
    const sunAltitude = precise.sun.horizontalPosition(time, state).altitude;
    const sunRadiusDeg = precise.sun.apparentAngularDiameter(ephemerisDay(jd)) / 2;
    // As seen from the chosen place, as the library classifies the eclipse: the Moon a little larger than from Earth's center.
    const moonRadiusDeg = precise.moon.topocentricAngularDiameter(time, state) / 2;
    const scale = SUN_RADIUS_UNITS / sunRadiusDeg;
    const moonRadius = moonRadiusDeg * scale;

    // Position angle is measured from the zenith towards increasing azimuth, which is to the right for anyone facing the Sun.
    const angle = eclipse.positionAngle * precise.DEG_TO_RAD;
    const distance = eclipse.separation * scale;
    const [mx, my] = [Math.sin(angle) * distance, -Math.cos(angle) * distance];

    const inner = Math.abs(sunRadiusDeg - moonRadiusDeg);
    const outer = sunRadiusDeg + moonRadiusDeg;
    const total = eclipse.separation <= inner && moonRadiusDeg > sunRadiusDeg;

    // How near totality, by the diameter covered; an annular eclipse leaves a ring too bright for any corona.
    const covered = (outer - eclipse.separation) / (2 * sunRadiusDeg);
    const near =
        moonRadiusDeg > sunRadiusDeg ? Math.min(1, Math.max(0, (covered - CORONA_FROM) / (1 - CORONA_FROM))) : 0;
    const amount = total ? 1 : near * near * (3 - 2 * near);
    let svg = "";
    if (amount > 0) svg += corona(amount);
    // The Sun sits at the center, so the visible horizon is the Sun's apparent altitude over it below; refraction lifts
    // the Sun, the observer's height lowers the horizon. The ground veils whatever is beneath.
    const sunAbove = precise.earth.apparentAltitude(sunAltitude, { observerHeightM: state.heightM });
    const horizon = sunAbove * scale;
    svg += sunGlow(0, 0, SUN_RADIUS_UNITS, horizon, "eclipse-sun") + circle(0, 0, SUN_RADIUS_UNITS, "eclipse-sun");
    const onPanel = distance < HALF * Math.SQRT2 + moonRadius;
    if (onPanel) svg += circle(mx, my, moonRadius, "eclipse-moon-new");

    svg += veiledHorizon(horizon, HALF, unitsPerPx);
    if (!onPanel) svg += offPanelMoon(mx, my);

    let status: string;
    if (eclipse.separation <= inner) status = total ? "total, only the corona is left" : "annular";
    else if (eclipse.separation < outer) {
        const covered = (outer - eclipse.separation) / (2 * sunRadiusDeg);
        status = `partial, ${Math.round(covered * 100)}% of the Sun's diameter covered`;
    } else status = `none, the Moon is ${eclipse.separation.toFixed(1)}° away`;
    return { svg: svg + greatestNote(jd), status };
}

function renderLunar(jd: number) {
    const eclipse = precise.eclipse.lunar(ephemerisDay(jd));
    const time = precise.fromJulianDay(jd);
    // Zenith up, every ecliptic position angle turns by where ecliptic north points on the sky, as a position angle
    // from celestial north at the Moon, less the parallactic angle, where the zenith points.
    const m = precise.moon.apparentPosition(ephemerisDay(jd));
    const pole = 90 - precise.earth.trueObliquity(ephemerisDay(jd));
    const turn =
        precise.positionAngle(m.rightAscension, m.declination, 270, pole) - precise.moon.parallacticAngle(time, state);
    const moonRadius = precise.moon.MEAN_RADIUS_KM / KM_PER_UNIT;
    const umbra = eclipse.umbraRadiusKm / KM_PER_UNIT;
    const penumbra = eclipse.penumbraRadiusKm / KM_PER_UNIT;

    // Ecliptic position angle, from north through increasing longitude (east), which is to the left on the sky; zenith
    // up, turned into the place's sky.
    const angle = (eclipse.positionAngle + turn) * precise.DEG_TO_RAD;
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
    const moonAltitude = precise.moon.horizontalPosition(time, state).altitude;
    const apparent = precise.earth.apparentAltitude(moonAltitude, { observerHeightM: state.heightM });
    // The horizon lies the Moon's apparent altitude below it, at the panel's scale of kilometers at its distance.
    const unitsPerDegree = (precise.moon.distance(ephemerisDay(jd)) * precise.DEG_TO_RAD) / KM_PER_UNIT;
    svg += veiledHorizon(my + apparent * unitsPerDegree, HALF, unitsPerPx);
    return { svg: svg + arrow, status };
}

const RENDERERS = { solar: renderSolar, lunar: renderLunar };
const views = document.querySelectorAll<HTMLElement>(".eclipse-view[data-kind]");

// Under each panel, a slider through the eclipse in minutes (see offset.ts): two hours either way for the Sun, three
// for the Moon, which takes longer to cross Earth's shadow.
offsetSliders();

// The status line's height above the panel's foot, clear of the buttons there.
const STATUS_BOTTOM_PX = 48;
const searchMessages = new WeakMap<Element, string>();

function render() {
    for (const view of views) {
        const panel = find<SVGSVGElement>(".eclipse-panel > svg", view);
        unitsPerPx = (2 * HALF) / (panel.clientWidth || 2 * HALF);
        const { svg, status } = RENDERERS[view.dataset.kind as keyof typeof RENDERERS](state.jd);
        // What the panel shows, in words, under the discs and above the buttons; a search that found nothing says so
        // there instead, until the next change.
        const line = searchMessages.get(view) ?? status;
        searchMessages.delete(view);
        drawSvg(panel, svg + svgText(0, HALF - STATUS_BOTTOM_PX * unitsPerPx, line, "figure-note"), unitsPerPx);
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
        const view = button.closest(".eclipse-view");
        const jd = nearestEclipse(state.jd, Number(button.dataset.step), button.dataset.jump === "lunar");
        if (jd !== null) update({ jd, live: false, animate: false });
        else if (view) {
            searchMessages.set(view, `none within ${SEARCH_YEARS} years of this moment`);
            render();
        }
    });
}

// The corona turns only while its panel is in view: off screen its animations pause, where they are.
for (const panel of document.querySelectorAll<SVGSVGElement>('.eclipse-view[data-kind="solar"] .eclipse-panel > svg')) {
    new IntersectionObserver(([entry]) => {
        if (entry?.isIntersecting) panel.unpauseAnimations();
        else panel.pauseAnimations();
    }).observe(panel);
}

// A click on the greatest eclipse's note goes there: its moment, and its place, at the observer's height.
for (const panel of document.querySelectorAll<SVGSVGElement>('.eclipse-view[data-kind="solar"] .eclipse-panel > svg')) {
    panel.addEventListener("click", (event) => {
        const target = (event.target as Element).closest?.("[data-goto]");
        const [jd, latitude, longitude] = (target?.getAttribute("data-goto") ?? "").split(",").map(Number);
        if (jd === undefined || latitude === undefined || longitude === undefined || Number.isNaN(jd)) return;
        update({ jd: Number(jd.toFixed(7)), latitude, longitude, live: false, animate: false });
    });
}

const [first] = views;
const requestRender = onDemand(render, first?.parentElement ?? undefined);
onChange(requestRender);
// The arrows are sized in screen pixels, so a resized panel redraws them.
if (first) new ResizeObserver(requestRender).observe(first);
render();
