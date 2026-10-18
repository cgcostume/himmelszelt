import { find } from "../dom";
import { onDemand } from "../frame";
import { offsetSliders } from "../sternzeit/offset";
import { type Environment, environment, gpu, gpuDevice, needEnvironment, onEnvironment } from "./atmosphere";

type Vec3 = [number, number, number];

const root = find("#harmonics");
const panel = find(".harmonics-panel", root);

// The nine basis functions over ENU directions, each scaled to a largest magnitude of 1 for showing.
const SHAPES = (x: number, y: number, z: number) => [
    1,
    y,
    z,
    x,
    2 * x * y,
    2 * y * z,
    (3 * z * z - 1) / 2,
    2 * x * z,
    x * x - y * y,
];
// The same with the library's normalization, see irradiance.comp.wgsl, and the cosine lobe's weight of each band.
const basis = (x: number, y: number, z: number) => [
    0.282095,
    0.488603 * y,
    0.488603 * z,
    0.488603 * x,
    1.092548 * x * y,
    1.092548 * y * z,
    0.315392 * (3 * z * z - 1),
    1.092548 * x * z,
    0.546274 * (x * x - y * y),
];
const LOBE = [Math.PI, (2 * Math.PI) / 3, Math.PI / 4];
const BAND = [0, 1, 1, 1, 2, 2, 2, 2, 2];

// One view for every shape, turned by dragging any of them: at first from the south-southwest and a little above, east
// to the right and the zenith up. Orthographic, so the shapes keep their proportions.
let dragging = false;
const view = { azimuth: (200 * Math.PI) / 180, altitude: (22 * Math.PI) / 180 };
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const along = (a: Vec3, b: Vec3, c: Vec3, x: number, y: number, z: number): Vec3 => [
    x * a[0] + y * b[0] + z * c[0],
    x * a[1] + y * b[1] + z * c[1],
    x * a[2] + y * b[2] + z * c[2],
];
function axes() {
    const { azimuth, altitude } = view;
    const toViewer: Vec3 = [
        Math.cos(altitude) * Math.sin(azimuth),
        Math.cos(altitude) * Math.cos(azimuth),
        Math.sin(altitude),
    ];
    const right: Vec3 = [-Math.cos(azimuth), Math.sin(azimuth), 0];
    const upward: Vec3 = [
        -Math.sin(altitude) * Math.sin(azimuth),
        -Math.sin(altitude) * Math.cos(azimuth),
        Math.cos(altitude),
    ];
    // Lit from the upper left, in front.
    const light = along(right, upward, toViewer, -0.45, 0.6, 0.66);
    return { toViewer, right, upward, light };
}

// A polar surface over a grid of directions, poles at the zenith and the nadir: each vertex at its direction times a
// radius, with a color and a signed value to interpolate.
const LATITUDES = 40;
const LONGITUDES = 80;
const GRID: Vec3[] = [];
for (let i = 0; i <= LATITUDES; ++i) {
    for (let j = 0; j < LONGITUDES; ++j) {
        const theta = (i / LATITUDES) * Math.PI;
        const phi = (j / LONGITUDES) * 2 * Math.PI;
        GRID.push([Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)]);
    }
}
type Shape = { positions: Vec3[]; normals: Vec3[]; colors: Vec3[]; values: number[] };

function polar(radius: (d: Vec3, k: number) => number, color: (d: Vec3, k: number) => Vec3 = () => [1, 1, 1]): Shape {
    const values = GRID.map(radius);
    const positions = GRID.map((d, k) => d.map((c) => c * Math.abs(values[k] ?? 0)) as Vec3);
    const at = (i: number, j: number) =>
        positions[Math.min(Math.max(i, 0), LATITUDES) * LONGITUDES + ((j + LONGITUDES) % LONGITUDES)] as Vec3;
    // Across the grid's two directions, from the neighbors on either side; along the direction itself at the poles and
    // wherever the surface pinches to a point.
    const normals = GRID.map((d, k) => {
        const i = Math.floor(k / LONGITUDES);
        const j = k % LONGITUDES;
        const [a, b] = [at(i + 1, j), at(i - 1, j)];
        const [c, e] = [at(i, j + 1), at(i, j - 1)];
        const u: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        const v: Vec3 = [c[0] - e[0], c[1] - e[1], c[2] - e[2]];
        const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const length = Math.hypot(...n);
        return length > 1e-9 ? (n.map((x) => x / length) as Vec3) : d;
    });
    return { positions, normals, colors: GRID.map(color), values };
}

