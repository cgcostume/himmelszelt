import { fileURLToPath } from "node:url";
import mdx from "@astrojs/mdx";
import { defineConfig } from "astro/config";
import { createCssVariablesTheme } from "shiki/core";

const source = (path) => fileURLToPath(new URL(`../packages/${path}`, import.meta.url));

// The libraries' shaders are .wgsl files their own builds inline as strings; the site reads its source, so it does the same.
const wgsl = {
    name: "wgsl",
    transform: (code, id) =>
        id.endsWith(".wgsl") ? { code: `export default ${JSON.stringify(code)};`, map: null } : null,
};

// Static output only: served locally by `pnpm dev` and deployed as plain files to GitHub Pages at himmelszelt.dev.
export default defineConfig({
    site: "https://himmelszelt.dev",
    output: "static",
    integrations: [mdx()],
    markdown: {
        shikiConfig: {
            // Every kind of token a CSS variable, which global.css sets from the page's own colors, in either theme.
            theme: createCssVariablesTheme({ name: "sternwarte" }),
            // Drops the theme's inline background, so code blocks take the site's own (see pre in global.css).
            transformers: [
                {
                    pre(node) {
                        node.properties.style = String(node.properties.style ?? "").replace(
                            /background-color:[^;]+;?/,
                            "",
                        );
                    },
                },
            ],
        },
    },
    vite: {
        plugins: [wgsl],
        // Shiki's pieces for the code built in the page (code.ts), bundled up front: found late, a dev server serves 504s.
        optimizeDeps: {
            include: ["shiki/core", "shiki/engine/javascript", "shiki/langs/typescript.mjs"],
        },
        // The site always shows the libraries' current source, no package build needed in between.
        resolve: {
            alias: [
                { find: /^@himmelszelt\/sternzeit$/, replacement: source("sternzeit/src/index.ts") },
                { find: /^@himmelszelt\/sternzeit\/approx$/, replacement: source("sternzeit/src/approx.ts") },
                { find: /^@himmelszelt\/dunstkreis$/, replacement: source("dunstkreis/src/index.ts") },
                { find: /^@himmelszelt\/dunstkreis\/wgsl$/, replacement: source("dunstkreis/src/wgsl/index.ts") },
                { find: /^@himmelszelt\/gewoelk$/, replacement: source("gewoelk/src/index.ts") },
                { find: /^@himmelszelt\/helldunkel$/, replacement: source("helldunkel/src/index.ts") },
                { find: /^@himmelszelt\/nachtgestirn$/, replacement: source("nachtgestirn/src/index.ts") },
                { find: /^@himmelszelt\/sternenheer$/, replacement: source("sternenheer/src/index.ts") },
                { find: /^@himmelszelt\/helldunkel\/wgsl$/, replacement: source("helldunkel/src/wgsl/index.ts") },
                { find: /^@himmelszelt\/rundbild$/, replacement: source("rundbild/src/index.ts") },
                { find: /^@himmelszelt\/rundbild\/wgsl$/, replacement: source("rundbild/src/wgsl/index.ts") },
            ],
        },
    },
});
