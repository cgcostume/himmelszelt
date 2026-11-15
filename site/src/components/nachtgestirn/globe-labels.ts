import type { MoonAt } from "./renderer";
import { tileFrame } from "./tiles";

const DEG = Math.PI / 180;
const MOON_KM = 1737.4;

type Kind = "mare" | "crater" | "site";
/** A named feature: latitude and east longitude in degrees, diameter in km, and from which tier on it shows. */
type Feature = [name: string, kind: Kind, lat: number, lon: number, km: number, tier: 1 | 2 | 3];

// After the IAU's Gazetteer of Planetary Nomenclature, rounded: the maria and craters every map of the Moon names, the
// far side's largest, and the Apollo landing sites. Tier 1 shows on the whole disc, 2 and 3 as the view zooms in.
const FEATURES: Feature[] = [
    ["Oceanus Procellarum", "mare", 18.4, -57.4, 2568, 1],
    ["Mare Imbrium", "mare", 32.8, -15.6, 1146, 1],
    ["Mare Serenitatis", "mare", 28.0, 17.5, 707, 1],
    ["Mare Tranquillitatis", "mare", 8.5, 31.4, 873, 1],
    ["Mare Crisium", "mare", 17.0, 59.1, 556, 1],
    ["Mare Fecunditatis", "mare", -7.8, 51.3, 909, 1],
    ["Mare Nectaris", "mare", -15.2, 35.5, 339, 1],
    ["Mare Nubium", "mare", -21.3, -16.6, 715, 1],
    ["Mare Humorum", "mare", -24.4, -38.6, 389, 1],
    ["Mare Frigoris", "mare", 56.0, 1.4, 1596, 1],
    ["Mare Orientale", "mare", -19.4, -92.8, 327, 1],
    ["Mare Moscoviense", "mare", 27.3, 147.9, 277, 1],
    ["South Pole-Aitken basin", "mare", -53.0, -169.0, 2500, 1],
    ["Mare Vaporum", "mare", 13.3, 3.6, 245, 2],
    ["Mare Australe", "mare", -38.9, 93.0, 603, 2],
    ["Mare Smythii", "mare", 1.3, 87.5, 373, 2],
    ["Mare Ingenii", "mare", -33.7, 163.5, 318, 2],
    ["Mare Marginis", "mare", 13.3, 86.1, 358, 3],
    ["Tycho", "crater", -43.31, -11.36, 85, 1],
    ["Copernicus", "crater", 9.62, -20.08, 96, 1],
    ["Kepler", "crater", 8.12, -38.01, 30, 1],
    ["Aristarchus", "crater", 23.73, -47.49, 40, 1],
    ["Plato", "crater", 51.62, -9.38, 101, 1],
    ["Clavius", "crater", -58.62, -14.73, 231, 1],
    ["Grimaldi", "crater", -5.2, -68.6, 173, 1],
    ["Tsiolkovskiy", "crater", -20.38, 129.06, 185, 1],
    ["Ptolemaeus", "crater", -9.16, -1.84, 154, 2],
    ["Alphonsus", "crater", -13.39, -2.85, 111, 2],
    ["Arzachel", "crater", -18.26, -1.93, 97, 2],
    ["Archimedes", "crater", 29.72, -3.99, 81, 2],
    ["Eratosthenes", "crater", 14.47, -11.32, 58, 2],
    ["Theophilus", "crater", -11.45, 26.28, 99, 2],
    ["Cyrillus", "crater", -13.2, 24.0, 98, 2],
    ["Catharina", "crater", -18.1, 23.6, 99, 2],
    ["Langrenus", "crater", -8.86, 61.04, 132, 2],
    ["Petavius", "crater", -25.3, 60.4, 184, 2],
    ["Posidonius", "crater", 31.88, 29.99, 95, 2],
    ["Gassendi", "crater", -17.55, -40.13, 110, 2],
    ["Schickard", "crater", -44.4, -54.6, 206, 2],
    ["Maginus", "crater", -50.0, -6.2, 194, 2],
    ["Hertzsprung", "crater", 2.4, -129.2, 536, 2],
    ["Korolev", "crater", -4.4, -157.4, 423, 2],
    ["Apollo", "crater", -36.1, -151.8, 524, 2],
    ["Daedalus", "crater", -5.9, 179.4, 93, 3],
    ["Shackleton", "crater", -89.67, 129.78, 21, 3],
    ["Apollo 11", "site", 0.674, 23.473, 0, 3],
    ["Apollo 12", "site", -3.012, -23.422, 0, 3],
    ["Apollo 14", "site", -3.645, -17.471, 0, 3],
    ["Apollo 15", "site", 26.132, 3.634, 0, 3],
    ["Apollo 16", "site", -8.973, 15.501, 0, 3],
    ["Apollo 17", "site", 20.191, 30.772, 0, 3],
];
// The disc's radius on screen in px from which a tier shows.
const TIER_PX = { 1: 160, 2: 500, 3: 1400 };
const FONT_PX = 12;
// The geometry's color, light on the dark sky in either theme.
const GEOMETRY = "rgb(255 196 120)";
const EARTH = "rgb(120 175 255)";
// The lines out of the Moon in px at every zoom: the arrows to the Sun and Earth out of the points under them, and from
// behind the limb, the axis out of the poles, the tick at the limb.
const ARROW_PX = 48;
const ARROW_BEHIND_PX = 28;
const AXIS_PX = 36;
const AXIS_BEHIND_PX = 20;
// The gap between the limb and a line coming out from behind it.
const LINE_GAP_PX = 6;
const LIMB_PX = 14;
// The stretch of the limb traced either side of its tick, in px, in steps fading out.
const LIMB_ARC_PX = 70;
const LIMB_STEPS = 16;

