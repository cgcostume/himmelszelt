/**
 * Code built in the page, highlighted like the chapters' code blocks: Shiki, as Astro runs it at build time, with the
 * same two themes, and their background dropped so the block takes the site's own (see astro.config.mjs). Only the
 * TypeScript grammar and the two themes, with the JavaScript regex engine rather than the WebAssembly one, and loaded
 * only once there is code to show, so the figures never wait for it.
 */
let highlighter: ReturnType<typeof load> | null = null;
async function load() {
    const [{ createHighlighterCoreSync }, { createJavaScriptRegexEngine }, typescript, githubLight, githubDark] =
        await Promise.all([
            import("shiki/core"),
            import("shiki/engine/javascript"),
            import("shiki/langs/typescript.mjs"),
            import("shiki/themes/github-light.mjs"),
            import("shiki/themes/github-dark.mjs"),
        ]);
    return createHighlighterCoreSync({
        themes: [githubLight.default, githubDark.default],
        langs: [typescript.default],
        engine: createJavaScriptRegexEngine(),
    });
}

const latest = new WeakMap<Element, string>();

/** Replaces the contents of `element` with `code` as a highlighted TypeScript block, the latest call's winning. */
export async function showCode(element: Element, code: string) {
    latest.set(element, code);
    highlighter ??= load();
    const html = (await highlighter).codeToHtml(code, {
        lang: "typescript",
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
        transformers: [
            {
                pre(node) {
                    node.properties.class = "astro-code astro-code-themes github-light github-dark";
                    node.properties.style = String(node.properties.style ?? "").replace(/background-color:[^;]+;?/, "");
                },
            },
        ],
    });
    if (latest.get(element) === code) element.innerHTML = html;
}
