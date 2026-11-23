import { cloudQuality, type QualityLevel } from "@himmelszelt/gewoelk";

/**
 * gewoelk's dials of quality as every figure of the chapter shows them, one definition for all: `cloudQuality`'s three
 * dials, in this order, each with its four levels, its radios named `${figure}-${dial}` and valued by the level. What a
 * level means is said in its title, from the library's own numbers, for the part of them a figure reads (`Reads`).
 */
export type Dial = "reach" | "sampling" | "motion";
export const DIALS: readonly Dial[] = ["reach", "sampling", "motion"];
export const LEVELS: readonly QualityLevel[] = ["low", "medium", "high", "ultra"];
/** What of a level a figure reads: the voxel pass, the layered pass, a march's share of the frame and steps alone, or
 *  the high sheet's map alone. */
export type Reads = "voxel" | "layered" | "march" | "sheet";

const share = (scale: number) =>
    scale === 1 ? "The whole frame" : scale === 0.5 ? "Half the frame" : "A third of the frame";

function level(dial: Dial, reads: Reads, at: QualityLevel): string {
    const q = cloudQuality({ [dial]: at });
    if (dial === "reach") {
        const { clearingKm } = q.clearing;
        const seen = clearingKm ? `Clouds out to ${clearingKm} km` : "Clouds to the horizon";
        return reads === "layered" ? `${seen}, marched ${q.march.reachKm} km` : seen;
    }
    if (dial === "motion")
        return !q.evolves
            ? "No change of shape"
            : q.evolutionEveryS
              ? `The maps baked every ${q.evolutionEveryS} s`
              : "The maps baked every frame";
    const { scale, maxSteps, mapSize, highMapSize } = q.layered;
    if (reads === "sheet") return `A map of ${highMapSize} x ${highMapSize} texels`;
    if (reads === "voxel") {
        const { grid } = q.voxel;
        return `${share(q.voxel.scale ?? 1)}, ${q.voxel.maxSteps} steps, ${grid?.size} x ${grid?.size} x ${grid?.layers} voxels`;
    }
    const march = `${share(scale)}, ${maxSteps} steps`;
    return reads === "layered" ? `${march}, maps of ${mapSize} and ${highMapSize}` : march;
}

const TITLES: Record<Dial, string> = {
    reach: "How far the clouds are seen: sets the clearing's sliders, which stay yours to move",
    sampling: "How finely the clouds are marched and stored",
    motion: "How the clouds' shape changes while the clock runs: drift and billows are free at every level",
};

/** A dial as a `Choice`'s props, named in its row. */
export const dial = (name: Dial, reads: Reads, checked: QualityLevel = "medium") => ({
    name,
    label: name[0]?.toUpperCase() + name.slice(1),
    heading: name,
    title: TITLES[name],
    options: LEVELS.map((at) => [at, at, level(name, reads, at)]),
    checked,
});

/** What the level a figure's choice `chosen` names comes to, "medium" where it names none. */
export const sampled = (chosen: string | undefined) =>
    cloudQuality({ sampling: LEVELS.find((at) => at === chosen) ?? "medium" });
