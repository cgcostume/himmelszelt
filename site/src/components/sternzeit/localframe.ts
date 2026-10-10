import type { HorizontalCoords } from "@himmelszelt/sternzeit";
import * as precise from "@himmelszelt/sternzeit";
import Zdog from "zdog";
import { find } from "../dom";
import { onDemand } from "../frame";
import { ARROWHEAD_PX, cssColor, SUN_SYMBOL, sunRays } from "./figure";
import { onChange, state } from "./state";
import "./export";

const { Illustration, Anchor, Shape, Ellipse, Vector } = Zdog;
const DEG = precise.DEG_TO_RAD;

// The horizon's radius in scene units; the whole scene is zoomed to fit its frame. The axes reach a little past it.
const R = 100;
const AXIS = 1.3 * R;
// The azimuth's arc lies on the ground well inside the horizon, so it does not crowd the altitude's.
const AZIMUTH_RADIUS = 0.45 * R;
const CENTER_SHIFT = 0.17;
const TILT_MIN = -85 * DEG;
const TILT_MAX = -8 * DEG;
const DRAG_RADIANS_PER_PX = 0.008;
const LABEL_GAP_PX = 14;
const BODY_GAP_PX = 4;

const INK = cssColor("--text", "#c5c9d2");
const MUTED = cssColor("--muted", "#808899");
const SURFACE = cssColor("--surface", "#12151c");
const ACCENT = cssColor("--accent", "#5aa9ff");

const frameEl = find(".frame-scene");
const labelsEl = find(".frame-labels", frameEl);

const dashes = new Map<Zdog.Anchor, string>();
const DOTTED = "line-dotted";
const DASHED = "line-dashed";
let zoom = 1;
let stageWidth = 0;
let stageHeight = 0;
let centerShiftPx = 0;
// Seen from the southwest and a little above, so east points right and north into the picture.
const rotation = { x: -22 * DEG, y: -35 * DEG, z: 0 };

function styled<T extends Zdog.Shape>(shape: T, strokePx: number, dash: string | null = null) {
    if (dash) dashes.set(shape, dash);
    shape.stroke = strokePx;
    return shape;
}

// Three stacked layers, as in the sun path diagram: whatever is below the horizon, the translucent ground, the rest.
function layer(name: string) {
    return new Illustration({
        element: find<SVGSVGElement>(`.dome-layer[data-layer="${name}"]`, frameEl),
        resize: true,
        rotate: rotation,
        onResize: function (this: Zdog.Illustration, width: number, height: number) {
            stageWidth = width;
            stageHeight = height;
            zoom = Math.min(width / 2 / (AXIS * 1.15), height / (AXIS * 1.7));
            centerShiftPx = height * CENTER_SHIFT;
            this.translate.y = centerShiftPx / zoom;
            this.zoom = zoom;
            this.setSize(width, height);
        },
    });
}
const below = layer("below");
const ground = layer("ground");
const above = layer("above");
const layers = [below, ground, above];

type Point = { x: number; y: number; z: number };

// ENU to Zdog, which is y down and z towards the viewer: x east, y up (negated), z north (negated).
const enu = ([e, n, u]: readonly number[], radius = R): Point => ({ x: e * radius, y: -u * radius, z: -n * radius });
const skyPoint = (horizontal: HorizontalCoords, radius = R) => enu(precise.horizontalToDirection(horizontal), radius);

// Arrowheads are semi-billboards: flat triangles that turn about their arrow to face the viewer (see turnArrowheads).
type Arrowhead = { shaft: Zdog.Shape; shape: Zdog.Shape; tip: Zdog.Vector; d: Zdog.Vector };
const arrowheads: Arrowhead[] = [];

/** An arrow from the origin to `tip`. */
function arrow(addTo: Zdog.Anchor, tip: Point, color: string, strokePx: number) {
    const d = new Vector(tip);
    d.multiply(1 / d.magnitude());
    const shaft = styled(new Shape({ addTo, path: [{ x: 0, y: 0, z: 0 }, tip], color }), strokePx);
    const shape = styled(new Shape({ addTo, path: [tip, tip, tip], fill: true, color }), 1);
    arrowheads.push({ shaft, shape, tip: new Vector(tip), d });
}

