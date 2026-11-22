import type { CloudLayer, DeepLayer, HighSheet } from "@himmelszelt/gewoelk";
import Zdog from "zdog";
import { find } from "../../dom";
import { onDemand } from "../../frame";
import { themeColor, themeColors } from "../../sternzeit/figure";
import type { Design } from "./kinds";

/**
 * What a kind of cloud is to gewoelk's layered model, drawn beside its designer: a marched layer as a map of columns
 * in a slab with a ray stepping through it, towers with their anvils and rain, a front as one band placed in the
 * world, and the high sheet as one shell read once. Drawn from the designer's numbers as the library reads them, and
 * again only when one of them changes.
 */

const { Illustration, Anchor, Shape, Cylinder } = Zdog;
const DEG = Math.PI / 180;
const INK = themeColor("--text");
const MUTED = themeColor("--muted");
const ACCENT = themeColor("--accent");
const DOTTED = "line-dotted";
const DASHED = "line-dashed";
// As layerpass.ts and the maps' shaders have them: the map's columns from a front's edge to its back, where its wall
// stands and how wide, an anvil's top as a share of its layer's depth, and the rain's lag per km fallen and m/s of wind.
const WALL = { at: 0.09, wide: 0.06 };
const ANVIL_TOP = 0.9;
const RAIN_LAG = 0.3 / 6.5;
// How many times taller than it is the front is drawn, 160 km deep and 9 km tall.
const FRONT_HEIGHTS = 4;
const FRONT_TURNED = 50;

type Point = { x: number; y: number; z: number };
type Km = [east: number, north: number, up: number];
const enu = ([e, n, u]: Km): Point => ({ x: e, y: -u, z: -n });
const clamp = (x: number, a = 0, b = 1) => Math.min(Math.max(x, a), b);
const smoothstep = (a: number, b: number, x: number) => {
    const t = clamp((x - a) / (b - a));
    return t * t * (3 - 2 * t);
};
/** A number that is the same for the same cell every time, 0 to 1. */
const random = (i: number, j: number, k = 0) => {
    const x = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
    return x - Math.floor(x);
};
/** A smooth field over the plane, 0 to 1, a lump per unit. */
function field(x: number, y: number) {
    const [i, j] = [Math.floor(x), Math.floor(y)];
    const [u, v] = [smoothstep(0, 1, x - i), smoothstep(0, 1, y - j)];
    const at = (a: number, b: number) => random(i + a, j + b, 3);
    return (at(0, 0) * (1 - u) + at(1, 0) * u) * (1 - v) + (at(0, 1) * (1 - u) + at(1, 1) * u) * v;
}
/** `gwLayerSpan`: where a column of value `m` has its bottom and its top, as shares of a layer `depth` km deep. */
function span(depth: number, m: number): [number, number] {
    const dip = Math.min(0.15 / depth, 0.3);
    return [dip * (1 - m), dip + m * (1 - dip)];
}
const km = (value: number) => `${Number(value.toFixed(value < 10 ? 1 : 0))} km`;

