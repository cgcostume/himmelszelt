import * as precise from "@himmelszelt/sternzeit";
import { APOGEE_KM, drawSvg, escapeText, PERIGEE_KM } from "./figure";
import { ephemerisDay, state } from "./state";

type Vec3 = readonly [number, number, number];

const DEG = precise.DEG_TO_RAD;
// The Moon's radius in Earth's: the two true to each other, only the distance between them squeezed.
const MOON_IN_EARTH = precise.moon.MEAN_RADIUS_KM / 6371;
const PAD = 8;
const LINE = 16;
// The download shows on hover only, over the sketch.
const TOP = PAD;

const f = (n: number) => n.toFixed(2);
const km = (n: number) => `${Math.round(n).toLocaleString("en-US")} km`;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: Vec3): Vec3 => {
    const n = Math.hypot(...v) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const line = (a: readonly number[], b: readonly number[], cls: string) =>
    `<line x1="${f(a[0] ?? 0)}" y1="${f(a[1] ?? 0)}" x2="${f(b[0] ?? 0)}" y2="${f(b[1] ?? 0)}" class="${cls}"/>`;
const polyline = (points: number[][], cls: string) =>
    `<polyline points="${points.map(([x, y]) => `${f(x ?? 0)},${f(y ?? 0)}`).join(" ")}" class="${cls}"/>`;
// A readout over two lines, its name muted above its value.
const readout = (x: number, y: number, name: string, value: string) =>
    `<text x="${f(x)}" y="${f(y)}" dy="0.35em" class="figure-note figure-readout figure-anchor-start"><tspan class="figure-readout-name">${escapeText(name)}</tspan><tspan x="${f(x)}" dy="${LINE}">${escapeText(value)}</tspan></text>`;
// A direction from its right ascension and declination, in degrees, in the equatorial frame of date.
const equatorial = (ra: number, dec: number): Vec3 => [
    Math.cos(dec * DEG) * Math.cos(ra * DEG),
    Math.cos(dec * DEG) * Math.sin(ra * DEG),
    Math.sin(dec * DEG),
];

const mix = (...terms: [number, Vec3][]): Vec3 =>
    terms.reduce<Vec3>((sum, [k, v]) => [sum[0] + k * v[0], sum[1] + k * v[1], sum[2] + k * v[2]], [0, 0, 0]);
type Radec = { rightAscension: number; declination: number };
const orbitNormal = (now: Radec, next: Radec) =>
    unit(cross(equatorial(now.rightAscension, now.declination), equatorial(next.rightAscension, next.declination)));

/** What the sketch shows: the Moon's distance from Earth's center and from the place, and the parallax between them. */
export function parallaxAt(jd: number, locked = true) {
    const t = ephemerisDay(jd);
    const time = precise.fromJulianDay(jd);
    const fromCenter = precise.moon.distance(t);
    const sidereal = precise.apparentSiderealTime(time);
    const apparent = precise.moon.apparentPosition(t);
    const geocentric = precise.equatorialToHorizontal(apparent, sidereal, state);
    const topocentric = precise.moon.horizontalPosition(time, state);
    // As topocentricAngularDiameter has it (Meeus ch. 40): the disc larger by what the place is closer.
    const sinPi = Math.sin(precise.moon.equatorialHorizontalParallax(t) * DEG);
    const fromPlace = fromCenter / (1 + Math.sin(topocentric.altitude * DEG) * sinPi);
    return {
        fromCenter,
        fromPlace,
        topocentric,
        parallax: geocentric.altitude - topocentric.altitude,
        moon: equatorial(apparent.rightAscension, apparent.declination),
        // The normal of the Moon's orbit, on its north side: from where the Moon goes counterclockwise.
        orbit: orbitNormal(apparent, precise.moon.apparentPosition(t + 0.1)),
        // Greenwich's meridian as a right ascension: how far Earth has turned.
        sidereal,
        // How the Moon is turned to the one looking: from Earth's center, or from the place, the diurnal libration added.
        libration: locked ? precise.moon.librations(t) : precise.moon.topocentricLibrations(time, state),
        axis: locked ? precise.moon.positionAngleOfAxis(t) : precise.moon.topocentricPositionAngleOfAxis(time, state),
    };
}

/**
 * Earth and the Moon in `svg`, true to each other but the distance between them squeezed, seen square to the Moon's orbit:
 * Earth as a globe turned as it stands, its axis tilted towards the Moon or away from it, its meridians every 60° and the
 * place's parallel, the place a dot on it, and the line to the Moon from Earth's center and from the place. The Moon at the top
 * where the panel is taller than wide, else to the right. `locked` marks the line the Moon view is seen along.
 */
export function drawParallax(svg: SVGSVGElement, locked: boolean) {
    const width = svg.clientWidth || 200;
    const height = svg.clientHeight || 500;
    svg.setAttribute("viewBox", `0 0 ${f(width)} ${f(height)}`);
    const upright = height >= width;
    const info = parallaxAt(state.jd, locked);
    // The sketch's frame: `a` towards the Moon, `b` across it towards Earth's north pole, `d` towards the viewer.
    // The sky's frame at the Moon, which turns it: `a` towards it, `b` north on the sky, `d` west on the sky.
    const a = info.moon;
    const b = unit([-a[0] * a[2], -a[1] * a[2], 1 - a[2] * a[2]]);
    const d = cross(a, b);
    // The sketch's frame, seen square to the Moon's orbit: `h` towards the Moon, `w` a quarter turn along its orbit. The
    // line to the Moon lies in the drawing, and Earth's axis tilts towards it or away from it over the month.
    const view = info.orbit;
    const h = unit(mix([1, a], [-dot(a, view), view]));
    const w = cross(view, h);
    // Upright the Moon up; lying the Moon to the right. Either way Earth turns counterclockwise.
    const [along, across] = upright ? [height - TOP, width] : [width, height - TOP];
    const earth = upright ? Math.min(across * 0.3, along * 0.14) : Math.min(across * 0.22, along * 0.12);
    const moon = earth * MOON_IN_EARTH;
    const center = upright
        ? [width - PAD - earth * 1.15, height - PAD - earth * 1.15]
        : [PAD + earth * 1.25, TOP + earth * 1.25];
    // The Moon at apogee as far as the panel allows, at perigee as much closer as the ratio of the two, tripled.
    const far = upright ? along - PAD - earth * 1.15 - moon - 8 : along - 2 * PAD - earth * 1.25 - moon - 4;
    const nearest = far * (1 - 3 * (1 - PERIGEE_KM / APOGEE_KM));
    const toSpan = (km: number) => nearest + ((far - nearest) * (km - PERIGEE_KM)) / (APOGEE_KM - PERIGEE_KM);
    const span = toSpan(info.fromCenter);
    const screen = (u: number, v: number) =>
        upright ? [(center[0] ?? 0) - v, (center[1] ?? 0) - u] : [(center[0] ?? 0) + u, (center[1] ?? 0) - v];
    const onGlobe = (p: Vec3) => screen(dot(p, h) * earth, dot(p, w) * earth);
    const onMoon = (p: Vec3) => screen(span + dot(p, h) * moon, dot(p, w) * moon);
    const moonAt = screen(span, 0);

    // A curve on the globe, its near half drawn and its far half faint.
    const curve = (points: Vec3[], cls: string, project = onGlobe) => {
        let out = "";
        let run: number[][] = [];
        let near = dot(points[0] ?? a, view) >= 0;
        const flush = () => {
            if (run.length > 1) out += polyline(run, `${cls}${near ? "" : " back"}`);
        };
        for (const p of points) {
            const front = dot(p, view) >= 0;
            if (front !== near) {
                run.push(project(p));
                flush();
                run = [];
                near = front;
            }
            run.push(project(p));
        }
        flush();
        return out;
    };
    // An axis through a globe, `reach` radii out from its center: dashed inside, solid outside, and faint past the pole
    // on the far side, so the near pole stands out from the far one.
    const axis = (pole: Vec3, reach: number, project: (p: Vec3) => number[]) => {
        let out = line(project(mix([-1, pole])), project(pole), "parallax-axis inner");
        for (const k of [1, -1]) {
            const end = mix([k, pole]);
            out += line(
                project(end),
                project(mix([k * reach, pole])),
                `parallax-axis${dot(end, view) < 0 ? " back" : ""}`,
            );
        }
        return out;
    };
    // A point at a longitude east of Greenwich and a latitude, in the equatorial frame of date.
    const at = (lon: number, lat: number) => equatorial(info.sidereal + lon, lat);
    const around = (lat: number) => Array.from({ length: 73 }, (_, i) => at(i * 5, lat));

    let out = `<circle cx="${f(center[0] ?? 0)}" cy="${f(center[1] ?? 0)}" r="${f(earth)}" class="parallax-earth"/>`;
    for (let lon = 0; lon < 360; lon += 60) {
        out += curve(
            Array.from({ length: 37 }, (_, i) => at(lon, -90 + i * 5)),
            "parallax-grid meridian",
        );
    }
    out += curve(around(0), "parallax-grid equator");
    out += curve(around(state.latitude), "parallax-grid parallel");
    // The axis through the poles, a little past them, the north pole named.
    const north = onGlobe([0, 0, 1.3]);
    out += axis([0, 0, 1], 1.15, onGlobe);
    out += `<text x="${f(north[0] ?? 0)}" y="${f(north[1] ?? 0)}" class="figure-note parallax-label figure-anchor-middle">N</text>`;
    out += `<circle cx="${f(moonAt[0] ?? 0)}" cy="${f(moonAt[1] ?? 0)}" r="${f(moon)}" class="parallax-moon"/>`;
    // The Moon as a globe too, turned as the one looking sees it: its north pole at the position angle of its axis on the
    // sky, tilted towards Earth by the libration in latitude, and its prime meridian off Earth's direction by the
    // libration in longitude. On the sky, north is `b` and east is away from the viewer, `-d`.
    const { longitude: l, latitude: lb } = info.libration;
    const P = info.axis * DEG;
    const toEarth: Vec3 = [-a[0], -a[1], -a[2]];
    const moonPole = mix(
        [Math.cos(lb * DEG) * Math.cos(P), b],
        [-Math.cos(lb * DEG) * Math.sin(P), d],
        [Math.sin(lb * DEG), toEarth],
    );
    const facing = unit(mix([1, toEarth], [-dot(toEarth, moonPole), moonPole]));
    const sideways = cross(moonPole, facing);
    const prime = mix([Math.cos(l * DEG), facing], [-Math.sin(l * DEG), sideways]);
    const primeSide = cross(moonPole, prime);
    const lunar = (lon: number, lat: number) =>
        mix(
            [Math.cos(lat * DEG) * Math.cos(lon * DEG), prime],
            [Math.cos(lat * DEG) * Math.sin(lon * DEG), primeSide],
            [Math.sin(lat * DEG), moonPole],
        );
    for (let lon = 0; lon < 360; lon += 45) {
        out += curve(
            Array.from({ length: 19 }, (_, i) => lunar(lon, -90 + i * 10)),
            "parallax-grid meridian",
            onMoon,
        );
    }
    out += curve(
        Array.from({ length: 37 }, (_, i) => lunar(i * 10, 0)),
        "parallax-grid equator",
        onMoon,
    );
    out += axis(moonPole, 1.3, onMoon);
    // The mean center of the face, which the libration moves off the point facing Earth.
    const middle = onMoon(prime);
    out += `<circle cx="${f(middle[0] ?? 0)}" cy="${f(middle[1] ?? 0)}" r="1.5" class="parallax-ray dot${dot(prime, view) < 0 ? " back" : ""}"/>`;

    // The lines to the Moon, broken halfway, where the distance is squeezed.
    const place = at(state.longitude, state.latitude);
    const [pa, pb] = [dot(place, h) * earth, dot(place, w) * earth];
    // Halfway to the Moon at perigee, so the break holds still while the Moon comes and goes.
    const breakAt = nearest * 0.5;
    const gap = 5;
    const ray = (u: number, v: number, cls: string) => {
        const point = (x: number) => screen(x, v - ((x - u) / (span - u)) * v);
        return line(screen(u, v), point(breakAt - gap), cls) + line(point(breakAt + gap), moonAt, cls);
    };
    const below = info.topocentric.altitude < 0;
    const [onCenter, onPlace] = locked ? ["parallax-ray on", "parallax-ray"] : ["parallax-ray", "parallax-ray on"];
    out += ray(0, 0, onCenter);
    out += ray(pa, pb, `${onPlace}${below ? " below" : ""}`);
    // Fixed, wide enough for any place's line, so the break holds still while the lines move through it.
    const [lo, hi] = [-earth * 0.6, earth * 0.6];
    for (const k of [-1, 1]) {
        out += line(screen(breakAt + k * gap - 2, lo), screen(breakAt + k * gap + 2, hi), "parallax-break");
    }
    // Perigee and apogee as ticks across the line to the Moon, named on the side away from the readouts.
    for (const [name, km] of [
        ["perigee", PERIGEE_KM],
        ["apogee", APOGEE_KM],
    ] as const) {
        const u = toSpan(km);
        const reach = moon + 4;
        out += line(screen(u, -reach), screen(u, reach), "parallax-tick");
        const [tx, ty] = upright ? screen(u, -reach - 4) : screen(u, -reach - 8);
        out += `<text x="${f(tx ?? 0)}" y="${f(ty ?? 0)}" class="figure-label${upright ? " figure-anchor-start" : ""}">${name}</text>`;
    }
    out += `<circle cx="${f(center[0] ?? 0)}" cy="${f(center[1] ?? 0)}" r="2" class="${onCenter} dot"/>`;
    const [px, py] = screen(pa, pb);
    out += `<circle cx="${f(px ?? 0)}" cy="${f(py ?? 0)}" r="3" class="${onPlace} dot${dot(place, view) < 0 ? " back" : ""}"/>`;

    const closer = info.fromCenter - info.fromPlace;
    const rows: [string, string][] = [
        ["geocentric", km(info.fromCenter)],
        ["topocentric", km(info.fromPlace)],
        [
            closer >= 0 ? "closer by" : "farther by",
            `${km(Math.abs(closer))}, ${((Math.abs(closer) / info.fromPlace) * 100).toFixed(1)}%`,
        ],
        [below ? "parallax, set" : "parallax", `${(info.parallax * 60).toFixed(1)}′ lower`],
    ];
    rows.forEach(([name, value], i) => {
        // Upright, a column on the left; lying, two by two along the bottom.
        const [x, y] = upright
            ? [PAD, PAD + 8 + i * 2.6 * LINE]
            : [PAD + (i % 2) * (width / 2), height - PAD - LINE * 1.6 - (1 - Math.floor(i / 2)) * 2.5 * LINE];
        out += readout(x, y, name, value);
    });
    drawSvg(svg, out, 1);
}
