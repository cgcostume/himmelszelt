import { fromSelenographic, selenographicPoint, surfaceCircle, type Vec3 } from "@himmelszelt/nachtgestirn";
import { drawSvg, escapeText, SUN_SYMBOL, sunGlow, sunRays, svgText, THUMB_RADIUS } from "../sternzeit/figure";
import { apply, dot } from "./laws";
import type { MoonAt } from "./renderer";
import { TYCHO } from "./tycho-profile";

const DEG = Math.PI / 180;
const MOON_KM = 1737.4;
// Tycho's diameter, after the IAU's Gazetteer of Planetary Nomenclature.
const TYCHO_KM = 85.3;
// The slice: this many km either side of Tycho's middle, its heights this many times as tall, and room above for the
// Sun's rays and below for the names, in px.
const HALF_KM = 100;
const TALLER = 4;
const ABOVE_PX = 96;
const BELOW_PX = 34;
// The pass' march towards the Sun, as moon.comp.wgsl takes it: steps from three quarters of a texel on, each 1.26 times
// the last, 24 of them, none at all where the Sun stands higher than any slope, 0.45 rad.
const STEPS = 24;
const GROWTH = 1.26;
const STEEPEST = 0.45;
// A normal drawn every this many texels, this long in px.
const NORMAL_EVERY = 6;
const NORMAL_PX = 16;
// The sunlight's hatching, as dunstkreis' sunlight through the air draws it: a line every this many px.
const HATCH_PX = 12;
// The hatching full with the Sun this many degrees over the middle's horizontal, and gone this many below it.
const HATCH_FULL = 2;
const HATCH_GONE = -3;
// How far in from the edges the Sun's symbol stops, its rays and glow whole: the radius, the gap and a ray, and the glow.
const SUN_ROOM_PX = SUN_SYMBOL.radius + SUN_SYMBOL.gap + SUN_SYMBOL.length + 8;
// The mip levels the march reads, the finest map's texels halved this many times.
const MIP_LEVELS = 5;
const f = (n: number) => n.toFixed(1);

type Point = readonly [number, number];

/**
 * A slice through Tycho on `svg`, west to east through its middle from LOLA's heights, as the pass shades and shadows
 * the relief: each texel's normal from its neighbors' heights, and how much of the Sun's disc it sees above the terrain,
 * marched towards the Sun step by growing step. One point's march drawn out: the steps, the highest of them, the
 * terrain's horizon through it and the Sun's disc against it. Drag along the slice to move the point.
 */
/**
 * Tycho and the slice through it on a disc drawn with `right` and `up` across it, seen along `toward`, `radius` px
 * across from `center`: the crater's rim and the slice's line, as SVG, on the near side. Where the disc is small, both
 * at least `least` px, the crater named.
 */
export function tychoMark(
    m: MoonAt,
    frame: { right: readonly number[]; up: readonly number[]; toward: readonly number[] },
    center: Point,
    radius: number,
    least = 0,
) {
    // A direction on the Moon in the observer's frame, and where it shows, or null behind.
    const shown = (n: Vec3): Point | null => {
        if (dot(n, frame.toward as [number, number, number]) < 0) return null;
        return [
            center[0] + dot(n, frame.right as [number, number, number]) * radius,
            center[1] - dot(n, frame.up as [number, number, number]) * radius,
        ];
    };
    const at = (latitude: number, longitude: number) =>
        shown(fromSelenographic(m.orientation, selenographicPoint(longitude, latitude)));
    const { latitude, longitude } = TYCHO;
    const middle = at(latitude, longitude);
    if (!middle) return "";
    // Grown about the middle to `least` px where the disc draws them smaller.
    const grown = (p: Point | null, size: number): Point | null =>
        p && size < least
            ? [middle[0] + ((p[0] - middle[0]) * least) / size, middle[1] + ((p[1] - middle[1]) * least) / size]
            : p;
    const path = (points: (Point | null)[], cls: string) => {
        const d = points.map((p, i) => (p ? `${i && points[i - 1] ? "L" : "M"}${f(p[0])} ${f(p[1])}` : "")).join("");
        return d ? `<path d="${d}" class="${cls}"/>` : "";
    };
    // The crater's rim, a circle on the sphere 85 km across, closed, and the slice along the parallel, as far either way
    // as it is drawn.
    const circle = surfaceCircle(m, longitude, latitude, TYCHO_KM, 32).map(shown);
    const rim = [...circle, circle[0] ?? null];
    const across = HALF_KM / (MOON_KM * Math.cos(latitude * DEG)) / DEG;
    const slice = Array.from({ length: 9 }, (_, i) => at(latitude, longitude + across * (i / 4 - 1)));
    const size = (points: (Point | null)[]) =>
        Math.max(...points.map((p) => (p ? Math.hypot(p[0] - middle[0], p[1] - middle[1]) : 0)));
    const [rimSize, sliceSize] = [size(rim), size(slice)];
    let out = path(
        rim.map((p) => grown(p, rimSize)),
        "tycho-mark",
    );
    out += path(
        slice.map((p) => grown(p, sliceSize / 2)),
        "tycho-mark tycho-mark-slice",
    );
    if (rimSize < least) out += svgText(middle[0] + least + 4, middle[1] + least + 6, "Tycho", "tycho-mark-label");
    return out;
}

