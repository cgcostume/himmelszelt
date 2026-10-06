import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/** One chapter per @himmelszelt/* library, ordered by `order` in the navigation. */
const chapters = defineCollection({
    loader: glob({ pattern: "*.mdx", base: "./src/content/chapters" }),
    schema: z.object({
        title: z.string(),
        package: z.string(),
        summary: z.string(),
        order: z.number(),
        /** A library that doesn't exist yet: its chapter is a placeholder, marked as such in the chapter list. */
        planned: z.boolean().default(false),
        /** Written, but not ready to publish: in full under `pnpm dev`, a placeholder like a planned one in the build. */
        draft: z.boolean().default(false),
        /** Ids from src/data/references.ts; each must be cited in the text via <Cite>, which also sets the numbering. */
        references: z.array(z.string()).default([]),
    }),
});

export const collections = { chapters };