type V = readonly number[];
const dot = (a: V, b: V) => (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const cross = (a: V, b: V) => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
];
const normalize = (v: V) => {
    const l = Math.hypot(...v) || 1;
    return v.map((c) => c / l);
};
const sum = (a: V, b: V, k = 1) => a.map((c, i) => c + k * (b[i] ?? 0));
const escaped = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The view the overlay matches: the canvas' size in CSS px, its degrees of sky across, the offset right and up. */
export interface LabelView {
    width: number;
    height: number;
    degreesAcross: number;
    offset: readonly [number, number];
}

/**
 * The annotations over the globe into `svg`, projected as the tile renderer projects the Moon: the terminator, the
 * limb, the axis, the points under the Sun and under Earth, the edge of the near side, and named maria, craters and
 * landing sites, the finer ones as the view zooms in, none over another.
 */
export function drawLabels(svg: SVGSVGElement, m: MoonAt & { earthDirection?: V }, view: LabelView) {
    const frame = tileFrame(m);
    let { right, up } = frame;
    let forward = frame.toward.map((t) => -t);
    const [ox, oy] = [Math.tan(view.offset[0] * DEG), Math.tan(view.offset[1] * DEG)];
    forward = normalize(sum(sum(forward, right, ox), up, oy));
    right = normalize(cross(forward, up));
    up = cross(right, forward);
    const half = Math.tan((view.degreesAcross * DEG) / 2);
    const halfY = (half * view.height) / view.width;
    const project = (dir: V): [number, number] => {
        const z = dot(dir, forward);
        return [
            (0.5 + dot(dir, right) / z / half / 2) * view.width,
            (0.5 - dot(dir, up) / z / halfY / 2) * view.height,
        ];
    };
    const d = m.trueDirection;
    const sinR = Math.sin((m.geocentricDiameter / 2) * DEG);
    const o = m.orientation;
    const toWorld = (p: V) =>
        [0, 1, 2].map(
            (j) =>
                (o[j * 3] ?? 0) * (p[0] ?? 0) + (o[j * 3 + 1] ?? 0) * (p[1] ?? 0) + (o[j * 3 + 2] ?? 0) * (p[2] ?? 0),
        );
    const onSky = (w: V, r = 1) => normalize(sum(d, w, sinR * r));
    // Above 0 where a point of the surface faces the viewer: the cosine of its angle to the viewer, less the limb's.
    const facing = (w: V) => -dot(w, d) - sinR;
    const center = project(d);
    const radiusPx = Math.hypot(...sum(project(onSky(frame.right)), center, -1));
    const inView = ([x, y]: V) =>
        (x ?? -1) > -40 && (x ?? -1) < view.width + 40 && (y ?? -1) > -40 && (y ?? -1) < view.height + 40;
    const fade = (w: V) => Math.max(0, Math.min(1, (facing(w) - 0.03) / 0.15));

    let lines = "";
    let texts = "";
    const placed: [number, number, number, number][] = [];
    const fits = (x: number, y: number, w: number, h: number) => {
        if (x < 2 || y < 2 || x + w > view.width - 2 || y + h > view.height - 2) return false;
        if (placed.some(([px, py, pw, ph]) => x < px + pw && px < x + w && y < py + ph && py < y + h)) return false;
        placed.push([x, y, w, h]);
        return true;
    };
    const textWidth = (s: string, italic = false) => s.length * FONT_PX * (italic ? 0.5 : 0.55);
    const label = (s: string, x: number, y: number, anchor: "start" | "middle" | "end", cls: string, opacity = 1) => {
        const w = textWidth(s, cls === "mare");
        const left = anchor === "start" ? x : anchor === "middle" ? x - w / 2 : x - w;
        if (!fits(left - 2, y - FONT_PX / 2 - 2, w + 4, FONT_PX + 4)) return false;
        texts += `<text class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" opacity="${opacity.toFixed(2)}">${escaped(s)}</text>`;
        return true;
    };
    const f = (n: number) => n.toFixed(1);
    const path = (points: ([number, number] | null)[]) => {
        let s = "";
        let open = false;
        for (const p of points) {
            if (p) {
                s += `${open ? "L" : "M"}${f(p[0])},${f(p[1])}`;
                open = true;
            } else open = false;
        }
        return s;
    };
    // Where a point `v` radii from the Moon's center shows on screen.
    const at = (v: V) => project(normalize(sum(d, v, sinR)));
    // A great circle about `normal` where it faces the viewer, by `slack` of `facing` behind the limb too, and where
    // `keep` holds: sampled over that arc alone, from the point facing the viewer most outwards, so its dashes stay put
    // as the view moves. And the point for its name, on it nearest the view's middle, smoothly.
    const greatCircle = (normal: V, keep: (w: V) => boolean = () => true, slack = 0) => {
        const n = normalize(normal);
        const toViewer = d.map((c) => -c);
        const along = sum(toViewer, n, -dot(toViewer, n));
        const l = Math.hypot(...along);
        const limit = sinR - slack;
        const middle =
            l > 1e-9 ? along.map((c) => c / l) : normalize(cross(n, Math.abs(n[2] ?? 0) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
        const reach = l > 1e-9 ? limit / l : limit < 0 ? -1 : 1;
        if (reach >= 1) return { d: "", labelAt: null };
        const end = Math.acos(Math.max(-1, reach));
        const side = cross(n, middle);
        const point = (t: number) =>
            sum(
                middle.map((c) => c * Math.cos(t)),
                side,
                Math.sin(t),
            );
        let drawn = "";
        for (const sign of [1, -1])
            drawn += path(
                Array.from({ length: 121 }, (_, i) => {
                    const w = point((sign * end * i) / 120);
                    return keep(w) ? at(w) : null;
                }),
            );
        // Nearest the view's middle on screen: a ternary search along the arc, smooth as the view moves.
        const away = (t: number) => {
            const [x, y] = at(point(t));
            return (x - view.width / 2) ** 2 + (y - view.height / 2) ** 2;
        };
        let [lo, hi] = [-0.85 * end, 0.85 * end];
        for (let k = 0; k < 40; k++) {
            const [m1, m2] = [lo + (hi - lo) / 3, hi - (hi - lo) / 3];
            if (away(m1) < away(m2)) hi = m2;
            else lo = m1;
        }
        const nearest = (lo + hi) / 2;
        return { d: drawn, labelAt: point(nearest) };
    };

    // The geometry first, so the names give way to it. The part earthshine lights, night but facing Earth, edged in a
    // faint blue: where Earth sets, on the limb as seen from Earth, and the terminator along it.
    const sun = m.moonSunDirection;
    const toEarth = m.earthDirection ?? d.map((c) => -c);
    // Behind the limb only while Earth is on the viewer's side, so it lies on the limb, not round a part out of sight.
    const earthSide = dot(toEarth, d) < 0;
    const earthEdge = greatCircle(toEarth, (w) => dot(w, sun) < 0 && (earthSide || facing(w) > 0), 1.02 * sinR);
    const earthTerminator = greatCircle(sun, (w) => dot(w, toEarth) > 0);
    for (const edge of [earthEdge, earthTerminator]) if (edge.d) lines += `<path class="earthlit" d="${edge.d}"/>`;
    const earthlit = normalize(sum(toEarth, sun, -1));
    if (dot(earthlit, sun) < -0.2 && dot(earthlit, toEarth) > 0.2 && facing(earthlit) > 0.1) {
        const [x, y] = at(earthlit);
        if (inView([x, y])) label("earthshine", x, y + 4, "middle", "earth", fade(earthlit));
    }
    const terminator = greatCircle(sun);
    if (terminator.d) {
        lines += `<path class="geometry" d="${terminator.d}" stroke-dasharray="5 4"/>`;
        if (terminator.labelAt) {
            const [x, y] = at(terminator.labelAt);
            label("terminator", x + 6, y - 10, "start", "geometry-label");
        }
    }
    const nearSide = greatCircle(toWorld([1, 0, 0]));
    if (nearSide.d) {
        lines += `<path class="geometry faint" d="${nearSide.d}" stroke-dasharray="2 4"/>`;
        if (nearSide.labelAt) {
            const [x, y] = at(nearSide.labelAt);
            label("edge of the near side", x + 6, y + 14, "start", "geometry-label");
        }
    }

    // Lines out of the Moon along `w` from the point under it, `px` long at every zoom and foreshortened as the sphere
    // turns it, so their tips move smoothly as the point goes round behind the Moon. There the part the Moon hides is
    // cut off, a gap off the limb opening as it turns away, and the tip stays at least `behindPx` out past the gap.
    const outOf = (w: V, px: number, behindPx: number) => {
        const [sx, sy] = [dot(w, right), -dot(w, up)];
        const l = Math.hypot(sx, sy);
        const ahead = facing(w) > 0;
        if (!ahead && l < 1e-6) return null;
        const u = (l > 1e-6 ? [sx / l, sy / l] : [0, 0]) as readonly [number, number];
        const surface = at(w);
        let to = [surface[0] + u[0] * px * l, surface[1] + u[1] * px * l] as const;
        if (ahead) return { from: surface, to, u, behind: false };
        const gap = LINE_GAP_PX * Math.min(1, -facing(w) / 0.05);
        const from = [center[0] + u[0] * (radiusPx + gap), center[1] + u[1] * (radiusPx + gap)] as const;
        const least = radiusPx + gap + behindPx;
        if (Math.hypot(to[0] - center[0], to[1] - center[1]) < least)
            to = [center[0] + u[0] * least, center[1] + u[1] * least] as const;
        return { from, to, u, behind: true };
    };
    // The axis, out of the poles.
    const north = toWorld([0, 0, 1]);
    for (const [pole, name] of [
        [north, "N"],
        [north.map((c) => -c), "S"],
    ] as const) {
        const line = outOf(pole, AXIS_PX, AXIS_BEHIND_PX);
        if (!line || !inView(line.to) || Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1]) < 2) continue;
        lines += `<path class="geometry" d="M${f(line.from[0])},${f(line.from[1])}L${f(line.to[0])},${f(line.to[1])}"/>`;
        label(name, line.to[0] + line.u[0] * 8, line.to[1] + line.u[1] * 8 + 4, "middle", "geometry-label");
    }
    // The limb, pointed at from outside the disc, where it comes nearest the view's upper left.
    {
        const [cx, cy] = [view.width * 0.2 - center[0], view.height * 0.15 - center[1]];
        const l = Math.hypot(cx, cy) || 1;
        const [ux, uy] = [cx / l, cy / l];
        const [ex, ey] = [center[0] + ux * radiusPx, center[1] + uy * radiusPx];
        const [tx, ty] = [ex + ux * LIMB_PX, ey + uy * LIMB_PX];
        if (
            inView([ex, ey]) &&
            inView([tx, ty]) &&
            label("limb", tx + ux * 4, ty + uy * 4 + 4, ux < 0 ? "end" : "start", "geometry-label")
        ) {
            lines += `<path class="geometry" d="M${f(ex)},${f(ey)}L${f(tx)},${f(ty)}"/>`;
            // A stretch of the limb itself, traced along the disc's edge and fading out both ways: on the night side
            // the edge does not show.
            const angle = Math.atan2(uy, ux);
            const span = Math.min(0.7, LIMB_ARC_PX / radiusPx);
            for (let k = -LIMB_STEPS; k < LIMB_STEPS; k++) {
                const [a, b] = [angle + (span * k) / LIMB_STEPS, angle + (span * (k + 1)) / LIMB_STEPS];
                const opacity = 1 - Math.abs(k + 0.5) / LIMB_STEPS;
                const [x1, y1] = [center[0] + Math.cos(a) * radiusPx, center[1] + Math.sin(a) * radiusPx];
                const [x2, y2] = [center[0] + Math.cos(b) * radiusPx, center[1] + Math.sin(b) * radiusPx];
                lines += `<path class="geometry" d="M${f(x1)},${f(y1)}L${f(x2)},${f(y2)}" opacity="${opacity.toFixed(2)}"/>`;
            }
        }
    }
    // The directions to the Sun and to Earth, as arrows out of the points under them: seen from Earth, the one to Earth
    // points at the viewer and shrinks to its point; behind the Moon, a short arrow round the limb, as sternzeit's views
    // point to what is off them.
    for (const [w, name, cls] of [
        [sun, "Sun", "sun"],
        [toEarth, "Earth", "earth"],
    ] as const) {
        const line = outOf(w, ARROW_PX, ARROW_BEHIND_PX);
        if (!line || !inView(line.from)) continue;
        const [ux, uy] = line.u;
        const tip = line.to;
        const length = Math.hypot(tip[0] - line.from[0], tip[1] - line.from[1]);
        lines += `<circle class="${cls}" cx="${f(line.from[0])}" cy="${f(line.from[1])}" r="2.5" opacity="${f(line.behind ? 1 : fade(w))}"/>`;
        if (length < 6) {
            label(name, line.from[0] + 7, line.from[1] + 4, "start", cls);
            continue;
        }
        lines += `<path class="${cls}" d="M${f(line.from[0] + ux * 4)},${f(line.from[1] + uy * 4)}L${f(tip[0])},${f(tip[1])}"/>`;
        const base = [tip[0] - ux * 5, tip[1] - uy * 5] as const;
        const head = [
            [tip[0] + ux * 1.5, tip[1] + uy * 1.5],
            [base[0] - uy * 3, base[1] + ux * 3],
            [base[0] + uy * 3, base[1] - ux * 3],
        ];
        lines += `<polygon class="${cls}" points="${head.map((q) => q.map(f).join(",")).join(" ")}"/>`;
        // Beyond the head where there is room, else beside it, towards the view's middle.
        const outward = ux < -0.3 ? "end" : ux > 0.3 ? "start" : "middle";
        if (!label(name, tip[0] + ux * 8, tip[1] + uy * 8 + 4, outward, cls))
            label(name, tip[0], tip[1] + (uy > 0 ? 16 : -8), ux > 0 ? "end" : "start", cls);
    }

    // The names, the coarsest tier first, each where it faces the viewer and has room.
    for (const tier of [1, 2, 3] as const) {
        if (radiusPx < TIER_PX[tier]) continue;
        for (const [name, kind, lat, lon, km, of] of FEATURES) {
            if (of !== tier) continue;
            const p = [
                Math.cos(lat * DEG) * Math.cos(lon * DEG),
                Math.cos(lat * DEG) * Math.sin(lon * DEG),
                Math.sin(lat * DEG),
            ];
            const w = toWorld(p);
            const opacity = fade(w);
            if (opacity <= 0) continue;
            const [x, y] = project(onSky(w));
            if (!inView([x, y])) continue;
            if (kind === "mare") {
                label(name, x, y + 4, "middle", "mare", opacity);
                continue;
            }
            if (kind === "site") {
                if (label(name, x + 5, y + 4, "start", "site", opacity))
                    lines += `<circle class="site-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" opacity="${opacity.toFixed(2)}"/>`;
                continue;
            }
            // A crater's rim as a circle on the surface, seen foreshortened.
            const east = normalize(cross(north, w));
            const northward = cross(w, east);
            const a = km / 2 / MOON_KM;
            const ring = Array.from({ length: 49 }, (_, i) => {
                const t = (i / 48) * 2 * Math.PI;
                const rim = sum(
                    w.map((c) => c * Math.cos(a)),
                    sum(
                        east.map((c) => c * Math.cos(t)),
                        northward,
                        Math.sin(t),
                    ),
                    Math.sin(a),
                );
                return facing(rim) > 0 ? project(onSky(rim)) : null;
            });
            const xs = ring.flatMap((q) => (q ? [q[0]] : []));
            const big = xs.length > 0 && Math.max(...xs) - Math.min(...xs) > 8;
            const at = big ? Math.max(...xs) + 4 : x + 5;
            if (label(name, at, y + 4, "start", "crater", opacity))
                lines += big
                    ? `<path class="rim" d="${path(ring)}" opacity="${opacity.toFixed(2)}"/>`
                    : `<circle class="site-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.5" opacity="${opacity.toFixed(2)}"/>`;
        }
    }

    const style = `<style>
        text { font: ${FONT_PX}px system-ui, sans-serif; fill: rgb(255 255 255 / 0.92); paint-order: stroke; stroke: rgb(0 0 0 / 0.65); stroke-width: 3px; stroke-linejoin: round; }
        text.mare { font-style: italic; letter-spacing: 0.04em; fill: rgb(235 225 205 / 0.95); }
        text.geometry-label { fill: ${GEOMETRY}; }
        .geometry { fill: none; stroke: ${GEOMETRY}; stroke-width: 1.25; }
        .geometry.faint { opacity: 0.6; }
        .geometry.point { fill: ${GEOMETRY}; stroke: rgb(0 0 0 / 0.6); stroke-width: 1; }
        .earthlit { fill: none; stroke: ${EARTH}; stroke-width: 1; stroke-opacity: 0.35; stroke-linecap: round; }
        text.sun { fill: white; }
        text.earth { fill: ${EARTH}; }
        path.sun, path.earth { fill: none; stroke-width: 1.25; }
        path.sun { stroke: white; }
        path.earth { stroke: ${EARTH}; }
        circle.sun, polygon.sun { fill: white; }
        circle.earth, polygon.earth { fill: ${EARTH}; }
        .rim { fill: none; stroke: rgb(255 255 255 / 0.55); stroke-width: 1; }
        .site-point { fill: rgb(255 255 255 / 0.9); stroke: rgb(0 0 0 / 0.6); stroke-width: 1; }
    </style>`;
    svg.setAttribute("viewBox", `0 0 ${view.width} ${view.height}`);
    svg.innerHTML = `${style}<g>${lines}</g><g>${texts}</g>`;
}
