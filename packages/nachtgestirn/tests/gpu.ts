/** The shared test device, Dawn through the `webgpu` package, as in dunstkreis' tests: opt-in, `pnpm test:gpu`. */
let devicePromise: Promise<GPUDevice | null> | undefined;
// Held for the life of the process: collected, it takes the device with it.
let instance: GPU | undefined;

export function gpuDevice(): Promise<GPUDevice | null> {
    devicePromise ??= (async () => {
        if (process.env.NACHTGESTIRN_GPU !== "1") return null;
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
