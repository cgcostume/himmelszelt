# himmelszelt workspace

Porting [osgHimmel](https://github.com/cgcostume/osghimmel) (a C++/OpenSceneGraph sky-rendering
library the user, Daniel Limberger, github: cgcostume, wrote as his own HPI master's thesis,
2011-2012) to modern TypeScript + WebGPU (compute-first), as a family of small, independent,
composable libraries. Goal: drop any single one into an existing WebGPU renderer without pulling
in the rest.

A read-only reference clone of the original lives at `./osghimmel` (kept here, not `/tmp`, so it
survives across sessions). Check it when porting a new module, don't guess at the original
algorithm from memory.

## Repo topology

**Monorepo** at `cgcostume/himmelszelt` (this directory is the repo root), pnpm workspace. What stays
independent are the **npm packages**, not the repos: each library under `packages/*` is its own
published `@himmelszelt/*` package (the `@himmel` npm scope was taken, hence the name) with its own `package.json`, `dist`, README and version. The earlier
polyrepo (`cgcostume/himmel-sternzeit`, `cgcostume/himmel-dunstkreis`) was dropped without history
and is to be deleted by the user.

```
packages/<name>/   one directory per published @himmelszelt/* package
site/              sternwarte: the single website (Astro), private, never published to npm
osghimmel/         read-only reference clone, gitignored
```

| npm package | Directory | Status |
|---|---|---|
| `@himmelszelt/sternzeit` (astronomy/sidereal time math) | `packages/sternzeit` | Julian Day, sidereal time, sun/moon/earth positions, moon phase, sun direction from the moon, earthshine and librations done (precise + approx), ΔT from IERS observations and Espenak & Meeus; cross-checked against astronomia; stars stubbed |
| `@himmelszelt/dunstkreis` (WebGPU atmosphere after Hillaire, on Bruneton's model) | `packages/dunstkreis` | tables, sky pass, traced refraction, exposure, sky cube map and diffuse IBL (SH9, irradiance cube) working, live in its chapter under `pnpm dev` (a draft, withheld from the published site); aerial perspective, specular IBL, Bruneton as another sky-view filler pending |
| `@himmelszelt/sternwarte` (the website, `private: true`) | `site/` | sternzeit chapter done (figures, glossary tooltips, references, TOC); dunstkreis chapter started (live sky, section skeleton), and `planned: true` placeholders for nachtgestirn, sternenheer, gewoelk, rundbild; deployed to GitHub Pages by CI from main |
| `@himmelszelt/gewoelk` (clouds) | not created yet | later |
| `@himmelszelt/sternenheer` (star rendering) | not created yet | later; the old poetic word for the host of stars, and clear of himmelszelt |
| `@himmelszelt/nachtgestirn` (moon rendering) | not created yet | later |
| `@himmelszelt/rundbild` (texture mapped skies) | not created yet | later; sky projections, HDR environment maps, IBL computed from them, and the horizon band from the thesis. Named after the Rundgemaelde, the 19th century panorama: a 360 degree image of the surroundings, which is what an environment map is |

**sternwarte** is one site for all libraries, structured like a blog with one chapter per library:
explains the techniques, showcases them, makes them explorable (WebGPU canvases, zdog
visualizations, sliders/buttons, code examples). Plus a generated API reference (TypeDoc to
Markdown). Terms are explained only as hover tooltips, in the text (`<Term>`) and in tables, from one
site-wide glossary (`site/src/data/glossary.json`); no glossary pages, no per-package GLOSSARY.md.
Sources are cited with `<Cite>` and listed at the end of each chapter (`site/src/data/references.ts`).

**sternzeit is the blueprint for every chapter.** The layout adds the name's meaning (from the glossary) under the
title, the lead (the `summary`), a meta line (last updated, term hint), a TOC from three sections on, and the
references right after the content; the short himmelszelt note shows only on a withheld chapter's placeholder, as the
header and footer say the rest. The
body follows: an interactive scene first, with the moment and place controls under it, still in the opening section, then the concepts building on each other,
"Precise or approximate?" wherever both variants exist, and the references. There is no separate code examples section:
each example sits in the section whose concepts it uses, led into from what the section just explained rather than by
a bold heading or any other subsection, and one that runs has its output live below it; what the library can be used
for at all opens the chapter. Leads are short and curious rather than feature lists, and never promise what a planned
chapter does not have yet.
Figures are numbered automatically; refer to one with `<Fig id="..." />`, never with a typed number, and only in
parentheses, as a reference after what it shows: "(Figure 2)", never "Figure 2 shows" or a sentence starting with it.

Final showpiece: one comprehensive demo
combining sun, moon, atmosphere, stars, clouds. Audience: developers who want to use the
libraries; should be a joy to read, educational, and nerdy. Hard requirements, non-negotiable:
runs locally with a single command, deploys as static files to GitHub Pages, no other hosting.
No per-package dev pages: a library is developed and debugged in its chapter, which imports its source directly.
`pnpm dev` and the published site differ on purpose: a chapter with `draft: true` in its frontmatter (dunstkreis for
now) is shown in full under `pnpm dev` and published as a placeholder like a planned one, and `<Planned>` figure notes
render under `pnpm dev` only. Both switch on `import.meta.env.DEV` (see `site/src/lib/chapters.ts`).

**No cross-module hard dependencies.** `dunstkreis` doesn't depend on `sternzeit`, it takes a
sun/moon direction vector + time as plain inputs. Whoever embeds it computes that vector however
they like. Keep this decoupling for every future module too.

**Directions are ENU** (x east, y north, z up, right-handed) in every package: sternzeit's
`horizontalToDirection` and `moon.sunDirection`, dunstkreis' `sunDirection` input and view rays. Azimuths are
compass azimuths (from north through east). A y-up engine converts with `(x, z, -y)`.

**Dropped from the port:** the original's stateful OOP facade (`AbstractAstronomy` to
`Astronomy`/`Astronomy2`, holding mutable time/lat/lon). Everything is plain functions instead,
simpler, tree-shakeable, no hidden state. Don't reintroduce a class hierarchy when porting more of
`astronomy.cpp`.

