// What the scripts here share: a Dawn device with timestamps, the package's shaders as they are and as they were at
// a commit, timing interleaved, and a PNG writer.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { prefixed } from "../../../../reisszeug/prefixed.ts";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(PACKAGE);
const { create, globals } = require("webgpu");
Object.assign(globalThis, globals);
// Held for the life of the process.
export const instance = create(["disable-dawn-features=timestamp_quantization"]);

export async function gpu() {
    const adapter = await instance.requestAdapter({ powerPreference: "high-performance" });
    const device = await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] });
    device.onuncapturederror = (e) => console.error("GPU ERROR:", e.error.message);
    return { adapter, device };
}

/** The commit compared against, `BASELINE` in the environment: by default the last with the noise before 2026-11-22. */
export const BASELINE = process.env.BASELINE ?? "53b20b1";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/** A file of the repository by its path from the root, as it is or as it was at commit `rev`; null where it was not. */
function file(path, rev) {
    try {
        if (!rev) return readFileSync(REPO + path, "utf8");
        return execFileSync("git", ["show", `${rev}:${path}`], {
            cwd: REPO,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch {
        return null;
    }
}

/**
 * A shader of the package by its file name, as it is or as it was at commit `rev`, composed as `wgsl` composed it then:
 * `noise.wgsl` and `params.wgsl` with reisszeug's chunks under the prefix `gw` once they came from there.
 */
export function wgsl(name, rev) {
    const own = (n) => file(`packages/gewoelk/src/wgsl/${n}`, rev);
    const shared = (chunk) => prefixed(file(`reisszeug/${chunk}.wgsl`, rev), "gw");
    if (name === "noise.wgsl") return own(name) ?? [shared("hash"), shared("noise"), own("cells.wgsl")].join("\n");
    if (name === "params.wgsl" && file("reisszeug/phase.wgsl", rev)) return [shared("phase"), own(name)].join("\n");
    return own(name);
}

/** The two sides compared: the baseline's shaders and the working tree's. */
export const SIDES = [
    { name: "before", shader: (file) => wgsl(file, BASELINE) },
    { name: "now", shader: (file) => wgsl(file) },
];

/** Workgroups across a layer's map of `size` texels, by the tile its shader bakes per workgroup: 8 before it had one. */
export function layerMapGroups(code, size) {
    const tile = Number(code.match(/GW_LAYER_MAP_TILE: u32 = (\d+)u/)?.[1] ?? 8);
    return Math.ceil(size / tile);
}

/** 2D gradient noise at `p` with `seed`, as each side reads it: a slice of the 3D noise before, gwPerlin2 since. */
export const noise2 = (code, p, seed, z = "0.5") =>
    code.includes("fn gwPerlin2(")
        ? `gwPerlin2(${p}, vec2i(1 << 20), ${seed})`
        : `gwPerlin(vec3f(${p}, ${z}), vec3i(1 << 20), ${seed})`;

export async function pipelineOf(device, code, entryPoint, constants) {
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}: ${m.message}`).join("\n"));
    return device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint, constants } });
}

/** Times `cases` ({ name, pipeline, group, dispatch }) interleaved, `runs` times each: median ms per case, by name. */
export async function time(device, cases, runs = 31, warm = 3) {
    const total = cases.length * runs;
    const sets = [];
    const PER = 2048;
    for (let i = 0; i < Math.ceil(total / PER); i++)
        sets.push(device.createQuerySet({ type: "timestamp", count: 2 * PER }));
    const once = async (c, slot) => {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass(
            slot === null
                ? {}
                : {
                      timestampWrites: {
                          querySet: sets[Math.floor(slot / PER)],
                          beginningOfPassWriteIndex: 2 * (slot % PER),
                          endOfPassWriteIndex: 2 * (slot % PER) + 1,
                      },
                  },
        );
        pass.setPipeline(c.pipeline);
        pass.setBindGroup(0, c.group);
        pass.dispatchWorkgroups(...c.dispatch);
        pass.end();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
    };
    for (let w = 0; w < warm; w++) for (const c of cases) await once(c, null);
    let slot = 0;
    for (let r = 0; r < runs; r++) for (const c of cases) await once(c, slot++);
    const bytes = 16 * PER * sets.length;
    const resolve = device.createBuffer({ size: bytes, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    sets.forEach((set, i) => {
        const used = Math.min(PER, total - i * PER);
        encoder.resolveQuerySet(set, 0, 2 * used, resolve, 16 * PER * i);
    });
    encoder.copyBufferToBuffer(resolve, 0, read, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const stamps = new BigUint64Array(read.getMappedRange().slice(0));
    read.unmap();
    const out = {};
    cases.forEach((c, k) => {
        const ms = [];
        for (let r = 0; r < runs; r++) {
            const s = r * cases.length + k;
            ms.push(Number(stamps[2 * s + 1] - stamps[2 * s]) / 1e6);
        }
        ms.sort((a, b) => a - b);
        out[c.name] = {
            median: ms[ms.length >> 1],
            low: ms[Math.floor(ms.length * 0.1)],
            high: ms[Math.floor(ms.length * 0.9)],
        };
    });
    return out;
}

/** An 8 bit grayscale or RGBA PNG. */
export function png(path, width, height, data, channels = 1) {
    const crcTable = new Uint32Array(256).map((_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, body) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(body.length);
        const td = Buffer.concat([Buffer.from(type), body]);
        const c = Buffer.alloc(4);
        c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
    };
    const head = Buffer.alloc(13);
    head.writeUInt32BE(width, 0);
    head.writeUInt32BE(height, 4);
    head.set([8, channels === 1 ? 0 : 6, 0, 0, 0], 8);
    const raw = Buffer.alloc((width * channels + 1) * height);
    for (let y = 0; y < height; y++)
        Buffer.from(data.buffer, data.byteOffset + y * width * channels, width * channels).copy(
            raw,
            y * (width * channels + 1) + 1,
        );
    writeFileSync(
        path,
        Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            chunk("IHDR", head),
            chunk("IDAT", deflateSync(raw)),
            chunk("IEND", Buffer.alloc(0)),
        ]),
    );
}
