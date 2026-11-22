# The noise, measured

How fast gewoelk's noise is, what the passes that bake from it cost, and whether a change keeps its character. Every
script builds the package's shaders twice, as they were at a baseline commit (`BASELINE`, by default `53b20b1`, the
last with the noise before 2026-11-22) and as they are in the working tree, and compares the two in one process.
They run under Dawn, the `webgpu` package, with timestamp queries; times are medians of 41 runs interleaved, on an
RX 7900 XT under RADV. Differences under some 15% are noise.

| script | what it does |
|---|---|
| `micro.mjs` | each noise function alone, ns per evaluation |
| `passes.mjs` | the passes that bake from it, ms per bake, and the sheets' noise per pixel and frame |
| `verify.mjs` | does each function still tile, and how it spreads: mean, deviation, range, the seam (`PERIOD=40` for many cells) |
| `examples.mjs` | before and now side by side in `out/`, the functions, the maps, the sheets |
| `spread.mjs` | how widely gwPerlin's slices spread against gwPerlin2, what `GW_PERLIN2_HEIGHT` is set by |
| `hashq.mjs` | chi squares of the bits a gradient is picked by, against its neighbors' and the next seed's |

```sh
node micro.mjs
BASELINE=HEAD node passes.mjs
```

## 2026-11-22: the noise rebuilt

| pass | before | now | |
|---|---|---|---|
| detail noise 128³, once | 5.84 ms | 2.31 ms | 2.5x |
| high map 2048² | 6.14 ms | 3.62 ms | 1.7x |
| layer map 512², heaps | 0.63 ms | 0.14 ms | 4.4x |
| layer map 512², towers | 1.12 ms | 0.36 ms | 3.1x |
| layer map 512², front | 1.10 ms | 0.35 ms | 3.1x |
| cloud map 512², with towers | 0.67 ms | 0.29 ms | 2.3x |
| the sheets' noise at 1080p, per sheet and frame | 0.99 ms | 0.52 ms | 1.9x |

What was slow, and what changed:

- **The lattice was wrapped at every corner,** `(cell % period + period) % period`: 48 integer divisions for one
  gradient noise, 162 for one alligator noise. It is wrapped once per call now, its neighbors by a compare.
- **Alligator noise hashed four times per cell for all 27 cells.** Now a cell's four numbers are one pcg4d, and cells
  a radius or more away are skipped: 3.7x.
- **The curl was twelve gradient noises by central differences.** Now it is the analytic slope of three that share
  one walk of the lattice and take their gradients from other bits of the same hashes: 5.8x.
- **A cell's eight corners were eight pcg3d.** Now they are a product per axis, summed and mixed by lowbias32, four
  at a time: gradient noise 1.9x.
- **The layer map computed each texel's value three times,** for the slope. Now a workgroup bakes a tile of 15 texels
  with invocations one texel wider, and takes the slope from its neighbors' values in workgroup memory. The values
  are the same to the bit, the slopes to 1e-4.
- **The sheets read 3D noise at a fixed height,** 18 times per pixel. They read gwPerlin2 now, half the corners.

A first variant changed only the wrapping and the skipped cells and kept every value to the bit: 1.4x to 1.6x on the
passes. The second, kept, draws other clouds from the same seeds, with the same statistics: over 40 cells gradient
noise's deviation is 0.276 against 0.277, alligator noise's mean 0.166 against 0.168. Every preset keeps its kind of
sky, not its exact clouds.

**A flaw found on the way.** The gradient was picked by pcg3d's low four bits, which depend on the neighbor's along x:
two cells apart z of over 100 (`hashq.mjs`), the same bits in 5.4% of cells, not 6.3%. Not visible, but real. The top
bits and the corners' hash are clean.

**Plain 2D gradient noise is 0 at every lattice point,** which pins the creases of its absolute value, the sheets'
flocks, to a visible grid. A slice of 3D noise is not, as each corner's third gradient component lifts it. So each
corner of gwPerlin2 has a height of its own, 0.35 of a unit, which spreads it as widely as the slices (deviation 0.268
against 0.25 to 0.28) and keeps the sheets' constants.

Also moved into the package, so the site keeps no copies: the jitter the marches start their rays by (it was in three
places), and the cell patterns the layer and high maps draw from (bumps, lumps, pillows, towers), which the research
figures had copied; both in `cells.wgsl`. The hashes and the noise themselves went on to `reisszeug/` at the
repository's root, shared with nachtgestirn, whose roughness reads the same gradient noise's slope: `wgsl.noise` is
both, under the prefix `gw`. The scripts here compose it as the package does, at either commit.
