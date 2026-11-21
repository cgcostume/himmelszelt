import { luminanceFromSurfaceBrightness } from "@himmelszelt/sternenheer";

/** A column of the figure: a star by its name among the film stars, or by its row in the catalog with a note of its own,
 *  or a color of its own at a luminance of 1. */
export type Patch =
    | { kind: "star"; name: string; row?: number; note?: string }
    | { kind: "sky" | "white"; name: string; note: string; rgb: readonly [number, number, number] };

/** A column as the page hands it to the script, its star read from the catalog. */
export interface BuiltPatch {
    kind: Patch["kind"];
    name: string;
    film: string;
    bv?: number;
    magnitude: number | null;
    rgb?: readonly [number, number, number];
}

// The stars to show, blue-white to orange, the film stars by name, the two reddest by their rows; the moonlit sky as dunstkreis draws it, red and
// blue of green from the darkest tenth of the moonlit photograph's figure; and D65's white.
export const PATCHES: readonly Patch[] = [
    { kind: "star", name: "Vega" },
    { kind: "star", name: "Sirius" },
    { kind: "star", name: "Canopus" },
    { kind: "star", name: "Alpha Centauri A" },
    { kind: "star", name: "40 Eridani A" },
    { kind: "star", name: "Arcturus", row: 5328, note: "orange giant" },
    { kind: "star", name: "Betelgeuse", row: 2053, note: "red supergiant" },
    { kind: "sky", name: "moonlit sky", note: "dunstkreis", rgb: [0.73, 1, 1.79] },
    { kind: "white", name: "white", note: "D65", rgb: [1, 1, 1] },
];

// The luminance axis as its logarithm in cd/m², and the levels marked: a display's white, sRGB's reference, the clear
// sky under a full Moon (Puschnig et al.) and a moonless one.
export const MARKS = {
    min: -4.5,
    max: 4,
    white: 80,
    fullMoon: luminanceFromSurfaceBrightness(18.5),
    moonless: luminanceFromSurfaceBrightness(21.5),
};