/** Turns every arrowhead's wings square to both its arrow and the line of sight. */
function turnArrowheads() {
    // The line of sight in scene coordinates: the screen's z, with the scene's rotation undone in reverse order.
    const view = new Vector({ x: 0, y: 0, z: 1 })
        .rotate({ x: -rotation.x })
        .rotate({ y: -rotation.y })
        .rotate({ z: -rotation.z });
    // Sized in screen pixels, so the shaft ends where the head starts, wherever the zoom is.
    for (const { shaft, shape, tip, d } of arrowheads) {
        const base = new Vector(tip).subtract(new Vector(d).multiply(ARROWHEAD_PX.length / zoom));
        const side = new Vector({
            x: d.y * view.z - d.z * view.y,
            y: d.z * view.x - d.x * view.z,
            z: d.x * view.y - d.y * view.x,
        });
        const length = side.magnitude();
        // Seen along the arrow, any direction across it will do.
        if (length < 1e-3) side.set({ x: 1, y: 0, z: 0 });
        else side.multiply(ARROWHEAD_PX.halfWidth / zoom / length);
        shaft.path = [{ x: 0, y: 0, z: 0 }, base];
        shaft.updatePath();
        shape.path = [tip, new Vector(base).add(side), new Vector(base).subtract(side)];
        shape.updatePath();
    }
}

// Fixed: the ground and the horizon, the dotted meridian from north over the zenith to south, and the ENU axes.
new Ellipse({ addTo: ground, diameter: 2 * R, rotate: { x: Math.PI / 2 }, color: SURFACE, fill: true, stroke: false });
styled(new Ellipse({ addTo: ground, diameter: 2 * R, rotate: { x: Math.PI / 2 }, color: MUTED }), 1);
const meridian = Array.from({ length: 37 }, (_, i) =>
    skyPoint(i <= 18 ? { azimuth: 0, altitude: i * 5 } : { azimuth: 180, altitude: 180 - i * 5 }),
);
styled(new Shape({ addTo: above, path: meridian, closed: false, color: MUTED }), 1, DOTTED);
arrow(above, enu([1, 0, 0], AXIS), INK, 1.5);
arrow(above, enu([0, 1, 0], AXIS), INK, 1.5);
arrow(above, enu([0, 0, 1], AXIS), INK, 1.5);
const STATIC_ARROWHEADS = arrowheads.length;

// The labels are HTML over the scene, each pushed this far out from where its point projects, away from the center.
type Label = { element: HTMLElement; point: Point; push: number };
const labels: Label[] = [];
function label(text: string, point: Point, cls = "", push = LABEL_GAP_PX) {
    const element = document.createElement("span");
    element.className = `dome-compass-label frame-label ${cls}`;
    element.dataset.exportText = "";
    element.textContent = text;
    labelsEl.append(element);
    const entry = { element, point, push };
    labels.push(entry);
    return entry;
}
label("x / E", enu([1, 0, 0], AXIS), "frame-axis");
label("y / N", enu([0, 1, 0], AXIS), "frame-axis");
label("z / up", enu([0, 0, 1], AXIS), "frame-axis");
label("S", skyPoint({ azimuth: 180, altitude: 0 }), "frame-axis");
label("W", skyPoint({ azimuth: 270, altitude: 0 }), "frame-axis");

