#!/usr/bin/env node
// Makes the Moon's maps beyond what the package ships, for a site to host: the whole Moon at 8192 texels around, with a
// strip at 8192 from 52° to 11° south and 108° west to 108° east, where a close-up of the terminator in the southern
// highlands looks. Same sources, layout and packing as `maps.mjs`, which makes the 2048 texels and less. 16K was tried
// and dropped: it shows nothing 8K does not. A strip's place is in its file name and in `strips.json`, in texels of the
// whole map at its size. Rerunnable: `node scripts/maps-hq.mjs <outDir> [--cache <dir>]`; downloads some 1.8 GB once
// into the cache.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720";
const DEM = "ldem_64_uint.tif";
const DEM_WIDTH = 23040;
const STRIP = { west: -108, east: 108, north: -11, south: -52 };

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--"));
const cache = args.includes("--cache") ? args[args.indexOf("--cache") + 1] : "node_modules/.cache/nachtgestirn-maps";
if (!out) {
    console.error("usage: node scripts/maps-hq.mjs <outDir> [--cache <dir>]");
    process.exit(1);
}
mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });

function download(name) {
    const file = join(cache, name);
    if (!existsSync(file)) {
        console.log(`downloading ${name}`);
        execFileSync("curl", ["-sSL", "-o", file, `${SVS}/${name}`], { stdio: "inherit" });
    }
    return file;
}
function magick(args, input) {
    const result = spawnSync("magick", args, { input, maxBuffer: 2 ** 31 });
    if (result.status !== 0) throw new Error(`magick ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
}
const wrote = (file) => console.log(`wrote ${file}, ${(statSync(join(out, file)).size / 1e6).toFixed(1)} MB`);

// The strip in texels of a map `width` around, on whole texels.
function stripOf(width) {
    const perDegree = width / 360;
    const x = Math.floor((STRIP.west + 180) * perDegree);
    const y = Math.floor((90 - STRIP.north) * perDegree);
    return {
        x,
        y,
        width: Math.ceil((STRIP.east + 180) * perDegree) - x,
        height: Math.ceil((90 - STRIP.south) * perDegree) - y,
    };
}

// Heights `size` texels, packed losslessly into red and green, from LOLA's 16-bit gray.
function packHeights(gray, size, file) {
    const heights = new Uint16Array(gray.buffer, gray.byteOffset, size.width * size.height);
    const rgb = new Uint8Array(size.width * size.height * 3);
    for (let i = 0; i < heights.length; i++) {
        rgb[i * 3] = heights[i] >> 8;
        rgb[i * 3 + 1] = heights[i] & 255;
    }
    magick(
        [
            "-size",
            `${size.width}x${size.height}`,
            "-depth",
            "8",
            "rgb:-",
            "-define",
            "webp:lossless=true",
            join(out, file),
        ],
        Buffer.from(rgb.buffer),
    );
    wrote(file);
}
const grayOut = ["-endian", "LSB", "-depth", "16", "gray:-"];
const colorOut = (file) => ["-depth", "8", "-quality", "88", "-define", "webp:method=6", join(out, file)];

const dem = download(DEM);
const strips = {};
for (const [name, width] of [["8k", 8192]]) {
    const color = download(`lroc_color_16bit_srgb_${name}.tif`);
    const whole = `moon-color-${name}.webp`;
    magick([color, ...colorOut(whole)]);
    wrote(whole);
    packHeights(
        magick([dem, "-filter", "Box", "-resize", `${width}x${width / 2}!`, ...grayOut]),
        { width, height: width / 2 },
        `moon-height-${name}.webp`,
    );
    const s = stripOf(width);
    const crop = `${s.width}x${s.height}+${s.x}+${s.y}`;
    const stripColor = `moon-color-${name}-strip.webp`;
    magick([color, "-crop", crop, "+repage", ...colorOut(stripColor)]);
    wrote(stripColor);
    // The heights' strip cut from the 64 texels per degree a little wider, then averaged down onto the strip's texels.
    const scale = DEM_WIDTH / width;
    const demCrop = `${Math.round(s.width * scale)}x${Math.round(s.height * scale)}+${Math.round(s.x * scale)}+${Math.round(s.y * scale)}`;
    packHeights(
        magick([dem, "-crop", demCrop, "+repage", "-filter", "Box", "-resize", `${s.width}x${s.height}!`, ...grayOut]),
        s,
        `moon-height-${name}-strip.webp`,
    );
    strips[name] = { ...s, mapWidth: width };
}
if (Object.keys(strips).length) writeFileSync(join(out, "strips.json"), `${JSON.stringify(strips, null, 4)}\n`);
console.log(JSON.stringify(strips));
