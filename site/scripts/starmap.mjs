// Makes NASA's starred layer of the Deep Star Maps 2020 (svs.gsfc.nasa.gov/4851) for the chapter's figure of the
// Milky Way with and without its stars: a cap of sky around Deneb, the rest black, in the encoding and at the
// resolution of sternenheer's own map, so the pass reads it the same way. NASA's starred layer is its two others added
// up, the Hipparcos and Tycho stars plus half the Milky Way background, clipped at 1, to within 1e-5 a texel:
// built here from those two, cached by sternenheer's `pnpm data:milkyway`. Its background is half the Milky Way layer's,
// so a texel of value 1 stands for twice MILKY_WAY_LUMINANCE, and the background matches sternenheer's map.
//
//     pnpm --filter @himmelszelt/sternwarte data:starmap [--force]
//
// Writes public/stars/starmap-cygnus.webp, 4096 by 2048 texels, each channel's log2 in 8 bits over 12 stops, and
// src/components/sternenheer/starmap.json. Needs sharp; downloads 57 MB once, from the asset mirror first.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { download, notice, upToDate } from "../../packages/sternenheer/scripts/common.mjs";
import { readExr } from "../../packages/sternenheer/scripts/exr.mjs";

const SITE = fileURLToPath(new URL("../", import.meta.url));
const CACHE = fileURLToPath(new URL("../../packages/sternenheer/node_modules/.cache/sternenheer/", import.meta.url));
const SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851";
const WIDTH = 4096;
const HEIGHT = 2048;
// As `MILKY_WAY_STOPS`.
const STOPS = 12;
// Deneb at J2000, and how far around it the map holds sky: past the corners of the figure's widest view.
const CENTER = { rightAscension: 310.358, declination: 45.28 };
const RADIUS = 36;
// The Milky Way background's share in NASA's starred layer.
const BACKGROUND = 0.5;
const WEBP = join(SITE, "public/stars/starmap-cygnus.webp");
const JSON_FILE = join(SITE, "src/components/sternenheer/starmap.json");

const force = process.argv.includes("--force");
if ([WEBP, JSON_FILE].every((file) => upToDate(file, [fileURLToPath(import.meta.url)], force))) {
    console.log(`${WEBP} is up to date`);
    process.exit(0);
}
notice("milkyway");

const layer = (name, size) => readExr(download(`${SVS}/${name}`, CACHE, name, size)).data;
const stars = layer("hiptyc_2020_4k.exr", "21 MB");
const milkyWay = layer("milkyway_2020_4k.exr", "35 MB");

const DEG = Math.PI / 180;
const unit = (ra, de) => [Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)];
const center = unit(CENTER.rightAscension * DEG, CENTER.declination * DEG);
const cosRadius = Math.cos(RADIUS * DEG);
const bytes = Buffer.alloc(WIDTH * HEIGHT * 3);
const encode = (v) => (v <= 0 ? 0 : Math.min(Math.max(Math.round((Math.log2(v) / STOPS + 1) * 255), 0), 255));
// The cap's light by layer, each texel weighted by its solid angle, in units of the Milky Way layer.
let [starsSum, backgroundSum, clipped] = [0, 0, 0];
for (let y = 0; y < HEIGHT; y++) {
    const declination = (90 - ((y + 0.5) / HEIGHT) * 180) * DEG;
    for (let x = 0; x < WIDTH; x++) {
        const rightAscension = 2 * Math.PI * (0.5 - (x + 0.5) / WIDTH);
        const [a, b, c] = unit(rightAscension, declination);
        if (a * center[0] + b * center[1] + c * center[2] < cosRadius) continue;
        const i = (y * WIDTH + x) * 3;
        for (let k = 0; k < 3; k++) {
            const v = stars[i + k] + BACKGROUND * milkyWay[i + k];
            if (k === 1 && v > 1) clipped++;
            bytes[i + k] = encode(Math.min(v, 1));
        }
        const weight = Math.cos(declination);
        const lum = (m) => 0.2126 * m[i] + 0.7152 * m[i + 1] + 0.0722 * m[i + 2];
        starsSum += (lum(stars) / BACKGROUND) * weight;
        backgroundSum += lum(milkyWay) * weight;
    }
}
await sharp(bytes, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .webp({ quality: 95, effort: 6 })
    .toFile(WEBP);
console.log(`wrote ${WEBP}, ${clipped} texels clipped`);
const added = ((100 * starsSum) / backgroundSum).toFixed(0);
console.log(`within ${RADIUS}° of Deneb the baked stars add ${added}% to the background's light`);
const about = { source: `${SVS}/starmap_2020_4k.exr`, width: WIDTH, stops: STOPS, background: BACKGROUND };
writeFileSync(JSON_FILE, `${JSON.stringify({ ...about, center: CENTER, radius: RADIUS }, null, 4)}\n`);
