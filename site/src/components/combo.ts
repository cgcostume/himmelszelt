// A radio group marked `data-combo` (see Choice.astro) shows its chosen option alone, on a button that drops the options
// down in a list. The radios stay what is chosen: they move into the list, which is a popover in the top layer, so no
// panel's overflow clips it, and every script that reads, sets or listens to them goes on as before.
const GROUPS = ".steps[data-combo]";
const GAP = 2;
const MARGIN = 8;
// The list's edge and padding, by which it stands out on either side so that its words line up with the button's.
const INSET = 3;

type Combo = { group: HTMLElement; button: HTMLButtonElement; list: HTMLElement };
const combos = new WeakMap<HTMLElement, Combo>();

const radios = (list: HTMLElement) => [
    ...list.querySelectorAll<HTMLInputElement>(':scope > label > input[type="radio"]'),
];
const choosable = (list: HTMLElement) => radios(list).filter((radio) => !radio.disabled && !radio.closest("[hidden]"));
const text = (radio: HTMLInputElement) => radio.parentElement?.textContent?.trim() ?? "";

function build(group: HTMLElement): Combo {
    let button = group.querySelector<HTMLButtonElement>(":scope > .combo-button");
    let list = group.querySelector<HTMLElement>(":scope > .combo-list");
    if (!button || !list) {
        button = Object.assign(document.createElement("button"), { type: "button", className: "combo-button" });
        button.setAttribute("aria-expanded", "false");
        button.innerHTML = '<span class="combo-value"></span><span class="combo-caret" aria-hidden="true"></span>';
        list = Object.assign(document.createElement("span"), { className: "combo-list" });
        list.popover = "auto";
        list.setAttribute("role", "radiogroup");
        const label = group.getAttribute("aria-label");
        if (label) list.setAttribute("aria-label", label);
        group.removeAttribute("role");
        group.removeAttribute("aria-label");
        group.append(button, list);
    }
    return { group, button, list };
}

// Labels a script puts straight into the group, as on a rebuild of its options, belong in the list.
function adopt({ group, list }: Combo) {
    for (const label of group.querySelectorAll(":scope > label")) list.append(label);
}

function sync({ group, button, list }: Combo) {
    const all = radios(list);
    const chosen = all.find((radio) => radio.checked);
    const value = chosen ? text(chosen) : "";
    const shown = button.querySelector(".combo-value");
    if (shown && shown.textContent !== value) shown.textContent = value;
    const name = list.getAttribute("aria-label") ?? group.querySelector(".steps-heading")?.textContent ?? "";
    button.setAttribute("aria-label", name ? `${name}: ${value}` : value);
    button.disabled = all.every((radio) => radio.disabled);
}

// Under the button, flush with its right end as a named row's options were, or with its left end in a row without a name,
// kept on screen; above it where there is no room below.
function place({ group, button, list }: Combo) {
    const at = button.getBoundingClientRect();
    list.style.minWidth = `${Math.ceil(at.width) + 2 * INSET}px`;
    list.style.maxHeight = "";
    const width = list.offsetWidth;
    const height = Math.ceil(list.getBoundingClientRect().height);
    const below = innerHeight - at.bottom - GAP - MARGIN;
    const above = at.top - GAP - MARGIN;
    const down = height <= below || below >= above;
    list.style.maxHeight = `${Math.min(height, Math.max(down ? below : above, 60))}px`;
    const start = group.querySelector(":scope > .steps-heading") ? at.right + INSET - width : at.left - INSET;
    const left = Math.min(start, innerWidth - MARGIN - width);
    list.style.left = `${Math.max(MARGIN, left)}px`;
    list.style.top = down ? `${at.bottom + GAP}px` : "";
    list.style.bottom = down ? "" : `${innerHeight - at.top + GAP}px`;
}

function close(combo: Combo, focus = true) {
    if (combo.list.matches(":popover-open")) combo.list.hidePopover();
    if (focus) combo.button.focus();
}

function step(to: HTMLInputElement | undefined) {
    if (!to || to.checked) return to?.focus();
    to.focus();
    to.click();
}

let typed = "";
let typedAt = 0;

function enhance(group: HTMLElement) {
    if (combos.has(group)) return;
    const combo = build(group);
    combos.set(group, combo);
    const { button, list } = combo;
    button.popoverTargetElement = list;
    adopt(combo);
    sync(combo);

    const replace = () => place(combo);
    list.addEventListener("beforetoggle", (event) => {
        const open = (event as ToggleEvent).newState === "open";
        if (open) sync(combo);
        button.setAttribute("aria-expanded", String(open));
        group.classList.toggle("combo-open", open);
        if (open) {
            addEventListener("scroll", replace, { capture: true, passive: true });
            addEventListener("resize", replace);
        } else {
            removeEventListener("scroll", replace, { capture: true });
            removeEventListener("resize", replace);
        }
    });
    list.addEventListener("toggle", (event) => {
        if ((event as ToggleEvent).newState !== "open") return;
        place(combo);
        const chosen = radios(list).find((radio) => radio.checked) ?? choosable(list)[0];
        chosen?.focus();
    });
    // A pick by the pointer closes the list; the arrow keys move the choice and leave it open, as they did on the row.
    list.addEventListener("click", (event) => {
        if (event.detail > 0 && (event.target as Element).closest("label")) close(combo);
    });
    list.addEventListener("keydown", (event) => {
        const options = choosable(list);
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            close(combo);
        } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            step(event.key === "Home" ? options[0] : options.at(-1));
        } else if (event.key === "Tab") {
            close(combo, false);
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            typed = event.timeStamp - typedAt < 700 ? typed + event.key.toLowerCase() : event.key.toLowerCase();
            typedAt = event.timeStamp;
            const from = options.findIndex((radio) => radio.checked);
            const order = [...options.slice(from + (typed.length > 1 ? 0 : 1)), ...options.slice(0, from + 1)];
            step(order.find((radio) => text(radio).toLowerCase().startsWith(typed)));
        }
    });
    button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        list.showPopover();
    });
    // Presets may set `checked` without an event: whatever changes in the figure, or the group, reads it anew.
    const scope = group.closest("figure") ?? group.closest(".sky-options, form") ?? group;
    for (const type of ["change", "input"]) scope.addEventListener(type, () => sync(combo));
    new MutationObserver(() => {
        adopt(combo);
        sync(combo);
    }).observe(group, { childList: true });
    new MutationObserver(() => sync(combo)).observe(list, {
        childList: true,
        subtree: true,
        attributeFilter: ["hidden", "disabled"],
    });
}

for (const group of document.querySelectorAll<HTMLElement>(GROUPS)) enhance(group);
new MutationObserver((records) => {
    for (const record of records)
        for (const node of record.addedNodes)
            if (node instanceof HTMLElement)
                for (const group of [node, ...node.querySelectorAll<HTMLElement>(GROUPS)])
                    if (group.matches(GROUPS)) enhance(group);
}).observe(document.body, { childList: true, subtree: true });

export {};