// Rebuilt whenever the moment or place changes: the pole and the equator for the place, the Sun with its angles.
const dynamic = [new Anchor({ addTo: below }), new Anchor({ addTo: above })];
const anchorFor = (altitude: number) => dynamic[altitude >= 0 ? 1 : 0];
const poleLabel = label("celestial pole", { x: 0, y: 0, z: 0 });
const latitudeLabel = label("", { x: 0, y: 0, z: 0 }, "frame-angle", 0);
const equatorLabel = label("celestial equator", { x: 0, y: 0, z: 0 });
const azimuthLabel = label("", { x: 0, y: 0, z: 0 }, "frame-angle", 0);
const altitudeLabel = label("", { x: 0, y: 0, z: 0 }, "frame-angle");
const directionLabel = label(
    "",
    { x: 0, y: 0, z: 0 },
    "frame-direction",
    SUN_SYMBOL.radius + SUN_SYMBOL.gap + SUN_SYMBOL.length + 12,
);
let bodyUp = true;
const billboards: { yaw: Zdog.Anchor; face: Zdog.Anchor }[] = [];

const degrees = (value: number) => `${value.toFixed(1).replace("-", "−")}°`;
const signed = (value: number) => value.toFixed(2).replace("-", "−");

/** A curve of samples, solid where it is above the horizon and dashed where below, in the layer it belongs to. */
function addCurve(samples: HorizontalCoords[], color: string, strokePx: number, radius = R) {
    let run: HorizontalCoords[] = [];
    const flush = () => {
        if (run.length > 1) {
            const up = run[Math.floor(run.length / 2)].altitude >= 0;
            const path = run.map((s) => skyPoint(s, radius));
            styled(
                new Shape({ addTo: anchorFor(up ? 0 : -1), path, closed: false, color }),
                strokePx,
                up ? null : DASHED,
            );
        }
    };
    for (const sample of samples) {
        const last = run.at(-1);
        if (last && last.altitude >= 0 !== sample.altitude >= 0) {
            flush();
            run = [last];
        }
        run.push(sample);
    }
    flush();
}

