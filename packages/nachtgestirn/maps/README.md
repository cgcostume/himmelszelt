# The Moon's maps

Made by `scripts/maps.mjs` and `scripts/roughness.mjs`, in the repository `pnpm maps` and `pnpm roughness`, where the
package is installed `npx @himmelszelt/nachtgestirn data maps` and `data roughness`, each with `--size
512,1k,2k,4k[,8k]` and `--whole` or `--seen`. The package ships the seen 512 and 1K; the whole ones up to 4K are checked
in for the site; the seen ones from 2K and every 8K are ignored by git, and `data` fetches them built from the asset
mirror (github.com/cgcostume/himmelszelt-assets) unless `--build` is given.

`moon-color-*.webp` and `moon-height-*.webp` come from NASA's CGI Moon Kit (https://svs.gsfc.nasa.gov/4720), credit
NASA's Scientific Visualization Studio: the color map of December 2025, from the LROC WAC Hapke-normalized mosaic, lossy
sRGB without metadata, and a height map from the LOLA elevation map at 64 pixels per degree, LOLA's 16-bit half meters
offset by 20,000 over the mean radius of 1737.4 km, red the high byte and green the low one, lossless. Near side mean
color, linear, 0.4125, 0.3924, 0.3828, reflectance 0.3960.

`moon-roughness-*.webp` come from Rosenburg et al. 2011's LOLA maps (NASA PDS Geosciences Node, LRO LOLA RDR,
extras/fractal): red the median absolute slope over 57 m in tenths of a degree (MAS_57M_16), green the Hurst exponent
from 57 m to 2.7 km, 0.5 to 1 over 0 to 255 (HE_8), lossless, 512 to 4096 texels around.

All are equirectangular, as many texels around as the size says and half as many down, centered on 0° longitude, east
to the right, north up.

The suffix `seen` before the size marks the maps that hold only what Earth ever sees. Past the edge of what is ever
seen, by a smoothstep over 2° to 6°, the color fades into the mean of the part no libration shows, per channel, in
linear light, weighted by area, and the heights and the roughness to none, the mean radius and no slope. That edge lies
a quarter turn from the mean sub-Earth point plus the librations' reach towards the texel, 7.9° in longitude and 6.7° in
latitude combined as a rectangle's support, plus 1.25° for the diurnal libration; it errs on the safe side by 0.3° to
0.6°. 36% of the surface is that fill alone, 39% touched at all. Where Earth sees, the heights and roughness are the
whole maps' bit for bit, the color within the lossy encoding's own noise.
