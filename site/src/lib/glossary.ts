import glossary from "../data/glossary.json";
import images from "../data/glossary-images.json";

/**
 * The site-wide glossary (src/data/glossary.json: term -> definition, both with inline markdown), the single
 * source for every tooltip, in the text (Term.astro) and in the tables (built in the browser). No node imports,
 * so it bundles into client scripts as is. A few entries carry a picture (src/data/glossary-images.json: term ->
 * a square image in public/images, its alt text and its credit), part of the entry's html.
 */
export interface GlossaryEntry {
    term: string;
    html: string;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Just the inline markdown the glossary uses: code spans, bold and italics. */
function inlineMarkdown(text: string): string {
    return escapeHtml(text)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*\w])\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>");
}

type GlossaryImage = { src: string; alt: string; credit: string };

// Square, at the start of the definition, which flows around it; loaded once the tooltip is near the screen.
const imageHtml = ({ src, alt, credit }: GlossaryImage) =>
    `<span class="term-image"><img src="${import.meta.env.BASE_URL}images/${src}" alt="${escapeHtml(alt).replace(/"/g, "&quot;")}" width="256" height="256" loading="lazy" decoding="async" /><span class="term-image-credit">${escapeHtml(credit)}</span></span>`;

// Every name an entry answers to, lowercased: the term before any parenthesis, split on " / ".
const byName = new Map<string, GlossaryEntry>();
for (const [term, definition] of Object.entries(glossary as Record<string, string>)) {
    const image = (images as Record<string, GlossaryImage>)[term];
    const entry = { term: term.replace(/`/g, ""), html: (image ? imageHtml(image) : "") + inlineMarkdown(definition) };
    for (const name of term.replace(/\s*\(.*$/, "").split(" / "))
        byName.set(name.replace(/`/g, "").trim().toLowerCase(), entry);
}

/** Finds an entry by one of its names, case-insensitively; throws so a typo fails the build instead of the page. */
export function findEntry(name: string): GlossaryEntry {
    const entry = byName.get(name.toLowerCase());
    if (!entry) throw new Error(`"${name}" is not in the glossary`);
    return entry;
}

/** What a German library name means word for word: the first quoted phrase of its entry, e.g. "star time". */
export function literalMeaning(name: string): string {
    const definition = (glossary as Record<string, string>)[name.toLowerCase()] ?? "";
    const match = definition.match(/"([^"]+)"/);
    if (!match) throw new Error(`"${name}" has no quoted literal meaning in the glossary`);
    return match[1];
}

/** Like findEntry, but for the browser: undefined instead of throwing. */
export const lookupEntry = (name: string): GlossaryEntry | undefined => byName.get(name.toLowerCase());
