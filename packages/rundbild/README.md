# @himmelszelt/rundbild

Skies as images: cube maps and panoramas, one laid out as the other, and the diffuse image-based lighting from them, on
WebGPU compute. Not a renderer: you hand it a `GPUDevice` and textures you own, and it records into your command encoder.
It takes any cube map as a plain `GPUTexture`, so it depends on no other package; `@himmelszelt/dunstkreis` can write
one, and so can anything else.

Directions are ENU (x east, y north, z up). A y-up engine samples a cube map with (x, -z, y).

## Panoramas

`await createPanoramaPass(device, { projection, format })`, then `encode(encoder, cube, texture)` into mip level 0 of a
2D texture, in the units the cube map holds, `samples` lookups per texel.

- `equirectangular`, as HDRIs are shared, 2:1: north at the left edge, east a quarter in, south in the middle, seen from
  inside, the zenith at the top.
- `octahedral`, the whole sphere in a square.
- `fisheye`, the upper hemisphere azimuthal equidistant in the inscribed circle.
- `sphere`, the sphere map, the whole sphere in the inscribed circle as a mirror ball shows it, equal in area, the nadir
  all round the rim.

The last three have the zenith in the middle, north up and east left, as a sky chart held overhead. Beyond the circle,
alpha 0, the fisheye's texels hold the horizon at their azimuth and the sphere map's the nadir, so a filtered lookup at
the rim blends into what lies there; the fisheye's top left corner texel alone holds the nadir, where `rbFisheyeUv` sends
every direction below the horizon. `azimuthOffset` turns each about the zenith, in degrees, 180 for north in the
equirectangular's middle. The mappings both ways are in `wgsl.panorama`, `rbPanoramaUv` and `rbPanoramaDirection`.

## Cube maps

`await createCubeFromPanoramaPass(device, { projection, cubify, samples })`, then `encode(encoder, panorama, cube)`, an
rgba16float panorama into a cube map, with its mip levels if it has them. For a cube map to hold what an equirectangular
of width W holds, its faces need W/π texels.

`await createEnvironmentBlendPass(device)`, then `encode(encoder, a, b, target, t, { a, b })`, fades two cube maps by
their light, each scaled first. `mixCoefficients(a, b, t)` does the same for their spherical harmonics coefficients.

`wgsl.cube` holds the layout: `rbCubeDirection` for writing a texel, and, for a cubified cube map, osgHimmel's `cubify`
after Nowell's mapping, `rbSphereFromCube` and `rbCubeFromSphere`. Its largest texel spans 4/3 of the smallest one's solid
angle, not some 5.2 times.

## Diffuse image-based lighting

`await createIrradiancePass(device, { cubified, sourceFormat })`: `encode(encoder, cube)` projects any cube map onto the
nine real spherical harmonics up to order 2 (Ramamoorthi & Hanrahan 2001), in a storage buffer to shade with directly,
and writes an irradiance cube map from them, 32x32 per face. An rgba32float source is read through a nearest sampler
unless the device has "float32-filterable".

## Files

`encodeRgbe(pixels, width, height)` gives the bytes of a Radiance HDR file, `decodeRgbe(bytes)` the pixels of one.

## Status

`wgsl.ground` puts an image's ground on a plane, so objects stand on it and a camera moves over it, and lifts its horizon.

The horizon band of the original thesis and specular image-based lighting follow. Exposure and tone
curves are `@himmelszelt/helldunkel`'s.

The WGSL is tested by executing it via Dawn in-process: `pnpm test:gpu`, since a CI runner has no GPU. Every identifier
is prefixed `rb`/`RB_`. Part of the [himmelszelt monorepo](https://github.com/cgcostume/himmelszelt).