/** A scene of two layers on `stage`, clouds under lines, turned by dragging: built anew by `begin`, drawn by `frame`. */
function scene(stage: HTMLElement, turned: number) {
    const labelsEl = find(".frame-labels", stage);
    const rotation = { x: -36 * DEG, y: turned * DEG, z: 0 };
    const layers = ["clouds", "lines"].map(
        (name) =>
            new Illustration({
                element: find<SVGSVGElement>(`svg[data-layer="${name}"]`, stage),
                rotate: rotation,
                resize: true,
                onResize(this: Zdog.Illustration, width: number, height: number) {
                    this.setSize(width, height);
                },
            }),
    );
    const [clouds, lines] = layers.map((illustration) => new Anchor({ addTo: illustration })) as [
        Zdog.Anchor,
        Zdog.Anchor,
    ];
    const styles = new Map<Zdog.Shape, { dash: string | null; opacity: number }>();
    let labels: { element: HTMLElement; point: Point; dx: number; dy: number }[] = [];
    // Arrows' heads are flat triangles turned to face the viewer, a few pixels long at every zoom.
    let arrows: { shaft: Zdog.Shape; head: Zdog.Shape; from: Zdog.Vector; tip: Zdog.Vector }[] = [];
    let zoom = 1;
    let lift = 0;

    const shape = (addTo: Zdog.Anchor, path: Km[], color: string, px: number, dash: string | null, opacity: number) => {
        const made = new Shape({ addTo, path: path.map(enu), closed: false, color, stroke: px });
        styles.set(made, { dash, opacity });
        return made;
    };
    const self = {
        /** Clears the scene and fits one `wide` km across and `tall` km high. */
        begin(wide: number, tall: number) {
            for (const anchor of [clouds, lines]) for (const child of [...anchor.children]) child.remove();
            styles.clear();
            labelsEl.replaceChildren();
            labels = [];
            arrows = [];
            const [width, height] = [stage.clientWidth, stage.clientHeight];
            zoom = Math.min(width / (1.45 * wide), height / (1.15 * (0.8 * tall + 0.85 * wide))) || 1;
            lift = tall / 2;
            for (const illustration of layers) {
                illustration.zoom = zoom;
                illustration.setSize(width, height);
            }
            for (const anchor of [clouds, lines]) anchor.translate.y = lift;
        },
        line: (path: Km[], color = INK, px = 1, dash: string | null = null, opacity = 1) =>
            shape(lines, path, color, px, dash, opacity),
        dot: (at: Km, color = INK, px = 5) => shape(lines, [at], color, px, null, 1),
        /** An arrow out of a point, as the Moon's figure points to the Sun and to Earth: a dot, a line and a small head. */
        arrow(from: Km, to: Km, color = ACCENT) {
            self.dot(from, color, 7);
            const shaft = shape(lines, [from, to], color, 1.5, null, 1);
            const head = shape(lines, [to, to, to], color, 1, null, 1);
            Object.assign(head, { closed: true, fill: true });
            arrows.push({ shaft, head, from: new Zdog.Vector(enu(from)), tip: new Zdog.Vector(enu(to)) });
        },
        /** A filled outline among the clouds, as opaque as `opacity`. */
        area(path: Km[], opacity: number, color = INK) {
            const made = shape(clouds, path, color, 0, null, opacity);
            Object.assign(made, { closed: true, fill: true });
        },
        /** The ground's outline, `wide` across, among the clouds, so the columns standing before it cover it. */
        ground(wide: number, pieces = 24) {
            const h = wide / 2;
            const corners: Km[] = [
                [-h, -h, 0],
                [h, -h, 0],
                [h, h, 0],
                [-h, h, 0],
            ];
            corners.forEach((a, c) => {
                const b = corners[(c + 1) % 4] as Km;
                const at = (t: number) => a.map((v, i) => v + ((b[i] ?? 0) - v) * t) as Km;
                for (let k = 0; k < pieces; k++)
                    shape(clouds, [at(k / pieces), at((k + 1) / pieces)], INK, 2 / zoom, null, 1);
            });
        },
        /** An upright column of cloud. */
        column([east, north]: [number, number], diameter: number, from: number, to: number) {
            new Cylinder({
                addTo: clouds,
                diameter,
                length: Math.max(to - from, 1e-3),
                translate: enu([east, north, (from + to) / 2]),
                rotate: { x: Math.PI / 2 },
                stroke: false,
                color: MUTED,
                frontFace: INK,
                backface: INK,
            });
        },
        /** A square on the level `up`, `wide` across, about the middle. */
        square(wide: number, up: number, color = MUTED, dash: string | null = null, opacity = 1) {
            const h = wide / 2;
            const corners: Km[] = [
                [-h, -h, up],
                [h, -h, up],
                [h, h, up],
                [-h, h, up],
                [-h, -h, up],
            ];
            return self.line(corners, color, 1, dash, opacity);
        },
        /** Text at a point, `dx` and `dy` pixels off it: its near edge where set off sideways, its middle otherwise. */
        label(at: Km, text: string, cls = "", dx = 0, dy = 0) {
            const element = Object.assign(document.createElement("span"), { textContent: text });
            element.className = `dome-compass-label frame-label ${cls}`;
            labelsEl.append(element);
            labels.push({ element, point: enu(at), dx, dy });
        },
        /** A length marked off between two points, with what it is. */
        measure(from: Km, to: Km, text: string, dx = 0, dy = 12) {
            self.line([from, to], INK, 1.5);
            const middle = from.map((c, i) => (c + (to[i] ?? 0)) / 2) as Km;
            self.label(middle, text, "frame-angle", dx, dy);
        },
        frame() {
            // The line of sight in the scene's coordinates: the screen's z, with the scene's rotation undone.
            const view = new Zdog.Vector({ x: 0, y: 0, z: 1 }).rotate({ x: -rotation.x }).rotate({ y: -rotation.y });
            for (const { shaft, head, from, tip } of arrows) {
                const d = tip.copy().subtract(from);
                const length = d.magnitude();
                if (length < 1e-6) continue;
                d.multiply(1 / length);
                const base = tip.copy().subtract(d.copy().multiply(Math.min(7 / zoom, length)));
                const side = new Zdog.Vector({
                    x: d.y * view.z - d.z * view.y,
                    y: d.z * view.x - d.x * view.z,
                    z: d.x * view.y - d.y * view.x,
                });
                const across = side.magnitude();
                if (across < 1e-3) side.set({ x: 1, y: 0, z: 0 });
                side.multiply(3.5 / zoom / Math.max(across, 1e-3));
                shaft.path = [from, base];
                shaft.updatePath();
                head.path = [tip, base.copy().add(side), base.copy().subtract(side)];
                head.updatePath();
            }
            for (const illustration of layers) {
                illustration.rotate.set(rotation);
                illustration.updateRenderGraph();
                themeColors(illustration.element);
            }
            for (const [made, { dash, opacity }] of styles) {
                const element = made.svgElement;
                if (!element) continue;
                if (dash) element.classList.add(dash);
                if (opacity < 1) element.style.opacity = String(opacity);
            }
            const [cx, cy] = [stage.clientWidth / 2, stage.clientHeight / 2];
            for (const { element, point, dx, dy } of labels) {
                const v = new Zdog.Vector({ ...point, y: point.y + lift }).rotate(rotation);
                element.style.left = `${cx + v.x * zoom + dx}px`;
                element.style.top = `${cy + v.y * zoom + dy}px`;
                element.style.transform = `translate(${dx > 0 ? 0 : dx < 0 ? -100 : -50}%, -50%)`;
            }
        },
        rotation,
    };
    return self;
}
type Scene = ReturnType<typeof scene>;

