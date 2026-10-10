import * as precise from "@himmelszelt/sternzeit";
import * as approx from "@himmelszelt/sternzeit/approx";
import { lookupEntry } from "../../lib/glossary";
import { escapeText } from "./figure";
import { formatDMS } from "./format";
import { GLOSSARY_TERMS } from "./glossary-map";
import { ephemerisDay, onChange, state } from "./state";

// The tables list every export of the library by name, so they see them as plain values and functions.
type Fn = (...args: unknown[]) => unknown;
type Namespace = Record<string, unknown>;

// Unit of each export's return value (or of an object return's fields, which all share one unit here).
// Anything not listed defaults to degrees, the overwhelming majority.
const UNITS: Record<string, string> = {
    julianDayUT: "jd",
    julianEphemerisDay: "jd",
    modifiedJulianDay: "d",
    deltaT: "s",
    MEAN_RADIUS_KM: "km",
    EQUATORIAL_RADIUS_KM: "km",
    MEAN_SYNODIC_MONTH: "d",
    MEAN_NEW_MOON: "jd",
    ATMOSPHERE_THICKNESS_KM: "km",
    ATMOSPHERE_THICKNESS_NON_UNIFORM_KM: "km",
    PRESSURE_SCALE_HEIGHT_M: "m",
    airPressureRatio: "",
    APPARENT_MAGNITUDE_LIMIT: "mag",
    distance: "km",
    viewDistanceWithinAtmosphere: "km",
    orbitEccentricity: "",
    "solar.phase": "",
    "solar.magnitude": "",
    "lunar.axisOffsetKm": "km",
    "lunar.phase": "",
    "lunar.umbralMagnitude": "",
    "lunar.penumbralMagnitude": "",
    "lunar.umbraRadiusKm": "km",
    "lunar.penumbraRadiusKm": "km",
    illuminatedFraction: "",
    sunDirection: "",
    direction: "",
    earthshine: "",
};
const DEFAULT_UNIT = "deg";

// Title and description for rows the glossary has no entry for (see glossary-map.js), shown in the same tooltip
// style as glossary terms. Keyed by name or "name.field".
const DESCRIPTIONS: Record<string, [title: string, text: string]> = {
    apparentAltitude: [
        "Apparent altitude",
        "How high a body appears above the visible horizon: its true altitude lifted by refraction, the horizon lowered by its dip for an observer above sea level.",
    ],
    brightLimbAngle: [
        "Bright limb angle",
        "Which way the Moon's lit side faces in the observer's sky, counterclockwise from up: what a crescent drawn over a horizon is turned by.",
    ],
    modifiedJulianDay: [
        "Modified Julian Day",
        "The Julian Day minus 2,400,000.5: days since midnight of 1858 November 17, a smaller number that starts at midnight.",
    ],
    MEAN_RADIUS_KM: ["Mean radius", "The body's mean radius, in kilometers."],
    EQUATORIAL_RADIUS_KM: [
        "Equatorial radius",
        "Earth's equatorial radius on the IAU 1976 ellipsoid, in kilometers: what parallaxes are measured against.",
    ],
    MEAN_SYNODIC_MONTH: [
        "Mean synodic month",
        "Mean length of a lunation, new moon to new moon, in days. The true interval swings about half a day either side of it.",
    ],
    MEAN_NEW_MOON: [
        "Mean new moon epoch",
        "The mean new moon of 2000 January 6, as a Julian Day: lunation k falls at this plus k mean synodic months, a full moon half a lunation later.",
    ],
    ATMOSPHERE_THICKNESS_KM: [
        "Atmosphere thickness",
        "The uniform-density atmosphere thickness used for simplified scattering models, in kilometers.",
    ],
    ATMOSPHERE_THICKNESS_NON_UNIFORM_KM: [
        "Atmosphere thickness, non-uniform",
        "The atmosphere thickness accounting for its actual density falloff with altitude, in kilometers.",
    ],
    APPARENT_MAGNITUDE_LIMIT: [
        "Apparent magnitude limit",
        "The faintest apparent magnitude generally considered visible to the naked eye.",
    ],
    PRESSURE_SCALE_HEIGHT_M: [
        "Pressure scale height",
        "The height over which air pressure drops by a factor of e, in the standard atmosphere, in meters.",
    ],
    airPressureRatio: [
        "Air pressure ratio",
        "Air pressure relative to sea level, at the observer's height: exp(-height / pressure scale height).",
    ],
    viewDistanceWithinAtmosphere: [
        "View distance within the atmosphere",
        "How far a line of sight towards the Sun travels through the atmosphere, in kilometers: to its top, or to the ground if the Sun is below the horizon.",
    ],
    distance: ["Distance", "Distance from Earth's center to the body's center, in kilometers."],
    direction: [
        "Direction",
        "Unit vector from the observer to the body, in the observer's ENU frame (x east, y north, z up): what a renderer places or lights it by.",
    ],
    sunDirection: [
        "Sun direction from the Moon",
        "Unit vector from the Moon's center to the Sun, in the observer's ENU frame (x east, y north, z up): the light to shade the Moon with.",
    ],
    "solar.separation": [
        "Separation",
        "Apparent center-to-center separation between Sun and Moon as seen by the observer.",
    ],
    "lunar.separation": [
        "Separation",
        "The Moon's angular distance from the axis of Earth's shadow, as seen geocentrically.",
    ],
    "lunar.axisOffsetKm": [
        "Shadow axis offset",
        "The Moon's linear distance from the axis of Earth's shadow, at the Moon's own distance.",
    ],
};

