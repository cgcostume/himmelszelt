import { liftedDirection, shimmerScales, type Vec3 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { morph } from "../dunstkreis/skyframe";
import { onDemand } from "../frame";
import { drawSvg, moonSymbol, svgText, THUMB_RADIUS } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { apply, cross, dot, multiply, noGpu, normalize, rotation, transpose } from "./laws";
import { type MoonAt, moonAt, shimmerThrough, type ToneCurveName } from "./renderer";
import { mapResolutions } from "./resolutions";
import { createTiles } from "./tiles";

const DEG = Math.PI / 180;
const ARCSEC = 206_265;
// The close-up: this share of the disc across, its middle this far from the disc's center, at the lower or upper limb.
const SHARE = 0.5;
const DOWN = 0.35;
// Where the Moon stands when the moment has it below the horizon, in degrees.
const LOW = 4;
// The lens the air is seen through, in meters: a telephoto's.
const APERTURE = 0.1;
// The close-up's width over its height, and the side view's under it.
const ASPECT = 2;
// The side view as dunstkreis' sunlight through the air draws it, not to scale: the planet half as wide, the air four
// times as thick, in km, a band of it a scale height, as many km across right of the zenith; the zenith this far in
// from the left, room for the heights' names and a Moon past it, and room above the air's top and below the observer
// on the ground, in px.
const THICKER = 4;
const GROUND_KM = 3180;
const SCALE_KM = 8;
const TOP_KM = 5 * SCALE_KM;
const AIR_KM = TOP_KM * THICKER;
const VIEW_KM = 1300;
const LEFT_PX = 150;
const ABOVE_PX = 34;
const BELOW_PX = 44;
const AIR_BELOW = [0.5, 0.9];
const heightWithAirBelow = (share: number) => -SCALE_KM * Math.log(1 - share);
// The Moon's apparent altitude from one horizon over the zenith to the other, in degrees, three quarters of the disc
// above both: from high up the horizon sinks below the level, as far as Earth's curve and the air's bending take it,
// and the Moon may follow it down.
const ABOVE_THE_HORIZON = 0.25;
const EARTH_KM = 6371;

/** The apparent altitude of the horizon from `heightM` up, in degrees: the lowest ray `bend` still traces past the ground. */
function apparentHorizon(bend: (apparent: number) => number | null, heightM: number) {
    const dip = Math.acos(EARTH_KM / (EARTH_KM + Math.max(heightM, 0) / 1000)) / DEG;
    let [low, high] = [-dip - 1, 0.5];
    if (bend(low) !== null || bend(high) === null) return -dip;
    for (let i = 0; i < 24; i++) {
        const middle = (low + high) / 2;
        if (bend(middle) === null) low = middle;
        else high = middle;
    }
    return high;
}
// How far the close-up zooms out and in, by the wheel, and each notch's step.
const ZOOM_LEAST = 0.1;
const ZOOM_MOST = 4;
const ZOOM_STEP = 1.15;
const f = (n: number) => n.toFixed(1);

/** `m` moved to `apparent` degrees up at its own azimuth, the Sun and its face turning with it, so it shows the same. */
function atAltitude(m: MoonAt, apparent: number): MoonAt {
    const real = m.trueDirection;
    // Turned in its own vertical plane, past the zenith on to the other side, as high as it is short of 180°.
    const level = normalize([real[0], real[1], 0]);
    const from = Math.atan2(real[2], dot(real, level));
    const up = apparent > 90 ? 180 - apparent : apparent;
    const altitude = (up - (m.bend(up) ?? 0)) * DEG;
    const to = apparent > 90 ? Math.PI - altitude : altitude;
    const moved: Vec3 = [level[0] * Math.cos(to), level[1] * Math.cos(to), Math.sin(to)];
    const r = rotation(normalize(cross(level, [0, 0, 1])), to - from);
    return {
        ...m,
        trueDirection: moved,
        direction: liftedDirection(moved, m.bend),
        moonSunDirection: apply(r, m.moonSunDirection),
        orientation: multiply(m.orientation, transpose(r)),
        earthShadow: null,
    };
}

/** The shimmer figure on `root`: the Moon's lower limb through the air, and the air its light crosses from the side. */
export function shimmerFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const cut = find<SVGSVGElement>("[data-field=cut]", root);
    const note = find("[data-field=note]", root);
    const play = find("[data-field=play]", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    const resolution = mapResolutions(root, "large", requestRender);
    const pressed = (button: Element) => button.getAttribute("aria-pressed") === "true";
    const parts = [...root.querySelectorAll<HTMLElement>("[data-part]")];
    const r0s = [...root.querySelectorAll<HTMLElement>("[data-r0]")];
    const part = (name: string) => parts.some((button) => button.dataset.part === name && pressed(button));
    const r0 = () => Number(r0s.find(pressed)?.dataset.r0 ?? 10) / 100;
    for (const button of parts) {
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", String(!pressed(button)));
            requestRender();
        });
    }
    for (const button of r0s) {
        button.addEventListener("click", () => {
            for (const other of r0s) other.setAttribute("aria-pressed", String(other === button));
            requestRender();
        });
    }
    // The air's own clock, held while paused.
    let clock = 0;
    let last = performance.now();
    const fold = morph(play);
    fold(true);
    play.addEventListener("click", () => {
        const playing = !pressed(play);
        play.setAttribute("aria-pressed", String(playing));
        play.setAttribute("aria-label", playing ? "Pause" : "Play");
        fold(playing);
        last = performance.now();
        requestRender();
    });
    // The close-up zoomed in by the wheel, a double click back.
    let zoom = 1;
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            zoom = Math.min(ZOOM_MOST, Math.max(ZOOM_LEAST, zoom * ZOOM_STEP ** (-event.deltaY / 100)));
            requestRender();
        },
        { passive: false },
    );
    canvas.addEventListener("dblclick", () => {
        zoom = 1;
        requestRender();
    });
    // The horizon from the observer's height, traced once a height, and how low the Moon may go.
    let horizon = { heightM: Number.NaN, model: null as unknown, altitude: 0 };
    let lowest = 0;
    // Below the level the side view draws the Moon's light as low through the air as it really goes: its lowest point
    // as far down from the observer to the ground, in the drawing's thicker air, as the real path's is, from none at
    // the level to the ground at the horizon. Above it, at the angle it has. `undrawn` turns a drawn angle back.
    const drawnDepth = (elevation: number) => {
        const [e, h] = [elevation * DEG, horizon.altitude * DEG];
        return Math.min(1, (1 - Math.cos(e)) / Math.max(1 - Math.cos(h), 1e-9));
    };
    const drawn = (apparent: number) => {
        const elevation = apparent > 90 ? 180 - apparent : apparent;
        if (elevation >= 0) return apparent;
        const { r0, depth } = geometry;
        const down = -Math.acos(Math.min(1, (r0 - depth * drawnDepth(elevation)) / r0)) / DEG;
        return apparent > 90 ? 180 - down : down;
    };
    const undrawn = (angle: number) => {
        const elevation = angle > 90 ? 180 - angle : angle;
        if (elevation >= 0) return angle;
        const { r0, depth } = geometry;
        const share = Math.min(1, (r0 - r0 * Math.cos(elevation * DEG)) / Math.max(depth, 1e-9));
        const h = horizon.altitude * DEG;
        const real = -Math.acos(Math.max(-1, Math.min(1, 1 - share * (1 - Math.cos(h))))) / DEG;
        return angle > 90 ? 180 - real : real;
    };
    // The Moon's apparent altitude set by a drag in the side view, or null for where it stands at the moment.
    let chosen: number | null = null;
    // The observer's height set by a drag in the side view, in meters, or null for the page's.
    let chosenHeight: number | null = null;

    function render() {
        const table = tables();
        if (!table) return;
        const now = performance.now();
        if (pressed(play)) clock += (now - last) / 1000;
        last = now;
        const real = moonAt(state.jd, { ...state, heightM: chosenHeight ?? state.heightM }, table.luts.model);
        const realAltitude = Math.asin(Math.max(-1, Math.min(1, real.direction[2]))) / DEG;
        const heightM = chosenHeight ?? state.heightM;
        if (horizon.heightM !== heightM || horizon.model !== table.luts.model) {
            horizon = { heightM, model: table.luts.model, altitude: apparentHorizon(real.bend, heightM) };
        }
        lowest = horizon.altitude + real.angularDiameter * ABOVE_THE_HORIZON;
        const altitude = Math.max(
            lowest,
            Math.min(180 - lowest, chosen ?? (realAltitude > lowest ? realAltitude : LOW)),
        );
        const m = atAltitude(real, altitude);
        // The close-up's up: towards the zenith, turning on past it as the Moon goes over, so the view does not flip.
        // It looks at the lower limb, or the upper where only that is lit; the Moon's phase as it shows from that up.
        const level = normalize([real.trueDirection[0], real.trueDirection[1], 0]);
        const turn = Math.atan2(m.direction[2], dot(m.direction, level));
        const up = normalize([-level[0] * Math.sin(turn), -level[1] * Math.sin(turn), Math.cos(turn)]);
        const right = cross(m.direction, up);
        const sun = m.moonSunDirection;
        const litAbove = dot(sun, up) > 0;
        const width = canvas.parentElement?.clientWidth || 400;
        const tilePx = Math.round(width * Math.min(window.devicePixelRatio || 1, 2));
        const across = (m.angularDiameter * SHARE) / zoom;
        // How much the refraction squeezes the disc up and down: its lower limb lifted more than its upper.
        const elevation = altitude > 90 ? 180 - altitude : altitude;
        const slope = ((real.bend(elevation + 0.05) ?? 0) - (real.bend(elevation - 0.05) ?? 0)) / 0.1;
        const squeezed = 1 / (1 - slope);
        const shimmer = {
            r0: r0(),
            aperture: APERTURE,
            time: clock,
            dispersion: part("colors") ? 1 : 0,
            motion: part("motion") ? 1 : 0,
            boiling: part("boiling") ? 1 : 0,
        };
        tiles?.draw({ count: 1, width: tilePx, height: Math.round(tilePx / ASPECT), degreesAcross: across }, () => ({
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: resolution(),
            ev100: null,
            albedo: true,
            relief: true,
            shadows: true,
            earthshine: true,
            eclipse: false,
            law: "hapke2012",
            nightVision: false,
            air: true,
            up,
            // At the limb as the air squeezes the disc up and down, zoomed out the whole disc in the middle.
            offset: [0, (litAbove ? 1 : -1) * m.angularDiameter * DOWN * squeezed * Math.min(1, zoom)] as const,
            shimmer,
        }));
        const { airColumn, bend } = shimmerThrough(m, shimmer);
        renderCut(altitude, airColumn, m.heightM, m.lit, dot(sun, right), -dot(sun, up), m.earthshine);
        const { tilt, cell: finest } = shimmerScales(shimmer, airColumn);
        const [rms, cell] = [tilt * ARCSEC, finest * ARCSEC];
        const fringe = bend * 0.0114 * ARCSEC;
        note.textContent =
            `the Moon ${Math.abs(elevation).toFixed(1)}° ${elevation < 0 ? "below the level" : "up"}` +
            `${altitude > 90 ? ", past the zenith" : chosen === null && realAltitude > lowest ? ", where it stands" : ""}: ` +
            `through ${airColumn.toFixed(1)} zenith columns of air · the image moves ${rms.toFixed(1)}″ rms · ` +
            `cells from ${cell.toFixed(1)}″ · blue over red by ${fringe.toFixed(1)}″`;
        if (pressed(play)) requestRender();
    }

    // The side view, as dunstkreis draws its sunlight through the air: the planet, the air's top dashed, the heights up
    // the observer's zenith, named by the real heights and the air below them, the observer to drag up and down, and the
    // light's path from the Moon through the air, strong while in it, the Moon on it to drag.
    const geometry = {
        observer: [0, 0] as [number, number],
        moon: [0, 0] as [number, number],
        scale: 1,
        r0: 1,
        depth: 0,
    };
    function renderCut(
        altitude: number,
        column: number,
        heightM: number,
        lit: number,
        dx: number,
        dy: number,
        earthshine: number,
    ) {
        const width = cut.clientWidth || 800;
        const scale = (width - LEFT_PX - 8) / VIEW_KM;
        const height = Math.round(ABOVE_PX + AIR_KM * scale + BELOW_PX);
        cut.style.height = `${height}px`;
        cut.setAttribute("viewBox", `0 0 ${f(width)} ${height}`);
        const groundY = ABOVE_PX + AIR_KM * scale;
        const zenithX = LEFT_PX;
        const at = (x: number, y: number) => [zenithX + x * scale, groundY - y * scale] as const;
        const [cx, cy] = at(0, -GROUND_KM);
        // The air in bands of a scale height each, the lower the denser, as each holds the ones above; the ground.
        let svg = "";
        for (let band = TOP_KM / SCALE_KM; band >= 1; band--) {
            const r = (GROUND_KM + band * SCALE_KM * THICKER) * scale;
            svg += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" class="shimmer-air"/>`;
        }
        svg += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(GROUND_KM * scale)}" class="figure-ground shimmer-earth"/>`;
        // The heights up the zenith, each named by the real height it stands for, and the air below it.
        const [, topY] = at(0, AIR_KM);
        svg += `<line x1="${f(zenithX)}" y1="${f(groundY)}" x2="${f(zenithX)}" y2="${f(topY)}" class="shimmer-axis"/>`;
        const realKm = (km: number) => `${km > 0.05 && km < 10 ? km.toFixed(1) : Math.round(km)}\u202Fkm`;
        const level = (km: number, share: string) => {
            const [, y] = at(0, km * THICKER);
            let out = `<line x1="${f(zenithX - 5)}" y1="${f(y)}" x2="${f(zenithX)}" y2="${f(y)}" class="shimmer-axis"/>`;
            out += svgText(zenithX - 8, y, realKm(km), "figure-grid-label figure-anchor-end");
            out += svgText(zenithX + 6, y, share, "figure-label figure-anchor-start shimmer-share");
            return out;
        };
        // The observer at its height, in the drawing's thicker air; its name under it, and past the zenith, where the
        // path runs off through the heights' names, the air crossed beside it; the levels' names clear of both.
        const km = Math.min((heightM / 1000) * THICKER, AIR_KM - 1);
        const [ox, oy] = at(0, km);
        const nameY = oy + 15;
        const east = altitude <= 90;
        const clear = (y: number) => Math.abs(y - nameY) > 12 && Math.abs(y - oy) > (east ? 9 : 18);
        for (const share of AIR_BELOW) {
            const [, y] = at(0, heightWithAirBelow(share) * THICKER);
            if (clear(y)) svg += level(heightWithAirBelow(share), `${Math.round(share * 100)}%`);
        }
        if (clear(at(0, AIR_KM)[1]))
            svg += level(TOP_KM, `${Math.floor(100 * (1 - Math.exp(-TOP_KM / 8)))}% of the air below`);
        // Where a ray from the observer at `a` degrees up leaves the air, along it in km, and a point along it in px.
        const r0 = GROUND_KM + km;
        const out = (a: number) => {
            const sin = Math.sin(a * DEG);
            const top = GROUND_KM + AIR_KM;
            return -r0 * sin + Math.sqrt(Math.max(r0 * r0 * sin * sin - r0 * r0 + top * top, 0));
        };
        const along = (a: number, d: number) => [ox + Math.cos(a * DEG) * d, oy - Math.sin(a * DEG) * d] as const;
        geometry.r0 = r0;
        geometry.depth = km;
        const shown = drawn(altitude);
        const air = out(shown) * scale;
        // The Moon past the air, inside the box.
        const room = Math.min(
            Math.cos(shown * DEG) > 1e-3 ? (width - 14 - ox) / Math.cos(shown * DEG) : Infinity,
            Math.cos(shown * DEG) < -1e-3 ? (ox - 14) / -Math.cos(shown * DEG) : Infinity,
            Math.sin(shown * DEG) > 1e-3 ? (oy - 14) / Math.sin(shown * DEG) : Infinity,
            Math.sin(shown * DEG) < -1e-3 ? (height - 12 - oy) / -Math.sin(shown * DEG) : Infinity,
        );
        // The Moon past the air where there is room, else at the box's edge with the air running on behind it.
        const distance = Math.min(air + 20, room);
        const inAir = Math.min(air, distance - 14);
        const [ex, ey] = along(shown, inAir);
        const [mx, my] = along(shown, distance);
        if (distance - inAir > 14)
            svg += `<line x1="${f(ex)}" y1="${f(ey)}" x2="${f(mx)}" y2="${f(my)}" class="shimmer-space"/>`;
        svg += `<line x1="${f(ox)}" y1="${f(oy)}" x2="${f(ex)}" y2="${f(ey)}" class="shimmer-path"/>`;
        const [lx, ly] = along(shown, inAir / 2);
        const name = `${column.toFixed(1)} columns of air`;
        svg += east
            ? svgText(lx + 8, ly - 10, name, "figure-note figure-anchor-start")
            : svgText(ox + 14, oy - 7, name, "figure-note figure-anchor-start");
        // The observer as the sliders' thumb, named with its height and the air below it.
        const real = heightM / 1000;
        svg += `<circle cx="${f(ox)}" cy="${f(oy)}" r="${THUMB_RADIUS}" class="figure-thumb"/>`;
        svg += `<circle cx="${f(ox)}" cy="${f(oy)}" r="12" class="shimmer-grab shimmer-observer-grab"/>`;
        const below = Math.round(100 * (1 - Math.exp(-real / 8)));
        svg += svgText(
            ox + 12,
            nameY,
            `${realKm(real)}, ${below}% of the air below`,
            "figure-label figure-anchor-start",
        );
        svg += `<g class="shimmer-moon">${moonSymbol(mx, my, 9, lit, dx, dy, earthshine)}<circle cx="${f(mx)}" cy="${f(my)}" r="16" class="shimmer-grab"/></g>`;
        svg += svgText(width - 4, 10, "not to scale", "figure-label figure-anchor-end");
        Object.assign(geometry, { observer: [ox, oy], moon: [mx, my], scale });
        drawSvg(cut, svg, 1);
    }

    // The observer dragged up and down its zenith, the Moon around it, from the horizon to a little past the zenith.
    let dragging: "moon" | "observer" | null = null;
    const pointerAt = (event: PointerEvent) => {
        const box = cut.getBoundingClientRect();
        return [event.clientX - box.left, event.clientY - box.top] as const;
    };
    const drag = (event: PointerEvent) => {
        const [x, y] = pointerAt(event);
        const [ox, oy] = geometry.observer;
        if (dragging === "observer") {
            const km = (ABOVE_PX + AIR_KM * geometry.scale - y) / geometry.scale / THICKER;
            chosenHeight = Math.min(Math.max(km, 0), TOP_KM * 0.98) * 1000;
        } else {
            // Down past the horizon on either side it stops there, not jumping over to the other.
            const angle = Math.atan2(oy - y, x - ox) / DEG;
            const apparent = undrawn(angle < -90 ? 360 + angle : angle);
            chosen = Math.max(lowest, Math.min(180 - lowest, apparent));
        }
        requestRender();
    };
    cut.addEventListener("pointerdown", (event) => {
        const [x, y] = pointerAt(event);
        const [ox, oy] = geometry.observer;
        const [mx, my] = geometry.moon;
        if (Math.hypot(x - ox, y - oy) <= 12) dragging = "observer";
        else if (Math.hypot(x - mx, y - my) <= 18 || y < oy - 6) dragging = "moon";
        else return;
        cut.setPointerCapture(event.pointerId);
        event.preventDefault();
        drag(event);
    });
    cut.addEventListener("pointermove", (event) => {
        if (dragging && cut.hasPointerCapture(event.pointerId)) drag(event);
    });
    const release = () => {
        dragging = null;
    };
    cut.addEventListener("pointerup", release);
    cut.addEventListener("pointercancel", release);
    // A double click puts the Moon and the observer back where the page has them.
    cut.addEventListener("dblclick", () => {
        chosen = null;
        chosenHeight = null;
        requestRender();
    });

    onChange(requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
