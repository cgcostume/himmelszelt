import Zdog from "zdog";
import { find } from "../dom";
import { onDemand } from "../frame";
import { themeColor, themeColors } from "../sternzeit/figure";

// The surface rbGroundedDirection lays an image on, drawn to scale in meters around the point it was taken from: the
// plane out to the reach, the dome from the horizon up, and between them the inverse of the distance faded from the
// one to the other. Two rays from a camera, in the vertical plane through it and the capture point, to where they land.

const { Illustration, Anchor, Shape, Ellipse } = Zdog;
const DEG = Math.PI / 180;
const FAR = 1e9;
const MERIDIANS = 16;
const DRAG_RADIANS_PER_PX = 0.008;
const TILT = { min: -50 * DEG, max: 0 };

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
let zoom = 1;
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
label("blend", "", 0, 12);
label("dome", "frame-angle", 0, -10);
label("horizon", "", 0, -10);
label("lifted", "frame-angle", 0, 12);

const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};
const reading = (length: number) => (length >= FAR ? "∞" : length.toFixed(length < 10 ? 1 : 0));
const meters = (length: number) => (length >= FAR ? "∞" : `${reading(length)} m`);
const degrees = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1).replace("-", "−")}°`;

/** The sliders as the grounded figure reads them: logarithmic, the last step without end, the same bounds. */
function parameters() {
    const far = (name: string, from: number) => (slider(name) >= 100 ? FAR : from * 100 ** (slider(name) / 99));
    const height = slider("height");
    const radius = Math.max(far("radius", 5), 2.5 * height);
    const reach = Math.min(far("reach", 3), Math.sqrt(radius ** 2 / 4 - height ** 2));
    // Where the blend begins, as the sine of how far below the horizon the reach's edge lies, as in ground.wgsl.
    const edge = Math.max(height / Math.hypot(height, reach), (2 * height) / radius);
    return { height, radius, reach, edge, lift: slider("lift") };
}
type Parameters = ReturnType<typeof parameters>;

/** How far from the capture point the surface lies along a direction `down` (the sine of its depression) below it. */
function distance({ height, radius, edge }: Parameters, down: number) {
    const dome = radius >= FAR ? 0 : height / radius;
    if (down <= 0) return radius;
    const w = dome + (down - dome) * smoothstep(0, edge, down);
    return w > 0 ? height / w : FAR;
}

/** The point on the surface `angle` above the capture point's horizon, horizontally and up from under it. */
function onSurface(p: Parameters, angle: number): [number, number] {
    const r = distance(p, -Math.sin(angle));
    return [r * Math.cos(angle), p.height + r * Math.sin(angle)];
}

/** The surface's profile from the reach's edge up to the zenith, cut off at `extent` where it has no dome. */
function profile(p: Parameters, extent: number): Profile {
    const points: Profile = [];
    const steps = 48;
    for (let k = 0; k <= steps; k++) {
        const down = p.edge * (1 - k / steps) ** 2;
        const r = Math.min(distance(p, down), 4 * extent);
        const point: [number, number] = [r * Math.sqrt(1 - down * down), p.height - r * down];
        if (point[0] > extent && p.radius >= FAR) {
            const last = points.at(-1);
            if (last) {
                const t = (extent - last[0]) / (point[0] - last[0]);
                points.push([extent, last[1] + t * (point[1] - last[1])]);
            }
            return points;
        }
        points.push(point);
    }
    if (p.radius < FAR) {
        for (let k = 1; k <= 24; k++) {
            const angle = (k / 24) * 90 * DEG;
            points.push([p.radius * Math.cos(angle), p.height + p.radius * Math.sin(angle)]);
        }
    }
    return points;
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
    zoom = Math.min(size.width / (2.3 * extent), size.height / (1.06 * steepest)) || 1;
    for (const illustration of layers) {
        illustration.zoom = zoom;
        illustration.setSize(size.width, size.height);
    }

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
    for (let k = 0; k < MERIDIANS; k++) {
        const azimuth = (k / MERIDIANS) * 360;
        const bold = azimuth === 90 || azimuth === 270;
        line(
            section.map((point) => around(point, azimuth)),
            bold ? INK : MUTED,
            1,
            null,
            bold ? 1 : 0.45,
        );
    }
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
    line([enu(0, 0, 0), around([plane, 0], 180)], MUTED, 1, DOTTED);
    labels.reach.point = around([plane, 0], 180);
    labels.reach.element.textContent = `reach ${meters(reach)}`;
    const blendMiddle = section.find(([rho]) => rho >= (plane + extent) / 2);
    labels.blend.point = blendMiddle ? around(blendMiddle, 270) : { x: 0, y: 0, z: Number.NaN };
    labels.blend.element.textContent = "blend";
    if (domed) {
        const toDome = around([radius * Math.cos(45 * DEG), height + radius * Math.sin(45 * DEG)], 180);
        line([capture, toDome], MUTED, 1, DOTTED);
        labels.dome.point = toDome;
    }
    labels.dome.element.textContent = `dome ${meters(radius)}`;

    // The camera west of the capture point, and two rays east: one to the plane, one to the dome or, without one, to
    // the sky at infinity, where its lookup runs parallel to it.
    const cameraAt: [number, number] = [-Math.min(0.5 * reach, 0.3 * radius, 5), Math.min(1.5, 0.75 * height + 0.3)];
    const camera = enu(cameraAt[0], 0, cameraAt[1]);
    dot(camera, INK);
    labels.camera.point = camera;
    labels.camera.element.textContent = "camera";
    const groundHit = enu(0.6 * plane, 0, 0);
    const skyAngle = 25 * DEG;
    const skyHit = domed
        ? enu(radius * Math.cos(skyAngle), 0, height + radius * Math.sin(skyAngle))
        : enu(cameraAt[0] + 0.9 * extent * Math.cos(skyAngle), 0, cameraAt[1] + 0.9 * extent * Math.sin(skyAngle));
    const skyLookup = domed
        ? skyHit
        : enu(0.9 * extent * Math.cos(skyAngle), 0, height + 0.9 * extent * Math.sin(skyAngle));
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

function placeLabels() {
    const center = { x: size.width / 2, y: size.height / 2 };
    const translate = layers[0]?.translate ?? { x: 0, y: 0, z: 0 };
    for (const { element, point, dx, dy } of Object.values(labels)) {
        if (Number.isNaN(point.z)) {
            element.hidden = true;
            continue;
        }
        element.hidden = false;
        const v = new Zdog.Vector(point).rotate(rotation);
        element.style.left = `${center.x + (v.x + translate.x) * zoom + dx}px`;
        element.style.top = `${center.y + (v.y + translate.y) * zoom + dy}px`;
        element.style.transform = `translate(${dx > 0 ? 0 : dx < 0 ? -100 : -50}%, -50%)`;
    }
}

function frame() {
    const tilt = -rotation.x;
    for (const illustration of layers) {
        illustration.translate.y = (fit.height * Math.cos(tilt) + fit.dome - fit.extent * Math.sin(tilt)) / 2;
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
    field("reachReading").textContent = reading(p.reach);
    field("radiusReading").textContent = reading(p.radius);
}

const requestFrame = onDemand(frame, stage);
const requestUpdate = onDemand(() => {
    rebuild();
    frame();
}, stage);

for (const name of ["height", "lift", "reach", "radius"]) field(name).addEventListener("input", requestUpdate);
new ResizeObserver(requestUpdate).observe(stage);

let dragFrom: { x: number; y: number } | null = null;
stage.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest(".scene-bar, .fig-actions")) return;
    dragFrom = { x: event.clientX, y: event.clientY };
    stage.setPointerCapture(event.pointerId);
});
stage.addEventListener("pointermove", (event) => {
    if (!dragFrom) return;
    rotation.y -= (event.clientX - dragFrom.x) * DRAG_RADIANS_PER_PX;
    rotation.x = Math.min(
        TILT.max,
        Math.max(TILT.min, rotation.x - (event.clientY - dragFrom.y) * DRAG_RADIANS_PER_PX),
    );
    dragFrom = { x: event.clientX, y: event.clientY };
    requestFrame();
});
stage.addEventListener("pointerup", () => {
    dragFrom = null;
});
requestUpdate();
