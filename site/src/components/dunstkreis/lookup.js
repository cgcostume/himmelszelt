import { clampObserverHeight } from "@himmelszelt/dunstkreis";
import Zdog from "zdog";
import { onDemand } from "../frame.js";
import { paintRange } from "../range.js";
import { COMPASS, cssColor } from "../sternzeit/figure.js";
import { onChange, state } from "../sternzeit/state.js";
import { gpu, onSkyView, onTables, quality, recompute, tables } from "./atmosphere.js";
import { geometry, lookups, multiScatteringAt, skyViewAt, transmittanceAt } from "./lutmap.js";
import { keptRay, onPick, pick, picked, unpoint } from "./pick.js";
import { createPreview, TABLE_PREVIEW } from "./preview.js";

// How a view ray becomes a sky-view texel: the ray from the eye, its samples, and at each the two lookups it was built
// from. Drawn to a scale of its own: the air far thicker than it is, and the planet curving one and a half times as fast.

const { Illustration, Anchor, Shape, Ellipse, Vector } = Zdog;
const DEG = Math.PI / 180;
const root = document.querySelector("#lookup");
const field = (name) => root.querySelector(`[data-field="${name}"]`);
const stage = field("scene");
const NAMES = ["transmittance", "multiScattering", "skyView"];

// The planet's radius in scene units, the air's thickness, and how much faster than the planet's the drawing curves.
const RADIUS = 100;
const AIR = 30;
const CURVE = 1.5;
// The compass ring on the ground, this far round the planet from the observer, in true degrees.
const COMPASS_RING = 24;
const COMPASS_LABEL_GAP_PX = 14;
const DRAG_RADIANS_PER_PX = 0.008;

const INK = cssColor("--text", "#d6dae3");
const MUTED = cssColor("--muted", "#8a92a3");
const color = (name) => getComputedStyle(root).getPropertyValue(`--lookup-${name}`).trim();

let zoom = 1;
let stageWidth = 0;
let stageHeight = 0;
const rotation = { x: -12 * DEG, y: 30 * DEG, z: 0 };
const styles = new Map();
function styled(shape, strokePx, dash = null, opacity = 1) {
    styles.set(shape, { strokePx, dash, opacity });
    shape.stroke = strokePx / zoom;
    return shape;
}

const illustration = new Illustration({
    element: stage,
    resize: true,
    rotate: rotation,
    onResize(width, height) {
        // The arcs reach 60 degrees round the drawn planet, the sun stands above: fitted, a little below the middle,
        // and left of the tables where they float over the scene.
        const panel = root.querySelector(".lookup-panel");
        const beside = getComputedStyle(panel).position === "absolute" ? panel.offsetWidth + 24 : 0;
        zoom = Math.min((width - beside) / 2 / (RADIUS * 1.2), height / 2 / (RADIUS * 0.8));
        this.zoom = zoom;
        this.translate.x = -beside / 2 / zoom;
        this.translate.y = RADIUS * 0.2;
        this.setSize(width, height);
        [stageWidth, stageHeight] = [width, height];
        for (const [shape, { strokePx }] of styles) shape.stroke = strokePx / zoom;
    },
});
const scene = new Anchor({ addTo: illustration });

/**
 * A point in km, the observer at the origin and the planet's center at (0, 0, -r0), as drawn: its angle around the
 * center from the observer's zenith times CURVE, its altitude stretched to fill AIR. ENU to Zdog, which is y down and z
 * towards the viewer: x east, y up negated, z north negated.
 */
function drawn(g, r0, p) {
    const c = [p[0], p[1], p[2] + r0];
    const r = Math.hypot(...c);
    const angle = Math.acos(Math.min(Math.max(c[2] / r, -1), 1)) * CURVE;
    const around = Math.atan2(c[1], c[0]);
    const radius = RADIUS + ((r - g.Rg) / g.top) * AIR;
    const [e, n, u] = [
        radius * Math.sin(angle) * Math.cos(around),
        radius * Math.sin(angle) * Math.sin(around),
        radius * Math.cos(angle) - RADIUS,
    ];
    return { x: e, y: -u, z: -n };
}

/** An arc at `altitude` km through the observer's zenith, in the vertical plane at compass `azimuth`. */
function arc(g, r0, altitude, azimuth) {
    const reach = 60 / CURVE;
    return Array.from({ length: 61 }, (_, i) => {
        const a = (-reach + (i / 60) * 2 * reach) * DEG;
        const r = g.Rg + altitude;
        return drawn(g, r0, [
            r * Math.sin(a) * Math.sin(azimuth),
            r * Math.sin(a) * Math.cos(azimuth),
            r * Math.cos(a) - r0,
        ]);
    });
}