// Row-specific context shown beneath the glossary definition, e.g. what a row is evaluated for here.
const NOTES: Record<string, string> = {
    julianDayUT: "Here: the chosen moment, in UT.",
    julianEphemerisDay: "Here: the chosen moment moved on by ΔT, the Julian Day the orbits are computed at.",
    atmosphericRefraction:
        "Here: from the Sun's true altitude right now, at the observer's height; n/a once it is more than 1° below the horizon.",
    atmosphericRefractionFromApparent:
        "Here: from the Sun's apparent altitude, the direction a renderer's view ray already has.",
    horizonDip: "Here: at the observer's height.",
    apparentAltitude: "Here: the Sun's, at the observer's height.",
};

// Same markup and styling as the Term component in the text: a dotted underline with a tooltip.
function tooltip(label: string, tipHtml: string) {
    return `<span class="term" tabindex="0">${label}<span class="term-tip" role="tooltip">${tipHtml}</span></span>`;
}

function nameCell(name: string, field?: string) {
    const key = field ? `${name}.${field}` : name;
    const label = field ? `${name}.${field}` : name;
    const terms: Record<string, string> = GLOSSARY_TERMS;
    const glossaryName = terms[key] ?? terms[name];
    const entry = glossaryName ? lookupEntry(glossaryName) : undefined;
    const own = DESCRIPTIONS[key] ?? (field ? undefined : DESCRIPTIONS[name]);
    const note = NOTES[key] ?? NOTES[name];
    const [title, text] = entry ? [entry.term, entry.html] : own ? [own[0], escapeText(own[1])] : [];
    if (title === undefined) return `<td>${label}</td>`;
    const context = note ? `<span class="tip-note">${escapeText(note)}</span>` : "";
    const definition = `<strong>${escapeText(title)}</strong> ${text}${context}`;
    return `<td>${tooltip(label, definition)}</td>`;
}

// The Sun's current true altitude: what the refraction and view-distance rows are evaluated for, since they need a
// direction and the Sun's is the one a sky renderer cares about most.
function sunAltitude(jd: number) {
    return precise.sun.horizontalPosition(precise.fromJulianDay(jd), state).altitude;
}

// Refraction is only meaningful for a body at or near the horizon, not for one well below it: null reads as n/a. Below
// about a degree under the horizon its fit no longer holds (see earth.apparentAltitude).
const REFRACTION_FLOOR_DEG = -1;
function refractionTowardsSun(fn: Fn, jd: number, apparent: boolean) {
    const altitude = sunAltitude(jd);
    if (altitude < REFRACTION_FLOOR_DEG) return null;
    const conditions = { observerHeightM: state.heightM };
    return fn(apparent ? altitude + precise.earth.atmosphericRefraction(altitude, conditions) : altitude, conditions);
}