/** The slab of a layer over a ground `wide` across, with its base and depth marked up one corner. */
function slab(s: Scene, wide: number, base: number, depth: number, heights = 1) {
    const h = wide / 2;
    const [low, high] = [base * heights, (base + depth) * heights];
    s.ground(wide);
    s.square(wide, low, MUTED, DOTTED);
    s.square(wide, high, MUTED, DOTTED);
    for (const [e, n] of [
        [-h, -h],
        [h, -h],
        [h, h],
        [-h, h],
    ] as const)
        s.line(
            [
                [e, n, 0],
                [e, n, high],
            ],
            MUTED,
            1,
            DOTTED,
            0.6,
        );
    s.label([-h, -h, low / 2], `base ${km(base)}`, "frame-angle", -8);
    s.label([-h, -h, (low + high) / 2], `depth ${km(depth)}`, "frame-angle", -8);
}

/** The wind out of `tail`, in a scene `wide` km across: an arrow where it blows to, the longer the stronger, with its speed. */
function wind(s: Scene, tail: Km, wide: number, windFrom: number, windSpeed: number) {
    const to = [Math.sin((windFrom + 180) * DEG), Math.cos((windFrom + 180) * DEG)] as const;
    const length = windSpeed > 0 ? wide * Math.min(0.08 + 0.006 * windSpeed, 0.32) : 0;
    const tip: Km = [tail[0] + to[0] * length, tail[1] + to[1] * length, tail[2]];
    if (length > 0) s.arrow(tail, tip);
    else s.dot(tail, ACCENT, 5);
    s.label(tail, windSpeed > 0 ? `wind ${Number(windSpeed.toFixed(0))} m/s` : "no wind", "frame-angle", 0, 13);
}