// Every ray is drawn straight, its elevation stretched by ELEVATION_STRETCH so a ray skimming the horizon still shows
// its angle, its azimuth kept: the view ray, the sunlight and the rays of the other two tables' texels alike. The
// tables' marks come from the true trace, bent by the air and following the planet's curve.
const ELEVATION_STRETCH = 3;
function drawnDirection(elevation, azimuth) {
    const e = Math.atan(ELEVATION_STRETCH * Math.tan(elevation));
    return { x: Math.cos(e) * Math.sin(azimuth), y: -Math.sin(e), z: -Math.cos(e) * Math.cos(azimuth) };
}

/** How far from drawn point `p` along drawn direction `d` the drawn air ends: at its top, or on the ground. */
function drawnThroughAir(p, d) {
    const o = [p.x, p.y - RADIUS, p.z];
    const b = o[0] * d.x + o[1] * d.y + o[2] * d.z;
    const oo = o[0] * o[0] + o[1] * o[1] + o[2] * o[2];
    const ground = b * b - (oo - RADIUS * RADIUS);
    if (b < 0 && ground >= 0 && -b - Math.sqrt(ground) > 1e-6) return -b - Math.sqrt(ground);
    return -b + Math.sqrt(Math.max(b * b - (oo - (RADIUS + AIR) ** 2), 0));
}

const along = (p, d, t) => ({ x: p.x + d.x * t, y: p.y + d.y * t, z: p.z + d.z * t });

// The sun as the direction it is, not a place: a long line from the observer, fading out step by step.
const SUN_REACH = 1.6 * RADIUS;
const SUN_FADE_STEPS = 16;
function sunDirectionLine(origin, d) {
    for (let i = 0; i < SUN_FADE_STEPS; i++) {
        const path = [
            along(origin, d, (SUN_REACH * i) / SUN_FADE_STEPS),
            along(origin, d, (SUN_REACH * (i + 1)) / SUN_FADE_STEPS),
        ];
        styled(new Shape({ addTo: scene, path, color: INK }), 1.5, null, 1 - i / SUN_FADE_STEPS);
    }
    sunLabelPoint = along(origin, d, SUN_REACH * 0.5);
}

function dot(point, colorValue, px) {
    styled(new Shape({ addTo: scene, translate: point, color: colorValue }), px);
}

// A circle `px` across on screen, always facing the viewer: the scene's turn undone, outermost first, and its units
// made screen pixels.
function billboard(point) {
    const yaw = new Anchor({ addTo: new Anchor({ addTo: scene, translate: point }) });
    const face = new Anchor({ addTo: yaw });
    billboards.push({ yaw, face });
    return face;
}

function halo(point, colorValue, px) {
    styled(new Ellipse({ addTo: billboard(point), diameter: px, color: colorValue }), 1);
}

let billboards = [];
let sky = null;
let info = "";

// The compass directions on a ring round the observer, and the observer's own label: HTML over the scene, placed by
// the same projection.
const compassEl = field("compass");
const compassLabels = COMPASS.map((text) =>
    compassEl.appendChild(
        Object.assign(document.createElement("span"), { className: "dome-compass-label", textContent: text }),
    ),
);
const observerLabel = compassEl.appendChild(
    Object.assign(document.createElement("span"), { className: "lookup-observer" }),
);
const sunLabel = compassEl.appendChild(Object.assign(document.createElement("span"), { className: "lookup-sun" }));
let sunLabelPoint = { x: 0, y: 0, z: 0 };
let compassPoints = [];
let observerPoint = { x: 0, y: 0, z: 0 };

/** Where a scene point shows on the stage, in pixels from its top left. */
function onStage(point) {
    const v = new Vector(point).rotate(rotation);
    const { x, y } = illustration.translate;
    return { x: stageWidth / 2 + (v.x + x) * zoom, y: stageHeight / 2 + (v.y + y) * zoom, z: v.z };
}

