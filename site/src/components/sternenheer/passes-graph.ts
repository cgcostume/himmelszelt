// The passes figure's frame graph: what the stars pass reads at the left, a box per dispatch, labeled with what it runs
// over, and what each leaves for the next as a thumbnail on the arrow that carries it, into the compose pass and on to
// your target. Across on a wide figure, lane under lane on a narrow one. The thumbnails are the figure's canvases,
// placed over the SVG; the SVG draws everything else, in Clocks' visual language (dunstkreis/clocks.css).

import { escapeText } from "../sternzeit/figure";

/** The canvases, as passes.ts names them: tile lists, halos' grid, halos, line tiles, frame. */
export type Thumb = "tiles" | "points" | "spread" | "lines" | "image";

/** What the graph shows besides its shape: what runs, and the numbers under the thumbnails and in the inputs. */
export interface GraphState {
    deep: boolean;
    sky: boolean;
    moon: boolean;
    notes: Partial<Record<Thumb, string>>;
    stars: string;
    milkyWay: string;
}

type Rect = { x: number; y: number; w: number; h: number };
type Box = { rect: Rect; name: string; sub: string; kind: "input" | "pass" | "yours"; on: boolean; lines?: string[] };
type Arrow = { points: [number, number][]; on: boolean; head?: boolean; label?: string };

const TITLES: Record<Thumb, string> = {
    tiles: "(a) the tile lists",
    points: "(b) the halos' grid",
    spread: "(c) the halos",
    lines: "(d) the lines' tiles",
    image: "(e) the frame",
};
const LINE = 14;
const CHAR = 6.4;
const MONO = 7;
const WIDE = 860;
const f = (n: number) => n.toFixed(1);

/** `text` broken into lines of at most `width` pixels at the labels' size, `char` pixels a character. */
function wrap(text: string, width: number, char = CHAR) {
    const most = Math.max(6, Math.floor(width / char));
    const lines: string[] = [];
    for (const word of text.split(" ")) {
        const last = lines[lines.length - 1];
        if (last !== undefined && last.length + 1 + word.length <= most) lines[lines.length - 1] = `${last} ${word}`;
        else lines.push(word);
    }
    return lines;
}

/** A box's height for its name and its note at `width`. */
const boxHeight = (name: string, sub: string, width: number) =>
    10 + (wrap(name, width - 8).length + wrap(sub, width - 8, MONO).length) * LINE;

