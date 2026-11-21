// The asset mirror, github.com/cgcostume/himmelszelt-assets: a release per source and per build, never changed once
// published. The package's assets.json lists every file there, its release URL, original URL, license, size and SHA-256.
// Sources come from the mirror first and from their original URL where it fails; built files from the mirror alone.
// The same file is in every package that downloads, as each stands alone on npm.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";

const manifests = new Map();
/** The files a package's assets.json lists. */
export function mirrored(manifest) {
    if (!manifests.has(manifest)) manifests.set(manifest, JSON.parse(readFileSync(manifest, "utf8")).files);
    return manifests.get(manifest);
}

/** A file's SHA-256, hex, read a few megabytes at a time. */
export function sha256(file) {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1 << 24);
    const fd = openSync(file, "r");
    for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) hash.update(chunk.subarray(0, n));
    closeSync(fd);
    return hash.digest("hex");
}

/** Downloads `url` to `file` by curl, through a part file, and keeps it only where its SHA-256 is `sha` (if given). */
function fetchTo(url, file, sha) {
    mkdirSync(dirname(file), { recursive: true });
    const part = `${file}.part`;
    const result = spawnSync("curl", ["-fsSL", "--retry", "3", "-o", part, url], {
        stdio: ["ignore", "inherit", "pipe"],
    });
    if (result.status !== 0) {
        rmSync(part, { force: true });
        console.log(`  failed: ${result.error?.message ?? String(result.stderr).trim()}`);
        return false;
    }
    const found = sha && sha256(part);
    if (sha && found !== sha) {
        rmSync(part, { force: true });
        console.log(`  SHA-256 ${found}, not ${sha}`);
        return false;
    }
    renameSync(part, file);
    return true;
}

/**
 * Downloads the source `original` to `file`: from the mirror where `manifest` lists it, else, or where that fails, from
 * `original`. A file from there that differs from the mirrored one is kept with a warning: the source has changed.
 */
export function fetchSource(manifest, original, file, size) {
    const entry = mirrored(manifest).find(
        (e) => e.original === original || (e.kind === "source" && e.name === basename(file)),
    );
    const label = `${basename(file)}${size ? `, ${size}` : ""}`;
    if (entry) {
        console.log(`downloading ${label}, from the mirror, ${entry.url}`);
        if (fetchTo(entry.url, file, entry.sha256)) return file;
    }
    console.log(`downloading ${label}, from ${original}`);
    if (!fetchTo(original, file)) throw new Error(`${original}: download failed`);
    if (entry && sha256(file) !== entry.sha256)
        console.warn(`warning: ${basename(file)} differs from the mirrored ${entry.tag}: the source has changed`);
    return file;
}

/**
 * Fetches the built file `name` from the mirror to `file`. Returns "current" where `file` already is the mirrored one,
 * "kept" where it exists but differs (built here, say), "fetched", or "missing" where the mirror lacks it or fails.
 */
export function fetchBuilt(manifest, name, file) {
    const entry = mirrored(manifest).find((e) => e.kind === "built" && e.name === name);
    if (!entry) return "missing";
    if (existsSync(file)) return sha256(file) === entry.sha256 ? "current" : "kept";
    console.log(`downloading ${name}, ${(entry.size / 1e6).toFixed(1)} MB, from the mirror, ${entry.url}`);
    return fetchTo(entry.url, file, entry.sha256) ? "fetched" : "missing";
}