/** A ray from the ground through a slab: strides below it, steps in it, and from one step the way to the Sun. */
function ray(s: Scene, wide: number, low: number, high: number) {
    const h = wide / 2;
    const from: Km = [-0.9 * h, -0.1 * h, 0];
    const to: Km = [0.75 * h, 0.5 * h, high * 1.12];
    const at = (t: number) => from.map((c, i) => c + ((to[i] ?? 0) - c) * t) as Km;
    s.line([from, to], ACCENT, 1.5);
    s.dot(from, ACCENT, 8);
    const [enter, leave] = [low / to[2], high / to[2]];
    const steps = 7;
    for (let k = 0; k <= steps; k++) s.dot(at(enter + ((leave - enter) * k) / steps), ACCENT, 4);
    for (let k = 1; k < 3; k++) s.dot(at((enter * k) / 3), MUTED, 3);
    const lit = at(enter + (leave - enter) * 0.6);
    const sun: Km = [lit[0] + 0.3 * h, lit[1] - 0.25 * h, lit[2] + 0.45 * h];
    s.line([lit, sun], ACCENT, 1, DASHED);
    s.label(sun, "to the Sun", "frame-angle", 6);
    s.label(to, "ray", "frame-angle", 0, -10);
    s.label(from, "eye", "frame-axis", 0, 12);
}

/** A low or a middle layer: its map on the ground, a column over each of its cells, as tall as the map says. */
function heaps(s: Scene, layer: CloudLayer, windFrom: number, windSpeed: number) {
    const { baseKm: base, depthKm: depth, sizeKm: size, coverage } = layer;
    const wide = 5 * size;
    s.begin(wide, base + depth);
    slab(s, wide, base, depth);
    const count = 10;
    const cell = wide / count;
    for (let i = 0; i < count; i++) {
        for (let j = 0; j < count; j++) {
            const [e, n] = [(i + 0.5) * cell - wide / 2, (j + 0.5) * cell - wide / 2];
            const spread = clamp((field(e / size + 9, n / size + 9) - 0.5) * 2.4 + 0.5);
            const cut = clamp((spread - (1 - coverage)) / Math.max(coverage, 1e-3));
            const value = 1 - (1 - cut) ** 2;
            if (value < 0.02) continue;
            const c = cell / 2;
            s.area(
                [
                    [e - c, n - c, 0],
                    [e + c, n - c, 0],
                    [e + c, n + c, 0],
                    [e - c, n + c, 0],
                ],
                0.15 + 0.6 * value,
            );
            const [bottom, top] = span(depth, value);
            s.column([e, n], 0.92 * cell, base + bottom * depth, base + top * depth);
        }
    }
    const front = -wide / 2;
    s.measure([-size / 2, front, 0], [size / 2, front, 0], `size ${km(size)}`);
    s.label([0, wide / 2, 0], "the map", "frame-axis", 0, -10);
    wind(s, [-0.62 * wide, 0.2 * wide, 0], wide, windFrom, windSpeed);
    ray(s, wide, base, base + depth);
}

/** The outline of an ellipse on the level `up`, its half axes `along` the direction `to` and `across` it. */
function ellipse([e, n]: [number, number], up: number, to: [number, number], along: number, across: number): Km[] {
    return Array.from({ length: 33 }, (_, k) => {
        const [c, w] = [Math.cos((k / 32) * 2 * Math.PI) * along, Math.sin((k / 32) * 2 * Math.PI) * across];
        return [e + c * to[0] - w * to[1], n + c * to[1] + w * to[0], up] as Km;
    });
}

