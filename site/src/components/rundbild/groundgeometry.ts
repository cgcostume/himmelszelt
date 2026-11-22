import Zdog from "zdog";
import { find } from "../dom";
import { onDemand } from "../frame";
import { themeColor, themeColors } from "../sternzeit/figure";
import { bendDistance, bendPoint, groundedBend, groundedMeets } from "./ground-math";
import { setGroundSurface } from "./ground-state";
import { createGroundedView } from "./grounded-view";

// The surface rbGroundedDirection lays an image on, drawn to scale in meters around the point it was taken from: the
// plane out to the reach, the dome from the horizon up, and between them the inverse of the distance faded from the
// one to the other. Two rays from a camera, in the vertical plane through it and the capture point, to where they land.
// Beside it, the chosen HDRI laid on that surface as the grounded figure renders it, seen from that camera.

const { Illustration, Anchor, Shape, Ellipse } = Zdog;
const DEG = Math.PI / 180;
const FAR = 1e9;
const MERIDIANS = 16;
const DRAG_RADIANS_PER_PX = 0.008;
const TILT = { min: -50 * DEG, max: 0 };
// The HDRI view's vertical field of view.
const FOV = 60 * DEG;

const INK = themeColor("--text");
const MUTED = themeColor("--muted");
const SURFACE = themeColor("--surface");
const ACCENT = themeColor("--accent");
const DOTTED = "line-dotted";
const DASHED = "line-dashed";

type Point = { x: number; y: number; z: number };
type Profile = [rho: number, z: number][];

const root = find("#ground-geometry");
const stage = find(".frame-scene", root);
const labelsEl = find(".frame-labels", stage);
const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
const slider = (name: string) => Number(field<HTMLInputElement>(name).value);

const rotation = { x: -20 * DEG, y: -28 * DEG, z: 0 };
// Where the camera looks, in degrees from north through east; it stands across the capture point from there.
let heading = 90;
let zoom = 1;
// The zoom that fits the scene, how many times the reader magnified it, and how far it is moved on the stage, in
// pixels, to keep the point zoomed at under the pointer.
let fitZoom = 1;
let magnify = 1;
const pan = { x: 0, y: 0 };
const MAGNIFY = { min: 0.5, max: 60 };
// What the scene spans, in meters: the capture point's height, the dome's radius above it, and how far out it reaches.
let fit = { height: 1, dome: 1, extent: 1 };
let size = { width: 0, height: 0 };

function layer(name: string) {
    return new Illustration({
        element: find<SVGSVGElement>(`.dome-layer[data-layer="${name}"]`, stage),
        rotate: rotation,
        resize: true,
        onResize(this: Zdog.Illustration, width: number, height: number) {
            this.setSize(width, height);
        },
    });
}
const layers = [layer("ground"), layer("above")];
const [groundAnchor, aboveAnchor] = layers.map((illustration) => new Anchor({ addTo: illustration })) as [
    Zdog.Anchor,
    Zdog.Anchor,
];

const styles = new Map<Zdog.Shape, { dash: string | null; opacity: number }>();
function styled<T extends Zdog.Shape>(shape: T, strokePx: number, dash: string | null = null, opacity = 1) {
    styles.set(shape, { dash, opacity });
    shape.stroke = strokePx;
    return shape;
}
const line = (path: Point[], color: string, strokePx = 1, dash: string | null = null, opacity = 1) =>
    styled(new Shape({ addTo: aboveAnchor, path, closed: false, color }), strokePx, dash, opacity);
const dot = (at: Point, color: string, px = 6) => styled(new Shape({ addTo: aboveAnchor, translate: at, color }), px);

// ENU to Zdog, which is y down and z towards the viewer.
const enu = (e: number, n: number, u: number): Point => ({ x: e, y: -u, z: -n });
// A point of a profile at an azimuth, in degrees from north through east.
const around = ([rho, z]: [number, number], azimuth: number) =>
    enu(rho * Math.sin(azimuth * DEG), rho * Math.cos(azimuth * DEG), z);

