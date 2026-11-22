import { type AirTable, liftedDirection } from "@himmelszelt/dunstkreis";
import { fromDate, julianDayUT, stars } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import {
    configureCanvas,
    display,
    gpuDevice,
    onDisplay,
    onTables,
    SDR,
    gpu as shared,
    tables,
} from "../dunstkreis/atmosphere";
import { save } from "../dunstkreis/download";
import { figureInfo } from "../figure-info";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, splitLine } from "../sternzeit/figure";
import { linkedSearch } from "../sternzeit/state";
import { gpuMissing } from "../webgpu";
import { ev100Of, PHOTOS, type StarPhoto } from "./photo-options";
import { createStarsRenderer, inverseViewProjection, type SkyAt, skyAt, type ToneCurveName } from "./renderer";
import { bindStarGroups, picked } from "./stargroups";

const DEG = Math.PI / 180;
const f = (n: number) => n.toFixed(1);
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

// The stars the figure can name, with their places at J2000.0 in degrees, the brightest first.
const NAMES: readonly (readonly [string, number, number])[] = [
    ["Sirius", 101.29, -16.72],
    ["Canopus", 95.99, -52.7],
    ["Alpha Centauri", 219.9, -60.83],
    ["Arcturus", 213.92, 19.18],
    ["Vega", 279.23, 38.78],
    ["Capella", 79.17, 46.0],
    ["Rigel", 78.63, -8.2],
    ["Procyon", 114.83, 5.22],
    ["Achernar", 24.43, -57.24],
    ["Betelgeuse", 88.79, 7.41],
    ["Hadar", 210.96, -60.37],
    ["Altair", 297.7, 8.87],
    ["Acrux", 186.65, -63.1],
    ["Aldebaran", 68.98, 16.51],
    ["Antares", 247.35, -26.43],
    ["Spica", 201.3, -11.16],
    ["Pollux", 116.33, 28.03],
    ["Fomalhaut", 344.41, -29.62],
    ["Deneb", 310.36, 45.28],
    ["Mimosa", 191.93, -59.69],
    ["Regulus", 152.09, 11.97],
    ["Gacrux", 187.79, -57.11],
    ["Shaula", 263.4, -37.1],
    ["Bellatrix", 81.28, 6.35],
    ["Alnilam", 84.05, -1.2],
    ["Alnitak", 85.19, -1.94],
    ["Miaplacidus", 138.3, -69.72],
    ["Kaus Australis", 276.04, -34.38],
    ["Avior", 125.63, -59.51],
    ["Sargas", 264.33, -43.0],
    ["Atria", 252.17, -69.03],
    ["Peacock", 306.41, -56.74],
    ["Nunki", 283.82, -26.3],
    ["Saiph", 86.94, -9.67],
    ["Rasalhague", 263.73, 12.56],
    ["Mintaka", 83.0, -0.3],
    ["Sabik", 257.59, -15.72],
    ["Dschubba", 240.08, -22.62],
];

/** The camera of a photograph in the observer's ENU frame: where it looks, its right and its up, and the tangents of
 *  half its fields of view. */