/** The deep layer's towers: one in a share of the cells, the tall ones under an anvil drawn downwind, rain under each. */
function towers(s: Scene, deep: DeepLayer, windFrom: number, windSpeed: number) {
    const { baseKm: base, depthKm: depth, sizeKm: size, coverage, lumps, anvil, rain } = deep;
    const count = 4;
    const wide = count * size;
    s.begin(wide, base + depth);
    slab(s, wide, base, depth);
    const to: [number, number] = [Math.sin((windFrom + 180) * DEG), Math.cos((windFrom + 180) * DEG)];
    let marked = false;
    for (let i = 0; i < count; i++) {
        for (let j = 0; j < count; j++) {
            // One cell always holds a tall tower, so the anvil has where to stand.
            const first = i === 1 && j === 2;
            const [chance, height] = first ? [0, 0.95] : [random(i, j, 1), random(i, j, 2)];
            if (chance > coverage) continue;
            const at: [number, number] = [
                (i + 0.5 + (random(i, j, 5) - 0.5) * 0.5) * size - wide / 2,
                (j + 0.5 + (random(i, j, 6) - 0.5) * 0.5) * size - wide / 2,
            ];
            const tall = 0.45 + 0.55 * height;
            const radius = (0.3 + 0.14 * height) * size * 0.85;
            const [bottom, top] = span(depth, tall);
            s.area(ellipse(at, 0, to, radius, radius), 0.15 + 0.6 * tall);
            // Turrets: the top cut down between them, by as much as the lumps say.
            const body = base + (bottom + (top - bottom) * (1 - 0.45 * lumps)) * depth;
            s.column(at, 2 * radius, base + bottom * depth, body);
            for (let k = 0; k < 3 && lumps > 0.05; k++) {
                const turn = (k / 3 + random(i, j, 7)) * 2 * Math.PI;
                const turret: [number, number] = [
                    at[0] + 0.45 * radius * Math.cos(turn),
                    at[1] + 0.45 * radius * Math.sin(turn),
                ];
                s.column(turret, 0.8 * radius, body, base + top * depth - 0.1 * k * (top - bottom) * depth * lumps);
            }
            const skirt = smoothstep(0.8, 0.95, tall) * smoothstep(0, 0.1, anvil);
            if (skirt > 0) {
                const center: [number, number] = [
                    at[0] + to[0] * anvil * 0.5 * size,
                    at[1] + to[1] * anvil * 0.5 * size,
                ];
                const rim = ellipse(center, base + ANVIL_TOP * depth, to, (0.5 + 0.6 * anvil) * size, 0.5 * size);
                s.area(rim, 0.35 * skirt);
                s.line(rim, INK, 1, null, 0.7);
                if (first) s.label(rim[0] as Km, "anvil", "frame-axis", 8);
            }
            if (rain > 0) {
                const lean = RAIN_LAG * windSpeed * base;
                for (const [a, b] of [
                    [-0.4, 0.1],
                    [0, -0.3],
                    [0.35, 0.25],
                ] as const) {
                    const [e, n] = [at[0] + a * radius, at[1] + b * radius];
                    s.line(
                        [
                            [e, n, base],
                            [e - to[0] * lean, n - to[1] * lean, 0],
                        ],
                        ACCENT,
                        1,
                        DASHED,
                        0.8,
                    );
                }
                if (!marked) s.label([at[0], at[1], base / 2], "rain", "frame-angle", 10);
                marked = true;
            }
        }
    }
    const front = -wide / 2;
    s.measure([-size / 2, front, 0], [size / 2, front, 0], `spacing ${km(size)}`);
    wind(s, [-0.62 * wide, 0.2 * wide, 0], wide, windFrom, windSpeed);
}