// The labels are HTML over the scene, each `dx` and `dy` screen pixels off its point: its near edge when set off to the
// side, its middle otherwise.
type Label = { element: HTMLElement; point: Point; dx: number; dy: number };
const labels: Record<string, Label> = {};
function label(name: string, cls = "", dx = 0, dy = 0) {
    const element = document.createElement("span");
    element.className = `dome-compass-label frame-label ${cls}`;
    element.dataset.exportText = "";
    labelsEl.append(element);
    labels[name] = { element, point: { x: 0, y: 0, z: 0 }, dx, dy };
}
label("capture", "frame-axis", -16, -24);
label("camera", "frame-axis", 0, 14);
label("reach", "frame-angle", 0, 12);
label("dome", "frame-angle", 0, -10);
label("horizon", "", 0, -10);
label("lifted", "frame-angle", 0, 12);
label("blend", "", 0, 12);

const reading = (length: number) => (length >= FAR ? "∞" : length.toFixed(length < 10 ? 1 : 0));
const meters = (length: number) => (length >= FAR ? "∞" : `${reading(length)} m`);
const degrees = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1).replace("-", "−")}°`;

/** The sliders as the grounded figure reads them: logarithmic, the last step without end, the same bounds. */
function parameters() {
    const far = (name: string, from: number) => (slider(name) >= 100 ? FAR : from * 100 ** (slider(name) / 99));
    const height = slider("height");
    const radius = Math.max(far("radius", 5), 2.5 * height);
    const soft = slider("soft");
    const lift = slider("lift");
    // As in ground.wgsl: how high up the dome the bend meets it, the bend itself, the reach at most its circle's; and as
    // the sines of how far below the horizon they lie, the lookups to the plane's edge and to the bend's foot on the
    // dome. Under a dome without end the ground falls away past the reach like a hilltop instead.
    const domed = radius < FAR;
    const meets = groundedMeets(height, radius, soft, lift * DEG);
    const bend = groundedBend(height, far("reach", 3), radius, meets);
    const reach = domed ? height * bend.along : far("reach", 3);
    const edge = domed && bend.corner ? -Math.sin(meets) : height / Math.hypot(height, reach);
    const foot = domed ? -Math.sin(Math.max(meets, -Math.asin(height / radius))) : 0;
    return { height, radius, reach, soft, domed, bend, edge, foot, meets, lift };
}
type Parameters = ReturnType<typeof parameters>;

/** How far from the capture point the surface lies along a direction `down` (the sine of its depression) below it. */
function distance(p: Parameters, down: number) {
    if (down >= p.edge) return down > 0 ? p.height / down : FAR;
    if (!p.domed) {
        // The hilltop: the cubic t^2 (2 - t) of the inverse distance, from the horizon to the plane's edge.
        const t = Math.max(down, 0) / p.edge;
        const inverse = p.edge * t * t * (2 - t);
        return inverse > 0 ? p.height / inverse : FAR;
    }
    if (down <= p.foot) return p.radius;
    return p.height * bendDistance(p.bend, down);
}

/** The point on the surface `angle` above the capture point's horizon, horizontally and up from under it. */
function onSurface(p: Parameters, angle: number): [number, number] {
    const r = distance(p, -Math.sin(angle));
    return [r * Math.cos(angle), p.height + r * Math.sin(angle)];
}

/** The surface's profile from the reach's edge up to the zenith, cut off at `extent` where it has no dome. */
function profile(p: Parameters, extent: number): Profile {
    const points: Profile = [];
    if (p.domed) {
        // The bend from the plane's edge to where it meets the dome, then the dome to its top.
        for (let k = 0; k <= 160; k++) {
            const [x, z] = bendPoint(p.bend, k / 160);
            points.push([x * p.height, z * p.height]);
        }
        const meets = Math.max(p.meets, -Math.asin(p.height / p.radius));
        for (let k = 1; k <= 48; k++) {
            const e = meets + ((Math.PI / 2 - meets) * k) / 48;
            points.push([p.radius * Math.cos(e), p.height + p.radius * Math.sin(e)]);
        }
        return points;
    }
    const steps = 192;
    for (let k = 0; k <= steps; k++) {
        const down = p.edge * (1 - k / steps) ** 2;
        const r = Math.min(distance(p, down), 4 * extent);
        const point: [number, number] = [r * Math.sqrt(1 - down * down), p.height - r * down];
        if (point[0] > extent) {
            const last = points.at(-1);
            if (last) {
                const t = (extent - last[0]) / (point[0] - last[0]);
                points.push([extent, last[1] + t * (point[1] - last[1])]);
            }
            return points;
        }
        points.push(point);
    }
    return points;
}

/** Where the camera stands, behind the capture point and above the ground, in meters. */
function cameraAt({ height, radius, reach }: Parameters): [number, number] {
    return [-Math.min(0.5 * reach, 0.3 * radius, 5), Math.min(1.5, 0.75 * height + 0.3)];
}

/** How tall the scene shows at a tilt, from the dome's top to the ground's near edge. */
const span = (tilt: number) => fit.height * Math.cos(tilt) + fit.dome + fit.extent * Math.sin(tilt);

function clear() {
    for (const anchor of [groundAnchor, aboveAnchor]) {
        for (const child of [...anchor.children]) {
            styles.delete(child as Zdog.Shape);
            child.remove();
        }
    }
}

function rebuild() {
    clear();
    size = { width: stage.clientWidth, height: stage.clientHeight };
    const p = parameters();
    const { height, radius, reach, lift } = p;
    const domed = radius < FAR;
    const extent = domed ? radius : reach < FAR ? Math.max(2.5 * reach, reach + 6 * height) : 25 * height;
    fit = { height, dome: domed ? radius : 0.5 * extent, extent };
    // Fitted for the steepest tilt, so the scale stays as the scene turns.
    const steepest = Math.max(...[0, 0.5, 1].map((t) => span(t * -TILT.min)));
    fitZoom = Math.min(size.width / (2.3 * extent), size.height / (1.06 * steepest)) || 1;
    for (const illustration of layers) illustration.setSize(size.width, size.height);

    const plane = Math.min(reach, extent);
    new Ellipse({
        addTo: groundAnchor,
        diameter: 2 * plane,
        rotate: { x: Math.PI / 2 },
        color: SURFACE,
        fill: true,
        stroke: false,
    });
    styled(new Ellipse({ addTo: aboveAnchor, diameter: 2 * plane, rotate: { x: Math.PI / 2 }, color: INK }), 1);

    // The surface of revolution: faint meridians, the section through the camera bold.
    const section = profile(p, extent);
    const meridian = (azimuth: number) => section.map((point) => around(point, azimuth));
    for (let k = 0; k < MERIDIANS; k++) line(meridian((k / MERIDIANS) * 360), MUTED, 1, null, 0.45);
    for (const azimuth of [heading, heading + 180]) line(meridian(azimuth), INK);
    const ring = (rho: number, z: number, color: string, dash: string | null, opacity = 1) =>
        styled(
            new Ellipse({
                addTo: aboveAnchor,
                diameter: 2 * rho,
                rotate: { x: Math.PI / 2 },
                translate: enu(0, 0, z),
                color,
            }),
            1,
            dash,
            opacity,
        );
    if (domed) {
        ring(radius, height, MUTED, null);
        for (const angle of [30, 60]) {
            ring(radius * Math.cos(angle * DEG), height + radius * Math.sin(angle * DEG), MUTED, DOTTED, 0.6);
        }
        labels.horizon.point = around([radius, height], 0);
    } else {
        labels.horizon.point = { x: 0, y: 0, z: Number.NaN };
    }
    labels.horizon.element.textContent = domed ? "horizon" : "";

    // Where the image's own horizon shows once it is lifted, as seen from where it was taken.
    const lifted = onSurface(p, lift * DEG);
    const showLift = lift !== 0 && (domed || lifted[0] <= extent);
    if (showLift) ring(lifted[0], lifted[1], ACCENT, DASHED);
    labels.lifted.point = showLift ? around(lifted, 135) : { x: 0, y: 0, z: Number.NaN };
    labels.lifted.element.textContent = showLift ? `image horizon ${degrees(lift)}` : "";

    // Where the image was taken, how high, and how far the plane reaches.
    const capture = enu(0, 0, height);
    dot(capture, INK);
    line([enu(0, 0, 0), capture], MUTED, 1, DASHED);
    labels.capture.point = capture;
    labels.capture.element.textContent = `capture point, ${meters(height)} up`;
    const reachAt = Math.min(reach, extent);
    line([enu(0, 0, 0), around([reachAt, 0], 180)], MUTED, 1, DOTTED);
    labels.reach.point = around([reachAt, 0], 180);
    labels.reach.element.textContent = `reach ${meters(reach)}`;
    const blendMiddle = section.find(([rho]) => rho >= (plane + extent) / 2);
    // How high the bend climbs, none at a hard corner.
    const blends = blendMiddle && p.domed && !p.bend.corner;
    labels.blend.point = blends ? around(blendMiddle, 270) : { x: 0, y: 0, z: Number.NaN };
    labels.blend.element.textContent = `bend, ${meters(p.bend.end[1] * height)} up`;
    if (domed) {
        const toDome = around([radius * Math.cos(45 * DEG), height + radius * Math.sin(45 * DEG)], 180);
        line([capture, toDome], MUTED, 1, DOTTED);
        labels.dome.point = toDome;
    }
    labels.dome.element.textContent = `dome ${meters(radius)}`;

    // The camera across the capture point from where it looks, and two rays that way: one to the plane, one to the
    // dome or, without one, to the sky at infinity, where its lookup runs parallel to it.
    const at = cameraAt(p);
    const camera = around(at, heading);
    dot(camera, INK);
    labels.camera.point = camera;
    labels.camera.element.textContent = "camera";
    const groundHit = around([0.6 * reachAt, 0], heading);
    const skyAngle = 25 * DEG;
    const skyHit = domed
        ? around([radius * Math.cos(skyAngle), height + radius * Math.sin(skyAngle)], heading)
        : around([at[0] + 0.9 * extent * Math.cos(skyAngle), at[1] + 0.9 * extent * Math.sin(skyAngle)], heading);
    const skyLookup = domed
        ? skyHit
        : around([0.9 * extent * Math.cos(skyAngle), height + 0.9 * extent * Math.sin(skyAngle)], heading);
    if (!domed) labels.dome.point = skyLookup;
    for (const [hit, lookup] of [
        [groundHit, groundHit],
        [skyHit, skyLookup],
    ] as const) {
        line([camera, hit], ACCENT, 1.5);
        line([capture, lookup], ACCENT, 1, DASHED);
        if (domed || hit === groundHit) dot(hit, ACCENT, 5);
    }
}

/**
 * Places the labels in the order they were made, each at the first of a few offsets around its point where it overlaps
 * none placed before it and stays on the stage; a label that finds none is left out, but for the first two.
 */
function placeLabels() {
    const center = { x: size.width / 2, y: size.height / 2 };
    const translate = layers[0]?.translate ?? { x: 0, y: 0, z: 0 };
    const stageBox = stage.getBoundingClientRect();
    const placed: DOMRect[] = [];
    const overlaps = (a: DOMRect, b: DOMRect) =>
        a.left < b.right + 2 && b.left < a.right + 2 && a.top < b.bottom + 1 && b.top < a.bottom + 1;
    Object.values(labels).forEach(({ element, point, dx, dy }, index) => {
        element.hidden = Number.isNaN(point.z);
        if (element.hidden) return;
        const v = new Zdog.Vector(point).rotate(rotation);
        const x = center.x + (v.x + translate.x) * zoom;
        const y = center.y + (v.y + translate.y) * zoom;
        const away = dy < 0 ? -1 : 1;
        const offsets = [
            [dx, dy],
            [dx, -dy || -14],
            [dx, dy + 16 * away],
            [dx, -dy - 16 * away],
            [12, 0],
            [-12, 0],
        ];
        for (const [ox = 0, oy = 0] of offsets) {
            element.style.left = `${x + ox}px`;
            element.style.top = `${y + oy}px`;
            element.style.transform = `translate(${ox > 0 ? 0 : ox < 0 ? -100 : -50}%, -50%)`;
            const box = element.getBoundingClientRect();
            const inside = box.left >= stageBox.left && box.right <= stageBox.right && box.bottom <= stageBox.bottom;
            if (inside && !placed.some((other) => overlaps(box, other))) {
                placed.push(box);
                return;
            }
        }
        if (index < 2) {
            element.style.left = `${x + dx}px`;
            element.style.top = `${y + dy}px`;
            element.style.transform = `translate(${dx > 0 ? 0 : dx < 0 ? -100 : -50}%, -50%)`;
            placed.push(element.getBoundingClientRect());
        } else {
            element.hidden = true;
        }
    });
}

function frame() {
    const tilt = -rotation.x;
    zoom = fitZoom * magnify;
    for (const illustration of layers) {
        // Zdog bakes the zoom into the SVG's viewBox when the size is set.
        illustration.zoom = zoom;
        illustration.setSize(size.width, size.height);
        illustration.translate.x = pan.x / zoom;
        illustration.translate.y =
            (fit.height * Math.cos(tilt) + fit.dome - fit.extent * Math.sin(tilt)) / 2 + pan.y / zoom;
        illustration.rotate.set(rotation);
        illustration.updateRenderGraph();
        themeColors(illustration.element);
    }
    for (const [shape, { dash, opacity }] of styles) {
        const element = shape.svgElement;
        if (!element) continue;
        if (dash) element.classList.add(dash);
        if (opacity < 1) element.style.opacity = String(opacity);
    }
    placeLabels();
    const p = parameters();
    field("heightReading").textContent = p.height.toFixed(1);
    field("liftReading").textContent = `${p.lift.toFixed(1)}°`;
    field("softReading").textContent = p.soft.toFixed(2);
    field("reachReading").textContent = reading(p.reach);
    field("radiusReading").textContent = reading(p.radius);
}

// The HDRI from the diagram's camera, without the solids, looking level the way it does: the scene's camera orbits a
// point a meter ahead of it.
const hdriCanvas = find<HTMLCanvasElement>('[data-field="canvas"]', root);
const requestHdri = createGroundedView(hdriCanvas, () => {
    const p = parameters();
    const [rho, up] = cameraAt(p);
    const [east, north] = [Math.sin(heading * DEG), Math.cos(heading * DEG)];
    const center: [number, number, number] = [(rho + 1) * east, (rho + 1) * north, up];
    return {
        camera: { yaw: (heading + 180) * DEG, pitch: 0, distance: 1, fov: FOV, center },
        height: p.height,
        lift: p.lift,
        reach: p.reach,
        meets: p.meets,
        radius: p.radius,
        flat: true,
        even: true,
        solids: false,
    };
});

const requestFrame = onDemand(frame, stage);
const requestDiagram = onDemand(() => {
    rebuild();
    frame();
}, stage);
// The grounded figure lays its solids on the same surface.
const publish = () => {
    const { height, lift, reach, radius, meets } = parameters();
    setGroundSurface({ height, lift, reach, radius, meets });
};
const requestUpdate = () => {
    requestDiagram();
    requestHdri?.();
};

for (const name of ["height", "lift", "reach", "soft", "radius"]) {
    field(name).addEventListener("input", () => {
        requestUpdate();
        publish();
    });
}
publish();
new ResizeObserver(requestDiagram).observe(stage);

/** Magnifies the diagram `factor` times about the stage point at `clientX`, `clientY`, which stays where it is. */
function zoomAt(factor: number, clientX: number, clientY: number) {
    const next = Math.min(MAGNIFY.max, Math.max(MAGNIFY.min, magnify * factor));
    const box = stage.getBoundingClientRect();
    const at = { x: clientX - box.left - box.width / 2, y: clientY - box.top - box.height / 2 };
    pan.x = at.x - ((at.x - pan.x) * next) / magnify;
    pan.y = at.y - ((at.y - pan.y) * next) / magnify;
    magnify = next;
    requestFrame();
}

// One pointer turns the camera and tilts the scene, two pinch to zoom; the wheel zooms too.
const pointers = new Map<number, { x: number; y: number }>();
const spread = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
};
stage.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest(".scene-bar, .fig-actions")) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    stage.setPointerCapture(event.pointerId);
});
stage.addEventListener("pointermove", (event) => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const before = spread();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size > 1) {
        const after = spread();
        if (before && after && before.d > 0) zoomAt(after.d / before.d, after.x, after.y);
        return;
    }
    const dx = event.clientX - last.x;
    const tilt = rotation.x - (event.clientY - last.y) * DRAG_RADIANS_PER_PX;
    rotation.x = Math.min(TILT.max, Math.max(TILT.min, tilt));
    if (dx === 0) {
        requestFrame();
        return;
    }
    heading -= (dx * DRAG_RADIANS_PER_PX) / DEG;
    requestUpdate();
});
for (const type of ["pointerup", "pointercancel"] as const) {
    stage.addEventListener(type, (event) => pointers.delete(event.pointerId));
}
stage.addEventListener(
    "wheel",
    (event) => {
        event.preventDefault();
        zoomAt(Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    },
    { passive: false },
);
// Turning the HDRI's view turns the diagram's camera with it, the same way for the same drag: the view as if grabbed.
hdriCanvas.addEventListener("pointerdown", (event) => {
    hdriCanvas.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, heading };
    const move = (e: PointerEvent) => {
        heading = start.heading - ((e.clientX - start.x) * FOV) / hdriCanvas.clientHeight / DEG;
        requestUpdate();
    };
    hdriCanvas.addEventListener("pointermove", move);
    hdriCanvas.addEventListener("pointerup", () => hdriCanvas.removeEventListener("pointermove", move), { once: true });
});
requestDiagram();