function rebuild() {
    const { jd, latitude, longitude, heightM } = state;
    billboards.length = 0;
    arrowheads.length = STATIC_ARROWHEADS;
    for (const anchor of dynamic) {
        for (const child of [...anchor.children]) {
            dashes.delete(child);
            child.remove();
        }
    }
    // The celestial pole stands above the horizon as high as the place's latitude: the north one in the north, the
    // south one in the south. The equator is the great circle a quarter turn from it.
    const poleAzimuth = latitude >= 0 ? 0 : 180;
    const phi = Math.abs(latitude);
    const pole = skyPoint({ azimuth: poleAzimuth, altitude: phi });
    styled(new Shape({ addTo: dynamic[1], path: [{ x: 0, y: 0, z: 0 }, pole], color: MUTED }), 1, DASHED);
    styled(new Shape({ addTo: dynamic[1], translate: pole, color: MUTED }), 5);
    poleLabel.point = pole;
    const poleArc = Array.from({ length: 31 }, (_, i) => ({ azimuth: poleAzimuth, altitude: (phi * i) / 30 }));
    addCurve(poleArc, ACCENT, 1, 0.35 * R);
    latitudeLabel.point = skyPoint({ azimuth: poleAzimuth, altitude: phi / 2 }, 0.48 * R);
    latitudeLabel.element.textContent = `φ ${degrees(phi)}`;

    const [s, c] = [Math.sin(latitude * DEG), Math.cos(latitude * DEG)];
    const equator = Array.from({ length: 121 }, (_, i) => {
        const t = (i / 120) * 2 * Math.PI;
        // East, and the direction a quarter turn below the north pole, which is up over the south for the north.
        const [e, n, u] = [Math.cos(t), -s * Math.sin(t), c * Math.sin(t)];
        return { azimuth: (Math.atan2(e, n) / DEG + 360) % 360, altitude: Math.asin(u) / DEG };
    });
    addCurve(equator, MUTED, 1);
    equatorLabel.point = skyPoint({ azimuth: latitude >= 0 ? 180 : 0, altitude: 90 - phi });

    // The Sun and the Moon as the sun path diagram shows them, over the visible horizon (see earth.apparentAltitude),
    // the same size, the Sun told apart by its rays.
    const time = precise.fromJulianDay(jd);
    const observer = { latitude, longitude, heightM };
    const seen = (body: typeof precise.sun | typeof precise.moon): HorizontalCoords => {
        const horizontal = body.horizontalPosition(time, observer);
        return {
            ...horizontal,
            altitude: precise.earth.apparentAltitude(horizontal.altitude, { observerHeightM: heightM }),
        };
    };
    const sun = seen(precise.sun);
    const moon = seen(precise.moon);
    const sunPoint = skyPoint(sun);
    bodyPoints.sun = sunPoint;
    bodyPoints.moon = skyPoint(moon);
    styled(
        new Shape({ addTo: anchorFor(sun.altitude), translate: sunPoint, color: INK }),
        2 * SUN_SYMBOL.radius,
        sun.altitude > 0 ? "figure-sun-glow" : null,
    );
    const at = new Anchor({ addTo: anchorFor(sun.altitude), translate: sunPoint });
    const yaw = new Anchor({ addTo: at });
    const face = new Anchor({ addTo: yaw });
    billboards.push({ yaw, face });
    for (const path of sunRays()) styled(new Shape({ addTo: face, path, color: INK }), 1, "figure-sun-ray");
    styled(
        new Shape({ addTo: anchorFor(moon.altitude), translate: bodyPoints.moon, color: MUTED }),
        2 * SUN_SYMBOL.radius,
    );

    // The chosen body's direction and its angles.
    const body = annotated === "sun" ? sun : moon;
    // The arrow and the altitude's arc stop short of the body's disc, a small gap before it, in screen pixels.
    const short = (SUN_SYMBOL.radius + BODY_GAP_PX) / zoom;
    arrow(anchorFor(body.altitude), skyPoint(body, R - short), ACCENT, 1.5);
    const foot = skyPoint({ azimuth: body.azimuth, altitude: 0 });
    styled(new Shape({ addTo: dynamic[1], path: [{ x: 0, y: 0, z: 0 }, foot], color: MUTED }), 1, DOTTED);
    // The azimuth on the ground from north through east, the altitude up the vertical circle through the body.
    const azimuthArc = Array.from({ length: 61 }, (_, i) => ({ azimuth: (body.azimuth * i) / 60, altitude: 0 }));
    addCurve(azimuthArc, ACCENT, 1, AZIMUTH_RADIUS);
    azimuthLabel.point = skyPoint({ azimuth: body.azimuth / 2, altitude: 0 }, AZIMUTH_RADIUS + 14);
    azimuthLabel.element.textContent = `A ${degrees(body.azimuth)}`;
    const altitudeEnd = body.altitude - Math.sign(body.altitude) * Math.min(Math.abs(body.altitude), short / R / DEG);
    const altitudeArc = Array.from({ length: 31 }, (_, i) => ({
        azimuth: body.azimuth,
        altitude: (altitudeEnd * i) / 30,
    }));
    addCurve(altitudeArc, ACCENT, 1);
    altitudeLabel.point = skyPoint({ azimuth: body.azimuth, altitude: body.altitude / 2 });
    altitudeLabel.element.textContent = `h ${degrees(body.altitude)}`;
    const [x, y, z] = precise.horizontalToDirection(body);
    directionLabel.point = skyPoint(body);
    bodyUp = body.altitude >= 0;
    directionLabel.element.textContent = `(${signed(x)}, ${signed(y)}, ${signed(z)})`;
}

// Which body the arrow and the angles are for, switched by a click on the other one.
let annotated: "sun" | "moon" = "sun";
const bodyPoints = { sun: { x: 0, y: 0, z: 0 }, moon: { x: 0, y: 0, z: 0 } };
// The labels switch hides every label but the axes' and the compass', as the armillary sphere's does.
const labelsButton = find('[data-field="labels"]', frameEl);
labelsButton.addEventListener("click", () => {
    const on = labelsButton.getAttribute("aria-pressed") !== "true";
    labelsButton.setAttribute("aria-pressed", String(on));
    frameEl.classList.toggle("labels-off", !on);
});