/** A front: one band placed by a distance and a bearing from the observer, a wall behind its edge, a shield to the rear. */
function front(s: Scene, deep: DeepLayer, windFrom: number, windSpeed: number) {
    const { baseKm: base, depthKm: depth, coverage, frontKm, frontDepthKm, frontBearing, rain } = deep;
    // What is shown along the bearing: from the observer, or the edge behind them, to the front's back.
    const [near, far] = [Math.min(frontKm, 0) - 10, Math.max(frontKm + frontDepthKm, 0) + 10];
    const wide = far - near;
    const across = 0.22 * wide;
    s.begin(wide, (base + depth) * FRONT_HEIGHTS);
    const along: [number, number] = [Math.sin(frontBearing * DEG), Math.cos(frontBearing * DEG)];
    const side: [number, number] = [along[1], -along[0]];
    const middle = (near + far) / 2;
    const place = (x: number, y: number, up: number): Km => [
        along[0] * (x - middle) + side[0] * y,
        along[1] * (x - middle) + side[1] * y,
        up * FRONT_HEIGHTS,
    ];
    // A column's value from the edge to the back, `gwLayerMapValue`'s without its noise: the wall, and the shield.
    const value = (x: number) => {
        const wall = Math.sqrt(Math.max(1 - ((x - WALL.at) / WALL.wide) ** 4, 0));
        const shield = smoothstep(0, 0.05, x) * (1 - smoothstep(0.5, 0.98, x));
        return clamp(Math.max(shield * 0.425 * (0.4 + 0.6 * coverage), wall * 0.85));
    };
    const samples = Array.from({ length: 49 }, (_, k) => k / 48);
    const cut = (y: number, part: 0 | 1) =>
        samples.map((x) => place(frontKm + x * frontDepthKm, y * across, base + span(depth, value(x))[part] * depth));
    for (const y of [-1, -0.5, 0, 0.5, 1]) {
        s.area([...cut(y, 1), ...cut(y, 0).reverse()], 0.45);
        s.line(cut(y, 1), INK, y === 1 ? 1.5 : 1, null, y === 1 ? 1 : 0.5);
    }
    const back = frontKm + frontDepthKm;
    s.line(
        [place(frontKm, -across, 0), place(back, -across, 0), place(back, across, 0), place(frontKm, across, 0)],
        MUTED,
    );
    s.line([place(frontKm, -across, 0), place(frontKm, across, 0)], ACCENT, 1.5);
    s.label(place(frontKm, -across, 0), "leading edge", "frame-angle", 0, -10);
    s.label(place(frontKm + WALL.at * frontDepthKm, -across, base + depth), "wall of towers", "frame-axis", 0, -12);
    s.label(place(frontKm + 0.6 * frontDepthKm, -across, base + 0.5 * depth), "shield", "frame-axis", 0, -12);
    if (rain > 0) {
        for (const y of [-0.75, -0.25, 0.25, 0.75]) {
            const x = frontKm + WALL.at * frontDepthKm;
            s.line([place(x, y * across, base), place(x, y * across, 0)], ACCENT, 1, DASHED, 0.8);
        }
    }
    // The observer, north, and the bearing out to the edge.
    const [observer, north] = [place(0, 0, 0), place(0, 0, 0)];
    north[1] += 0.12 * wide;
    s.dot(observer, INK, 6);
    s.label(observer, "observer", "frame-axis", 0, 12);
    s.line([observer, north], MUTED, 1, DOTTED);
    s.label(north, "N", "", 0, -8);
    s.line([observer, place(frontKm, 0, 0)], ACCENT, 1.5);
    s.label(place(frontKm / 2, 0, 0), `${km(frontKm)} at ${frontBearing.toFixed(0)}°`, "frame-angle", 0, -10);
    s.measure(place(frontKm, across, 0), place(back, across, 0), `front depth ${km(frontDepthKm)}`, 0, 12);
    wind(s, place(far - 0.2 * wide, -1.5 * across, 0), wide, windFrom, windSpeed);
}

/** The high sheet: one shell, its map's tile laid along the wind and repeated, read once where a ray crosses it. */
function sheet(s: Scene, high: HighSheet, windFrom: number, windSpeed: number) {
    const { altitudeKm: up, tileKm: tile, patchKm, bandStretch, bandAngle, coverage } = high;
    const wide = 2 * tile;
    s.begin(wide, up);
    s.square(wide, 0, INK);
    s.square(wide, up, INK);
    const to: [number, number] = [Math.sin((windFrom + 180) * DEG), Math.cos((windFrom + 180) * DEG)];
    const side: [number, number] = [to[1], -to[0]];
    const h = wide / 2;
    const place = (x: number, y: number): Km => [to[0] * x + side[0] * y, to[1] * x + side[1] * y, up];
    const within = (p: Km) => Math.abs(p[0]) <= h && Math.abs(p[1]) <= h;
    // The tile's lattice in the wind's frame, cut to the square shown; the tile about the middle drawn through.
    for (let k = -2; k <= 2; k++) {
        for (const [a, b] of [
            [place((k + 0.5) * tile, -3 * tile), place((k + 0.5) * tile, 3 * tile)],
            [place(-3 * tile, (k + 0.5) * tile), place(3 * tile, (k + 0.5) * tile)],
        ] as const) {
            const points = Array.from(
                { length: 97 },
                (_, i) => a.map((c, j) => c + ((b[j] ?? 0) - c) * (i / 96)) as Km,
            );
            const inside = points.filter(within);
            if (inside.length > 1) s.line([inside[0] as Km, inside.at(-1) as Km], MUTED, 1, DOTTED, 0.7);
        }
    }
    const t = tile / 2;
    const corners = [place(-t, -t), place(t, -t), place(t, t), place(-t, t)];
    if (corners.every(within)) s.line([...corners, corners[0] as Km], INK, 1.5);
    s.label(place(0, -t), `the map, one tile ${km(tile)}`, "frame-axis", 0, 12);
    // A patch of the broad field, stretched into a band at its angle to the wind: what the coverage keeps of the sheet.
    const turned = (bandAngle * Math.PI) / 180;
    const band: [number, number] = [
        to[0] * Math.cos(turned) + side[0] * Math.sin(turned),
        to[1] * Math.cos(turned) + side[1] * Math.sin(turned),
    ];
    const half = (patchKm / 2) * Math.sqrt(clamp(coverage, 0.05));
    const rim = ellipse([0, 0], up, band, half * bandStretch, half).map(
        ([e, n, u]) => [clamp(e, -h, h), clamp(n, -h, h), u] as Km,
    );
    s.area(rim, 0.25);
    s.label(rim[8] as Km, `a patch, ${km(patchKm)}`, "frame-axis", 0, -12);
    wind(s, place(-0.2 * wide, 0.4 * wide), wide, windFrom, windSpeed);
    // The ray: nothing to step through, one read where it crosses the shell.
    const eye: Km = [-0.8 * h, -0.6 * h, 0];
    const hit: Km = [0.35 * h, 0.2 * h, up];
    s.line([eye, hit], ACCENT, 1.5);
    s.dot(eye, ACCENT, 8);
    s.dot(hit, ACCENT, 7);
    s.label(eye, "eye", "frame-axis", 0, 12);
    s.label(hit, "read once", "frame-angle", 8);
    s.line(
        [
            [-h, -h, 0],
            [-h, -h, up],
        ],
        MUTED,
        1,
        DOTTED,
    );
    s.label([-h, -h, up / 2], `altitude ${km(up)}`, "frame-angle", -8);
}

