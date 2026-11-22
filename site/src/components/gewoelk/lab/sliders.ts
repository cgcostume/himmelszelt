/** A research figure's slider: the parameter's name, its label, range, step, start and what it does. */
export type LabSlider = [
    param: string,
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    title: string,
];

/** The clouds thinning out towards the horizon, for every figure of the research: from where, and to nothing where. */
export const CLEARING: LabSlider[] = [
    ["clearFrom", "clear from", 0, 200, 5, 30, "The distance from which the clouds thin out, in km"],
    [
        "clearing",
        "clearing",
        0,
        400,
        10,
        0,
        "The distance at which the last cloud is gone, in km, so the horizon stays clear and a low sun shines in under the clouds: 0 for clouds all the way",
    ],
];

// The sliders of the cirrus figure, group by group.
export const CIRRUS_SHEET: LabSlider[] = [
    [
        "c.altitude",
        "altitude",
        4,
        18,
        0.1,
        7,
        "The sheet's height, in km: high clouds stand between 5 and 13 km in the middle latitudes, lower towards the poles and higher in the tropics",
    ],
    [
        "c.opticalDepth",
        "depth",
        0.1,
        4,
        0.1,
        0.6,
        "The sheet's optical depth where the map reads 1: a veil the Sun shines through has under 1, the densest cirrus about 3",
    ],
    ["c.tile", "tile", 8, 80, 1, 32, "One tile of the map, in km: larger tiles, coarser texels"],
    [
        "c.reach",
        "reach",
        0,
        400,
        10,
        140,
        "The distance at which the sheet has thinned out to none, in km: 0 for a sheet to the horizon",
    ],
    [
        "wind.from",
        "wind from",
        0,
        360,
        5,
        250,
        "Where the wind blows from, in degrees from north through east: the map's x axis runs along it",
    ],
    ["wind.speed", "wind", 0, 60, 1, 20, "The wind the sheet drifts with while the animation runs, in m/s"],
];
export const CIRRUS_PATCHES: LabSlider[] = [
    ["c.coverage", "coverage", 0, 1, 0.01, 0.55, "How much of the sky the sheet's patches and bands cover"],
    ["c.patchKm", "patch size", 10, 300, 5, 60, "A patch's size across, in km"],
    ["c.bandStretch", "band stretch", 1, 10, 0.1, 2, "How many times as long as wide the patches are: bands"],
    ["c.bandAngle", "band angle", 0, 180, 5, 20, "The bands' angle to the wind, in degrees"],
    ["c.edge", "edge", 0, 1, 0.05, 0.6, "How far a patch thins out towards its edge, where the puffs shrink"],
    ["c.flakes", "flakes", 0, 1, 0.05, 0.5, "How far the patches break up into flakes with clear sky between"],
    ["c.flakeKm", "flake size", 1, 40, 0.5, 9, "A flake's size across, in km"],
];
export const CIRRUS_CELLS: LabSlider[] = [
    ["c.cells", "puffs", 0, 1, 0.05, 1, "How much of the sheet is puffs, the cells of cirrocumulus and altocumulus"],
    ["c.cellKm", "puff size", 0.1, 1.5, 0.01, 0.32, "A puff's size across the wind, in km"],
    ["c.elongation", "elongation", 0.5, 4, 0.1, 1.1, "How many times as long along the wind as across the puffs are"],
    ["c.rows", "rows", 0, 1, 0.05, 0.7, "How regular the puffs stand, 0 scattered, 1 in rows"],
    ["c.grain", "grain", 0, 1, 0.05, 0.5, "How far lumps and a fine grain break each puff"],
    [
        "c.soft",
        "softness",
        0,
        1,
        0.05,
        0.5,
        "How far a puff fades out past its rim, read from a coarser level of the map: 0 a hard edge",
    ],
    ["c.billows", "billows", 0, 1, 0.05, 0.5, "How deep billows eat into the puffs from their rims, read per pixel"],
    ["c.billowKm", "billow size", 0.03, 0.6, 0.01, 0.14, "The largest billows' size, in km"],
    [
        "billowSpeed",
        "billow speed",
        0,
        5,
        0.1,
        0.5,
        "How fast the billows creep while the animation runs, in m/s: free, the map is not baked again for it",
    ],
];
export const CIRRUS_RIPPLES: LabSlider[] = [
    ["c.ripples", "ripples", 0, 1, 0.05, 0.7, "How far lanes of sky across the wind cut the puffs into rows"],
    ["c.rippleKm", "ripple spacing", 0.3, 6, 0.1, 1.1, "From crest to crest, in km"],
    ["c.curve", "curve", 0, 1, 0.05, 0.6, "How far the rows bend"],
    [
        "c.ribs",
        "ribs",
        0,
        1,
        0.05,
        0,
        "How far billows across a band break it into ribs, each with a sharp front and a tail",
    ],
    ["c.ribKm", "rib spacing", 1, 10, 0.1, 3.5, "From rib to rib, in km"],
];
export const CIRRUS_VEIL: LabSlider[] = [
    ["c.veil", "veil", 0, 1, 0.05, 0.08, "How much of the sheet is a veil without puffs"],
    ["c.striation", "striation", 0, 1, 0.05, 0.3, "How far the veil is drawn into fine lines along the wind"],
    ["c.stretch", "stretch", 2, 30, 1, 10, "How many times as long as wide the veil's lines are"],
    [
        "comb",
        "combing",
        0,
        48,
        2,
        0,
        "Steps of combing along the wind: each lets what lies upwind trail a little farther",
    ],
    ["c.streaks", "trail length", 0, 1, 0.05, 0.3, "How slowly a trail fades behind what it trails from"],
    ["c.bend", "trail bend", 0, 1, 0.05, 0.1, "How far the trails bend off the wind: 0 for straight, combed lines"],
];
export const CIRRUS_TIME: LabSlider[] = [
    [
        "phase",
        "phase",
        0,
        8,
        0.05,
        0,
        "The map's evolution, which loops every 8: puffs swell and fade, the fields shift",
    ],
    ["change", "change", 0, 20, 0.5, 2, "How fast the phase runs while the animation does, in steps per hour"],
    ["c.seed", "seed", 1, 99, 1, 7, "Another sky of the same kind"],
];
export const CIRRUS_LIGHT: LabSlider[] = [
    ["c.relief", "relief", 0, 3, 0.1, 1, "How far a puff's sunward neighbors shade it"],
    [
        "c.forwardG",
        "forward lobe",
        0.3,
        0.95,
        0.01,
        0.8,
        "The phase function's forward asymmetry, Henyey and Greenstein's g",
    ],
    ["view.ev", "exposure", 11, 17, 0.1, 14.2, "The exposure, in EV100"],
];