/** Where a scene point shows on the stage, in pixels from its top left corner, and how far it lies towards the viewer. */
function onStage(point: Point) {
    const p = new Vector(point).rotate(rotation);
    return { x: stageWidth / 2 + p.x * zoom, y: stageHeight / 2 + centerShiftPx + p.y * zoom, z: p.z };
}

/** The body whose disc is under the pointer, if any, the nearer one to the viewer first. */
function bodyAt(event: PointerEvent) {
    const box = frameEl.getBoundingClientRect();
    const [x, y] = [event.clientX - box.left, event.clientY - box.top];
    const hits = (["sun", "moon"] as const)
        .map((name) => ({ name, at: onStage(bodyPoints[name]) }))
        .filter(({ at }) => Math.hypot(at.x - x, at.y - y) <= SUN_SYMBOL.radius + 4)
        .sort((a, b) => b.at.z - a.at.z);
    return hits[0]?.name ?? null;
}

function placeLabels() {
    const center = { x: stageWidth / 2, y: stageHeight / 2 + centerShiftPx };
    for (const { element, point, push } of labels) {
        const p = new Vector(point).rotate(rotation);
        // Pushed away from the center, except the vector, which stands straight over its body while that is up and hangs
        // below it while it is down, clear of the axes either way.
        const reach = Math.hypot(p.x, p.y) || 1;
        const [dx, dy] = element === directionLabel.element ? [0, bodyUp ? -1 : 1] : [p.x / reach, p.y / reach];
        element.style.left = `${center.x + p.x * zoom + dx * push}px`;
        element.style.top = `${center.y + p.y * zoom + dy * push}px`;
        element.style.opacity = p.z < 0 && !element.matches(".frame-angle, .frame-direction") ? "0.45" : "1";
    }
}

// A drag turns the scene; a click on the Sun or the Moon annotates that one instead.
const CLICK_PX = 4;
let dragFrom: { x: number; y: number } | null = null;
let pressedAt: { x: number; y: number } | null = null;
frameEl.addEventListener("pointerdown", (event) => {
    // Not on the switch, whose clicks the captured pointer would take away.
    if (event.target instanceof Element && event.target.closest(".frame-options")) return;
    dragFrom = { x: event.clientX, y: event.clientY };
    pressedAt = dragFrom;
    frameEl.setPointerCapture(event.pointerId);
});
frameEl.addEventListener("pointermove", (event) => {
    if (!dragFrom) {
        frameEl.classList.toggle("over-body", bodyAt(event) !== null);
        return;
    }
    rotation.y -= (event.clientX - dragFrom.x) * DRAG_RADIANS_PER_PX;
    rotation.x = Math.min(
        TILT_MAX,
        Math.max(TILT_MIN, rotation.x - (event.clientY - dragFrom.y) * DRAG_RADIANS_PER_PX),
    );
    dragFrom = { x: event.clientX, y: event.clientY };
    requestFrame();
});
frameEl.addEventListener("pointerup", (event) => {
    const clicked = pressedAt && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) < CLICK_PX;
    dragFrom = null;
    pressedAt = null;
    const body = clicked ? bodyAt(event) : null;
    if (body && body !== annotated) {
        annotated = body;
        update();
    }
});

function frame() {
    turnArrowheads();
    for (const { yaw, face } of billboards) {
        yaw.rotate.set({ x: 0, y: -rotation.y, z: 0 });
        face.rotate.set({ x: -rotation.x, y: 0, z: 0 });
        face.scale.set({ x: 1 / zoom, y: 1 / zoom, z: 1 / zoom });
    }
    for (const illustration of layers) {
        illustration.rotate.set(rotation);
        illustration.updateRenderGraph();
    }
    for (const [shape, dash] of dashes) shape.svgElement?.classList.add(dash);
    placeLabels();
}

const requestFrame = onDemand(frame);

function update() {
    rebuild();
    requestFrame();
}

onChange(onDemand(update, frameEl));
// The gaps before the Sun are in screen pixels, so a new size rebuilds.
new ResizeObserver(update).observe(frameEl);
update();