/**
 * A shape drawn into a canvas, as a small software renderer does it: triangles into a depth buffer at twice the
 * canvas' resolution, shaded per pixel, then averaged down for smooth outlines. `paint` turns the interpolated color
 * and value into one, before the light.
 */
function render(canvas: HTMLCanvasElement, shape: Shape, paint: (color: Vec3, value: number) => Vec3, frame?: string) {
    const size = Math.min(Math.round(canvas.clientWidth * devicePixelRatio), 160);
    if (size === 0) return;
    if (canvas.width !== size) canvas.width = canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return;
    const { toViewer, right, upward, light } = axes();
    // Once at the canvas' own resolution while dragging, to keep up with the pointer.
    const big = size * (dragging ? 1 : 2);
    const sub = big / size;
    const scale = big * 0.47;
    const depth = new Float32Array(big * big).fill(Number.NEGATIVE_INFINITY);
    const rgb = new Float32Array(big * big * 3);
    const screen = shape.positions.map((p) => [
        big / 2 + scale * dot(p, right),
        big / 2 - scale * dot(p, upward),
        dot(p, toViewer),
    ]);
    const triangle = (k0: number, k1: number, k2: number) => {
        const [x0 = 0, y0 = 0, z0 = 0] = screen[k0] ?? [];
        const [x1 = 0, y1 = 0, z1 = 0] = screen[k1] ?? [];
        const [x2 = 0, y2 = 0, z2 = 0] = screen[k2] ?? [];
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (Math.abs(area) < 1e-9) return;
        const left = Math.max(Math.floor(Math.min(x0, x1, x2)), 0);
        const top = Math.max(Math.floor(Math.min(y0, y1, y2)), 0);
        const rightmost = Math.min(Math.ceil(Math.max(x0, x1, x2)), big - 1);
        const bottom = Math.min(Math.ceil(Math.max(y0, y1, y2)), big - 1);
        for (let y = top; y <= bottom; ++y) {
            for (let x = left; x <= rightmost; ++x) {
                const px = x + 0.5;
                const py = y + 0.5;
                const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
                const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const z = w0 * z0 + w1 * z1 + w2 * z2;
                const pixel = y * big + x;
                if (z <= (depth[pixel] ?? 0)) continue;
                depth[pixel] = z;
                const n0 = shape.normals[k0] as Vec3;
                const n1 = shape.normals[k1] as Vec3;
                const n2 = shape.normals[k2] as Vec3;
                const n = along(n0, n1, n2, w0, w1, w2);
                const facing = dot(n, toViewer) < 0 ? -1 : 1;
                const lit = 0.32 + 0.68 * Math.max((facing * dot(n, light)) / Math.max(Math.hypot(...n), 1e-9), 0);
                const c0 = shape.colors[k0] as Vec3;
                const c1 = shape.colors[k1] as Vec3;
                const c2 = shape.colors[k2] as Vec3;
                const value =
                    w0 * (shape.values[k0] ?? 0) + w1 * (shape.values[k1] ?? 0) + w2 * (shape.values[k2] ?? 0);
                const color = paint(along(c0, c1, c2, w0, w1, w2), value);
                for (let c = 0; c < 3; ++c) rgb[pixel * 3 + c] = (color[c] ?? 0) * lit;
            }
        }
    };
    for (let i = 0; i < LATITUDES; ++i) {
        for (let j = 0; j < LONGITUDES; ++j) {
            const k = i * LONGITUDES + j;
            const next = i * LONGITUDES + ((j + 1) % LONGITUDES);
            triangle(k, k + LONGITUDES, next);
            triangle(next, k + LONGITUDES, next + LONGITUDES);
        }
    }
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; ++y) {
        for (let x = 0; x < size; ++x) {
            const p = (y * size + x) * 4;
            let covered = 0;
            const sum = [0, 0, 0];
            for (const [dx, dy] of sub === 1
                ? ([[0, 0]] as const)
                : ([
                      [0, 0],
                      [1, 0],
                      [0, 1],
                      [1, 1],
                  ] as const)) {
                const pixel = (sub * y + dy) * big + sub * x + dx;
                if (depth[pixel] === Number.NEGATIVE_INFINITY) continue;
                ++covered;
                for (let c = 0; c < 3; ++c) sum[c] = (sum[c] ?? 0) + (rgb[pixel * 3 + c] ?? 0);
            }
            if (covered === 0) continue;
            for (let c = 0; c < 3; ++c) image.data[p + c] = (sum[c] ?? 0) / covered;
            image.data[p + 3] = (255 * covered) / sub ** 2;
        }
    }
    context.putImageData(image, 0, 0);
    if (frame) {
        // Behind the shape, for scale and place: the horizon at the radius of 1 and the vertical through the center.
        const r = (scale / sub) * 1;
        const c = size / 2;
        context.globalCompositeOperation = "destination-over";
        context.strokeStyle = frame;
        context.lineWidth = devicePixelRatio;
        context.beginPath();
        context.ellipse(c, c, r, r * Math.abs(dot(toViewer, [0, 0, 1])), 0, 0, 2 * Math.PI);
        context.moveTo(c, c - r * dot([0, 0, 1], upward));
        context.lineTo(c, c + r * dot([0, 0, 1], upward));
        context.stroke();
        // The Sun's direction at the same reach, in front of the shape or behind it.
        const [sx = 0, sy = 0, sz = 0] = sunDirection;
        const sun: Vec3 = [sx, sy, sz];
        context.globalCompositeOperation = dot(sun, toViewer) >= 0 ? "source-over" : "destination-over";
        context.fillStyle = SUN_COLOR;
        context.beginPath();
        context.arc(c + r * dot(sun, right), c - r * dot(sun, upward), 2.5 * devicePixelRatio, 0, 2 * Math.PI);
        context.fill();
        context.globalCompositeOperation = "source-over";
    }
}
const SUN_COLOR = "oklch(0.85 0.15 85)";

