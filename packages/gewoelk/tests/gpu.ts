import { readFileSync } from "node:fs";
import { reisszeugSource } from "../../../reisszeug/source.js";

/** The shared test device, Dawn through the `webgpu` package, as in dunstkreis' tests: opt-in, `pnpm test:gpu`. */
let devicePromise: Promise<GPUDevice | null> | undefined;
// Held for the life of the process: collected, it takes the device with it.
let instance: GPU | undefined;

export function gpuDevice(): Promise<GPUDevice | null> {
    devicePromise ??= (async () => {
        if (process.env.GEWOELK_GPU !== "1") return null;
        const { create, globals } = await import("webgpu");
        Object.assign(globalThis, globals);
        instance = create([]);
        const adapter = await instance.requestAdapter();
        return adapter ? adapter.requestDevice() : null;
    })();
    return devicePromise;
}

/** Compiles `code` and returns its error messages, empty when it compiled cleanly. */
export async function compileWgsl(device: GPUDevice, code: string): Promise<string[]> {
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    return info.messages.filter((m) => m.type === "error").map((m) => `${m.lineNum}: ${m.message}`);
}

/** A fragment `wgsl` composes with reisszeug's chunks, as the package does, by name; undefined for a file of its own. */
export function composedSource(name: string): string | undefined {
    const own = (file: string) => readFileSync(new URL(`../src/wgsl/${file}`, import.meta.url), "utf8");
    if (name === "noise")
        return [reisszeugSource("hash", "gw"), reisszeugSource("noise", "gw"), own("cells.wgsl")].join("\n");
    if (name === "params") return [reisszeugSource("phase", "gw"), own("params.wgsl")].join("\n");
    return undefined;
}