export function tychoSlice(
    svg: SVGSVGElement,
    note: HTMLElement | null,
    requestRender: () => void,
    show: { shadows: () => boolean; normals: () => boolean } = { shadows: () => true, normals: () => true },
) {
    const name = svg.parentElement?.querySelector<HTMLElement>("[data-field=sliceName]");
    const heights = TYCHO.heights.map((m) => m / 1000);
    const middle = (heights.length - 1) / 2;
    const texel = TYCHO.texelKm;
    // The profile's mip levels as the map's: each texel of a level the mean of two of the one below, centered between
    // them; read linearly between a level's texels, and between two levels by the fraction, trilinear as the pass.
    const levels: number[][] = [heights];
    while (levels.length <= MIP_LEVELS) {
        const below = levels[levels.length - 1] ?? [];
        levels.push(
            Array.from(
                { length: Math.floor(below.length / 2) },
                (_, k) => ((below[2 * k] ?? 0) + (below[2 * k + 1] ?? 0)) / 2,
            ),
        );
    }
    const inLevel = (s: number, level: number) => {
        const texels = levels[level] ?? heights;
        const at = (middle + s / texel + 0.5) / 2 ** level - 0.5;
        const i = Math.max(0, Math.min(texels.length - 2, Math.floor(at)));
        const t = Math.max(0, Math.min(1, at - i));
        return (texels[i] ?? 0) * (1 - t) + (texels[i + 1] ?? 0) * t;
    };
    // The height at `s` km east of the middle, at a level of the map, fractional between two.
    const heightAt = (s: number, level = 0) => {
        const l = Math.max(0, Math.min(MIP_LEVELS, level));
        const below = Math.floor(l);
        const t = l - below;
        return t > 0 ? inLevel(s, below) * (1 - t) + inLevel(s, below + 1) * t : inLevel(s, below);
    };
    // A point of the slice in its plane, km east and up from the mean surface under the middle, and its up.
    const place = (s: number, h: number): Point => {
        const a = s / MOON_KM;
        return [(MOON_KM + h) * Math.sin(a), (MOON_KM + h) * Math.cos(a) - MOON_KM];
    };
    const upAt = (s: number): Point => [Math.sin(s / MOON_KM), Math.cos(s / MOON_KM)];

    const geometry = { width: 800 };
    // The point whose march is drawn, km east of the middle, or null for the most telling one.
    let chosen: number | null = null;
    let last: MoonAt | null = null;

    function draw(m: MoonAt) {
        last = m;
        const width = svg.clientWidth || 800;
        // The Sun from Tycho, in the slice's plane: its direction cast into the plane from west to east through the
        // middle, which is what shades a profile along it, so it swings through the zenith at noon instead of jumping.
        const up: [number, number, number] = [
            Math.cos(TYCHO.latitude * DEG) * Math.cos(TYCHO.longitude * DEG),
            Math.cos(TYCHO.latitude * DEG) * Math.sin(TYCHO.longitude * DEG),
            Math.sin(TYCHO.latitude * DEG),
        ];
        const east: [number, number, number] = [-Math.sin(TYCHO.longitude * DEG), Math.cos(TYCHO.longitude * DEG), 0];
        const sunOnMoon = apply(m.orientation, m.moonSunDirection);
        const [se, su] = [dot(sunOnMoon, east), dot(sunOnMoon, up)];
        const side = se >= 0 ? 1 : -1;
        const sun: Point = [se / (Math.hypot(se, su) || 1), su / (Math.hypot(se, su) || 1)];
        // Over the middle's horizontal, towards the side the Sun is on: 90° at noon.
        const elevation = Math.atan2(su, Math.abs(se));
        const radius = (m.sunAngularDiameter / 2) * DEG;

        // How much of the Sun's disc the point at `s` sees above the terrain, and its march: the steps, the highest.
        const march = (s: number) => {
            const h = heightAt(s);
            const p = place(s, h);
            const u = upAt(s);
            const toward: Point = [side * u[1], -side * u[0]];
            const own = Math.asin(Math.max(-1, Math.min(1, sun[0] * u[0] + sun[1] * u[1])));
            const steps: { at: Point; angle: number }[] = [];
            if (own > STEEPEST) return { share: 1, own, horizon: -Math.PI / 2, steps, highest: -1, p };
            let horizon = -Math.PI / 2;
            let highest = -1;
            for (let k = 0; k < STEPS; k++) {
                const d = 0.75 * texel * GROWTH ** k;
                const q = s + side * d;
                if (Math.abs(q / texel) > middle) break;
                // Read as coarse as the steps are apart, so no peak falls between two of them.
                const level = Math.max(0, Math.log2((d * 0.3) / texel));
                const at = place(q, heightAt(q, level));
                const v: Point = [at[0] - p[0], at[1] - p[1]];
                const angle = Math.atan2(v[0] * u[0] + v[1] * u[1], v[0] * toward[0] + v[1] * toward[1]);
                steps.push({ at, angle });
                if (angle > horizon) [horizon, highest] = [angle, steps.length - 1];
            }
            const x = Math.max(-1, Math.min(1, (own - horizon) / radius));
            const share = 0.5 + (x * Math.sqrt(1 - x * x) + Math.asin(x)) / Math.PI;
            return { share, own, horizon, steps, highest, p };
        };

        // The view: the slice's km across the width, its heights TALLER times as tall, the lowest and highest in it.
        const scale = width / (2 * HALF_KM);
        const shown: { s: number; p: Point }[] = [];
        for (let i = 0; i < heights.length; i++) {
            const s = (i - middle) * texel;
            if (Math.abs(s) <= HALF_KM + texel) shown.push({ s, p: place(s, heights[i] ?? 0) });
        }
        const ys = shown.map(({ p }) => p[1]);
        const [low, high] = [Math.min(...ys), Math.max(...ys)];
        const height = Math.round(ABOVE_PX + (high - low) * TALLER * scale + BELOW_PX);
        svg.setAttribute("viewBox", `0 0 ${f(width)} ${height}`);
        svg.style.height = `${height}px`;
        const view = ([x, y]: Point): Point => [width / 2 + x * scale, ABOVE_PX + (high - y) * TALLER * scale];

        // The Sun's rays, all parallel, drawn taller too: a direction (x, y) shows as (x, TALLER y).
        const shownAngle = (angle: number): Point => {
            const [x, y] = [side * Math.cos(angle), Math.sin(angle) * TALLER];
            const l = Math.hypot(x, y);
            return [x / l, -y / l];
        };
        let out = "";
        const line = shown.map(({ p }) => view(p));
        const bottom = height + 2;
        // Past the terminator the highest peaks catch the Sun up to some 0.12 rad below the middle's horizontal.
        const day = elevation > -0.12;
        // The share of the Sun every texel of the profile sees, and those shown.
        const everywhere = heights.map((_, i) => (day ? march((i - middle) * texel).share : 0));
        const first = Math.round(middle + (shown[0]?.s ?? 0) / texel);
        const shares = shown.map((_, i) => everywhere[first + i] ?? 0);
        // The shadows in the air above the slice, the Sun's middle cast along parallel rays: walked from the Sun's side,
        // each point's height across the light, the highest of the points before it is where the last ray grazing the
        // terrain runs; a point under it is in its shadow, which reaches back up along that ray to what cast it.
        const shadows: Point[][] = [];
        const shadowed = show.shadows();
        const normals = show.normals();
        if (day && shadowed) {
            const toSun = sun;
            // Square to the light and up, whichever side the Sun is on.
            const across: Point = [-side * toSun[1], side * toSun[0]];
            const order = heights.map((_, i) => (side > 0 ? heights.length - 1 - i : i));
            let caster: Point | null = null;
            let level = Number.NEGATIVE_INFINITY;
            let run: Point[] = [];
            const close = (last: Point | null) => {
                if (caster && last && run.length) {
                    // Back up the ray over the last point in the shadow to the height of what cast it.
                    const a = (last[0] - caster[0]) * toSun[0] + (last[1] - caster[1]) * toSun[1];
                    const top: Point = [caster[0] + a * toSun[0], caster[1] + a * toSun[1]];
                    shadows.push([caster, ...run, top].map(view));
                }
                run = [];
            };
            let last: Point | null = null;
            for (const i of order) {
                const point = place((i - middle) * texel, heights[i] ?? 0);
                const height = point[0] * across[0] + point[1] * across[1];
                if (height >= level) {
                    close(last);
                    [caster, level] = [point, height];
                } else run.push(point);
                last = point;
            }
            close(last);
        }
        const d = (points: Point[]) => `M${points.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
        // The shadows a shade darker, the sunlight's direction hatched over all of it, then the ground over both, and
        // the mean sphere through the middle, dashed.
        // At night all of it in the shadow, the Moon's own.
        if (!day && shadowed) out += `<rect width="${f(width)}" height="${height}" class="tycho-shadow"/>`;
        if (day) {
            for (const polygon of shadows) out += `<path d="${d(polygon)}" class="tycho-shadow"/>`;
            const [dx, dy] = shownAngle(elevation);
            const [nx, ny] = [-dy, dx];
            const reach = Math.hypot(width, height);
            // Fading out as the Sun sinks to the middle's horizon, gone before the last peaks lose it.
            const fade = Math.max(0, Math.min(1, (elevation / DEG - HATCH_GONE) / (HATCH_FULL - HATCH_GONE)));
            out += `<g style="opacity: ${fade.toFixed(2)}">`;
            for (let o = -reach; o <= reach; o += HATCH_PX) {
                const [cx, cy] = [width / 2 + nx * o, height / 2 + ny * o];
                out += `<line x1="${f(cx - dx * reach)}" y1="${f(cy - dy * reach)}" x2="${f(cx + dx * reach)}" y2="${f(cy + dy * reach)}" class="tycho-hatch"/>`;
            }
            out += "</g>";
        }
        out += `<path d="M${line.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}L${f(width)} ${bottom}L0 ${bottom}Z" class="figure-ground"/>`;
        const mean = shown.map(({ s }) => view(place(s, 0)));
        out += `<path d="M${mean.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}" class="tycho-mean"/>`;
        // The surface lit as the pass lights it: the cosine of its normal to the Sun, from the normals, times the share of
        // the Sun it sees, from the march; exposed as a photograph of it would be, the brightest slope full, from the
        // page's color in the shadow to the light's.
        const facing = shown.map((_, i) => {
            const [a, b] = [shown[Math.max(0, i - 1)]?.p, shown[Math.min(shown.length - 1, i + 1)]?.p];
            if (!a || !b) return 0;
            const [ux, uy] = [b[0] - a[0], b[1] - a[1]];
            return Math.max(0, (-uy * sun[0] + ux * sun[1]) / (Math.hypot(ux, uy) || 1));
        });
        const light = shown.map((_, i) => (normals ? (facing[i] ?? 0) : 1) * (shadowed ? (shares[i] ?? 0) : 1));
        const brightest = Math.max(...light, 1e-6);
        for (let i = 1; i < line.length; i++) {
            const [a, b] = [line[i - 1] as Point, line[i] as Point];
            const lit = day ? ((light[i - 1] ?? 0) + (light[i] ?? 0)) / 2 / brightest : 0;
            out += `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" class="tycho-surface" style="stroke: color-mix(in oklab, var(--tycho-lit) ${(8 + 92 * lit).toFixed(0)}%, var(--bg))"/>`;
        }
        // The normals, from the neighbors' heights, square to the slice as it is drawn, taller, as normals transform: each
        // as long as it turns to the Sun, the cosine the pass lights the relief by, and bright where the point sees the
        // Sun, dim in the shadow.
        for (let i = NORMAL_EVERY; normals && i < shown.length - 1; i += NORMAL_EVERY) {
            const [a, b] = [shown[i - 1]?.p, shown[i + 1]?.p];
            const at = line[i];
            if (!a || !b || !at) continue;
            const [ux, uy] = [b[0] - a[0], b[1] - a[1]];
            const lambert = Math.max(0, (-uy * sun[0] + ux * sun[1]) / (Math.hypot(ux, uy) || 1));
            const seen = day ? (shadowed ? (shares[i] ?? 0) : 1) : 0;
            const [tx, ty] = [ux * scale, -uy * TALLER * scale];
            const length = Math.hypot(tx, ty) || 1;
            const [nx, ny] = [ty / length, -tx / length];
            const long = 3 + (NORMAL_PX - 3) * (day ? lambert : 0);
            out += `<line x1="${f(at[0])}" y1="${f(at[1])}" x2="${f(at[0] + nx * long)}" y2="${f(at[1] + ny * long)}" class="tycho-normal" style="opacity: ${(0.3 + 0.7 * seen).toFixed(2)}"/>`;
        }

        // The point whose march is drawn: the tip of the shadow nearest the middle, where the light comes back down from
        // the Sun and the penumbra is widest, else the middle.
        let s0 = chosen;
        if (s0 === null) {
            s0 = 0;
            for (let i = 1; i < shown.length; i++) {
                const [before, after] = side > 0 ? [i, i - 1] : [i - 1, i];
                const tip = (shares[before] ?? 1) < 0.5 && (shares[after] ?? 0) >= 0.5;
                const s = shown[after]?.s ?? 0;
                if (tip && (s0 === 0 || Math.abs(s) < Math.abs(s0))) s0 = s;
            }
        }
        const one = march(s0);
        const p = view(one.p);
        // The Sun no higher than the middle of the switches over the top left corner, level with them.
        const buttons = svg.parentElement?.querySelector(":scope > .view-buttons")?.getBoundingClientRect();
        const box = svg.getBoundingClientRect();
        const sunTop = buttons && buttons.height > 0 ? buttons.top + buttons.height / 2 - box.top : SUN_ROOM_PX;
        const toEdge = ([x, y]: Point, [dx, dy]: Point) => {
            const t = Math.min(
                dx > 0 ? (width - SUN_ROOM_PX - x) / dx : dx < 0 ? (SUN_ROOM_PX - x) / dx : Number.POSITIVE_INFINITY,
                dy < 0 ? (y - sunTop) / -dy : Number.POSITIVE_INFINITY,
            );
            return [x + dx * t, y + dy * t] as Point;
        };
        let readout: string;
        if (!day) {
            readout = "night over Tycho";
        } else {
            const end = toEdge(p, shownAngle(elevation));
            out += `<line x1="${f(p[0])}" y1="${f(p[1])}" x2="${f(end[0])}" y2="${f(end[1])}" class="tycho-ray"/>`;
            out += sunAt(end[0], end[1]);
            if (shadowed && one.steps.length) {
                // Every step in view seen from the point: its angle over the point's horizontal, the highest the horizon.
                const inView = one.steps.map((step) => {
                    const [x] = view(step.at);
                    return x >= 0 && x <= width;
                });
                // The map as the march reads it from this point: ever coarser with the distance, its level growing as the
                // steps grow apart; every step lies on it.
                const reach = one.steps.length ? 0.75 * texel * GROWTH ** (one.steps.length - 1) : 0;
                const seen: Point[] = [];
                for (let d = 0; d <= reach; d += texel / 2) {
                    const q = s0 + side * d;
                    if (Math.abs(q) > HALF_KM + texel) break;
                    const level = d > 0 ? Math.max(0, Math.log2((d * 0.3) / texel)) : 0;
                    seen.push(view(place(q, heightAt(q, level))));
                }
                if (seen.length > 1) {
                    out += `<path d="M${seen.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}" class="tycho-seen"/>`;
                }
                for (const [i, step] of one.steps.entries()) {
                    if (!inView[i]) continue;
                    const [x, y] = view(step.at);
                    out += `<line x1="${f(p[0])}" y1="${f(p[1])}" x2="${f(x)}" y2="${f(y)}" class="tycho-sight"/>`;
                }
                // The highest step, what casts the horizon.
                const highest = one.steps[one.highest];
                if (highest && inView[one.highest]) {
                    const [x, y] = view(highest.at);
                    out += `<circle cx="${f(x)}" cy="${f(y)}" r="3.2" class="tycho-highest"/>`;
                }
                const top = one.steps[one.highest];
                if (top) {
                    const [hx, hy] = view(top.at);
                    const [ux, uy] = [hx - p[0], hy - p[1]];
                    const l = Math.hypot(ux, uy) || 1;
                    const [ex, ey] = toEdge(p, [ux / l, uy / l]);
                    out += `<line x1="${f(p[0])}" y1="${f(p[1])}" x2="${f(ex)}" y2="${f(ey)}" class="tycho-horizon"/>`;
                }
            }
            // Above the steepest slope there is no march: no rim or peak stands higher over a point, so nothing can hide
            // the Sun. The point's own horizontal is turned from the middle's by its arc, towards the Sun east of it.
            if (shadowed && one.own > STEEPEST) {
                const [x, y] = shownAngle(STEEPEST - (s0 / MOON_KM) * side);
                const a = Math.atan2(y, x);
                out += `<line x1="${f(p[0])}" y1="${f(p[1])}" x2="${f(p[0] + Math.cos(a) * 110)}" y2="${f(p[1] + Math.sin(a) * 110)}" class="tycho-steepest"/>`;
            }
            const where =
                Math.abs(s0) < 0.5 ? "the middle" : `${Math.abs(s0).toFixed(0)} km ${s0 > 0 ? "east" : "west"}`;
            const from = side > 0 ? "east" : "west";
            readout = !shadowed
                ? `${where}: the Sun ${(one.own / DEG).toFixed(1)}° up from the ${from}, the relief shaded by its normals alone`
                : one.own > STEEPEST
                  ? `${where}: the Sun ${(one.own / DEG).toFixed(1)}° up from the ${from}, higher than any slope, no march`
                  : `${where}: the Sun ${(one.own / DEG).toFixed(1)}° up from the ${from}, the terrain's horizon ${(one.horizon / DEG).toFixed(1)}° up, ` +
                    `${Math.round(one.share * 100)}% of the Sun's disc above it`;
        }
        out += `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${THUMB_RADIUS}" class="figure-thumb"/>`;
        // The hint as the drawing's title, the tooltip over all of it.
        const hint = svg.dataset.hint ? `<title>${escapeText(svg.dataset.hint)}</title>` : "";
        drawSvg(svg, hint + out, 1);
        if (note) note.textContent = readout;
        if (name) name.textContent = `Tycho, ${2 * HALF_KM} km across, heights ×${TALLER}`;
        geometry.width = width;
    }

    // The Sun as the figures draw it, at the end of its ray.
    function sunAt(x: number, y: number) {
        const r = SUN_SYMBOL.radius;
        let out = sunGlow(x, y, r, 1e4, "figure-sun");
        out += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" class="figure-sun"/>`;
        for (const [a, b] of sunRays()) {
            out += `<line x1="${f(x + a.x)}" y1="${f(y + a.y)}" x2="${f(x + b.x)}" y2="${f(y + b.y)}" class="figure-sun-ray"/>`;
        }
        return out;
    }

    const pick = (event: PointerEvent) => {
        const box = svg.getBoundingClientRect();
        const x = event.clientX - box.left;
        chosen = Math.max(-HALF_KM, Math.min(HALF_KM, ((x / geometry.width) * 2 - 1) * HALF_KM));
        requestRender();
    };
    svg.addEventListener("pointermove", (event) => {
        if (svg.hasPointerCapture(event.pointerId)) pick(event);
    });
    svg.addEventListener("pointerdown", (event) => {
        svg.setPointerCapture(event.pointerId);
        pick(event);
    });
    svg.addEventListener("dblclick", () => {
        chosen = null;
        requestRender();
    });
    return { draw, redraw: () => last && draw(last) };
}
