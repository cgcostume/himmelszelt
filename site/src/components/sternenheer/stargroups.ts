import { HIPPARCOS, TYCHO } from "@himmelszelt/sternenheer";
import { follow, settings } from "../settings";

/** The pick of `group` in `root`, a `data-pick` of StarGroups.astro. */
export const picked = (root: HTMLElement, group: string) =>
    root.querySelector<HTMLElement>(`[data-group="${group}"] [aria-pressed="true"]`)?.dataset.pick ?? "";

/** An offset group's pick as the pass takes it: the light, 0 or 1, and the stops. */
export function offsetOf(root: HTMLElement, group: string) {
    const pick = picked(root, group);
    return { light: pick === "off" ? 0 : 1, stops: pick === "off" ? 0 : Number(pick) };
}

// Whether `pnpm assets` has made the catalogs the package does not ship, asked once a page.
const present = (url: URL) =>
    fetch(url, { method: "HEAD" }).then(
        (response) => response.ok && !response.headers.get("content-type")?.includes("text/html"),
        () => false,
    );
let made: Promise<{ hipparcos: boolean; tycho: boolean }> | null = null;
const NAMES = { hipparcos: "Hipparcos", tycho: "Tycho-2" } as const;

/**
 * The groups in `root`: a click or an arrow picks, one tab stop a group. On a phone a group shows its pick alone and
 * opens to all of its buttons when that is pressed. A catalog `pnpm assets` has not made stays disabled, unless the
 * figure does not draw the catalogs' stars (`needsCatalogs` false).
 */
export function bindStarGroups(root: HTMLElement, onPick: () => void, needsCatalogs = true) {
    const groups = [...root.querySelectorAll<HTMLElement>("[data-group]")];
    const buttonsOf = (group: HTMLElement) => [...group.querySelectorAll<HTMLButtonElement>("button[data-pick]")];
    function pick(group: HTMLElement, chosen: HTMLButtonElement) {
        for (const button of buttonsOf(group)) {
            button.setAttribute("aria-pressed", String(button === chosen));
            button.tabIndex = button === chosen ? 0 : -1;
        }
        onPick();
    }
    const close = () => {
        for (const group of groups) group.classList.remove("open");
    };
    for (const group of groups) {
        const buttons = buttonsOf(group);
        for (const button of buttons) {
            button.addEventListener("click", () => {
                const collapsed = buttons.some(
                    (other) => other !== button && getComputedStyle(other).display === "none",
                );
                if (collapsed && !group.classList.contains("open")) {
                    close();
                    group.classList.add("open");
                    return;
                }
                group.classList.remove("open");
                if (button.getAttribute("aria-pressed") !== "true") pick(group, button);
            });
            button.addEventListener("keydown", (event) => {
                const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
                if (step === undefined) return;
                event.preventDefault();
                const usable = buttons.filter((b) => !b.disabled);
                const next = usable.at((usable.indexOf(button) + step) % usable.length);
                if (!next || next === button) return;
                pick(group, next);
                next.focus();
            });
        }
        group.addEventListener("focusout", (event) => {
            if (!group.contains(event.relatedTarget as Node | null)) group.classList.remove("open");
        });
    }
    document.addEventListener("pointerdown", (event) => {
        if (!groups.some((group) => group.contains(event.target as Node))) close();
    });

    // The catalog and the Milky Way follow the page's settings, a pick here a local override (see settings.ts).
    for (const group of groups) {
        const name = group.dataset.group;
        if (name !== "catalog" && name !== "milkyWay") continue;
        const buttons = buttonsOf(group);
        const read = () => buttons.find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.pick ?? "";
        const initial = read();
        const lit = initial === "off" ? "0" : initial;
        const want = () =>
            name === "catalog" ? settings.catalog : !settings.milkyWay ? "off" : read() === "off" ? lit : read();
        const write = (value: string) => {
            const button = buttons.find((b) => b.dataset.pick === value);
            if (button && !button.disabled) pick(group, button);
        };
        follow(group, name, want, read, write);
    }

    if (!needsCatalogs) return;
    made ??= Promise.all([present(HIPPARCOS.compact), present(TYCHO.compact)]).then(([hipparcos, tycho]) => ({
        hipparcos,
        tycho,
    }));
    made.then((catalogs) => {
        const group = root.querySelector<HTMLElement>('[data-group="catalog"]');
        if (!group) return;
        const buttons = buttonsOf(group);
        for (const name of ["hipparcos", "tycho"] as const) {
            const button = buttons.find((b) => b.dataset.pick === name);
            if (catalogs[name] || !button) continue;
            button.disabled = true;
            button.title = `${NAMES[name]}: not made here; pnpm assets makes it`;
        }
        const chosen = buttons.find((b) => b.getAttribute("aria-pressed") === "true");
        const fallback = buttons.findLast((b) => !b.disabled && buttons.indexOf(b) <= buttons.indexOf(chosen ?? b));
        if (chosen?.disabled && fallback) pick(group, fallback);
    });
}