/** The graph laid out into `width` pixels: the boxes, the thumbnails' places, the arrows and the height it takes. */
export function layout(width: number, s: GraphState) {
    const boxes: Box[] = [];
    const arrows: Arrow[] = [];
    const thumbs = {} as Record<Thumb, Rect>;
    const box = (x: number, cy: number, w: number, name: string, sub: string, kind: Box["kind"], on = true) => {
        const h = boxHeight(name, sub, w);
        const rect = { x, y: cy - h / 2, w, h };
        boxes.push({ rect, name, sub, kind, on });
        return rect;
    };
    const right = (r: Rect): [number, number] => [r.x + r.w, r.y + r.h / 2];
    const left = (r: Rect): [number, number] => [r.x, r.y + r.h / 2];
    // An input under the one before, by the height its wrapped name and note take.
    const below = (r: Rect, name: string, sub: string) => r.y + r.h + 10 + boxHeight(name, sub, r.w) / 2;
    const thumb = (name: Thumb, x: number, cy: number, w: number) => {
        const h = (w * 9) / 16;
        thumbs[name] = { x, y: cy - h / 2, w, h };
        return thumbs[name];
    };
    const inputs = {
        catalog: ["catalogs", s.stars],
        lines: ["constellations", "743 lines"],
        deep: ["Tycho-2", "2.4 million stars"],
        milkyWay: ["Milky Way's map", s.milkyWay],
        sky: ["dunstkreis' sky", "cd/m²"],
    } as const;
    const header =
        "Read by every pass: the parameters, with the camera, the sky's turn, the exposure and the Moon's disc, and the air's table";
    const headerLines = wrap(header, width - 90);
    const top = headerLines.length * LINE + 14;
    let height: number;
    const STEPS = [
        "the sky behind",
        "+ the Milky Way",
        "+ the stars of the tile",
        "+ the deep stars' light",
        "+ the halos",
        "+ the lines",
        "the eye at night",
        "× the exposure",
        "the tone curve",
    ];
    const steps = (w: number) => STEPS.flatMap((step) => wrap(step, w));

    if (width >= WIDE) {
        const g = width / 1140;
        const X = { input: 0, pass: 140 * g, t1: 290 * g, halo: 475 * g, t2: 600 * g, comp: 790 * g, out: 985 * g };
        const W = { input: 110 * g, pass: 120 * g, thumb: 160 * g, halo: 100 * g, comp: 170 * g, out: width - 985 * g };
        const th = (W.thumb * 9) / 16;
        const lane = th + 48;
        const cy = { tiles: top + 6 + th / 2, halos: top + lane + 6 + th / 2, lines: top + 2 * lane + 6 + th / 2 };
        const deepY = top + 3 * lane + 22;

        const catalog = box(X.input, cy.tiles, W.input, ...inputs.catalog, "input");
        const binH = cy.halos - cy.tiles + 52;
        const bin = { x: X.pass, y: cy.tiles - 26, w: W.pass, h: binH };
        boxes.push({ rect: bin, name: "bin", sub: "per star: count, prepare, place", kind: "pass", on: true });
        const tiles = thumb("tiles", X.t1, cy.tiles, W.thumb);
        const grid = thumb("points", X.t1, cy.halos, W.thumb);
        const halo = box(X.halo, cy.halos, W.halo, "halo", "a dispatch per level", "pass");
        const spread = thumb("spread", X.t2, cy.halos, W.thumb);
        const lineInput = box(X.input, cy.lines, W.input, ...inputs.lines, "input");
        const linePass = box(X.pass, cy.lines, W.pass, "lines", "per piece of a line", "pass");
        const lineTiles = thumb("lines", X.t1, cy.lines, W.thumb);
        const deepInput = box(X.input, deepY, W.input, ...inputs.deep, "input", s.deep);
        const deepPass = box(X.pass, deepY, W.pass, "deep", "per block of stars", "pass", s.deep);
        const map = box(X.input, below(deepInput, ...inputs.milkyWay), W.input, ...inputs.milkyWay, "input");
        const sky = box(X.input, below(map, ...inputs.sky), W.input, ...inputs.sky, "input", s.sky);
        const [mapY, skyY] = [map.y + map.h / 2, sky.y + sky.h / 2];
        height = sky.y + sky.h + 4;
        const compose = { x: X.comp, y: top, w: W.comp, h: height - top };
        const lines = steps(W.comp - 16);
        boxes.push({ rect: compose, name: "compose", sub: "per pixel, in cd/m²", kind: "pass", on: true, lines });
        const moon = box(X.out, cy.tiles, W.out, "nachtgestirn's Moon", "a pass over every pixel", "pass", s.moon);
        const frame = thumb("image", X.out, cy.halos, W.out);

        arrows.push(
            { points: [right(catalog), [bin.x, cy.tiles]], on: true },
            { points: [[bin.x + bin.w, cy.tiles], left(tiles)], on: true },
            { points: [[bin.x + bin.w, cy.halos], left(grid)], on: true },
            { points: [right(tiles), [compose.x, cy.tiles]], on: true },
            { points: [right(grid), left(halo)], on: true },
            { points: [right(halo), left(spread)], on: true },
            { points: [right(spread), [compose.x, cy.halos]], on: true },
            { points: [right(lineInput), left(linePass)], on: true },
            { points: [right(linePass), left(lineTiles)], on: true },
            { points: [right(lineTiles), [compose.x, cy.lines]], on: true },
            { points: [right(deepInput), left(deepPass)], on: s.deep },
            { points: [right(deepPass), [compose.x, deepY]], on: s.deep, label: "light, a sum a pixel" },
            { points: [right(map), [compose.x, mapY]], on: true },
            { points: [right(sky), [compose.x, skyY]], on: s.sky },
            { points: [[compose.x + compose.w, cy.tiles], left(moon)], on: s.moon },
            {
                points: [
                    [moon.x + moon.w / 2, moon.y + moon.h],
                    [frame.x + frame.w / 2, frame.y],
                ],
                on: s.moon,
            },
            {
                points: [
                    [compose.x + compose.w, cy.halos],
                    [frame.x, cy.halos],
                ],
                on: !s.moon,
            },
        );
    } else {
        const X = { input: 0, pass: 0.31 * width, thumb: 0.62 * width };
        const W = { input: 0.25 * width, pass: 0.25 * width, thumb: width - 0.62 * width - 14 };
        const bus = width - 5;
        const th = (W.thumb * 9) / 16;
        const lane = Math.max(th, 52) + 46;
        let y = top;
        const cyTiles = y + lane / 2 - 18;
        const catalog = box(X.input, cyTiles, W.input, ...inputs.catalog, "input");
        const bin = box(X.pass, cyTiles, W.pass, "bin", "per star: count, prepare, place", "pass");
        const tiles = thumb("tiles", X.thumb, cyTiles, W.thumb);
        y += lane;
        const cyHalos = y + lane / 2 - 10;
        const grid = thumb("points", X.input, cyHalos, W.input);
        const halo = box(X.pass, cyHalos, W.pass, "halo", "a dispatch per level", "pass");
        const spread = thumb("spread", X.thumb, cyHalos, W.thumb);
        y += lane + 8;
        const cyLines = y + lane / 2 - 18;
        const lineInput = box(X.input, cyLines, W.input, ...inputs.lines, "input");
        const linePass = box(X.pass, cyLines, W.pass, "lines", "per piece of a line", "pass");
        const lineTiles = thumb("lines", X.thumb, cyLines, W.thumb);
        y += lane;
        const deepY = y + 26;
        const deepInput = box(X.input, deepY, W.input, ...inputs.deep, "input", s.deep);
        const deepPass = box(X.pass, deepY, W.pass, "deep", "per block of stars", "pass", s.deep);
        const map = box(X.input, below(deepInput, ...inputs.milkyWay), W.input, ...inputs.milkyWay, "input");
        const sky = box(X.input, below(map, ...inputs.sky), W.input, ...inputs.sky, "input", s.sky);
        const composeY = sky.y + sky.h + 24;
        const lines = wrap(`${STEPS.slice(0, 6).join(" ")}; then ${STEPS.slice(6).join(", ")}`, width - 24);
        const composeH = 14 + 2 * LINE + lines.length * LINE + 6;
        const compose = { x: 0, y: composeY, w: width - 12, h: composeH };
        boxes.push({ rect: compose, name: "compose", sub: "per pixel, in cd/m²", kind: "pass", on: true, lines });
        const moonY = composeY + composeH + 40;
        const moon = box(
            width * 0.3,
            moonY,
            width * 0.4,
            "nachtgestirn's Moon",
            "a pass over every pixel",
            "pass",
            s.moon,
        );
        const frame = thumb("image", 0, 0, width);
        frame.y = moon.y + moon.h + 30;
        height = frame.y + frame.h + 2 * LINE + 8;

        const into = (from: [number, number]): Arrow => ({ points: [from, [bus, from[1]]], on: true, head: false });
        arrows.push(
            { points: [right(catalog), left(bin)], on: true },
            { points: [right(bin), left(tiles)], on: true },
            into(right(tiles)),
            {
                points: [
                    [bin.x + bin.w / 2, bin.y + bin.h],
                    [bin.x + bin.w / 2, grid.y - 10],
                    [grid.x + grid.w / 2, grid.y - 10],
                    [grid.x + grid.w / 2, grid.y],
                ],
                on: true,
            },
            { points: [right(grid), left(halo)], on: true },
            { points: [right(halo), left(spread)], on: true },
            into(right(spread)),
            { points: [right(lineInput), left(linePass)], on: true },
            { points: [right(linePass), left(lineTiles)], on: true },
            into(right(lineTiles)),
            { points: [right(deepInput), left(deepPass)], on: s.deep },
            { ...into(right(deepPass)), on: s.deep, label: "light, a sum a pixel" },
            { ...into(right(map)), on: true },
            { ...into(right(sky)), on: s.sky },
            {
                points: [
                    [bus, cyTiles],
                    [bus, compose.y],
                ],
                on: true,
            },
            {
                points: [
                    [moon.x + moon.w / 2, compose.y + compose.h],
                    [moon.x + moon.w / 2, moon.y],
                ],
                on: s.moon,
            },
            {
                points: [
                    [moon.x + moon.w / 2, moon.y + moon.h],
                    [moon.x + moon.w / 2, frame.y],
                ],
                on: s.moon,
            },
            {
                points: [
                    [width * 0.15, compose.y + compose.h],
                    [width * 0.15, frame.y],
                ],
                on: !s.moon,
            },
        );
    }
    return { width, height, boxes, arrows, thumbs, header: headerLines };
}