// The sliders of the formation figure: a layer's, and the figure's own.
// What a layer's clouds can be, with a little to spare: where its base stands, how deep it is and how dense, as extinction
// per km, which for droplets is 1.5 times the liquid water in g/m³ over their radius in mm.
interface Physical {
    base: [min: number, max: number, where: string];
    depth: [min: number, max: number, how: string];
    density: [min: number, max: number, which: string];
}
const LOW: Physical = {
    base: [0.2, 2.5, "low clouds stand below 2 km"],
    depth: [0.2, 3, "a fair-weather heap is a km deep, a swelling one two or three"],
    density: [5, 130, "a thin deck has 10 to 20, a heap 30 to 80"],
};
const DEEP: Physical = {
    base: [0.3, 3, "towers stand on the low clouds' level, higher over dry land"],
    depth: [2, 16, "to the tropopause at most, 12 km up in the middle latitudes and 17 in the tropics"],
    density: [10, 160, "a tower's core has 50 to 150, and the coarse map stands for less"],
};
const MIDDLE: Physical = {
    base: [2, 8, "middle clouds stand between 2 and 7 km, to 8 in the tropics"],
    depth: [0.2, 3, "altocumulus is a few hundred m deep, altostratus up to a few km"],
    density: [2, 60, "thin and partly ice: 5 to 30"],
};
const layer = (i: number, v: number[], what: string, lumps: string, is: Physical): LabSlider[] => [
    [`l${i}.coverage`, "coverage", 0, 1, 0.01, v[0] ?? 0, `How much of the sky ${what} cover: 0 for none`],
    [`l${i}.base`, "base", is.base[0], is.base[1], 0.1, v[1] ?? 0, `The layer's base, in km: ${is.base[2]}`],
    [
        `l${i}.depth`,
        "depth",
        is.depth[0],
        is.depth[1],
        0.1,
        v[2] ?? 0,
        `How deep the layer is, in km, its tallest clouds: ${is.depth[2]}`,
    ],
    [`l${i}.feature`, "size", 0.3, 40, 0.1, v[3] ?? 0, "A cloud's size across, in km"],
    [`l${i}.tile`, "tile", 8, 400, 4, v[4] ?? 0, "One tile of the layer's map, in km: it repeats beyond"],
    [
        `l${i}.extinction`,
        "density",
        is.density[0],
        is.density[1],
        1,
        v[5] ?? 0,
        `Extinction per km of full density: ${is.density[2]}`,
    ],
    [`l${i}.detail`, "detail", 0, 1, 0.05, v[6] ?? 0, "How far the detail noise's billows heap the surface out"],
    [`l${i}.sharp`, "sharpness", 0, 1, 0.05, v[7] ?? 0, "How hard the map's edges are"],
    [`l${i}.lumps`, "lumps", 0, 1, 0.05, v[8] ?? 0, lumps],
    [`l${i}.warp`, "bulge", 0, 1, 0.05, v[9] ?? 0, "How far the flanks bulge in and out as they rise"],
];
const CELLS = "How deep the cells on top cut: the turrets of a heap, the pillows of a deck, apart at 1";
const TURRETS = "How deep the turrets on a tower's top cut";
export const FORMATION_LOW = layer(0, [0.36, 1.2, 1.4, 2.5, 24, 40, 0.6, 0.4, 0.5, 0.4], "the low clouds", CELLS, LOW);
export const FORMATION_DEEP = layer(1, [0, 1.2, 9, 14, 112, 25, 0.5, 0.3, 0.7, 0.6], "the deep clouds", TURRETS, DEEP);
export const FORMATION_MIDDLE = layer(
    2,
    [0.25, 4.5, 0.7, 1.6, 28, 10, 0.5, 0.3, 0.6, 0.2],
    "the middle clouds",
    CELLS,
    MIDDLE,
);
export const FORMATION_ANVIL: LabSlider[] = [
    [
        "anvil",
        "anvil reach",
        0,
        1,
        0.05,
        0.6,
        "How far the anvils of tall towers stretch downwind, in towers' spacings",
    ],
];
export const FORMATION_FRONT: LabSlider[] = [
    [
        "front.distance",
        "front at",
        -200,
        200,
        1,
        12,
        "How far the front's leading edge is, in km along its bearing: negative once it has passed overhead",
    ],
    ["front.bearing", "bearing", 0, 360, 5, 20, "Where the front stands, in degrees from north through east"],
    ["front.depth", "front depth", 40, 400, 10, 160, "From the front's leading edge to its back, in km"],
];
export const FORMATION_RAIN: LabSlider[] = [
    [
        "rain",
        "rain",
        0,
        30,
        0.5,
        0,
        "How hard it rains under the deep clouds' tall columns, in mm an hour: where the Sun reaches the rain, its bows",
    ],
];
export const FORMATION_TIME: LabSlider[] = [
    [
        "wind.speed",
        "wind",
        0,
        40,
        1,
        10,
        "The wind the layers drift with while the animation runs, in m/s: the deep clouds at 0.6 of it, the middle ones at 1.8",
    ],
    ["wind.from", "wind from", 0, 360, 5, 200, "Where the wind blows from, in degrees from north through east"],
    ["shear", "shear", 0, 1.5, 0.05, 0.3, "How far the clouds lean with the wind as they rise, in km per km of height"],
    ["phase", "phase", 0, 8, 0.05, 0, "The maps' evolution, which loops every 8"],
    ["change", "change", 0, 20, 0.5, 1, "How fast the phase runs while the animation does, in steps per hour"],
    ["seed", "seed", 1, 99, 1, 23, "Another sky of the same kind"],
];
export const FORMATION_LIGHT: LabSlider[] = [
    ["multiple", "multiple", 0, 0.9, 0.05, 0.6, "Each further order of scattering's share of the one before"],
    ["ambient", "ambient", 0, 2, 0.05, 1, "The sky's light on the clouds"],
    ["view.ev", "exposure", 11, 17, 0.1, 14.2, "The exposure, in EV100"],
];
export const FORMATION_MARCH: LabSlider[] = [
    ["stepKm", "step", 0.02, 0.4, 0.01, 0.06, "The first step's length, in km"],
    ["stepGrowth", "step growth", 0, 0.1, 0.005, 0.03, "How steps grow with the distance, per km"],
    ["reachKm", "reach", 20, 400, 10, 200, "How far the march goes through the layers, in km"],
    ["fadeKm", "air", 20, 300, 5, 90, "The distance at which a cloud has faded to 1/e into the sky, in km"],
    ["noiseKm", "noise tile", 0.3, 6, 0.1, 1.6, "One tile of the detail noise, in km"],
    ["mapKm", "map extent", 40, 800, 20, 300, "How many km the view from above is tall"],
];