// The basis as the classic lobes: in every direction as far out as the function's magnitude there, scaled to 1.
const LOBES = Array.from({ length: 9 }, (_, index) => polar(([x, y, z]) => SHAPES(x, y, z)[index] ?? 0));

// A theme color as sRGB bytes, read back from a pixel: the tokens are oklch and color-mix, which canvas resolves.
const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
function token(name: string): Vec3 {
    if (!probe) return [128, 128, 128];
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = getComputedStyle(root).getPropertyValue(name).trim() || "gray";
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
}

// Positive in the accent, negative in the golden hour's orange.
function drawBasis() {
    const positive = token("--accent");
    const negative = token("--golden-hour");
    for (const canvas of root.querySelectorAll<HTMLCanvasElement>(".harmonics-basis")) {
        const shape = LOBES[Number(canvas.dataset.index)];
        if (shape) render(canvas, shape, (_, value) => (value >= 0 ? positive : negative));
    }
}

// The key to the spheres' axes, in the same view: east, north and up from the center.
function drawKey() {
    const svg = find<SVGSVGElement>(".harmonics-key", root);
    const r = 22;
    const { right, upward } = axes();
    const names: [string, Vec3][] = [
        ["E", [1, 0, 0]],
        ["N", [0, 1, 0]],
        ["up", [0, 0, 1]],
    ];
    const parts = names.map(([name, axis]) => {
        const x = r * dot(axis, right);
        const y = -r * dot(axis, upward);
        const length = Math.max(Math.hypot(x, y), 1e-9);
        const lx = x + (9 * x) / length;
        const ly = y + (9 * y) / length + 4;
        return `<line x1="0" y1="0" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${name}</text>`;
    });
    svg.setAttribute("viewBox", "-40 -40 80 80");
    svg.innerHTML = `<circle r="2"/>${parts.join("")}`;
}