export type ModelNumbers = CloudLayer | DeepLayer | HighSheet;

/** The model's graphic in `root`'s `[data-field="model"]` for `design`: `update` draws it for the numbers given. */
export function cloudModel(root: HTMLElement, design: Design) {
    const stage = root.querySelector<HTMLElement>('[data-field="model"]');
    if (!stage) return null;
    // A front lies along its bearing, north by east at first: turned so that it runs across the scene.
    const s = scene(stage, design === "front" ? FRONT_TURNED : -32);
    let drawn: { numbers: ModelNumbers; windFrom: number; windSpeed: number } | null = null;
    let key = "";
    const build = () => {
        if (!drawn || stage.clientWidth === 0) return;
        const { numbers, windFrom, windSpeed } = drawn;
        if (design === "high") sheet(s, numbers as HighSheet, windFrom, windSpeed);
        else if (design === "front") front(s, numbers as DeepLayer, windFrom, windSpeed);
        else if (design === "towers") towers(s, numbers as DeepLayer, windFrom, windSpeed);
        else heaps(s, numbers as CloudLayer, windFrom, windSpeed);
        s.frame();
    };
    const requestBuild = onDemand(build, stage);
    const requestFrame = onDemand(() => s.frame(), stage);
    new ResizeObserver(requestBuild).observe(stage);

    let dragFrom: { x: number; y: number } | null = null;
    stage.addEventListener("pointerdown", (event) => {
        dragFrom = { x: event.clientX, y: event.clientY };
        stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener("pointermove", (event) => {
        if (!dragFrom) return;
        s.rotation.y -= (event.clientX - dragFrom.x) * 0.008;
        s.rotation.x = clamp(s.rotation.x - (event.clientY - dragFrom.y) * 0.008, -80 * DEG, -4 * DEG);
        dragFrom = { x: event.clientX, y: event.clientY };
        requestFrame();
    });
    for (const type of ["pointerup", "pointercancel"]) stage.addEventListener(type, () => (dragFrom = null));

    return {
        /** Draws the model for `numbers`, once they differ, to the slider's step, from what is drawn. */
        update(numbers: ModelNumbers, windFrom: number, windSpeed: number) {
            const rounded = Object.fromEntries(
                Object.entries(numbers).map(([name, value]) => [
                    name,
                    typeof value === "number" ? Number(value.toFixed(2)) : value,
                ]),
            ) as unknown as ModelNumbers;
            const next = JSON.stringify([rounded, windFrom, windSpeed]);
            if (next === key) return;
            key = next;
            drawn = { numbers: rounded, windFrom, windSpeed };
            requestBuild();
        },
    };
}