// How to call an export that isn't just fn(julianDay). The state is an observer too: it has latitude, longitude, heightM. Anything not listed here falls back to
// fn.length === 0 ? fn() : fn(jd), with jd in ephemeris time.
const CALL_OVERRIDES: Record<string, (fn: Fn, jd: number) => unknown> = {
    atmosphericRefraction: (fn, jd) => refractionTowardsSun(fn, jd, false),
    // Fed the apparent altitude it expects: the true one lifted by the refraction from the row above.
    atmosphericRefractionFromApparent: (fn, jd) => refractionTowardsSun(fn, jd, true),
    // y = sin(altitude), the vertical component of a unit view direction vector.
    viewDistanceWithinAtmosphere: (fn, jd) =>
        fn(Math.sin(sunAltitude(jd) * precise.DEG_TO_RAD), { observerHeightM: state.heightM }),
    // jd is already an absolute instant; fromJulianDay(jd) (offset 0) round-trips it as a UT AstronomicalTime,
    // which is what julianDayUT() inside horizontalPosition/parallacticAngle expects. A nonzero offset here
    // would double-shift the instant, since jd carries no timezone to begin with.
    horizontalPosition: (fn, jd) => fn(precise.fromJulianDay(jd), state),
    topocentricPosition: (fn, jd) => fn(precise.fromJulianDay(jd), state),
    parallacticAngle: (fn, jd) => fn(precise.fromJulianDay(jd), state),
    brightLimbAngle: (fn, jd) => fn(precise.fromJulianDay(jd), state),
    apparentAltitude: (fn, jd) => fn(sunAltitude(jd), { observerHeightM: state.heightM }),
    sunDirection: (fn, jd) => fn(precise.fromJulianDay(jd), state),
    direction: (fn, jd) => fn(precise.fromJulianDay(jd), state),
    airPressureRatio: (fn) => fn(state.heightM),
    horizonDip: (fn) => fn(state.heightM),
    // The time functions take the moment itself, as a date; deltaT takes its Julian Day in UT.
    julianDayUT: (fn, jd) => fn(precise.fromJulianDay(jd)),
    julianEphemerisDay: (fn, jd) => fn(precise.fromJulianDay(jd)),
    modifiedJulianDay: (fn, jd) => fn(precise.fromJulianDay(jd)),
    siderealTime: (fn, jd) => fn(precise.fromJulianDay(jd)),
    apparentSiderealTime: (fn, jd) => fn(precise.fromJulianDay(jd)),
    deltaT: (fn, jd) => fn(jd),
    // lunar takes just jd like the fn(jd) default already handles; only solar needs observer location too.
    solar: (fn, jd) => fn(precise.fromJulianDay(jd), state),
    topocentricAngularDiameter: (fn, jd) => fn(precise.fromJulianDay(jd), state),
};

const DECIMALS = 4;

// Which of the two variants every table shows, one at a time: the toggle in any table's heading switches them all.
let variant = "precise";

function variantToggle() {
    const button = (name: string) =>
        `<button type="button" class="variant" data-variant="${name}" aria-pressed="${variant === name}">${name}</button>`;
    return `<span class="variant-toggle" title="Precise after Meeus, or approximate after Jensen et al.">${button("precise")}${button("approx")}</span>`;
}

// Fixed decimal count + a reserved sign column (a space where "-" would go) so that, combined with the
// monospace font and right-aligned cells, digits/decimal points/signs all line up down a column. Thousands
// separators (km values can run into the hundreds of millions) don't break that: they only ever land left
// of the decimal point, so the fixed-width decimal tail every row ends with stays aligned regardless.
function formatDecimal(n: number, unit: string) {
    const sign = n < 0 ? "-" : " ";
    // A Julian Day's fourth decimal is almost nine seconds; six resolve ΔT's minute to a tenth of a second.
    const decimals = unit === "jd" ? 6 : DECIMALS;
    const formatted = Math.abs(n).toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        useGrouping: unit === "km",
    });
    return sign + formatted;
}

// Widest value this app ever formats here, "(-330.7170°)", fixes the group's width so left-padding it
// (rather than padding the digits inside) lines up the closing paren, and therefore the DMS notation
// that follows, on the same column every row.
const DEG_PAREN_WIDTH = 12;

// The parenthetical shows the raw value in its own actual unit (matching the unit column: "°" for deg,
// nothing extra for rad since the column already says "rad"), while the DMS notation after it is always
// the degrees breakdown regardless of which unit the row is actually in.
function formatDegreesLike(rawValue: number, rawSuffix: string, degreesValue: number) {
    const sign = rawValue < 0 ? "-" : "";
    const paren = `(${sign}${Math.abs(rawValue).toFixed(DECIMALS)}${rawSuffix})`.padStart(DEG_PAREN_WIDTH, " ");
    return `${paren}  ${formatDMS(degreesValue)}`;
}

function formatNumber(n: number, unit: string) {
    if (!Number.isFinite(n)) return String(n);
    if (unit === "deg") return formatDegreesLike(n, "°", n);
    // The unit column still says "rad" (that's genuinely what the export returns); only the DMS half
    // converts to degrees; the parenthetical stays the actual raw radian value, not a converted one.
    if (unit === "rad") return formatDegreesLike(n, "", n * precise.RAD_TO_DEG);
    return formatDecimal(n, unit);
}