const degrees = (value, positive, negative) => `${Math.abs(value).toFixed(2)}° ${value < 0 ? negative : positive}`;
const meters = (m) => (m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(1)} km`);

function rebuild() {
    for (const child of [...scene.children]) child.remove();
    styles.clear();
    billboards = [];
    if (!sky) return;
    const { luts } = tables();
    const g = geometry(luts.model);
    const h = Math.min(clampObserverHeight(state.heightM) / 1000, g.top);
    const r0 = g.Rg + h;
    const sun = sky.sunDirection;
    const sunAzimuth = Math.atan2(sun[0], sun[1]);

    // The ground and the top of the air, through the sun's vertical plane and across it.
    for (const azimuth of [sunAzimuth, sunAzimuth + Math.PI / 2]) {
        styled(new Shape({ addTo: scene, path: arc(g, r0, -h, azimuth), closed: false, color: MUTED }), 1.5);
        styled(
            new Shape({ addTo: scene, path: arc(g, r0, g.top - h, azimuth), closed: false, color: MUTED }),
            1,
            [3, 3],
        );
    }
    // The ground round the observer, where the compass directions stand.
    const around = (azimuth) => {
        const a = COMPASS_RING * DEG;
        return drawn(g, r0, [
            g.Rg * Math.sin(a) * Math.sin(azimuth),
            g.Rg * Math.sin(a) * Math.cos(azimuth),
            g.Rg * Math.cos(a) - r0,
        ]);
    };
    const ring = Array.from({ length: 73 }, (_, i) => around(i * 5 * DEG));
    styled(new Shape({ addTo: scene, path: ring, closed: false, color: MUTED }), 1, [0.1, 4]);
    compassPoints = COMPASS.map((_, i) => around(i * 45 * DEG));
    const origin = drawn(g, r0, [0, 0, 0]);
    observerPoint = origin;
    observerLabel.textContent =
        `observer, ${meters(clampObserverHeight(state.heightM))} up\n` +
        `${degrees(state.latitude, "N", "S")}, ${degrees(state.longitude, "E", "W")}`;
    dot(origin, INK, 7);
    const sunElevation = Math.asin(Math.min(Math.max(sun[2], -1), 1));
    const toSun = drawnDirection(sunElevation, sunAzimuth);
    sunDirectionLine(origin, toSun);
    sunLabel.textContent = `to the Sun, ${(sunElevation / DEG).toFixed(1)}° ${sunElevation < 0 ? "below the horizon" : "up"}`;

    const ray = picked();
    const samples = samplesShown();
    const sizes = Object.fromEntries(NAMES.map((name) => [name, textures[name] ?? { width: 1, height: 1 }]));
    const { trace } = lookups(g, sizes, h, sun, ray, samples);
    const transmittance = color("transmittance");
    const multiple = color("multiScattering");

    if (ray.kind === "view") {
        // Up to the top of the drawn air, or down to its ground where the true ray ends there, the samples spaced along
        // it as evenly as the trace spaces them.
        const elevation = Math.asin(ray.mu);
        const view = drawnDirection(
            trace.hitsGround ? Math.min(elevation, -1e-3) : Math.max(elevation, 0),
            sunAzimuth + ray.azimuth,
        );
        const length = drawnThroughAir(origin, view);
        styled(new Shape({ addTo: scene, path: [origin, along(origin, view, length)], closed: false, color: INK }), 2);
        for (let i = 0; i < trace.points.length; i++) {
            const p = along(origin, view, (length * (i + 0.5)) / trace.points.length);
            const path = [p, along(p, toSun, drawnThroughAir(p, toSun))];
            styled(new Shape({ addTo: scene, path, closed: false, color: transmittance }), 1, null, 0.45);
            halo(p, multiple, 7);
            dot(p, INK, 3.5);
        }
        const up = Math.asin(ray.mu) / DEG;
        info =
            `view ray ${up.toFixed(2)}° up, ${(Math.abs(ray.azimuth) / DEG).toFixed(1)}° from the sun: ${samples} samples, ` +
            `${samples} transmittance and ${samples} multiple scattering lookups, one sky-view texel` +
            (trace.hitsGround ? ", ending on the ground" : "");
    } else {
        // A texel of the other two tables: a point above the observer, the sun at its angle in the sun's plane.
        const altitude = ray.kind === "transmittance" ? ray.r - g.Rg : ray.altitude;
        const mu = ray.kind === "transmittance" ? ray.mu : ray.muS;
        const p = drawn(g, r0, [0, 0, altitude - h]);
        const d = drawnDirection(Math.asin(mu), sunAzimuth);
        const path = [p, along(p, d, drawnThroughAir(p, d))];
        styled(
            new Shape({ addTo: scene, path, closed: false, color: transmittance }),
            ray.kind === "transmittance" ? 2 : 1,
        );
        if (ray.kind === "multiScattering") halo(p, multiple, 16);
        dot(p, INK, 5);
        const angle = (Math.asin(mu) / DEG).toFixed(2);
        info =
            ray.kind === "transmittance"
                ? `transmittance texel: ${altitude.toFixed(2)} km up, towards ${angle}° above the horizontal`
                : `multiple scattering texel: ${altitude.toFixed(2)} km up, the sun ${angle}° high`;
    }
    field("info").textContent = info;
}

function frame() {
    for (const { yaw, face } of billboards) {
        yaw.rotate.set({ x: 0, y: -rotation.y, z: 0 });
        face.rotate.set({ x: -rotation.x, y: 0, z: 0 });
        face.scale.set({ x: 1 / zoom, y: 1 / zoom, z: 1 / zoom });
    }
    illustration.rotate.set(rotation);
    illustration.updateRenderGraph();
    for (const [shape, { dash, opacity }] of styles) {
        if (!shape.svgElement) continue;
        if (dash) shape.svgElement.setAttribute("stroke-dasharray", `${dash[0] / zoom},${dash[1] / zoom}`);
        if (dash) shape.svgElement.setAttribute("stroke-linecap", "round");
        if (opacity < 1) shape.svgElement.setAttribute("opacity", String(opacity));
    }
    // Each label pushed out from the observer on screen, so they keep their distance from the ring at any turn.
    const center = onStage(observerPoint);
    compassPoints.forEach((point, i) => {
        const at = onStage(point);
        const reach = Math.hypot(at.x - center.x, at.y - center.y) || 1;
        const label = compassLabels[i];
        label.style.left = `${at.x + ((at.x - center.x) / reach) * COMPASS_LABEL_GAP_PX}px`;
        label.style.top = `${at.y + ((at.y - center.y) / reach) * COMPASS_LABEL_GAP_PX}px`;
        label.style.opacity = at.z < center.z ? 0.45 : 1;
    });
    observerLabel.style.left = `${center.x}px`;
    observerLabel.style.top = `${center.y}px`;
    const sunAt = onStage(sunLabelPoint);
    sunLabel.style.left = `${sunAt.x}px`;
    sunLabel.style.top = `${sunAt.y}px`;
}
const requestFrame = onDemand(frame);

// The three tables, small, with what the kept ray touches in them, and the texel under the pointer apart: pointing at
// one shows what it stands for, a click keeps it.
const textures = {};
const previews = {};
let marks = null;
let hovered = null;

function paint(name) {
    const texture = textures[name];
    if (!texture) return;
    const image = root.querySelector(`[data-lut="${name}"] [data-field="image"]`);
    previews[name] ??= createPreview(image);
    previews[name].draw(texture, { ...TABLE_PREVIEW[name], filter: "nearest" });
    drawMarks(name);
}

function drawMarks(name) {
    const texture = textures[name];
    const overlay = root.querySelector(`[data-lut="${name}"] [data-field="overlay"]`);
    const dpr = window.devicePixelRatio || 1;
    const [width, height] = [Math.round(overlay.clientWidth * dpr), Math.round(overlay.clientHeight * dpr)];
    if (overlay.width !== width || overlay.height !== height) Object.assign(overlay, { width, height });
    const context = overlay.getContext("2d");
    context.clearRect(0, 0, width, height);
    if (!texture) return;
    if (hovered?.name === name) {
        // The texel under the pointer: a dashed outline, apart from the kept ones.
        const [w, h] = [width / texture.width, height / texture.height];
        const [x0, y0] = [hovered.column * w, hovered.shownRow * h];
        context.strokeStyle = color("skyView");
        context.lineWidth = Math.max(1, dpr);
        context.setLineDash([3 * dpr, 2 * dpr]);
        context.strokeRect(x0 - 2 * dpr, y0 - 2 * dpr, Math.max(w, 4 * dpr) + 4 * dpr, Math.max(h, 4 * dpr) + 4 * dpr);
        context.setLineDash([]);
    }
    if (!marks) return;
    const texels = marks[name];
    context.fillStyle = context.strokeStyle = color(name);
    context.lineWidth = Math.max(1, dpr);
    for (const { x, y } of texels) {
        const column = Math.round(x);
        const row = TABLE_PREVIEW[name].flip ? texture.height - 1 - Math.round(y) : Math.round(y);
        const [cx, cy] = [((column + 0.5) / texture.width) * width, ((row + 0.5) / texture.height) * height];
        if (texels.length === 1) {
            const [w, h] = [Math.max(width / texture.width, 4 * dpr), Math.max(height / texture.height, 4 * dpr)];
            context.strokeRect(cx - w / 2 - dpr, cy - h / 2 - dpr, w + 2 * dpr, h + 2 * dpr);
            continue;
        }
        context.beginPath();
        context.arc(cx, cy, 1.5 * dpr, 0, 2 * Math.PI);
        context.fill();
    }
}

function update() {
    if (!sky) return;
    const g = geometry(tables().luts.model);
    const h = Math.min(clampObserverHeight(state.heightM) / 1000, g.top);
    if (NAMES.every((name) => textures[name])) {
        marks = lookups(g, textures, h, sky.sunDirection, keptRay(), samplesShown()).texels;
    }
    for (const name of NAMES) drawMarks(name);
    rebuild();
    requestFrame();
}

// What the texel under the pointer stands for, like the tables figure's own.
function rayAt(name, event) {
    const texture = textures[name];
    const rect = event.currentTarget.getBoundingClientRect();
    const column = Math.min(Math.floor(((event.clientX - rect.left) / rect.width) * texture.width), texture.width - 1);
    const shownRow = Math.min(
        Math.floor(((event.clientY - rect.top) / rect.height) * texture.height),
        texture.height - 1,
    );
    hovered = { name, column, shownRow };
    const row = TABLE_PREVIEW[name].flip ? texture.height - 1 - shownRow : shownRow;
    const g = geometry(tables().luts.model);
    if (name === "transmittance") {
        const { r, mu } = transmittanceAt(g, texture, column, row);
        return { kind: name, r, mu };
    }
    if (name === "multiScattering") return { kind: name, ...multiScatteringAt(g, texture, column, row) };
    const h = Math.min(clampObserverHeight(state.heightM) / 1000, g.top);
    const { mu, azimuth } = skyViewAt(g, texture, h, column, row);
    const current = picked();
    return { kind: "view", mu, azimuth: current.kind === "view" && current.azimuth < 0 ? -azimuth : azimuth };
}

if (gpu.error) {
    root.querySelector(".lookup-panel").hidden = true;
} else {
    const show = (name, texture) => {
        textures[name] = texture;
        paint(name);
    };
    onTables(({ luts }) => {
        show("transmittance", luts.transmittance);
        show("multiScattering", luts.multiScattering);
        update();
    });
    onSkyView((next) => {
        sky = next;
        show("skyView", next.pass.skyViewTexture);
        update();
    });
    onPick(update);
    onChange(update);
    const { luts } = tables();
    show("transmittance", luts.transmittance);
    show("multiScattering", luts.multiScattering);
    for (const name of NAMES) {
        const box = root.querySelector(`[data-lut="${name}"]`);
        const image = box.querySelector('[data-field="image"]');
        image.addEventListener("pointermove", (event) => textures[name] && pick(rayAt(name, event)));
        image.addEventListener("click", (event) => textures[name] && pick(rayAt(name, event), true));
        image.addEventListener("pointerleave", () => {
            hovered = null;
            drawMarks(name);
            unpoint();
        });
        new ResizeObserver(() => paint(name)).observe(image);
    }
}

let dragFrom = null;
stage.addEventListener("pointerdown", (event) => {
    dragFrom = { x: event.clientX, y: event.clientY };
    stage.setPointerCapture(event.pointerId);
});
stage.addEventListener("pointermove", (event) => {
    if (!dragFrom) return;
    rotation.y -= (event.clientX - dragFrom.x) * DRAG_RADIANS_PER_PX;
    rotation.x = Math.min(0, Math.max(-80 * DEG, rotation.x - (event.clientY - dragFrom.y) * DRAG_RADIANS_PER_PX));
    dragFrom = { x: event.clientX, y: event.clientY };
    requestFrame();
});
stage.addEventListener("pointerup", () => {
    dragFrom = null;
});
new ResizeObserver(requestFrame).observe(stage);

// The sky view's samples per view ray, dunstkreis' own setting: shown in the scene as it is dragged, computed with
// once let go, when the tables figure's slider follows.
const samplesInput = field("samples");
const samplesShown = () => Number(samplesInput.value);
function showSamples() {
    samplesInput.value = String(quality.config.integralSamples.skyView);
    paintRange(samplesInput);
    field("samplesValue").textContent = samplesInput.value;
}
showSamples();
onTables(showSamples);
samplesInput.addEventListener("input", () => {
    paintRange(samplesInput);
    field("samplesValue").textContent = samplesInput.value;
    update();
});
samplesInput.addEventListener("change", () => {
    quality.config.integralSamples.skyView = samplesShown();
    recompute();
});
