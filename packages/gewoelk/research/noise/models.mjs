// The models the bakes are timed and pictured with, and a bench of the sheets' noise.
import { noise2 } from "./lib.mjs";

// A mackerel sky under a veil with ribs, every part of the high map's bake on, by the model's field names: the struct
// changes between commits, and each side packs it as its own shader lays it out.
const HIGH = {
    ...{ tile: 24, evolution: 0.37, seed: 7, combStep: 3, puffs: 1, puffSize: 0.32, elongation: 1.1, rows: 0.7 },
    ...{ grain: 0.5, ripples: 0.7, rippleSize: 1.1, curve: 0.6, ribs: 0.5, ribSize: 3.5, veil: 0.6, striation: 0.5 },
    ...{ stretch: 10, trails: 0.3, trailBend: 0.1 },
};

/** The high map's model for `code`, the shader it is baked by, its scalars packed in order; `ribs` set apart. */
export function highModel(code, ribs = HIGH.ribs) {
    const body = code.slice(
        code.indexOf("struct GwHighModel {"),
        code.indexOf("}", code.indexOf("struct GwHighModel {")),
    );
    const fields = [...body.matchAll(/^\s+(\w+): (f32|u32)/gm)].map((m) => [m[1], m[2]]);
    const buffer = new ArrayBuffer(Math.ceil((fields.length * 4) / 16) * 16);
    const [f, u] = [new Float32Array(buffer), new Uint32Array(buffer)];
    for (const [i, [name, type]] of fields.entries()) {
        const value = name === "ribs" ? ribs : (HIGH[name] ?? 0);
        if (type === "u32") u[i] = value;
        else f[i] = value;
    }
    return buffer;
}

/** The storage format a shader writes `binding` in, as it declares it. */
export const storageFormat = (code, binding) => code.match(new RegExp(`${binding}: texture_storage_2d<(\\w+),`))?.[1];

/** A layer's model of `kind`: 0 heaps, 2 towers, 3 a front, with anvils drawn out by the wind. */
export function layerModel(kind, layer = 0) {
    const buffer = new ArrayBuffer(64);
    new Uint32Array(buffer).set([kind, layer, 7 + layer * 17, kind === 0 ? 12 : 6], 0);
    new Float32Array(buffer).set([0.5, 0.5, 0.6, 0.37, 0.4, 0.1, 40, 40, 0.5], 4);
    return buffer;
}
/** The voxel model's cloud map, with towers or none. */
export function cloudModel(towers) {
    const buffer = new ArrayBuffer(48);
    new Float32Array(buffer).set([0.5, 0.5, 0.2, 0.37], 0);
    new Uint32Array(buffer).set([7, 5, 0, 4], 4);
    new Float32Array(buffer).set([towers, 0.3], 8);
    new Uint32Array(buffer)[10] = 8;
    new Float32Array(buffer)[11] = 2;
    return buffer;
}

/** What gwSheet asks of the noise for a pixel whose footprint is `footprint` km: 18 gradient noises at the finest. */
export function sheetBench(sheet, footprint) {
    const n = (p, seed, z) => noise2(sheet, p, seed, z);
    const functions = sheet.slice(
        sheet.indexOf("// A sheet's fibers"),
        sheet.indexOf("// Light scattered along a ray"),
    );
    return `${functions}
@group(0) @binding(0) var benchOut: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8, 1)
fn bench(@builtin(global_invocation_id) id: vec3u) {
    let ground = vec2f(id.xy) * 0.013 + 3.0;
    let sweep = ${n("ground / 25.0", "5u", "0.5")} * 4.0;
    let hook = ${n("ground / 5.0", "6u", "1.5")} * 0.8;
    let flow = vec2f(ground.x, ground.y + sweep + hook);
    let bundle = 0.5 + 0.5 * ${n("vec2f(flow.x / 3.3, flow.y)", "17u", "5.7")};
    let fiber = gwFibers(flow, 1.0, 2.0, 6.0, ${footprint}, 5u) * bundle;
    let ripples = gwRipples(flow, 1.0, ${footprint}, 5u);
    let broad = ${n("ground / 40.0", "35u", "8.9")};
    let flocks = gwFlocks(ground, 0.5, ${footprint}, 5u);
    let grain = gwGrain(ground, 0.2, ${footprint}, 5u);
    textureStore(benchOut, vec2i(id.xy), vec4f(fiber + ripples + broad + flocks + grain));
}`;
}