function formatValue(value: unknown, unit: string): string {
    if (typeof value === "number") return formatNumber(value, unit);
    // Vectors in one row, as a tuple: "( 0.6951, -0.4916, -0.5245)".
    if (Array.isArray(value)) return `(${value.map((n) => formatDecimal(Number(n), unit)).join(", ")})`;
    if (typeof value === "object" && value !== null) {
        return Object.entries(value)
            .map(([k, v]) => `${k}: ${formatValue(v, unit)}`)
            .join(", ");
    }
    return String(value);
}

function callExport(name: string, entry: unknown, jd: number) {
    if (typeof entry === "number") return entry;
    if (typeof entry !== "function") return undefined;
    const override = CALL_OVERRIDES[name];
    try {
        const fn = entry as Fn;
        return override ? override(fn, jd) : fn.length === 0 ? fn() : fn(ephemerisDay(jd));
    } catch (err) {
        return `error: ${err instanceof Error ? err.message : err}`;
    }
}

// Objects get one row per field; arrays (vectors) stay one row, see formatValue.
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Delta as a signed, fixed-decimal value with the row's own unit suffix, e.g. "Δ +0.0004°". Kept as a plain
// signed decimal rather than formatNumber's full DMS breakdown: a tooltip is for "how far off is this",
// not a value to read precision out of.
function formatDelta(delta: number, unit: string) {
    const sign = delta < 0 ? "-" : "+";
    const suffix = unit === "deg" ? "°" : unit === "rad" ? "\u202frad" : unit ? `\u202f${unit}` : "";
    const formatted = Math.abs(delta).toLocaleString("en-US", {
        minimumFractionDigits: DECIMALS,
        maximumFractionDigits: DECIMALS,
    });
    return `Δ ${sign}${formatted}${suffix}`;
}

// The precise values are plain; an approximate one carries how far off the precise value it is, a hover away.
function cell(value: unknown, present: boolean, unit: string, preciseValue: unknown, precisePresent: boolean) {
    if (!present) return `<td class="value missing">n/a</td>`;
    const formatted = formatValue(value, unit);
    const hasDelta =
        variant === "approx" &&
        precisePresent &&
        typeof value === "number" &&
        typeof preciseValue === "number" &&
        value !== preciseValue;
    if (!hasDelta) return `<td class="value">${formatted}</td>`;
    const tip = `<strong>${formatDelta(value - preciseValue, unit)}</strong> off the precise value.`;
    return `<td class="value">${tooltip(formatted, tip)}</td>`;
}

function computeRows(names: string[], preciseNs: Namespace, approxNs: Namespace, jd: number) {
    return names.flatMap((name) => {
        let hasPrecise = name in preciseNs;
        let hasApprox = name in approxNs;
        const preciseValue = hasPrecise ? callExport(name, preciseNs[name], jd) : undefined;
        const approxValue = hasApprox ? callExport(name, approxNs[name], jd) : undefined;
        // An override returning null means "not meaningful right now", shown as n/a like a missing variant.
        if (preciseValue === null) hasPrecise = false;
        if (approxValue === null) hasApprox = false;
        const unit = UNITS[name] ?? DEFAULT_UNIT;

        // Object results (apparentPosition, horizontalPosition, position, opticalLibrations, ...) get one row
        // per field instead of one combined "key: value, key: value" row.
        if (isPlainObject(preciseValue) || isPlainObject(approxValue)) {
            const fields = [
                ...new Set([
                    ...(isPlainObject(preciseValue) ? Object.keys(preciseValue) : []),
                    ...(isPlainObject(approxValue) ? Object.keys(approxValue) : []),
                ]),
            ];
            return fields.map((field) => {
                const preciseHasField = isPlainObject(preciseValue) && field in preciseValue;
                const approxHasField = isPlainObject(approxValue) && field in approxValue;
                // Most object exports (apparentPosition, position, ...) have every field share one unit, but
                // eclipse states mix degrees/km/dimensionless/strings, so a "name.field" entry wins if present.
                const fieldUnit = UNITS[`${name}.${field}`] ?? unit;
                const fieldOf = (value: unknown) => (isPlainObject(value) ? value[field] : undefined);
                const shown: [unknown, boolean] =
                    variant === "approx"
                        ? [fieldOf(approxValue), approxHasField]
                        : [fieldOf(preciseValue), preciseHasField];
                return `<tr>${nameCell(name, field)}<td class="unit">${fieldUnit}</td>${cell(...shown, fieldUnit, fieldOf(preciseValue), preciseHasField)}</tr>`;
            });
        }

        return [
            `<tr>${nameCell(name)}<td class="unit">${unit}</td>${cell(...((variant === "approx" ? [approxValue, hasApprox] : [preciseValue, hasPrecise]) as [unknown, boolean]), unit, preciseValue, hasPrecise)}</tr>`,
        ];
    });
}

