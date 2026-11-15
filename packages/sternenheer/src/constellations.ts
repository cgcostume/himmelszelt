// The constellations' lines: which stars of the shipped catalog a line joins, for the pass to draw between them, and
// the 88 constellations' names to choose among them by.

/** The 88 constellations, their IAU abbreviations and Latin names, in the order the lines' data numbers them. */
export const CONSTELLATIONS: readonly (readonly [abbreviation: string, name: string])[] = [
    ["And", "Andromeda"],
    ["Ant", "Antlia"],
    ["Aps", "Apus"],
    ["Aql", "Aquila"],
    ["Aqr", "Aquarius"],
    ["Ara", "Ara"],
    ["Ari", "Aries"],
    ["Aur", "Auriga"],
    ["Boo", "Boötes"],
    ["CMa", "Canis Major"],
    ["CMi", "Canis Minor"],
    ["CVn", "Canes Venatici"],
    ["Cae", "Caelum"],
    ["Cam", "Camelopardalis"],
    ["Cap", "Capricornus"],
    ["Car", "Carina"],
    ["Cas", "Cassiopeia"],
    ["Cen", "Centaurus"],
    ["Cep", "Cepheus"],
    ["Cet", "Cetus"],
    ["Cha", "Chamaeleon"],
    ["Cir", "Circinus"],
    ["Cnc", "Cancer"],
    ["Col", "Columba"],
    ["Com", "Coma Berenices"],
    ["CrA", "Corona Austrina"],
    ["CrB", "Corona Borealis"],
    ["Crt", "Crater"],
    ["Cru", "Crux"],
    ["Crv", "Corvus"],
    ["Cyg", "Cygnus"],
    ["Del", "Delphinus"],
    ["Dor", "Dorado"],
    ["Dra", "Draco"],
    ["Equ", "Equuleus"],
    ["Eri", "Eridanus"],
    ["For", "Fornax"],
    ["Gem", "Gemini"],
    ["Gru", "Grus"],
    ["Her", "Hercules"],
    ["Hor", "Horologium"],
    ["Hya", "Hydra"],
    ["Hyi", "Hydrus"],
    ["Ind", "Indus"],
    ["LMi", "Leo Minor"],
    ["Lac", "Lacerta"],
    ["Leo", "Leo"],
    ["Lep", "Lepus"],
    ["Lib", "Libra"],
    ["Lup", "Lupus"],
    ["Lyn", "Lynx"],
    ["Lyr", "Lyra"],
    ["Men", "Mensa"],
    ["Mic", "Microscopium"],
    ["Mon", "Monoceros"],
    ["Mus", "Musca"],
    ["Nor", "Norma"],
    ["Oct", "Octans"],
    ["Oph", "Ophiuchus"],
    ["Ori", "Orion"],
    ["Pav", "Pavo"],
    ["Peg", "Pegasus"],
    ["Per", "Perseus"],
    ["Phe", "Phoenix"],
    ["Pic", "Pictor"],
    ["PsA", "Piscis Austrinus"],
    ["Psc", "Pisces"],
    ["Pup", "Puppis"],
    ["Pyx", "Pyxis"],
    ["Ret", "Reticulum"],
    ["Scl", "Sculptor"],
    ["Sco", "Scorpius"],
    ["Sct", "Scutum"],
    ["Ser", "Serpens Cauda"],
    ["Sex", "Sextans"],
    ["Sge", "Sagitta"],
    ["Sgr", "Sagittarius"],
    ["Tau", "Taurus"],
    ["Tel", "Telescopium"],
    ["TrA", "Triangulum Australe"],
    ["Tri", "Triangulum"],
    ["Tuc", "Tucana"],
    ["UMa", "Ursa Major"],
    ["UMi", "Ursa Minor"],
    ["Vel", "Vela"],
    ["Vir", "Virgo"],
    ["Vol", "Volans"],
    ["Vul", "Vulpecula"],
];

/** The twelve constellations of the zodiac, and Ophiuchus, which the ecliptic crosses too. */
export const ZODIAC: readonly string[] = [
    "Ari",
    "Tau",
    "Gem",
    "Cnc",
    "Leo",
    "Vir",
    "Lib",
    "Sco",
    "Oph",
    "Sgr",
    "Cap",
    "Aqr",
    "Psc",
];

/** Lines between stars of a catalog: per line the constellation's index in `CONSTELLATIONS`, the two stars' indices in
 *  the catalog, and a zero, as the pass reads them. */
export interface ConstellationLines {
    count: number;
    data: Uint32Array;
}

/** Lines from the bytes of a `.bin` as `scripts/constellations.mjs` writes them: little-endian Uint16 triples. */
export function constellationsFromBuffer(buffer: ArrayBuffer): ConstellationLines {
    if (buffer.byteLength % 6 !== 0) throw new Error("sternenheer: not a set of constellation lines");
    const view = new DataView(buffer);
    const count = buffer.byteLength / 6;
    const data = new Uint32Array(count * 4);
    for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) data[i * 4 + k] = view.getUint16((i * 3 + k) * 2, true);
    return { count, data };
}

/**
 * The shipped lines: 743 lines of the 88 constellations between stars of the shipped catalog, 4 KB, after the figures
 * of d3-celestial. Resolved next to the package's own files, as `BRIGHT_STARS`.
 */
export const CONSTELLATION_LINES = new URL("../data/constellations.bin", import.meta.url);

/** Fetches a set of lines, the shipped one by default, which fits the shipped catalog only. */
export async function loadConstellations(url: string | URL = CONSTELLATION_LINES): Promise<ConstellationLines> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`sternenheer: ${response.status} fetching ${url}`);
    return constellationsFromBuffer(await response.arrayBuffer());
}

/** Which constellations to draw as the bits the pass takes, 128 of them: all for null, else the abbreviations given. */
export function constellationMask(chosen: readonly string[] | null): Uint32Array {
    const mask = new Uint32Array(4);
    if (chosen === null) return mask.fill(0xffffffff);
    for (const abbreviation of chosen) {
        const i = CONSTELLATIONS.findIndex(([a]) => a === abbreviation);
        if (i < 0) throw new Error(`sternenheer: no constellation ${abbreviation}`);
        mask[i >> 5] = (mask[i >> 5] ?? 0) | (1 << (i & 31));
    }
    return mask;
}
