// The site's files that are not checked in, `pnpm assets [--all] [--build]`: the Moon's 8K maps, fetched from the asset
// mirror (github.com/cgcostume/himmelszelt-assets), checked by their SHA-256, or built where the mirror lacks them or
// with --build. --all also remakes the checked-in files the site's scripts make.
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBuilt } from "../../packages/sternenheer/scripts/mirror.mjs";

const SITE = fileURLToPath(new URL("../", import.meta.url));
const PACKAGES = join(SITE, "../packages");
const args = process.argv.slice(2);
const build = args.includes("--build");

const node = (script, ...rest) => execFileSync(process.execPath, [script, ...rest], { stdio: "inherit", cwd: SITE });
const FILES = [
    {
        files: ["public/moon/moon-color-8k.webp", "public/moon/moon-height-8k.webp"],
        manifest: join(PACKAGES, "nachtgestirn/assets.json"),
        make: () =>
            node(
                join(PACKAGES, "nachtgestirn/scripts/maps.mjs"),
                ...["--whole", "--size", "8k", "--out", "public/moon", "--force"],
                ...["--cache", join(PACKAGES, "nachtgestirn/node_modules/.cache/nachtgestirn-maps")],
            ),
    },
];

for (const { files, manifest, make } of FILES) {
    const states = build ? [] : files.map((file) => [file, fetchBuilt(manifest, basename(file), join(SITE, file))]);
    for (const [file, state] of states)
        if (state === "kept") console.log(`${file} differs from the mirror's and is kept; delete it to fetch it`);
    if (build || states.some(([, state]) => state === "missing")) make();
}
if (args.includes("--all"))
    for (const script of ["bluenoise", "images", "starmap", "starless", "milkyway-crops", "star-colors"])
        node(`scripts/${script}.mjs`);
