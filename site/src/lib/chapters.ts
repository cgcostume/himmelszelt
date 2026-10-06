import type { CollectionEntry } from "astro:content";

type Chapter = CollectionEntry<"chapters">;

/** A draft is withheld from the published site; `pnpm dev` shows it in full. */
export const withheld = (chapter: Chapter) => chapter.data.draft && !import.meta.env.DEV;

/** Shown as a placeholder: a library that does not exist yet, or a chapter that is withheld. */
export const placeholder = (chapter: Chapter) => chapter.data.planned || withheld(chapter);