// The sky, read back from a small mip level of the environment's cube map: radiance along directions spread evenly over
// the sphere, without the Sun's disc, which the cube map leaves out.
const SAMPLES = 2048;
const FACE = 16;
let samples: { directions: Vec3[]; radiance: Float32Array } | null = null;
let coefficients: Float32Array | null = null;
let sunDirection: readonly number[] = [0, -1, 0];
let reading = false;
let next: Environment | null = null;

const half = (bits: number) => {
    const exponent = (bits >> 10) & 31;
    const fraction = bits & 1023;
    const sign = bits & 32768 ? -1 : 1;
    if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
    if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
};

// Nowell's mapping inverted, as dkCubeFromSphere in cube.wgsl does it: the point on the cube a cubified map keeps d at.
function cubifyFace([x, y]: Vec3, z: number): Vec3 {
    const xx2 = 2 * x * x;
    const yy2 = 2 * y * y;
    const root3 = 3 - Math.sqrt(Math.max((yy2 - xx2 - 3) ** 2 - 12 * xx2, 0));
    return [
        Math.sign(x) * Math.sqrt(Math.max(xx2 - yy2 + root3, 0)) * Math.SQRT1_2,
        Math.sign(y) * Math.sqrt(Math.max(yy2 - xx2 + root3, 0)) * Math.SQRT1_2,
        Math.sign(z),
    ];
}
function cubeFromSphere([x, y, z]: Vec3): Vec3 {
    const [ax, ay, az] = [Math.abs(x), Math.abs(y), Math.abs(z)];
    if (ay >= ax && ay >= az) {
        const [a, b, c] = cubifyFace([x, z, y], y);
        return [a, c, b];
    }
    if (ax >= az) {
        const [a, b, c] = cubifyFace([y, z, x], x);
        return [c, a, b];
    }
    return cubifyFace([x, y, z], z);
}

/** The face, in WebGPU's order, and its s and t in [-1, 1] for a point on the cube or a direction, see cube.wgsl. */
function texelOf([x, y, z]: Vec3): [number, number, number] {
    const [ax, ay, az] = [Math.abs(x), Math.abs(y), Math.abs(z)];
    if (ax >= ay && ax >= az) return x > 0 ? [0, -z / ax, -y / ax] : [1, z / ax, -y / ax];
    if (ay >= az) return y > 0 ? [2, x / ay, z / ay] : [3, x / ay, -z / ay];
    return z > 0 ? [4, x / az, -y / az] : [5, -x / az, -y / az];
}

