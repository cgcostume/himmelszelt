import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { DEFAULT_CLOUD_PARAMS, DEFAULT_SHEET, drift, evolutionAt, PARAMS_SIZE, paramsData } from "../dist/index.js";

/**
 * Walks a WGSL struct's members by the uniform layout rules, so the packer and params.wgsl cannot drift apart: nothing
 * in the toolchain would catch it otherwise.
 */
const SIZES: Record<string, [size: number, align: number]> = {
    f32: [4, 4],
    u32: [4, 4],
    vec2f: [8, 8],
    vec3f: [12, 16],
    vec4f: [16, 16],
    mat4x4f: [64, 16],
};

function layout(source: string, name: string, structs: Map<string, [number, number]>) {
    const body = source.match(new RegExp(`struct ${name} \\{([^}]*)\\}`))?.[1] ?? "";
    let offset = 0;
    let align = 0;
    const members: Record<string, number> = {};
    for (const [, member, type] of body.matchAll(/^\s*(\w+):\s*([\w<>, ]+),/gm)) {
        const array = type?.match(/^array<(\w+), (\d+)>$/);
        const inner = array?.[1] ?? type ?? "";
        const [size, a] = SIZES[inner] ?? structs.get(inner) ?? [0, 0];
        const stride = Math.ceil(size / 16) * 16;
        const memberAlign = array ? Math.max(a, 16) : a;
        offset = Math.ceil(offset / memberAlign) * memberAlign;
        members[member ?? ""] = offset;
        offset += array ? stride * Number(array[2]) : size;
        align = Math.max(align, memberAlign);
    }
    const size = Math.ceil(offset / align) * align;
    structs.set(name, [size, align]);
    return { members, size };
}

test("the packer writes GwParams as params.wgsl lays it out", () => {
    const source = readFileSync(new URL("../src/wgsl/params.wgsl", import.meta.url), "utf8");
    const structs = new Map<string, [number, number]>();
    const sheet = layout(source, "GwSheet", structs);
    const cloudscape = layout(source, "GwCloudscape", structs);
    const params = layout(source, "GwParams", structs);
    expect(params.size).toBe(PARAMS_SIZE);
    expect(sheet.size).toBe(64);
    expect(cloudscape.size).toBe(112);

    const p = {
        ...DEFAULT_CLOUD_PARAMS,
        ev100: 0,
        timeS: 3600,
        sheets: [DEFAULT_SHEET, { ...DEFAULT_SHEET, seed: 9 }],
    };
    const data = paramsData(p, 5);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    const at = (offset: number) => f[offset / 4];
    expect(at(params.members.sunDirection ?? -1)).toBeCloseTo(p.sunDirection[0]);
    expect(at(params.members.planetRadius ?? -1)).toBe(p.planetRadiusKm);
    expect(at(params.members.exposure ?? -1)).toBeCloseTo(1 / 1.2);
    expect(u[(params.members.frame ?? -4) / 4]).toBe(5);
    expect(u[(params.members.sheets ?? -4) / 4]).toBe(2);
    const volume = (params.members.cloudscape ?? 0) + (cloudscape.members.extinction ?? 0);
    expect(at(volume)).toBe(p.cloudscape.extinction);
    const second = (params.members.sheet ?? 0) + 64 + (sheet.members.seed ?? 0);
    expect(u[second / 4]).toBe(9);
    const windDrift = (params.members.sheet ?? 0) + (sheet.members.drift ?? 0);
    expect(at(windDrift)).toBeCloseTo(drift(DEFAULT_SHEET.wind, 3600, DEFAULT_SHEET.scaleKm)[0]);
});

test("drift and evolution wrap", () => {
    // 25 m/s for an hour is 90 km, 10 km into the third 40 km tile.
    expect(drift([25, 0], 3600, 40)[0]).toBeCloseTo(10);
    expect(drift([-25, 0], 3600, 40)[0]).toBeCloseTo(30);
    expect(evolutionAt(1, 9 * 3600)).toBeCloseTo(1);
});
