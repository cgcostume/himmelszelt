import type { CloudParams, CloudPass } from "@himmelszelt/gewoelk";
import { find } from "../dom";

// Timestamps of a frame's passes, two each: the march, the immediate rebuild, the blend, the detail noise made with the
// pass, and a keyframe's steps, each its own. Each frame resolves into its own stretch of a ring, read back whole
// whenever the last readback is done, so no frame's times are lost to one that is still mapped. A stretch is a multiple
// of 256 bytes, the least a resolve may be offset by.
const SLOTS = { march: 0, rebuild: 2, blend: 4, detail: 6, build: 8, COUNT: 96 } as const;
const RING = 64;
const STRETCH = 768;

type Batch = { id: number; step: number; slot: number };
type Frame = { seq: number; march: boolean; rebuild: boolean; sheets: boolean; blend: boolean; batches: Batch[] };
type Build = { id: number; frames: number; seq: number; steps: { label: string; ms: number | null }[]; done: boolean };

/** What a texture of the cloudscape is built by: the steps of a keyframe whose times add up to its own. */
const PARTS = { map: /^cloudMap$/, volume: /^(shape|flood|modeling|coverage)/, light: /^light$/, ambient: /^ambient$/ };
// The steps as the lab lists them: the jump flood's as one.
const listed = (name: string) => (name.startsWith("flood") ? "flood" : name);

const fixed = (ms: number) => ms.toFixed(ms < 0.095 ? 3 : 2);

/**
 * The lab of the clouds figure, for a `figure[data-clouds][data-lab]`: a clock of its own that runs the wind, the
 * evolution and the billows while it animates, the cloudscape changing by keyframes built a few steps a frame, and what
 * each part costs on the GPU. The figure calls it through its frame: `tick`, `update`, the march, `finish`, `submitted`.
 */