**Precise + fast variants.** The original ships both a Meeus-precision implementation and a
cheaper Jensen et al. approximation for sun/moon/earth/sidereal-time math (`sun.cpp` vs
`sun2.cpp`, etc.). Port both as a pair of functions (see `meanSiderealTime` /
`meanSiderealTimeApprox` in `sternzeit` for the established naming pattern), not just the precise
one.

## Local dev setup

Open this directory as a plain VS Code folder (single root). `pnpm install` at the root installs
everything; one `pnpm-lock.yaml`, one `biome.json`, one `tsconfig.base.json` (each package's
`tsconfig.json` extends it). Cross-package dependencies use `workspace:*` (e.g. dunstkreis' tests
use sternzeit), which pnpm rewrites to real version ranges on publish.

Root scripts: `pnpm dev` (site at http://localhost:4321/himmelszelt/), `pnpm build`, `pnpm typecheck`, `pnpm test` (recursive), `pnpm lint`, `pnpm format`, `pnpm clean` (removes everything generated, including `node_modules`).

## Tooling (same across every `@himmelszelt/*` package)

- **TypeScript**, strict, ESM-only (`type: module`, no CJS output).
- **pnpm** as the only package manager (no npm/yarn).
- **Rolldown** (+ `rolldown-plugin-dts`) as the bundler, chosen over tsup after comparing
  GitHub activity/stars; Vite itself is migrating to Rolldown internally.
- **Playwright** as the *only* test runner, including pure-math unit tests (no Vitest). Test files
  that never touch the `page`/`browser` fixtures run with zero browser overhead, so this doesn't
  cost anything for e.g. `sternzeit`'s golden-value tests, and it unifies with visual-regression
  tests once there's something to render.
- **Biome** (not Prettier/ESLint) for formatting + linting. Needs the `biomejs.biome` VS Code
  extension installed manually. Config: 4-space indent, 120-column line width, `formatOnSave` on.
- **Shared config lives at the root** (`biome.json`, `tsconfig.base.json`), not in a config package.
- **Astro** for the site (`site/`): content collections + MDX per chapter, zero JS by default,
  every interactive demo is an island. Only acceptable as long as it stays static-exportable to
  GitHub Pages and runs locally with one command. The site pins TypeScript 6: `astro check` needs the
  programmatic compiler API, which TypeScript 7 (native) does not ship yet.
- **MIT license**, no NOTICE/BSD-carryover needed. The user is the sole author/rights-holder of
  the original osgHimmel work (his own thesis, not employer-commissioned), so relicensing is his
  call.

## Working conventions

- **Never commit without explicit approval in the moment**, even for setup/scaffolding work.
- No em-dash characters anywhere: not in code, comments, docs, or commit messages. Use a comma,
  colon, parentheses, or split into two sentences instead.
- Prefer one-line code and comments (including JSDoc) whenever it fits ~120 columns and stays
  readable; don't wrap just because that's how it was first typed.
- Large binary/data assets (e.g. the ~9k-star catalog in `sternzeit`): keep a checked-in CSV as
  the human-readable source of truth, generate a binary (flat `Float32Array`, matching whatever
  precision the original C data actually had, don't over-precision to float64) via a dedicated,
  rerunnable package script. One-shot conversions (e.g. extracting data out of vendored original
  C++ source) don't need to stay as a repo script once their output is checked in.
