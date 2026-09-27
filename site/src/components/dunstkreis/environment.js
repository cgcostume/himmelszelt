import { readTexture } from "@himmelszelt/dunstkreis";
import { gpu, onEnvironment, setEnvironmentSize } from "./atmosphere.js";

const root = document.querySelector("#environment");
const field = (name) => root.querySelector(`[data-field="${name}"]`);
const panel = (name) => root.querySelector(`[data-panel="${name}"] canvas`);

const srgb = (c) => {
    const v = Math.min(Math.max(c, 0), 1);
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
};
const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The face and texel an ENU direction falls on: the inverse of cube.wgsl's dkCubeDirection. */
function cubeTexel([x, y, z], size) {
    const [ax, ay, az] = [Math.abs(x), Math.abs(y), Math.abs(z)];
    let face;
    let s;
    let t;
    if (ax >= ay && ax >= az) [face, s, t] = x > 0 ? [0, -z / ax, -y / ax] : [1, z / ax, -y / ax];
    else if (ay >= az) [face, s, t] = y > 0 ? [2, x / ay, z / ay] : [3, x / ay, -z / ay];
    else [face, s, t] = z > 0 ? [4, x / az, -y / az] : [5, -x / az, -y / az];
    const texel = (v) => Math.min(Math.floor(((v + 1) / 2) * size), size - 1);
    return [face, texel(s), texel(t)];
}

// Unrolled into a panorama, azimuth from north through east across, altitude up, tone mapped around its mean.
function drawPanorama(canvas, faces) {
    const size = faces[0].width;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const H = Math.max(1, Math.round(canvas.clientHeight * dpr));
    Object.assign(canvas, { width: W, height: H });
    const values = new Float32Array(W * H * 3);
    let sum = 0;
    for (let py = 0; py < H; ++py) {
        const altitude = Math.PI / 2 - ((py + 0.5) / H) * Math.PI;
        for (let px = 0; px < W; ++px) {
            const azimuth = ((px + 0.5) / W) * 2 * Math.PI;
            const d = [
                Math.cos(altitude) * Math.sin(azimuth),
                Math.cos(altitude) * Math.cos(azimuth),
                Math.sin(altitude),
            ];
            const [face, tx, ty] = cubeTexel(d, size);
            const i = (ty * size + tx) * 4;
            const data = faces[face].data;
            const o = (py * W + px) * 3;
            values.set([data[i], data[i + 1], data[i + 2]], o);
            sum += Math.log2(Math.max(luminance(data[i], data[i + 1], data[i + 2]), 1e-6));
        }
    }
    const key = 0.18 / 2 ** (sum / (W * H));
    const image = new ImageData(W, H);
    for (let p = 0; p < W * H; ++p) {
        const [r, g, b] = [values[p * 3], values[p * 3 + 1], values[p * 3 + 2]];
        const l = luminance(r, g, b) * key;
        [r, g, b].forEach((c, k) => {
            image.data[p * 4 + k] = srgb((c * key) / (1 + l));
        });
        image.data[p * 4 + 3] = 255;
    }
    canvas.getContext("2d").putImageData(image, 0, 0);
}

const readFaces = (texture) => Promise.all([0, 1, 2, 3, 4, 5].map((layer) => readTexture(gpu.device, texture, layer)));

let drawing = false;
let next = null;

// One at a time, drawing only the latest environment once the one before is done.
async function draw(environment) {
    next = environment;
    if (drawing) return;
    drawing = true;
    while (next) {
        const { cube, ibl, sh, sun, buildMs } = next;
        next = null;
        const [sky, irradiance] = await Promise.all([readFaces(cube), readFaces(ibl.irradiance)]);
        field("timing").textContent = `built in ${buildMs.toFixed(1)} ms`;
        drawPanorama(panel("sky"), sky);
        drawPanorama(panel("irradiance"), irradiance);
        showValues(sh, sun);
    }
    drawing = false;
}

const NAMES = ["0, 0", "1, −1", "1, 0", "1, 1", "2, −2", "2, −1", "2, 0", "2, 1", "2, 2"];
const e = (v) => v.toExponential(3).padStart(10);

function showValues(sh, [r, g, b]) {
    field("sun").textContent =
        `Sunlight at the observer: ${Math.round(luminance(r, g, b)).toLocaleString("en")} lux ` +
        `(rgb ${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
    field("sh").textContent = [
        "l, m        r          g          b",
        ...NAMES.map((name, i) => `${name.padEnd(6)} ${e(sh[i * 3])} ${e(sh[i * 3 + 1])} ${e(sh[i * 3 + 2])}`),
    ].join("\n");
}

if (gpu.error) {
    root.querySelector(".lut-bar").insertAdjacentHTML("afterend", `<p class="note">${gpu.error}</p>`);
} else {
    onEnvironment(draw);
    for (const radio of root.querySelectorAll('input[name="environment-size"]')) {
        radio.addEventListener("change", () => setEnvironmentSize(Number(radio.value)));
    }
}
