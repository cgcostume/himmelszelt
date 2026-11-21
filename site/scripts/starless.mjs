// Makes NASA's starless layer of the Deep Star Maps 2020 (svs.gsfc.nasa.gov/4851) as published, the "Milky Way
// background" without the cleanup sternenheer's `pnpm milkyway` gives it, for the chapter's figure of the Milky Way with
// and without its stars: the cap around Deneb of starmap.json, the rest black, in the encoding and at the resolution of
// sternenheer's own map, a texel of value 1 standing for MILKY_WAY_LUMINANCE as there. The cleanup moves light and keeps
// it, so the calibration holds for both.
//
//     pnpm --filter @himmelszelt/sternwarte starless [--force]
//
// Writes public/stars/starless-cygnus.webp, 4096 by 2048 texels, each channel's log2 in 8 bits over 12 stops. Needs
// sharp; downloads 35 MB once, into the cache `pnpm milkyway` uses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { download, notice, upToDate } from "../../packages/sternenheer/scripts/common.mjs";
import { readExr } from "../../packages/sternenheer/scripts/exr.mjs";

const SITE = fileURLToPath(new URL("../", import.meta.url));
const CACHE = fileURLToPath(new URL("../../packages/sternenheer/node_modules/.cache/sternenheer/", import.meta.url));
const SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851";
const JSON_FILE = join(SITE, "src/components/sternenheer/starmap.json");
const { width: WIDTH, stops: STOPS, center: CENTER, radius: RADIUS } = JSON.parse(readFileSync(JSON_FILE, "utf8"));
const HEIGHT = WIDTH / 2;
const WEBP = join(SITE, "public/stars/starless-cygnus.webp");
// As milkyway.mjs: a texel is a star where it is this many times brighter than the median of the 5 by 5 around it.
const STAR_RATIO = 2.5;

if (upToDate(WEBP, [fileURLToPath(import.meta.url), JSON_FILE], process.argv.includes("--force"))) {
    console.log(`${WEBP} is up to date`);
    process.exit(0);
}
notice("milkyway");

const milkyWay = readExr(download(`${SVS}/milkyway_2020_4k.exr`, CACHE, "milkyway_2020_4k.exr", "35 MB")).data;

const DEG = Math.PI / 180;
const unit = (ra, de) => [Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)];
const center = unit(CENTER.rightAscension * DEG, CENTER.declination * DEG);
const cosRadius = Math.cos(RADIUS * DEG);
const encode = (v) => (v <= 0 ? 0 : Math.min(Math.max(Math.round((Math.log2(v) / STOPS + 1) * 255), 0), 255));
const luminance = (i) => 0.2126 * milkyWay[3 * i] + 0.7152 * milkyWay[3 * i + 1] + 0.0722 * milkyWay[3 * i + 2];
const bytes = Buffer.alloc(WIDTH * HEIGHT * 3);
const window = new Float32Array(25);
let [texels, stars] = [0, 0];
for (let y = 0; y < HEIGHT; y++) {
    const declination = (90 - ((y + 0.5) / HEIGHT) * 180) * DEG;
    for (let x = 0; x < WIDTH; x++) {
        const [a, b, c] = unit(2 * Math.PI * (0.5 - (x + 0.5) / WIDTH), declination);
        if (a * center[0] + b * center[1] + c * center[2] < cosRadius) continue;
        const i = y * WIDTH + x;
        for (let k = 0; k < 3; k++) bytes[3 * i + k] = encode(Math.min(milkyWay[3 * i + k], 1));
        // The points the cleanup would take out, counted.
        let n = 0;
        for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) window[n++] = luminance((y + dy) * WIDTH + ((x + dx + WIDTH) % WIDTH));
        window.sort();
        texels++;
        if (luminance(i) > STAR_RATIO * window[12] + 1e-4) stars++;
    }
}
await sharp(bytes, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .webp({ quality: 95, effort: 6 })
    .toFile(WEBP);
console.log(`wrote ${WEBP}; within ${RADIUS}° of Deneb ${stars} of ${texels} texels are points the cleanup takes out`);
