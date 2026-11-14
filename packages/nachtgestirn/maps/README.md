# The Moon's maps

Made by `pnpm --filter @himmelszelt/nachtgestirn maps` from NASA's CGI Moon Kit (https://svs.gsfc.nasa.gov/4720),
credit NASA's Scientific Visualization Studio: the color map of December 2025, from the LROC WAC Hapke-normalized
mosaic, and a height map from the LOLA elevation map at 64 pixels per degree, LOLA's 16-bit half meters offset by
20,000 over the mean radius of 1737.4 km, red the high byte and green the low one. Each 4096, 2048, 1024 and 512
texels around, equirectangular, centered on 0° longitude, east to the right, north up. Near side mean color, linear,
0.4125, 0.3924, 0.3828, reflectance 0.3960.

The optional `moon-roughness-1k.webp`, `-2k` and `-4k` are made by `pnpm --filter @himmelszelt/nachtgestirn roughness`
from Rosenburg et al. 2011's LOLA maps (NASA PDS Geosciences Node, LRO LOLA RDR, extras/fractal): red the median absolute slope over 57 m in tenths
of a degree (MAS_57M_16), green the Hurst exponent from 57 m to 2.7 km, 0.5 to 1 over 0 to 255 (HE_8). 1024, 2048
and 4096 texels around, laid out as the others.
