import { skyRequirements, unmetRequirements } from "@himmelszelt/dunstkreis";

/**
 * The page's one WebGPU check, shared by every figure that renders on the GPU: the adapter, the device with what the
 * figures need, and where either cannot be had, why, with the fix for this browser. A page that imports it and has no
 * device shows one notice at its top; each figure that cannot render puts `gpuMissing` where its canvas was.
 */

const ua = navigator.userAgent;
const firefox = /Firefox\//.test(ua);
const safari = /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
const linux = /Linux/.test(ua) && !/Android/.test(ua);

const code = (text: string) => `<code>${text}</code>`;

function noApi() {
    if (!window.isSecureContext) return "WebGPU is only there for pages served over https or from localhost.";
    if (firefox && linux) {
        return (
            `Firefox on Linux ships WebGPU turned off. Open ${code("about:config")}, set ${code("dom.webgpu.enabled")} ` +
            `to true and reload. If the figures then find no GPU adapter, set ${code("gfx.webgpu.ignore-blocklist")} ` +
            "to true as well."
        );
    }
    if (firefox) {
        return (
            "Firefox has WebGPU on Windows from version 141 and on Macs with Apple silicon from 147. Update it, or set " +
            `${code("dom.webgpu.enabled")} to true in ${code("about:config")} and reload.`
        );
    }
    if (safari) {
        return (
            "Safari has WebGPU from version 26 on, in macOS, iOS and iPadOS 26. In older versions it can be turned on " +
            "under Develop, Feature Flags, WebGPU."
        );
    }
    return (
        "This browser has no WebGPU. Chrome and Edge have it from version 113, Firefox from 141 on Windows, Safari " +
        'from 26; see <a href="https://caniuse.com/webgpu" target="_blank" rel="noopener">caniuse.com/webgpu</a>.'
    );
}

function noAdapter() {
    if (firefox) {
        return (
            `Firefox found no GPU adapter for WebGPU, likely a blocklisted driver. Set ${code("gfx.webgpu.ignore-blocklist")} ` +
            `to true in ${code("about:config")} and reload.`
        );
    }
    if (linux && !safari) {
        return (
            `WebGPU is there, but without a GPU adapter. On Linux, Chrome needs ${code("chrome://flags/#enable-unsafe-webgpu")} ` +
            `and ${code("chrome://flags/#enable-vulkan")} enabled and a restart.`
        );
    }
    return "WebGPU is there, but the browser found no GPU adapter for it: the GPU or its driver may be blocklisted.";
}

export type Gpu = { device?: GPUDevice; adapterName?: string; error?: string };

async function acquire(): Promise<Gpu> {
    if (!navigator.gpu) return { error: noApi() };
    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) return { error: noAdapter() };
        const unmet = unmetRequirements(adapter, { format: "rgba8unorm" });
        if (unmet.length > 0) return { error: `This GPU lacks what the figures need: ${unmet.join(", ")}.` };
        // With subgroups where the GPU has them, for the sums over a workgroup.
        const requirements = skyRequirements({ format: "rgba8unorm" }, adapter);
        // Timestamps around a pass, for the figures that show what a pass costs, where the GPU gives them.
        if (adapter.features.has("timestamp-query")) requirements.requiredFeatures.push("timestamp-query");
        // As large a texture as the GPU takes, up to 16384, for the largest maps and environments.
        requirements.requiredLimits.maxTextureDimension2D = Math.max(
            requirements.requiredLimits.maxTextureDimension2D ?? 8192,
            Math.min(adapter.limits.maxTextureDimension2D, 16384),
        );
        // And as large a buffer, up to a gigabyte, to stage such a texture in on its way to the GPU.
        requirements.requiredLimits.maxBufferSize = Math.max(
            requirements.requiredLimits.maxBufferSize ?? 268_435_456,
            Math.min(adapter.limits.maxBufferSize, 1 << 30),
        );
        const device = await adapter.requestDevice(requirements);
        device.lost.then((info) => {
            if (info.reason === "destroyed") return;
            gpu.error = `The GPU device was lost (${info.message || "no reason given"}). Reloading the page brings it back.`;
            showGpuNotice();
        });
        // Which GPU, for the timings: a fallback adapter renders on the CPU, a hundred times slower.
        const { vendor, architecture, description, isFallbackAdapter } = adapter.info ?? {};
        const name = description || [vendor, architecture].filter(Boolean).join(" ") || "unknown GPU";
        return { device, adapterName: isFallbackAdapter ? `${name}, a CPU fallback` : name };
    } catch (error) {
        return { error: `The GPU gave no device: ${error instanceof Error ? error.message : String(error)}` };
    }
}

export const gpu = await acquire();

/** The page's GPU device, for code that runs only once `gpu.error` has been ruled out. */
export function gpuDevice(): GPUDevice {
    if (!gpu.device) throw new Error(gpu.error);
    return gpu.device;
}

/** Records why the GPU cannot render the figures after all, as when the tables fail to build, and says so on the page. */
export function gpuFailed(error: unknown) {
    console.error(error);
    gpu.error ??= `The figures failed on this GPU: ${error instanceof Error ? error.message : String(error)}`;
    showGpuNotice();
}

/** Shows the page's one notice of why its WebGPU figures do not render, at its top, once. */
export function showGpuNotice() {
    if (!gpu.error) return;
    let notice = document.getElementById("webgpu");
    if (!notice) {
        notice = Object.assign(document.createElement("aside"), { id: "webgpu", className: "gpu-notice" });
        notice.setAttribute("role", "note");
        const anchor = document.querySelector("main .page-meta") ?? document.querySelector("main h1");
        if (anchor) anchor.after(notice);
        else (document.querySelector("main") ?? document.body).prepend(notice);
    }
    notice.innerHTML =
        `<p><strong>The figures drawn on the GPU need WebGPU.</strong> ${gpu.error}</p>` +
        "<p>The text and the other figures work without it.</p>";
}

/** What a figure says in its canvas' place, or in its status line, where it cannot render: short, linked to the notice. */
export const GPU_MISSING = 'This figure needs WebGPU. <a href="#webgpu">Why not here?</a>';

/**
 * Hides a figure's `canvas`, or any element, behind a short note that it needs WebGPU, linked to the page's notice.
 * The element stays in the page, hidden, so code that still looks it up finds it, and the note takes its height, so the
 * figure keeps its shape. `className` styles the note: "tiles-empty" (the default) on the page, "sky-error" in a dark frame.
 */
export function gpuMissing(element: HTMLElement | SVGElement, className = "tiles-empty") {
    showGpuNotice();
    const note = Object.assign(document.createElement("div"), { className: `gpu-missing ${className}` });
    note.innerHTML = `<p>${GPU_MISSING}</p>`;
    const { height } = element.getBoundingClientRect();
    if (height > 0) note.style.minHeight = `${height}px`;
    element.style.display = "none";
    element.after(note);
    return note;
}

if (gpu.error) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showGpuNotice);
    else showGpuNotice();
}
