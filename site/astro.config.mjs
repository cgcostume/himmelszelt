import { fileURLToPath } from "node:url";
import mdx from "@astrojs/mdx";
import { defineConfig } from "astro/config";

const source = (path) => fileURLToPath(new URL(`../packages/${path}`, import.meta.url));

// dunstkreis' shaders are .wgsl files its own build inlines as strings; the site reads its source, so it does the same.
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
        // The site always shows the libraries' current source, no package build needed in between.
        resolve: {
            alias: [
                { find: /^@himmelszelt\/sternzeit$/, replacement: source("sternzeit/src/index.ts") },
                { find: /^@himmelszelt\/sternzeit\/approx$/, replacement: source("sternzeit/src/approx.ts") },
                { find: /^@himmelszelt\/dunstkreis$/, replacement: source("dunstkreis/src/index.ts") },
            ],
        },
    },
});
