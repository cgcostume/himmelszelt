#!/usr/bin/env node
// The package's maps, made where it is installed: `npx @himmelszelt/nachtgestirn data <name...> [options]`, or in the
// repository `pnpm assets [--all]`. Each name runs its script, which caches its downloads and skips the work while its
// output is newer than its inputs. Maps the asset mirror holds built come from there instead, checked by their SHA-256,
// unless `--build` is given.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSETS, MAPS, mapFile, SHIPPED } from "./common.mjs";
import { fetchBuilt } from "./mirror.mjs";

const SCRIPTS = {
    maps: "the color and height maps from NASA's CGI Moon Kit, public domain, credit NASA's Scientific Visualization Studio; --size 512,1k,2k,4k,8k, the seen 512 and 1K shipped, 590 MB download, the 8K 240 MB more",
    roughness:
        "the roughness maps from Rosenburg et al. 2011's LOLA maps, NASA PDS Geosciences Node, public domain; --size 512,1k,2k,4k, the seen 512 and 1K shipped, 41 MB download",
};
// What the site draws: the whole Moon, its far side too, at every size up to 4K.
const SITE = ["--whole", "--size", "512,1k,2k,4k"];
// The kinds of map each name makes.
const KINDS = { maps: ["color", "height"], roughness: ["roughness"] };

const [command, ...rest] = process.argv.slice(2);
const names = rest.filter((arg, i) => !arg.startsWith("--") && !rest[i - 1]?.match(/^--(out|cache|size)$/));
const options = rest.filter((arg) => !names.includes(arg) && arg !== "--all" && arg !== "--build");

/** The maps a name makes with these options, as its script reads them. */
function outputs(name, argv) {
    const option = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);
    const whole = argv.includes("--whole");
    const variants = [...(whole ? [false] : []), ...(argv.includes("--seen") || !whole ? [true] : [])];
    const out = resolve(option("--out", MAPS));
    const sizes = option("--size", SHIPPED.join(",")).split(",");
    return KINDS[name].flatMap((kind) =>
        sizes.flatMap((size) => variants.map((seen) => join(out, mapFile(kind, size, seen)))),
    );
}

/** Whether `file` is there: checked in, or as the mirror holds it, fetched if need be; one built here is kept. */
function present(file) {
    const name = basename(file);
    const state = fetchBuilt(ASSETS, name, file);
    if (state === "kept")
        console.log(`${name} differs from the mirror's and is kept; delete it to fetch it, --build remakes it`);
    return state !== "missing" || existsSync(file);
}

function run(name, extra = []) {
    console.log(`\n${name}: ${SCRIPTS[name]}`);
    if (!rest.includes("--build") && outputs(name, [...options, ...extra]).every(present)) return;
    execFileSync(process.execPath, [fileURLToPath(new URL(`${name}.mjs`, import.meta.url)), ...options, ...extra], {
        stdio: "inherit",
    });
}

if (command === "assets") {
    for (const name of Object.keys(SCRIPTS)) {
        run(name, SITE);
        if (rest.includes("--all")) run(name);
    }
} else if (command === "data" && names.length > 0 && names.every((name) => name in SCRIPTS)) {
    for (const name of names) run(name);
} else {
    console.log(`usage: nachtgestirn data <name...> [--size 512,1k,...] [--whole] [--seen] [--out <dir>] [--cache <dir>] [--force] [--build]
       nachtgestirn assets [--all] [--build]

Makes the package's maps, by default into its own maps directory, where MOON_MAPS and MOON_ROUGHNESS find them; downloads
are cached in node_modules/.cache/nachtgestirn-maps of the directory you run it from. The seen maps (the default) hold
only what Earth ever sees, the whole ones (--whole) the far side too. Maps the asset mirror
(github.com/cgcostume/himmelszelt-assets) holds built are fetched from there, unless --build is given; building needs
sharp. Names:
${Object.entries(SCRIPTS)
    .map(([name, what]) => `  ${name.padEnd(11)}${what}`)
    .join("\n")}`);
    process.exit(command === undefined || command === "help" || command === "--help" ? 0 : 1);
}
