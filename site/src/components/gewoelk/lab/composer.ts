import { CLOUD_TYPES, type Sky, WEATHER } from "@himmelszelt/gewoelk";
import { type Design, type Place, placeOf, presetOf } from "./kinds";
import type { Lab } from "./lab";
import { deleteWeather, type OwnWeather, onOwnChange, ownKinds, ownList, ownWeathers, saveWeather } from "./store";

/**
 * The weather composer of the whole-sky figure: for each place of the sky a kind of cloud, the library's or one saved
 * in a designer, or none; the library's weathers, which name a kind for each place; and the reader's own, saved from
 * what is chosen. A choice is "none", "kind:" and a library kind's name, "own:" with a designer and a saved kind's
 * name, or "kept", numbers that have no name: a library weather's own, or a saved weather's whose kind was deleted.
 */

const PLACES: Place[] = ["low", "deep", "middle", "high"];
const DESIGNS: Design[] = ["low", "towers", "front", "middle", "high"];
type Numbers = Record<string, number | string>;

/** Wires the composer in `root`: `numbers` gives a place's as the sliders have them. */
export function composer(root: HTMLElement, lab: Lab, numbers: (place: Place) => object) {
    const selects = new Map(
        PLACES.flatMap((place) => {
            const select = root.querySelector<HTMLSelectElement>(`select[data-place="${place}"]`);
            return select ? [[place, select] as const] : [];
        }),
    );
    if (selects.size === 0) return;
    const kept: Partial<Record<Place, Numbers>> = {};
    const weathers = () => root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-weather"]`);

    const option = (value: string, text: string, hidden = false) =>
        Object.assign(document.createElement("option"), { value, text, hidden });
    const group = (label: string, options: HTMLOptionElement[]) => {
        const made = Object.assign(document.createElement("optgroup"), { label });
        made.append(...options);
        return made;
    };
    /** The choices of every place, the chosen one kept where it is still there. */
    function fill() {
        for (const [place, select] of selects) {
            const chosen = select.value;
            const library = Object.keys(CLOUD_TYPES[place]).map((name) => option(`kind:${name}`, name));
            const own = DESIGNS.filter((design) => placeOf(design) === place).flatMap((design) =>
                ownKinds(design).map(({ name }) =>
                    option(`own:${design}:${name}`, place === "deep" ? `${design}: ${name}` : name),
                ),
            );
            select.replaceChildren(
                option("none", "none"),
                group("the library's", library),
                ...(own.length ? [group("yours", own)] : []),
                option("kept", "as saved", true),
            );
            const there = [...select.options].some((o) => o.value === chosen);
            select.value = there ? chosen : chosen.startsWith("own:") && kept[place] ? "kept" : "none";
        }
    }

    function resolve(place: Place, choice: string): Numbers | null {
        const [from, a, ...rest] = choice.split(":");
        if (from === "kind") return (CLOUD_TYPES[place] as Record<string, Numbers>)[a ?? ""] ?? null;
        if (from === "own") {
            return ownKinds(a as Design).find(({ name }) => name === rest.join(":"))?.numbers ?? null;
        }
        return from === "kept" ? (kept[place] ?? null) : null;
    }
    /** The sliders of `place` as its choice has them, none as its defaults without coverage. */
    function apply(place: Place, eased = true) {
        const found = resolve(place, selects.get(place)?.value ?? "none");
        if (found) kept[place] = found;
        lab.apply(`place:${place}`, presetOf(place, found ?? { coverage: 0 }), eased);
    }
    /** Chooses for every place what `choices` names, or what it brings as numbers. */
    function choose(choices: Record<Place, { choice: string; numbers: Numbers | null }>, eased = true) {
        fill();
        for (const [place, select] of selects) {
            const { choice, numbers } = choices[place];
            const there = [...select.options].some((o) => o.value === choice) && choice !== "kept";
            if (!there && numbers) kept[place] = numbers;
            select.value = there ? choice : numbers ? "kept" : "none";
            apply(place, eased);
        }
    }
    /** A library weather: the kind it names for each place, or its own numbers for one. */
    function chooseWeather(name: string, eased = true) {
        const sky: Sky = (WEATHER as Record<string, { layers?: Sky }>)[name]?.layers ?? {};
        const entries = PLACES.map((place) => {
            const kind = sky[place];
            const choice = typeof kind === "string" ? `kind:${kind}` : kind ? "kept" : "none";
            return [place, { choice, numbers: kind && typeof kind === "object" ? (kind as Numbers) : null }];
        });
        choose(Object.fromEntries(entries), eased);
    }

    const list = ownList(root.querySelector<HTMLElement>('[data-field="ownWeathers"]') ?? root, {
        what: "the four kinds as chosen",
        names: () => ownWeathers().map(({ name }) => name),
        load(name) {
            const weather = ownWeathers().find((own) => own.name === name);
            if (!weather) return;
            for (const input of weathers()) input.checked = false;
            choose(weather.places);
        },
        save(name) {
            const places = PLACES.map((place) => {
                const choice = selects.get(place)?.value ?? "none";
                const rounded = Object.entries(numbers(place)).map(([key, value]) => [
                    key,
                    typeof value === "number" ? Number(value.toFixed(3)) : value,
                ]);
                return [place, { choice, numbers: choice === "none" ? null : Object.fromEntries(rounded) }];
            });
            return saveWeather({ name, places: Object.fromEntries(places) as OwnWeather["places"] });
        },
        remove: deleteWeather,
    });
    for (const [place, select] of selects) {
        select.addEventListener("change", () => {
            for (const input of weathers()) input.checked = false;
            list.clear();
            apply(place);
        });
    }
    for (const input of weathers()) {
        input.addEventListener("change", () => {
            list.clear();
            chooseWeather(input.value);
        });
    }
    // A kind saved again in its designer shows here at once; one deleted leaves its numbers behind.
    onOwnChange(() => {
        fill();
        for (const [place, select] of selects) if (select.value.startsWith("own:")) apply(place);
    });
    const first = [...weathers()].find((input) => input.checked)?.value;
    if (first) chooseWeather(first, false);
    else fill();
}
