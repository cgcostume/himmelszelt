import { defineConfig, type Plugin } from "rolldown";
import { dts } from "rolldown-plugin-dts";

/** Inlines `.wgsl` files as strings at build time, so `dist` reads nothing from disk. See `src/wgsl.d.ts`. */
const wgsl = (): Plugin => ({
    name: "wgsl",
    transform: {
        filter: { id: /\.wgsl$/ },
        handler(code) {
            return { code: `export default ${JSON.stringify(code)};`, moduleType: "js" };
        },
    },
});

export default defineConfig({
    input: { index: "src/index.ts", wgsl: "src/wgsl/index.ts" },
    plugins: [wgsl(), dts()],
    output: { dir: "dist", format: "es", cleanDir: true },
});
