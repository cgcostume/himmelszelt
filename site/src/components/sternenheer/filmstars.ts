// Real stars of the Yale Bright Star Catalogue that films and novels name, and two that history made matter, each claim
// checked against the source given. One entry per star and work, so a star may appear more than once. Fictional suns
// (Interstellar's Gargantua, Star Wars' suns) have no star here. Other figures read this list.

export interface FilmStar {
    /** The star's number in the Yale Bright Star Catalogue. */
    readonly hr: number;
    /** The star's row in `brightstars.csv` and in `loadCatalog`, counted from 0. */
    readonly row: number;
    readonly name: string;
    /** The official designation: the IAU's proper name where it differs from `name`, and the Bayer designation. */
    readonly designation: string;
    /** The color index B-V, as `brightstars.csv` lists it. */
    readonly bv: number;
    /** The work that names the star, or for a star of history a short label for what it did. */
    readonly film: string;
    /** The work's year, or the year of the historic record. */
    readonly year: number;
    /** A star of history, not of fiction: `film` is then a label, not a title. */
    readonly history?: boolean;
    readonly note: string;
    readonly source: string;
}

/** The work and its year, or the label and its year for a star of history, as plain text. */
export function told({ film, year, history }: Pick<FilmStar, "film" | "year" | "history">) {
    return history ? `${film}, ${year < 1000 ? "AD " : ""}${year}` : `${film} (${year})`;
}

export const FILM_STARS: readonly FilmStar[] = [
    {
        hr: 7001,
        row: 6987,
        name: "Vega",
        designation: "α Lyrae",
        bv: 0,
        film: "Contact",
        year: 1997,
        note: "The signal of prime numbers Ellie Arroway picks up comes from Vega.",
        source: "https://en.wikipedia.org/wiki/Contact_(1997_American_film)",
    },
    {
        hr: 509,
        row: 504,
        name: "Tau Ceti",
        designation: "τ Ceti",
        bv: 0.72,
        film: "Project Hail Mary",
        year: 2026,
        note: "The one star the Astrophage leave bright, where Ryland Grace is sent; the novel is from 2021.",
        source: "https://en.wikipedia.org/wiki/Tau_Ceti",
    },
    {
        hr: 1325,
        row: 1319,
        name: "40 Eridani A",
        designation: "Keid, ο² Eridani A",
        bv: 0.82,
        film: "Project Hail Mary",
        year: 2026,
        note: "Erid, the home of Rocky's people, orbits it.",
        source: "https://en.wikipedia.org/wiki/40_Eridani",
    },
    {
        hr: 2326,
        row: 2318,
        name: "Canopus",
        designation: "α Carinae",
        bv: 0.15,
        film: "Dune",
        year: 1965,
        note: "Arrakis orbits it, in Frank Herbert's novel that the films of 1984 and 2021 adapt.",
        source: "https://en.wikipedia.org/wiki/Canopus",
    },
    {
        hr: 1010,
        row: 1005,
        name: "Zeta² Reticuli",
        designation: "ζ² Reticuli",
        bv: 0.6,
        film: "Alien",
        year: 1979,
        note: "The Nostromo is just short of Zeta II Reticuli when it sets down on the moon later named LV-426.",
        source: "https://www.imdb.com/title/tt0078748/faq/",
    },
    {
        hr: 5459,
        row: 5447,
        name: "Alpha Centauri A",
        designation: "Rigil Kentaurus, α¹ Centauri",
        bv: 0.71,
        film: "Avatar",
        year: 2009,
        note: "Pandora is a moon of the gas giant Polyphemus, which orbits Alpha Centauri A.",
        source: "https://www.space.com/7698-real-science-avatar.html",
    },
    {
        hr: 5459,
        row: 5447,
        name: "Alpha Centauri A",
        designation: "Rigil Kentaurus, α¹ Centauri",
        bv: 0.71,
        film: "3 Body Problem",
        year: 2024,
        note: "The San-Ti live in the Alpha Centauri system, four light years away; the novel is from 2008.",
        source: "https://www.npr.org/2024/07/01/1250455746/netflix-three-body-problem-aliens-alpha-centauri",
    },
    {
        hr: 509,
        row: 504,
        name: "Tau Ceti",
        designation: "τ Ceti",
        bv: 0.72,
        film: "The Fall of Hyperion",
        year: 1990,
        note: "Tau Ceti Center, the world the Hegemony of Man rules from, orbits it, in Dan Simmons' Hyperion Cantos.",
        source: "https://www.penguinrandomhouse.com/books/167472/the-fall-of-hyperion-by-dan-simmons/paperback",
    },
    {
        hr: 2061,
        row: 2053,
        name: "Betelgeuse",
        designation: "α Orionis",
        bv: 1.85,
        film: "The Hitchhiker's Guide to the Galaxy",
        year: 2005,
        note: "Ford Prefect comes from a small planet somewhere near Betelgeuse; the novel is from 1979.",
        source: "https://en.wikipedia.org/wiki/Ford_Prefect_(character)",
    },
    {
        hr: 424,
        row: 419,
        name: "Polaris",
        designation: "α Ursae Minoris",
        bv: 0.6,
        film: "Navigation",
        year: 1492,
        history: true,
        note: "A degree from the pole, its height gives the latitude; Columbus corrected for its circle in 1492.",
        source: "https://en.wikipedia.org/wiki/Polaris",
    },
    {
        hr: 2491,
        row: 2482,
        name: "Sirius",
        designation: "α Canis Majoris",
        bv: 0,
        film: "Egypt's calendar",
        year: 139,
        history: true,
        note: "Its first rise at dawn heralded the Nile's flood; Censorinus records it on the Egyptian New Year of AD 139.",
        source: "https://en.wikipedia.org/wiki/Sothic_cycle",
    },
];