// The sliders of the voxel cloudscape's designer.
export const VOXEL: LabSlider[] = [
    ["v.coverage", "coverage", 0, 1, 0.01, 0.42, "How much of the sky the clouds cover"],
    ["v.sharpness", "sharpness", 0, 0.9, 0.01, 0.35, "How hard the cloud map's edges are"],
    [
        "v.size",
        "size",
        0.5,
        3,
        0.05,
        1,
        "How much larger the clouds are, every length of them but the base's height: the voxels grow with them",
    ],
    ["v.baseKm", "base", LOW.base[0], LOW.base[1], 0.1, 1.2, `The layer's base, in km: ${LOW.base[2]}`],
    ["v.heightKm", "height", 0.4, 4, 0.1, 2.4, "How tall the ordinary clouds' layer is, in km"],
    ["v.offset", "offset", 0, 0.9, 0.01, 0.25, "The share of the height the bottoms dip below the base's level"],
    [
        "v.extinction",
        "density",
        LOW.density[0],
        LOW.density[1],
        1,
        32,
        `Extinction per km of full density: ${LOW.density[2]}`,
    ],
    ["v.towers", "towers", 0, 1, 0.01, 0.3, "How much of the layer grows into towers that rise through it"],
    ["v.towerScale", "tower height", 1, 4, 0.1, 1.5, "How many times taller than the layer the towers grow"],
    [
        "v.billows",
        "billows",
        0,
        1,
        0.01,
        0.12,
        "How deep billows heap up the voxels' surface, as a share of the height",
    ],
    ["v.detail", "detail", 0, 1, 0.05, 0.55, "How far the detail noise erodes the voxels' shape, at every step"],
];