/** The graph's SVG for `state` at `width`, and where its thumbnails go. */
export function graphSvg(width: number, state: GraphState) {
    const { height, boxes, arrows, thumbs, header } = layout(width, state);
    let svg = `<defs>${["", "-on"].map((suffix) => `<marker id="passes-head${suffix}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L10 5L0 9z" class="passes-head${suffix}"/></marker>`).join("")}</defs>`;
    header.forEach((line, i) => {
        svg += `<text x="0" y="${12 + i * LINE}" class="figure-label figure-anchor-start">${escapeText(line)}</text>`;
    });
    for (const arrow of arrows) {
        const d = arrow.points.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join(" ");
        const head = arrow.head === false ? "" : ` marker-end="url(#passes-head${arrow.on ? "-on" : ""})"`;
        svg += `<path d="${d}" class="passes-arrow${arrow.on ? " on" : ""}"${head}/>`;
        if (arrow.label) {
            const [[x0, y0], [x1]] = arrow.points as [[number, number], [number, number]];
            const x = x1 - (x1 - x0) / 2;
            svg += `<text x="${f(x)}" y="${f(y0 - 8)}" class="figure-label passes-label${arrow.on ? "" : " off"}">${escapeText(arrow.label)}</text>`;
        }
    }
    for (const b of boxes) {
        const { x, y, w, h } = b.rect;
        const cls = `passes-box ${b.kind}${b.on ? " on" : ""}`;
        svg += `<g class="${cls}"><rect x="${f(x + 0.5)}" y="${f(y + 0.5)}" width="${f(w - 1)}" height="${f(h - 1)}" rx="4" class="passes-frame"/>`;
        const name = wrap(b.name, w - 8);
        const sub = wrap(b.sub, w - 8, MONO);
        const middle = x + w / 2;
        const start = b.lines ? y + 16 : y + h / 2 - ((name.length + sub.length - 1) * LINE) / 2;
        name.forEach((line, i) => {
            svg += `<text x="${f(middle)}" y="${f(start + i * LINE)}" class="figure-note passes-name">${escapeText(line)}</text>`;
        });
        sub.forEach((line, i) => {
            svg += `<text x="${f(middle)}" y="${f(start + (name.length + i) * LINE)}" class="figure-label passes-sub">${escapeText(line)}</text>`;
        });
        b.lines?.forEach((line, i) => {
            const ly = start + (name.length + sub.length + i) * LINE + 8;
            svg += `<text x="${f(x + 8)}" y="${f(ly)}" class="figure-label figure-anchor-start">${escapeText(line)}</text>`;
        });
        svg += "</g>";
    }
    for (const [name, r] of Object.entries(thumbs) as [Thumb, Rect][]) {
        svg += `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" rx="2" class="passes-thumb"/>`;
        const lines = [TITLES[name], ...wrap(state.notes[name] ?? "", r.w + 60)];
        lines.forEach((line, i) => {
            const title = i === 0 ? " passes-title" : "";
            // Centered under the thumbnail, but within the figure.
            const half = (line.length * CHAR) / 2;
            const x = Math.min(Math.max(r.x + r.w / 2, half), width - half);
            svg += `<text x="${f(x)}" y="${f(r.y + r.h + 12 + i * LINE)}" class="figure-label${title}">${escapeText(line)}</text>`;
        });
    }
    return { svg, height, thumbs };
}