function cameraOf(p: StarPhoto) {
    const [azimuth, altitude, roll] = [p.azimuth * DEG, p.altitude * DEG, p.roll * DEG];
    const forward = [
        Math.cos(altitude) * Math.sin(azimuth),
        Math.cos(altitude) * Math.cos(azimuth),
        Math.sin(altitude),
    ];
    const level = [Math.cos(azimuth), -Math.sin(azimuth), 0];
    const top = [
        (level[1] ?? 0) * (forward[2] ?? 0) - (level[2] ?? 0) * (forward[1] ?? 0),
        (level[2] ?? 0) * (forward[0] ?? 0) - (level[0] ?? 0) * (forward[2] ?? 0),
        (level[0] ?? 0) * (forward[1] ?? 0) - (level[1] ?? 0) * (forward[0] ?? 0),
    ];
    const [c, s] = [Math.cos(roll), Math.sin(roll)];
    const tx = Math.tan((p.fieldOfView * DEG) / 2);
    return {
        forward,
        right: level.map((r, i) => c * r - s * (top[i] ?? 0)),
        up: top.map((u, i) => c * u + s * (level[i] ?? 0)),
        tx,
        ty: (tx * p.height) / p.width,
    };
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

const minus = (text: string) => text.replace(/-/g, "−");
/** The photographs figure on `root`: photographs of the night sky under sternenheer's sky for their moments, places,
 *  lenses and exposures, one at a time. */
export function photosFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const img = find<HTMLImageElement>(".starphoto-frame > img", root);
    const stage = find<HTMLElement>(".starphoto-stage", root);
    const frame = find<HTMLElement>("[data-field=frame]", root);
    const marks = find<SVGSVGElement>("[data-field=marks]", root);
    const slider = find<HTMLInputElement>("[data-field=split]", root);
    const exposure = find<HTMLInputElement>("[data-field=exposure]", root);
    const haloStrength = find<HTMLInputElement>("[data-field=halo]", root);
    const note = find("[data-field=note]", root);
    const pressed = (name: string) => find(`[data-field=${name}]`, root).getAttribute("aria-pressed") === "true";
    const requestRender = onDemand(render, root);

    function setup() {
        if (shared.error) return null;
        const context = canvas.getContext("webgpu");
        if (!context) return null;
        configureCanvas(context, SDR);
        return { device: gpuDevice(), context };
    }
    const gpu = setup();
    if (!gpu) {
        // Without WebGPU the photographs still show, whole, with a note over their foot in the canvas' place.
        Object.assign(gpuMissing(canvas).style, { minHeight: "", background: "none" });
    }
    const renderer = gpu ? createStarsRenderer(gpu.device, requestRender) : null;

    const picks = [...root.querySelectorAll<HTMLButtonElement>(".photo-tab[data-pick]")];
    const credit = find("[data-field=credit]", root);
    let chosen = 0;
    const photo = () => PHOTOS[chosen] ?? (PHOTOS[0] as StarPhoto);
    // The exposure the photograph's stars match at, and the one drawn: the slider's stops brighter.
    const matched = (p: StarPhoto) => ev100Of(p.camera) - p.stops;
    const drawnAt = (p: StarPhoto) => matched(p) - Number(exposure.value);

    // The chosen photograph's moment, place, author and license, on the bar its tab opens into.
    function credits(p: StarPhoto) {
        const link = (href: string, text: string) =>
            Object.assign(document.createElement("a"), { href, textContent: text });
        const name = Object.assign(document.createElement("span"), {
            className: "photo-credit-name",
            textContent: p.label,
        });
        credit.replaceChildren(
            name,
            ` ${p.when}, ${p.where}, by `,
            link(p.page, p.author),
            ", ",
            link(p.licenseUrl, p.license),
        );
    }
    function pick(i: number) {
        chosen = i;
        const p = photo();
        img.src = `${root.dataset.base}${p.file}`;
        stage.style.setProperty("--aspect", String(p.width / p.height));
        for (const button of picks) button.setAttribute("aria-pressed", String(Number(button.dataset.pick) === i));
        exposure.value = "0";
        paintRange(exposure);
        credits(p);
        requestRender();
    }

    // The frame, the photograph's shape, as large as the stage holds it: all of it on the page, centered in full screen.
    function placed(p: StarPhoto) {
        const [w, h] = [stage.clientWidth || 600, stage.clientHeight || 400];
        const scale = Math.min(w / p.width, h / p.height);
        const [fw, fh] = [p.width * scale, p.height * scale];
        Object.assign(frame.style, {
            left: `${(w - fw) / 2}px`,
            top: `${(h - fh) / 2}px`,
            width: `${fw}px`,
            height: `${fh}px`,
        });
        return [fw, fh] as const;
    }

    // The brightest named stars in the frame, where the fit puts them, and the Moon where it is in it.
    function namesOf(p: StarPhoto, sky: SkyAt, air: AirTable | null, w: number, h: number) {
        const camera = cameraOf(p);
        const at = (direction: readonly [number, number, number]) => {
            const d = air ? liftedDirection(air, direction) : direction;
            const along = dot(d, camera.forward);
            if (along <= 0.05) return null;
            const [x, y] = [dot(d, camera.right) / along / camera.tx, dot(d, camera.up) / along / camera.ty];
            return Math.abs(x) < 0.97 && Math.abs(y) < 0.94 ? ([((x + 1) / 2) * w, ((1 - y) / 2) * h] as const) : null;
        };
        let svg = "";
        let shown = 0;
        const label = (name: string, [x, y]: readonly [number, number], r: number) => {
            svg += `<circle cx="${f(x)}" cy="${f(y)}" r="${r}" class="starphoto-ring"/>`;
            svg += `<text x="${f(x + r + 4)}" y="${f(y + 4)}" class="starphoto-name">${name}</text>`;
        };
        for (const [name, rightAscension, declination] of NAMES) {
            const direction = stars.applyMatrix3(
                sky.skyRotation,
                stars.equatorialToVector({ rightAscension, declination }),
            );
            const point = at(direction as [number, number, number]);
            if (!point || shown >= 9) continue;
            label(name, point, 9);
            shown++;
        }
        const moonAt = at(sky.moonDirection as [number, number, number]);
        if (moonAt) label("Moon", moonAt, 14);
        return svg;
    }

    let last: { sky: SkyAt; air: AirTable | null } | null = null;
    let drawn = false;
    function drawMarks() {
        if (!drawn) return;
        const p = photo();
        const [w, h] = placed(p);
        const at = Number(slider.value) / 100;
        let svg = last && pressed("names") ? namesOf(p, last.sky, last.air, w, h) : "";
        // The split line, but not at either end, where one side shows alone; a slider's thumb on it to drag.
        svg += at > 0 && at < 1 ? splitLine(at * w, 0, h, h / 2, "photo-split-line") : "";
        marks.setAttribute("viewBox", `0 0 ${w} ${h}`);
        drawSvg(marks, svg, 1);
        canvas.style.clipPath = `inset(0 0 0 ${at * 100}%)`;
        paintRange(slider);
    }

    let seen: Record<string, unknown> = {};
    function render() {
        const table = tables();
        if (!gpu || !renderer || !table) return;
        const p = photo();
        // At the photograph's own pixels, whatever the screen's: a star's image is as wide in both.
        if (canvas.width !== p.width || canvas.height !== p.height)
            Object.assign(canvas, { width: p.width, height: p.height });
        const sky = skyAt(julianDayUT(fromDate(new Date(p.date))), p.place, table.luts.model);
        const camera = cameraOf(p);
        const ev100 = drawnAt(p);
        const result = renderer.draw(gpu.context.getCurrentTexture(), {
            sky,
            luts: table.luts,
            format: SDR,
            headroom: 1,
            toneMap: display.toneCurve as ToneCurveName,
            width: p.width,
            height: p.height,
            inverseViewProjection: inverseViewProjection(camera.forward, camera.right, camera.up, camera.tx, camera.ty),
            projectionDistance: 0,
            pixelRatio: 1,
            ev100,
            stars: true,
            faintStars: picked(root, "catalog") !== "yale",
            deepStars: picked(root, "catalog") === "tycho",
            milkyWay: pressed("milkyway"),
            maps: "large",
            air: pressed("air"),
            twinkle: false,
            time: 0,
            glare: pressed("glare"),
            halo: Number(haloStrength.value),
            // A camera, not an eye: no shift towards blue in the dark.
            darkAdapted: false,
            moon: true,
            constellations: [],
        });
        if (!result) return;
        last = { sky, air: result.air };
        drawn = true;
        // For whoever waits for the picture, the fit's script: how many frames were drawn.
        root.dataset.frames = String(Number(root.dataset.frames ?? 0) + 1);
        drawMarks();
        const { latitude, longitude } = p.place;
        const { fNumber, seconds, iso } = p.camera;
        const utc = new Date(p.date).toISOString().slice(11, 16);
        const towards = COMPASS[Math.round(p.azimuth / 45) % 8];
        const moonUp = sky.moonDirection[2] > 0;
        note.textContent =
            `${p.when} (${utc} UTC), ${p.where}, ${Math.abs(latitude).toFixed(2)}° ${latitude >= 0 ? "N" : "S"} ` +
            `${Math.abs(longitude).toFixed(2)}° ${longitude >= 0 ? "E" : "W"} · looking ${towards}, ${p.altitude.toFixed(0)}° up, ` +
            `${p.fieldOfView.toFixed(0)}° wide · f/${fNumber}, ${seconds} s, ISO ${iso} · the Moon ` +
            `${moonUp ? `${(Math.asin(sky.moonDirection[2]) / DEG).toFixed(0)}° up, ${(sky.moonLit * 100).toFixed(0)}% lit` : "down"} · ` +
            `fitted to ${p.fit.stars} stars, ${p.fit.residual.toFixed(1)}′ left` +
            (picked(root, "catalog") === "tycho" && renderer.deepStars().state === "loading"
                ? " · fetching Tycho-2"
                : "");
        find("[data-field=ev]", root).textContent = minus(
            `${ev100.toFixed(1)} · the camera's ${ev100Of(p.camera).toFixed(1)}, its stars' ${matched(p).toFixed(1)}`,
        );
        seen = {
            ev100,
            cameraEV100: ev100Of(p.camera),
            moonAltitudeDeg: Math.asin(sky.moonDirection[2]) / DEG,
            moonLit: sky.moonLit,
        };
    }

    // The copy: the photograph's own moment and place in place of the page's, its source, author, license and fit.
    figureInfo(
        root,
        () => {
            const { label, matches: _, differs: __, ...p } = photo();
            return {
                utc: new Date(p.date).toISOString(),
                julianDay: julianDayUT(fromDate(new Date(p.date))),
                latitude: p.place.latitude,
                longitude: p.place.longitude,
                heightM: p.place.heightM,
                photograph: { label, ...p },
                drawn: seen,
            };
        },
        () => `${location.origin}${location.pathname}?photo=${chosen}#${root.id}`,
    );

    // The comparison as shown, at the photograph's pixels, as PNG: the photograph left of the split, sternenheer's sky
    // right of it. The canvas is drawn just before it is copied: WebGPU keeps it only for that task.
    function download() {
        const p = photo();
        const out = Object.assign(document.createElement("canvas"), { width: p.width, height: p.height });
        const context = out.getContext("2d");
        if (!context) return;
        const at = Math.round((Number(slider.value) / 100) * p.width);
        render();
        context.drawImage(canvas, 0, 0);
        context.drawImage(img, 0, 0, (at / p.width) * img.naturalWidth, img.naturalHeight, 0, 0, at, p.height);
        const name = p.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        out.toBlob((blob) => save(blob, `himmelszelt-${root.id}-${name}.png`), "image/png");
    }
    find("[data-field=download]", root).addEventListener("click", download);

    // Full screen takes the gallery along, so another photograph is a click away there too.
    const full = find("[data-field=full]", root);
    const fullscreen = find("[data-field=fullscreen]", root);
    fullscreen.addEventListener("click", () =>
        document.fullscreenElement ? document.exitFullscreen() : full.requestFullscreen(),
    );
    document.addEventListener("fullscreenchange", () => {
        fullscreen.setAttribute("aria-pressed", String(document.fullscreenElement === full));
        drawMarks();
    });

    bindStarGroups(root, requestRender);
    for (const name of ["milkyway", "air", "glare", "names"]) {
        const toggle = find(`[data-field=${name}]`, root);
        toggle.addEventListener("click", () => {
            toggle.setAttribute("aria-pressed", String(!pressed(name)));
            if (name === "names") drawMarks();
            else requestRender();
        });
    }
    exposure.addEventListener("input", () => {
        paintRange(exposure);
        requestRender();
    });
    function showHalo() {
        find("[data-field=haloValue]", root).textContent = Number(haloStrength.value).toFixed(2);
        paintRange(haloStrength);
    }
    haloStrength.addEventListener("input", () => {
        showHalo();
        requestRender();
    });
    showHalo();
    slider.addEventListener("input", drawMarks);
    // The line dragged on the picture itself, which full screen needs, as the slider is outside it.
    const drag = (event: PointerEvent) => {
        const box = frame.getBoundingClientRect();
        slider.value = String(Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)));
        drawMarks();
    };
    // Not the browser's own drag of the photograph or a selection, which a press just beside the line would start.
    stage.addEventListener("dragstart", (event) => event.preventDefault());
    stage.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        stage.setPointerCapture(event.pointerId);
        drag(event);
    });
    stage.addEventListener("pointermove", (event) => {
        if (stage.hasPointerCapture(event.pointerId)) drag(event);
    });
    for (const button of picks) button.addEventListener("click", () => pick(Number(button.dataset.pick)));

    // A link copied from here opens the same photograph.
    const linked = Number(linkedSearch.get("photo"));
    pick(location.hash === `#${root.id}` && Number.isInteger(linked) && PHOTOS[linked] ? linked : 0);
    paintRange(exposure);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(drawMarks).observe(stage);
}
