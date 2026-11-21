#!/usr/bin/env node
// The package's data, made where it is installed: `npx @himmelszelt/sternenheer data <name...> [options]`, or in the
// repository `pnpm assets [--all]`. Each name runs its script, which prints the terms its data comes under and the
// credit they ask for, caches its downloads and skips the work while its output is newer than its inputs. The files the
// asset mirror holds built come from there instead, checked by their SHA-256, unless `--build` is given.
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSETS, DATA, notice } from "./common.mjs";
import { fetchBuilt } from "./mirror.mjs";

const SCRIPTS = {
    catalog: "the Yale Bright Star Catalogue, brightstars-compact.bin.gz and brightstars.bin.gz, shipped",
    constellations: "the constellations' lines, constellations.bin, shipped",
    milkyway:
        "the Milky Way's maps, 2K and 4K, shipped, needs sharp and the repository's hipparcos.csv, 35 MB download; --size 8k, 19 MB, from the mirror or made with sharp from a 137 MB download",
    hipparcos:
        "the Hipparcos stars, hipparcos-compact.bin.gz and hipparcos.bin.gz, ESA, CC BY-NC 3.0 IGO; 15 MB download outside the repository",
    tycho: "the Tycho-2 stars, tycho-compact.bin.gz and tycho.bin.gz, ESA, CC BY-NC 3.0 IGO, after hipparcos; 200 MB download",
};
// What `assets` makes: the files the package does not ship, the site's 8K map among them, and with --all the shipped
// ones too.
const UNSHIPPED = [["hipparcos"], ["tycho"], ["milkyway", ["--size", "8k"]]];
// The files a name makes, with its options, that the mirror holds built.
const BUILT = {
    hipparcos: ["hipparcos.bin.gz", "hipparcos-compact.bin.gz"],
    tycho: ["tycho.bin.gz", "tycho-compact.bin.gz"],
    "milkyway --size 8k": ["milkyway-8k.webp"],
};

const [command, ...rest] = process.argv.slice(2);
const names = rest.filter((arg, i) => !arg.startsWith("--") && !rest[i - 1]?.match(/^--(out|cache|limit|size)$/));
const options = rest.filter((arg) => !names.includes(arg) && arg !== "--all" && arg !== "--build");
const out = resolve(rest.includes("--out") ? rest[rest.indexOf("--out") + 1] : DATA);

/** Whether `file` is in `out` as the mirror holds it, fetched if need be; one built here is kept. */
function fetched(file) {
    const state = fetchBuilt(ASSETS, file, join(out, file));
    if (state === "kept")
        console.log(`${file} differs from the mirror's and is kept; delete it to fetch it, --build remakes it`);
    return state !== "missing";
}

function run(name, extra = []) {
    console.log(`\n${name}: ${SCRIPTS[name]}`);
    const built = BUILT[[name, ...extra].join(" ")] ?? [];
    if (!rest.includes("--build") && built.length > 0 && built.every(fetched)) {
        notice(name);
        return;
    }
    execFileSync(process.execPath, [fileURLToPath(new URL(`${name}.mjs`, import.meta.url)), ...options, ...extra], {
        stdio: "inherit",
    });
}

if (command === "assets") {
    if (rest.includes("--all")) for (const name of Object.keys(SCRIPTS)) run(name);
    for (const [name, extra] of UNSHIPPED) if (!rest.includes("--all") || extra) run(name, extra);
} else if (command === "data" && names.length > 0 && names.every((name) => name in SCRIPTS)) {
    for (const name of names) run(name);
} else {
    console.log(`usage: sternenheer data <name...> [--out <dir>] [--cache <dir>] [--force] [--build] [--size 4k|8k]
       sternenheer assets [--all] [--build]

Makes the package's data files, by default into its own data directory, where its loaders find them; downloads are
cached in node_modules/.cache/sternenheer of the directory you run it from. Files the asset mirror
(github.com/cgcostume/himmelszelt-assets) holds built are fetched from there, unless --build is given. ESA's
catalogues come under CC BY-NC 3.0 IGO, not the package's MIT license: making them, you accept ESA's terms. Names:
${Object.entries(SCRIPTS)
    .map(([name, what]) => `  ${name.padEnd(15)}${what}`)
    .join("\n")}`);
    process.exit(command === undefined || command === "help" || command === "--help" ? 0 : 1);
}