// The time functions are top-level exports, not a namespace, so the table gathers them into one.
const TIME_EXPORTS = [
    "julianDayUT",
    "julianEphemerisDay",
    "deltaT",
    "modifiedJulianDay",
    "siderealTime",
    "apparentSiderealTime",
];
type Domain = "time" | "earth" | "sun" | "moon" | "eclipse";
const pick = (module: Namespace): Namespace => Object.fromEntries(TIME_EXPORTS.map((name) => [name, module[name]]));
const namespacesOf = (domainName: Domain): [Namespace, Namespace] =>
    // biome-ignore lint/performance/noDynamicNamespaceImportAccess: the tables list every export, so it needs the whole namespace anyway
    domainName === "time" ? [pick(precise), pick(approx)] : [precise[domainName], approx[domainName]];

// What each table holds, ahead of the namespace it lists; the time functions have none.
const TITLES: Record<Domain, string> = {
    time: "Julian Day, ΔT and sidereal time",
    earth: "Earth's axis, size and atmosphere",
    sun: "The Sun's position, distance and size",
    moon: "The Moon's position, phase and libration",
    eclipse: "Solar and lunar eclipses",
};

function renderDomain(domainName: Domain, jd: number, open: boolean) {
    const [preciseNs, approxNs] = namespacesOf(domainName);
    const label = domainName === "time" ? "time" : `${domainName}.*`;
    const title = `<span class="table-caption">${TITLES[domainName]}${domainName === "time" ? "</span>" : `,</span> ${label}`}`;
    // Not alphabetized: preserves each namespace's own hand-grouped declaration order (index.ts/approx.ts),
    // e.g. apparentPosition/equatorialHorizontalParallax/topocentricPosition/horizontalPosition stay adjacent
    // as a pipeline, which sorting would scatter (a.../e.../h.../t...).
    const names = [...new Set([...Object.keys(preciseNs), ...Object.keys(approxNs)])];
    const rows = computeRows(names, preciseNs, approxNs, jd);

    // Folded until asked for, because a table of this length is a wall to scroll past in the middle of the text.
    // The cards have no heading row, so the variant toggle sits above them instead.
    return `
        <details class="fold table-fold"${open ? " open" : ""}>
            <summary>${title}</summary>
            <p class="table-note note">Values: ${variantToggle()}</p>
            <table>
                <colgroup><col class="name" /><col class="unit" /><col class="value" /></colgroup>
                <thead><tr><th>${label}</th><th>unit</th><th class="value">${variantToggle()}</th></tr></thead>
                <tbody>${rows.join("")}</tbody>
            </table>
        </details>
    `;
}

// One container per domain, placed wherever the chapter text discusses it (see Table.astro).
const tableContainers = document.querySelectorAll<HTMLElement>(".sternzeit-table[data-domain]");

// The set of controls the chapter places right after a table (see the .mdx); a script tag may sit in between.
function controlsAfter(container: Element) {
    for (let node = container.nextElementSibling, hop = 0; node && hop < 2; node = node.nextElementSibling, hop++) {
        if (node instanceof HTMLElement && node.classList.contains("moment")) return node;
    }
    return null;
}

// A folded-away table leaves nothing for its controls to act on, so they fold with it rather than standing alone.
function syncControls(container: Element) {
    const controls = controlsAfter(container);
    const fold = container.querySelector<HTMLDetailsElement>(".table-fold");
    if (controls) controls.hidden = Boolean(fold && !fold.open);
}

function render() {
    for (const container of tableContainers) {
        // Rerendered on every change, so whether the reader folded it open is carried over by hand.
        const fold = container.querySelector<HTMLDetailsElement>(".table-fold");
        const open = fold ? fold.open : location.hash === `#${container.id}`;
        container.innerHTML = renderDomain(container.dataset.domain as Domain, state.jd, open);
        syncControls(container);
    }
}

// The details element's toggle event does not bubble, so it is caught on the way down instead.
for (const container of tableContainers) {
    container.addEventListener("toggle", () => syncControls(container), true);
    // On the container, not on the button, which is rewritten with the rest of the table on every change.
    container.addEventListener("click", (event) => {
        const button = event.target instanceof Element ? event.target.closest<HTMLElement>(".variant") : null;
        if (!button?.dataset.variant || button.dataset.variant === variant) return;
        variant = button.dataset.variant;
        render();
    });
}

onChange(render);
render();
