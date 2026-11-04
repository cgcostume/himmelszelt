import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { veilingGlare } from "../src/glare.js";
import { gpuDevice } from "./gpu.js";

const wgsl = (name: string) => readFileSync(new URL(`../src/wgsl/${name}.wgsl`, import.meta.url), "utf8");

test("the veil follows CIE's equation, within its angles, and grows with age", () => {
    // At 1° a young eye: the three terms and the constant, 15.1025 cd/m² per lux.
    expect(veilingGlare(1, 0, 1)).toBeCloseTo(15.1025, 10);
    // Held at 0.1° inside, and at 100° outside, where the constant is nearly all that is left.
    expect(veilingGlare(0.01)).toBe(veilingGlare(0.1));
    expect(veilingGlare(180)).toBe(veilingGlare(100));
    expect(veilingGlare(100, 0, 1)).toBeCloseTo(0.00401, 6);
    // An eye of 62.5 years veils twice as much in the terms that age, and the cubic one not at all.
    const aging = (age: number) => veilingGlare(10, age, 1) - 10 / 1000 - 0.0025;
    expect(aging(62.5)).toBeCloseTo(2 * aging(0), 10);
    // Pigment adds a little, dark eyes least.
    expect(veilingGlare(10, 30, 0)).toBeLessThan(veilingGlare(10, 30, 1.2));
});

test("glare.wgsl compiles on its own and with the tone curves", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    for (const code of [wgsl("glare"), [wgsl("tonemap"), wgsl("glare")].join("\n")]) {
        const info = await device.createShaderModule({ code }).getCompilationInfo();
        expect(info.messages.filter((m) => m.type === "error")).toEqual([]);
    }
});
