# himmelszelt

Sky rendering for WebGPU, compute first, as a family of small libraries that each drop into a renderer on their own:
the astronomy (`@himmelszelt/sternzeit`), the atmosphere (`dunstkreis`), light to pixels (`helldunkel`), skies as
images (`rundbild`), clouds (`gewoelk`), the Moon (`nachtgestirn`) and the stars (`sternenheer`), each under
`packages/`, and sternwarte, the site that explains and shows them all, under `site/`. A port of osgHimmel to
TypeScript.

## Getting started

You need Node 22 or later, pnpm and `curl`; a browser with WebGPU for the site's figures.

```sh
pnpm install
pnpm assets   # the data no package ships or checks in, see below
pnpm dev      # the site at http://localhost:4321/
```

`pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm lint` do the rest, for every package at once.

`pnpm assets` fetches the files that are neither checked in nor shipped: the star catalogues of ESA's Hipparcos
satellite, sternenheer's faint stars (108,883 stars, 701 KB) and deep stars (Tycho-2, 2.4 million stars, 14 MB), the
Milky Way's 8K map, the Moon's 8K maps and the stars chapter's starred map. They come built from the asset mirror,
[cgcostume/himmelszelt-assets](https://github.com/cgcostume/himmelszelt-assets), a GitHub release per source and per
build, never changed once published, each file checked against its SHA-256 in the manifests (`packages/*/assets.json`,
`site/assets.json`, the mirror's `manifest.json` is their union). A file the mirror lacks is built, and `pnpm assets
--build` builds them all; the scripts then download their sources from the mirror too, from the original source where
that fails, once, into `node_modules/.cache/<package>`, and do nothing while their output is newer than their inputs.
Building images needs only `sharp`, installed with the workspace. Each script prints the terms its data comes under:
both of ESA's catalogues are [CC BY-NC 3.0 IGO](https://creativecommons.org/licenses/by-nc/3.0/igo/), free for
non-commercial use with the credit "ESA", which is why the MIT packages do not carry them. The site runs without them,
with a note in the figures that need them. `pnpm assets --all` remakes every data file, the checked-in ones too; a
package's own scripts, such as `pnpm --filter @himmelszelt/sternenheer tycho`, make one file each.

## License

The code is MIT (`LICENSE`). The site's writing and figures are CC BY 4.0 (`site/LICENSE.md`), and data by others keeps
its own terms, listed there and in `packages/sternenheer/data/LICENSE.md`.
