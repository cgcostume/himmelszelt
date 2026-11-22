# reisszeug

The shader math more than one `@himmelszelt/*` package needs, in one place. Named after the *Reißzeug*, the case of
compasses and rulers a draftsman's work starts from. Not a package: no `package.json`, never published. A package
imports from here by relative path, and its build inlines what it takes into its `dist`, so npm users still install one
package and nothing else.

## What lives here

Generic math, once a second package needs it. What has a natural owner stays with that owner and is bundled from there:
the camera's rays with dunstkreis, the tone curves with helldunkel, the cube map's layout with rundbild. What only one
package needs stays in that package, however generic it looks.

| file | what | used by |
|---|---|---|
| `hash.wgsl` | pcg3d, pcg4d, lowbias32, wrapping and a lattice cell's numbers | gewoelk, nachtgestirn |
| `noise.wgsl` | gradient noise in 3D and 2D, its octaves and slope, the curl, alligator noise | gewoelk, nachtgestirn |
| `turbulence.wgsl` | Kolmogorov's turbulence, what wanders an image seen through the air | dunstkreis, nachtgestirn |
| `phase.wgsl` | Henyey and Greenstein's phase function | dunstkreis, gewoelk |
| `reduce.ts` | `workgroupSum`, a workgroup's sum in WGSL, with subgroups or without | dunstkreis, rundbild |
| `prefixed.ts` | a chunk under the importing package's prefix | every package that imports from here |
| `source.ts` | a chunk read from disk under a prefix, for the packages' tests | their tests only |

## The prefix

Every identifier here is prefixed `rz`, `Rz` for structs and `RZ_` for constants. A package renames them to its own as
it composes them, so its snippets read as its own and two packages' snippets never collide in one module:

```ts
import rzNoise from "../../../../reisszeug/noise.wgsl";
import { prefixed } from "../../../../reisszeug/prefixed.js";

export const noise = prefixed(rzNoise, "gw"); // rzPerlin is gwPerlin
```

A chunk names what it requires the way a package's shaders do. Nothing here may use a constant of its own that a
package defines too: `RZ_PI` would become a second `GW_PI`. Write the number instead.

## Tests and measurements

The chunks are tested through the packages that inline them: their GPU tests compile and run them, reading each chunk
with `reisszeugSource(name, prefix)`. gewoelk's `research/noise` measures the hashes and the noise.

A package's build leaves `.d.ts` files here: TypeScript 7's `tsgo` writes the declarations of sources outside a
package's root beside them rather than into its output. Git ignores them, and TypeScript reads the `.ts` over them.