export function changeLab(
    root: HTMLElement,
    device: GPUDevice,
    hooks: { requestRender: () => void; nextWeather: () => void; timed?: () => void },
) {
    const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
    const choice = (name: string) =>
        root.querySelector<HTMLInputElement>(`input[name="${root.id}-${name}"]:checked`)?.value ?? "";
    const pressed = (name: string) => field(name).getAttribute("aria-pressed") === "true";
    const sliders = [...root.querySelectorAll<HTMLInputElement>("input[data-lab]")];
    const slider = (name: string) => Number(sliders.find((input) => input.dataset.lab === name)?.value ?? 0);
    for (const input of sliders) input.addEventListener("input", hooks.requestRender);

    const timed = device.features.has("timestamp-query");
    const timing = timed
        ? {
              set: device.createQuerySet({ type: "timestamp", count: SLOTS.COUNT }),
              resolve: device.createBuffer({
                  size: RING * STRETCH,
                  usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
              }),
              read: device.createBuffer({
                  size: RING * STRETCH,
                  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
              }),
          }
        : null;
    const stamps = (slot: number): { timestampWrites: GPUComputePassTimestampWrites } | Record<string, never> =>
        timing
            ? {
                  timestampWrites: {
                      querySet: timing.set,
                      beginningOfPassWriteIndex: slot,
                      endOfPassWriteIndex: slot + 1,
                  },
              }
            : {};

    const frames: (Frame | undefined)[] = [];
    let seq = 0;
    let read = 0;
    let busy = false;
    let frame: Frame = { seq: 0, march: false, rebuild: false, sheets: false, blend: false, batches: [] };
    const cost = { march: Number.NaN, rebuild: Number.NaN, blend: Number.NaN, sheets: Number.NaN, detail: Number.NaN };
    const builds = new Map<number, Build>();
    let building: Build | null = null;
    let lastBuild: Build | null = null;
    let buildCount = 0;
    let memoryBytes = 0;

    // The lab's clock, in seconds on top of the page's moment, and how far the billows have risen by it.
    const clock = { seconds: 0, detailShiftKm: 0 };
    let last = performance.now();
    let dt = 0;
    let morph = 1;
    let blended = -1;
    let first = true;
    let cycled = performance.now();

    function show() {
        const immediate = choice("mode") === "immediate";
        const parts = [`march ${Number.isFinite(cost.march) ? `${fixed(cost.march)} ms` : "untimed"}`];
        if (immediate)
            parts.push(`rebuild ${Number.isFinite(cost.rebuild) ? `${fixed(cost.rebuild)} ms` : "none yet"}`);
        else {
            parts.push(`blend ${Number.isFinite(cost.blend) ? `${fixed(cost.blend)} ms` : "none yet"}`);
            const total = lastBuild?.steps.reduce((sum, step) => sum + (step.ms ?? 0), 0);
            parts.push(
                lastBuild && total !== undefined
                    ? `keyframe ${fixed(total)} ms over ${lastBuild.frames} ${lastBuild.frames === 1 ? "frame" : "frames"}`
                    : "no keyframe yet",
            );
        }
        parts.push(`textures ${(memoryBytes / 2 ** 20).toFixed(0)} MiB`);
        field("lab.cost").textContent = timed ? parts.join(" · ") : "This browser gives no GPU timestamps.";
        const steps = new Map<string, number>();
        for (const step of immediate ? [] : (lastBuild?.steps ?? []))
            if (!step.label.startsWith("copy:"))
                steps.set(listed(step.label), (steps.get(listed(step.label)) ?? 0) + (step.ms ?? 0));
        field("lab.steps").textContent = [...steps].map(([label, ms]) => `${label} ${fixed(ms)}`).join(" · ");
        hooks.timed?.();
    }

    // Every frame's stretch since the last readback, once the buffer is free; again if frames came in meanwhile.
    async function readBack() {
        if (!timing || busy || read >= seq) return;
        busy = true;
        const upTo = seq;
        const encoder = device.createCommandEncoder({ label: "sternwarte:cloudsLabTimes" });
        encoder.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, RING * STRETCH);
        device.queue.submit([encoder.finish()]);
        await timing.read.mapAsync(GPUMapMode.READ);
        const times = new BigInt64Array(timing.read.getMappedRange().slice(0));
        timing.read.unmap();
        busy = false;
        for (let s = Math.max(read + 1, upTo - RING + 1); s <= upTo; s++) {
            const f = frames[s % RING];
            if (!f || f.seq !== s) continue;
            const ms = (slot: number) => {
                const at = ((s % RING) * STRETCH) / 8 + slot;
                return Number((times[at + 1] ?? 0n) - (times[at] ?? 0n)) / 1e6;
            };
            if (f.march) cost.march = ms(SLOTS.march);
            if (f.rebuild) cost.rebuild = ms(SLOTS.rebuild);
            if (f.sheets) cost.sheets = ms(SLOTS.rebuild);
            if (ms(SLOTS.detail) > 0) cost.detail = ms(SLOTS.detail);
            if (f.blend) cost.blend = ms(SLOTS.blend);
            for (const batch of f.batches) {
                const build = builds.get(batch.id);
                const step = build?.steps[batch.step];
                if (!build || !step) continue;
                step.ms = ms(batch.slot);
                if (build.done && build.steps.every((each) => each.ms !== null)) {
                    lastBuild = build;
                    builds.delete(build.id);
                }
            }
        }
        read = upTo;
        show();
        readBack();
    }

    // A keyframe's step as an entry of its build, timed unless it only copied or the frame is out of timestamps.
    function record(names: string[], slot: number | null) {
        if (!building) return;
        if (names.length > 0 && building.seq !== seq) building.frames += 1;
        building.seq = seq;
        for (const label of names) {
            const untimed = !timing || slot === null || label.startsWith("copy:");
            building.steps.push({ label, ms: untimed ? 0 : null });
            if (!untimed) frame.batches.push({ id: building.id, step: building.steps.length - 1, slot });
        }
    }
    // Up to `count` steps of the build that runs, a pass and a pair of timestamps each, from `slot` on: the slot after.
    function advance(
        keyframes: NonNullable<CloudPass["keyframes"]>,
        count: number,
        encoder: GPUCommandEncoder,
        slot: number,
    ) {
        let next = slot;
        for (let i = 0; i < count && keyframes.pending > 0; i++) {
            const timed = next + 1 < SLOTS.COUNT;
            record(keyframes.advance(1, { encoder, ...(timed ? stamps(next) : {}) }), timed ? next : null);
            if (timed) next += 2;
        }
        return next;
    }
    function finished(keyframes: NonNullable<CloudPass["keyframes"]>) {
        if (!building || keyframes.pending > 0) return;
        building.done = true;
        if (building.steps.every((step) => step.ms !== null)) {
            lastBuild = building;
            builds.delete(building.id);
        }
        building = null;
    }
    function begin(keyframes: NonNullable<CloudPass["keyframes"]>) {
        if (!keyframes.begin()) return;
        building = { id: ++buildCount, frames: 0, seq: -1, steps: [], done: false };
        builds.set(building.id, building);
    }

    for (const name of ["lab.animate", "lab.cycle"]) {
        field(name).addEventListener("click", () => {
            last = performance.now();
            cycled = last;
        });
    }

    return {
        clock,
        get animating() {
            return pressed("lab.animate");
        },
        /** What the cloud pass is made with, and a key of it. */
        get keyframes() {
            return choice("mode") !== "immediate";
        },
        get gridSize() {
            return Number(choice("grid")) || 256;
        },
        /** Timestamps for the pass' creation, which computes the detail noise. */
        get created() {
            return stamps(SLOTS.detail);
        },
        /** What a texture last took to compute, in ms: a part of the cloudscape by its keyframe's steps, the sheets'
         *  maps, or the detail noise. Unknown where the cloudscape is rebuilt at once, in a single pass. */
        took(part: keyof typeof PARTS | "sheets" | "detail") {
            if (part === "sheets" || part === "detail") return Number.isFinite(cost[part]) ? cost[part] : undefined;
            const steps = lastBuild?.steps.filter((step) => PARTS[part].test(step.label)) ?? [];
            return steps.length > 0 ? steps.reduce((sum, step) => sum + (step.ms ?? 0), 0) : undefined;
        },
        /** A new pass: no keyframe of it is built yet. */
        reset(pass: CloudPass) {
            first = true;
            morph = 1;
            blended = -1;
            building = null;
            lastBuild = null;
            builds.clear();
            cost.rebuild = Number.NaN;
            cost.blend = Number.NaN;
            memoryBytes = pass.memoryBytes;
        },
        /** Starts a frame: the clock runs on while the lab animates. */
        tick() {
            const now = performance.now();
            dt = pressed("lab.animate") ? Math.min((now - last) / 1000, 0.1) : 0;
            last = now;
            const elapsed = dt * (Number(choice("speed")) || 1);
            clock.seconds += elapsed;
            clock.detailShiftKm += (elapsed * slider("billowSpeed")) / 1000;
            if (dt > 0 && pressed("lab.cycle") && now - cycled > 6000) {
                cycled = now;
                hooks.nextWeather();
            }
            frame = { seq: ++seq, march: false, rebuild: false, sheets: false, blend: false, batches: [] };
            frames[seq % RING] = frame;
        },
        /** The parameters into the pass, and its cloudscape changed: at once, or by keyframes a few steps a frame. */
        update(pass: CloudPass, params: Partial<CloudParams>, encoder: GPUCommandEncoder) {
            // With keyframes, what the pass still rebuilds at once are the sheets' maps.
            // The first keyframe is the lab's to build as well, so its steps are timed like any other's.
            const rebuilt = pass.update(params, encoder, { ...stamps(SLOTS.rebuild), firstKeyframe: false });
            frame.rebuild = rebuilt && !pass.keyframes;
            frame.sheets = rebuilt && Boolean(pass.keyframes);
            const keyframes = pass.keyframes;
            if (!keyframes) return;
            if (dt > 0 && !first) {
                if (keyframes.stale && keyframes.pending === 0 && !keyframes.ready) begin(keyframes);
                const budget = Number(choice("budget")) || Number.POSITIVE_INFINITY;
                advance(keyframes, budget, encoder, SLOTS.build);
                finished(keyframes);
                morph += dt / Math.max(slider("interval"), 1e-3);
                if (morph >= 1 && keyframes.ready) {
                    keyframes.promote();
                    morph = 0;
                }
            } else {
                // Still, a change shows at once: whatever build runs is finished, and one of the clouds as they are now.
                // A new pass' first keyframe is built so too, for clouds in its first frame.
                first = false;
                let slot: number = SLOTS.build;
                for (let i = 0; i < 2 && (keyframes.stale || keyframes.pending > 0 || keyframes.ready); i++) {
                    if (keyframes.pending === 0 && !keyframes.ready) begin(keyframes);
                    slot = advance(keyframes, Number.POSITIVE_INFINITY, encoder, slot);
                    finished(keyframes);
                    keyframes.promote();
                    blended = -1;
                }
                morph = 1;
            }
            const t = Math.min(morph, 1);
            if (t !== blended) {
                keyframes.blend(t, { encoder, ...stamps(SLOTS.blend) });
                frame.blend = true;
                blended = t;
            }
        },
        /** The march's timestamps, for the pass' `encode`. */
        march() {
            frame.march = Boolean(timing);
            return stamps(SLOTS.march);
        },
        /** Ends a frame's encoder: its timestamps into the ring. */
        finish(encoder: GPUCommandEncoder) {
            if (timing) encoder.resolveQuerySet(timing.set, 0, SLOTS.COUNT, timing.resolve, (seq % RING) * STRETCH);
        },
        /** After the frame was submitted: the times read back, and the next frame while the lab animates. */
        submitted() {
            if (timing) readBack();
            else show();
            for (const input of sliders) {
                const output = input.parentElement?.querySelector("output");
                if (output) output.textContent = input.value;
            }
            if (pressed("lab.animate")) hooks.requestRender();
        },
    };
}