async function readSky(environment: Environment) {
    if (reading) {
        next = environment;
        return;
    }
    const { cube, sh, scale } = environment;
    if (!cube || !sh) return;
    reading = true;
    const cubified = environment.cubified ?? false;
    const device = gpuDevice();
    const level = Math.max(0, Math.round(Math.log2(cube.width / FACE)));
    const face = Math.max(1, cube.width >> level);
    const bytesPerRow = 256;
    const buffer = device.createBuffer({
        size: bytesPerRow * face * 6,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder({ label: "sternwarte:harmonicsReadback" });
    encoder.copyTextureToBuffer(
        { texture: cube, mipLevel: level },
        { buffer, bytesPerRow, rowsPerImage: face },
        { width: face, height: face, depthOrArrayLayers: 6 },
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const texels = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.destroy();
    const directions: Vec3[] = [];
    const radiance = new Float32Array(SAMPLES * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let k = 0; k < SAMPLES; ++k) {
        const z = 1 - (2 * (k + 0.5)) / SAMPLES;
        const h = Math.sqrt(Math.max(1 - z * z, 0));
        const d: Vec3 = [h * Math.cos(k * golden), h * Math.sin(k * golden), z];
        directions.push(d);
        const [f, s, t] = texelOf(cubified ? cubeFromSphere(d) : d);
        const i = Math.min(Math.floor(((s + 1) / 2) * face), face - 1);
        const j = Math.min(Math.floor(((t + 1) / 2) * face), face - 1);
        const offset = (f * face * bytesPerRow + j * bytesPerRow) / 2 + i * 4;
        for (let c = 0; c < 3; ++c) radiance[k * 3 + c] = half(texels[offset + c] ?? 0) / scale;
    }
    samples = { directions, radiance };
    sunDirection = environment.sky?.sunDirection ?? [0, -1, 0];
    coefficients = sh.map((v) => v / scale);
    buildSky();
    reading = false;
    requestDraw();
    if (next) {
        const pending = next;
        next = null;
        readSky(pending);
    }
}

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The irradiance for `normal` from the first `bands` bands of the coefficients, in lux. */
function fromCoefficients(sh: Float32Array, [x, y, z]: Vec3, bands: number): Vec3 {
    const weights = basis(x, y, z);
    const e: Vec3 = [0, 0, 0];
    for (let i = 0; i < bands * bands; ++i) {
        const w = (LOBE[BAND[i] ?? 0] ?? 0) * (weights[i] ?? 0);
        for (let c = 0; c < 3; ++c) e[c] += w * (sh[i * 3 + c] ?? 0);
    }
    return e.map((v) => Math.max(v, 0)) as Vec3;
}

/** The irradiance for `normal` from the sky's samples themselves, each weighted by the cosine, in lux. */
function fromSky({ directions, radiance }: NonNullable<typeof samples>, [x, y, z]: Vec3): Vec3 {
    const e: Vec3 = [0, 0, 0];
    directions.forEach(([dx, dy, dz], k) => {
        const cosine = x * dx + y * dy + z * dz;
        if (cosine <= 0) return;
        for (let c = 0; c < 3; ++c) e[c] += cosine * (radiance[k * 3 + c] ?? 0);
    });
    return e.map((v) => (v * 4 * Math.PI) / directions.length) as Vec3;
}

const encode = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
let skyShapes: Shape[] = [];

// The sky's irradiance as one shape each from one, two and three bands and from the whole sky: in every direction as
// far out as the light a surface facing it receives, all to one scale, the whole sky's farthest at 1, and colored by
// its hue. Under each but the last, how far it is off the whole sky's at worst, as a share of the brightest.
function buildSky() {
    if (!samples || !coefficients) return;
    const sky = samples;
    const sh = coefficients;
    const irradiance = [
        (n: Vec3) => fromCoefficients(sh, n, 1),
        (n: Vec3) => fromCoefficients(sh, n, 2),
        (n: Vec3) => fromCoefficients(sh, n, 3),
        (n: Vec3) => fromSky(sky, n),
    ];
    const fields = irradiance.map((light) => GRID.map(light));
    const exact = fields[3] ?? [];
    const brightest = Math.max(...exact.map((e) => luminance(...e)), 1e-9);
    skyShapes = fields.map((field) => {
        const hue = (e: Vec3) => e.map((c) => encode(c / Math.max(...e, 1e-9))) as Vec3;
        return polar(
            (_, k) => luminance(...(field[k] as Vec3)) / brightest,
            (_, k) => hue(field[k] as Vec3),
        );
    });
    fields.slice(0, 3).forEach((field, step) => {
        const worst = Math.max(...field.map((e, k) => Math.abs(luminance(...e) - luminance(...(exact[k] as Vec3)))));
        find(`[data-error="${step}"]`, root).textContent = `off by ${Math.round((100 * worst) / brightest)}%`;
    });
    find('[data-error="3"]', root).textContent = "the cube map";
}

function drawSky() {
    for (const canvas of root.querySelectorAll<HTMLCanvasElement>(".harmonics-build canvas")) {
        const shape = skyShapes[Number(canvas.dataset.step)];
        if (shape) render(canvas, shape, (color) => color, "rgb(255 255 255 / 0.25)");
    }
}

// The sky's own nine, rgb each, as bars from a line at zero, all to one scale: the largest of the 27 fills its height.
const CHANNELS = ["red", "green", "blue"];
function drawBars() {
    const sh = coefficients;
    if (!sh) return;
    const top = Math.max(...sh.map(Math.abs), 1e-9);
    const W = 36;
    const H = 28;
    for (const svg of root.querySelectorAll<SVGSVGElement>(".harmonics-bars")) {
        const index = Number(svg.dataset.index);
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        const bars = CHANNELS.map((channel, c) => {
            const v = ((sh[index * 3 + c] ?? 0) / top) * (H / 2 - 1);
            const y = v >= 0 ? H / 2 - v : H / 2;
            return `<rect class="harmonics-${channel}" x="${6 + c * 8}" y="${y.toFixed(2)}" width="7" height="${Math.max(Math.abs(v), 0.4).toFixed(2)}"/>`;
        });
        const values = CHANNELS.map(
            (channel, c) => `${channel} ${Math.round(sh[index * 3 + c] ?? 0).toLocaleString("en")}`,
        );
        svg.innerHTML = `<title>${values.join(", ")}</title>${bars.join("")}<line x1="2" x2="${W - 2}" y1="${H / 2}" y2="${H / 2}"/>`;
    }
}

// The irradiance along a vertical circle through the Sun, from every step: the normal turns from the zenith towards the
// Sun, down to the nadir and up again on the far side. One pixel a unit, so text stays at the page's size.
const STEPS = ["band 0", "bands 0, 1", "bands 0 to 2", "whole sky"];
function drawPlot() {
    const sky = samples;
    const sh = coefficients;
    const svg = find<SVGSVGElement>(".harmonics-plot", root);
    const width = svg.clientWidth;
    if (!sky || !sh || width === 0) return;
    const narrow = width < 480;
    const margin = { left: 1, right: 1, top: narrow ? 40 : 24, bottom: 22 };
    const height = 160 + margin.top;
    const [sx = 0, sy = -1] = sunDirection;
    const across = Math.hypot(sx, sy);
    const towards: Vec3 = across > 1e-6 ? [sx / across, sy / across, 0] : [0, -1, 0];
    const normals = Array.from({ length: 145 }, (_, k) => {
        const angle = (k / 144) * 2 * Math.PI;
        return [Math.sin(angle) * towards[0], Math.sin(angle) * towards[1], Math.cos(angle)] as Vec3;
    });
    const curves = [
        ...[1, 2, 3].map((bands) => normals.map((n) => luminance(...fromCoefficients(sh, n, bands)))),
        normals.map((n) => luminance(...fromSky(sky, n))),
    ];
    const top = Math.max(...curves.flat(), 1e-9) * 1.05;
    // A round number of lux under the top, as the one gridline across.
    const decade = 10 ** Math.floor(Math.log10(top));
    const round = ([5, 2, 1].find((f) => f * decade <= top) ?? 1) * decade;
    const x = (k: number) => margin.left + ((width - margin.left - margin.right) * k) / 144;
    const y = (v: number) => height - margin.bottom - ((height - margin.top - margin.bottom) * v) / top;
    const lines = curves.map(
        (curve, step) =>
            `<polyline class="harmonics-curve" data-step="${step}" points="${curve.map((v, k) => `${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`,
    );
    const names = narrow
        ? ["zenith", "Sun", "nadir", "away", "zenith"]
        : ["zenith", "towards the Sun", "nadir", "away from it", "zenith"];
    const ticks = names.map((name, i) => {
        const anchor = i === 0 ? "start" : i === 4 ? "end" : "middle";
        return `<line class="harmonics-grid" x1="${x(i * 36)}" x2="${x(i * 36)}" y1="${margin.top}" y2="${height - margin.bottom}"/><text x="${x(i * 36)}" y="${height - 6}" text-anchor="${anchor}">${name}</text>`;
    });
    const scale = `<line class="harmonics-grid" x1="${x(0)}" x2="${x(144)}" y1="${y(round)}" y2="${y(round)}"/><text x="${x(144) - 3}" y="${y(round) - 4}" text-anchor="end">${round.toLocaleString("en")} lux</text>`;
    const zero = `<line class="harmonics-zero" x1="${x(0)}" x2="${x(144)}" y1="${y(0)}" y2="${y(0)}"/>`;
    // The key over the plot, right-aligned and wrapped onto a second row where it does not fit one, its widths estimated
    // from the small text's average glyph.
    const widths = STEPS.map((name) => name.length * 6 + 30);
    const rows = widths.reduce((sum, w) => sum + w, 0) > width ? [STEPS.slice(0, 2), STEPS.slice(2)] : [STEPS];
    let step = 0;
    const key = rows.flatMap((row, r) => {
        let kx = width - margin.right - row.reduce((sum, name) => sum + name.length * 6 + 30, 0) + 12;
        const ky = r * 16 + 8;
        return row.map((name) => {
            const item = `<line class="harmonics-curve" data-step="${step++}" x1="${kx}" x2="${kx + 18}" y1="${ky - 4}" y2="${ky - 4}"/><text x="${kx + 22}" y="${ky}">${name}</text>`;
            kx += name.length * 6 + 30;
            return item;
        });
    });
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.style.height = `${height}px`;
    svg.innerHTML = [...ticks, zero, ...lines, scale, ...key].join("");
}

// While dragging, only the shapes and their key are drawn again.
const drawShapes = () => {
    drawBasis();
    drawSky();
    drawKey();
};
const requestShapes = onDemand(drawShapes, root);
const requestDraw = onDemand(() => {
    drawShapes();
    drawBars();
    drawPlot();
}, root);

new ResizeObserver(requestDraw).observe(panel);
// The basis follows the theme and its accent, both set on the root element.
new MutationObserver(requestDraw).observe(document.documentElement, { attributes: true });

// Any shape turns them all: across for the azimuth, up and down for the altitude, short of the poles.
for (const canvas of root.querySelectorAll<HTMLCanvasElement>(".harmonics-panel canvas")) {
    let last: [number, number] | null = null;
    canvas.addEventListener("pointerdown", (event) => {
        last = [event.clientX, event.clientY];
        dragging = true;
        canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
        if (!last) return;
        const limit = (85 * Math.PI) / 180;
        view.azimuth -= (event.clientX - last[0]) * 0.012;
        view.altitude = Math.min(Math.max(view.altitude + (event.clientY - last[1]) * 0.012, -limit), limit);
        last = [event.clientX, event.clientY];
        requestShapes();
    });
    for (const end of ["pointerup", "pointercancel"]) {
        canvas.addEventListener(end, () => {
            last = null;
            dragging = false;
            requestShapes();
        });
    }
}

for (const button of root.querySelectorAll<HTMLElement>(".harmonics-variants [data-variant]")) {
    button.addEventListener("click", () => {
        panel.dataset.variant = button.dataset.variant;
        for (const other of root.querySelectorAll(".harmonics-variants [data-variant]"))
            other.setAttribute("aria-pressed", String(other === button));
        requestDraw();
    });
}

if (gpu.error) {
    find(".harmonics-build", root).insertAdjacentHTML("afterbegin", `<p class="note">${gpu.error}</p>`);
} else {
    onEnvironment(readSky);
    needEnvironment(root);
    if (environment.sh) readSky(environment);
}

offsetSliders();
