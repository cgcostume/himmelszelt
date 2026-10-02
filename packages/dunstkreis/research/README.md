# Research notes

How dunstkreis' choices were made: the experiments, what they measured, and what came of them. Where something here
departs from Bruneton & Neyret 2008 and Hillaire 2020, the two papers this package builds on, it says so and why. A
section ends with what we believe is new, as far as we have found; corrections welcome.

## At a glance

Every sample count and table size is a parameter (`PrecomputedTextureConfig` and the cube pass' `samples`). The
errors are the luminance's, mean and worst, against references with many more samples or texels, over a sun 1.7° up,
5.7° and 12° down and 45° up; the GPU times an RX 7900 XT's, which an integrated or mobile GPU may take 20 to 50 times
as long for. The sections below have how they were measured; `measure.mjs` measures them again.

| samples | default | faster | quality | little better beyond | at the default | cost |
|---|---|---|---|---|---|---|
| transmittance | 100 | 40: 0.1%, the sun's horizon cutoff a texel off here and there | 100 | 128 | 0.015%, 0.2% | 0.9 ms once, linear |
| multiple scattering | 40 | 20: 0.25%, 10% | 40 | 64 | 0.08%, 3% | 0.7 ms once |
| sky view | 30 | 20: 1.2%, 10% | 40: 0.4%, 2.8% | 64 | 0.4%, 4.8% in deep twilight | 0.07 ms per rebuild |

| table | default | its effect on the sky | larger | cost |
|---|---|---|---|---|
| transmittance | 256x64 | 0.04%, 0.6% | 512x128: a quarter of the mean | 0.9 ms once, 2 at 512x128 |
| multiple scattering | 128x64 | 1.2%, 2.6% with the sun 12° down; Hillaire's 32x32 14% and 27% | | 0.7 ms once |
| sky view | 128x256 | 0.03%, 0.33% for the worst hundredth; Hillaire's 192x108 4x and 6x that | 128x512: a half and a third | 0.07 ms per rebuild, 0.11 at 128x512 |

The light is computed at four wavelengths and turned into RGB by a matrix fitted to sky spectra, see below. On the GPU
it costs nothing measurable over three: the arithmetic is on four components either way.

## How things are measured

Two scripts measure everything below, both in this folder:

- `wavelengths.ts`, on the CPU: the color conversion. `node packages/dunstkreis/research/wavelengths.ts` (Node 24 or
  later, which strips the types).
- `measure.mjs`, on the GPU: the tables' errors and the passes' times. It runs the built package in Chromium with
  WebGPU, from a page of the site's preview server; see its header for the commands. Modes: `samples`, `tables`,
  `ground` and `timing`.

Errors are relative errors of the luminance, over every texel brighter than a thousandth (tables of light) or a
ten-thousandth (ratios) of the brightest: mean, 99th percentile and maximum. They are measured against a reference with
many more samples, or a table with many more texels read bilinearly at the reference's texel centers, as the shaders
read it. For a table that only feeds others, the transmittance and the multiple scattering, it is its effect on the
sky-view table that is measured, everything else at the reference's quality. Each measurement runs at four suns, 1.7°
up, 5.7° and 12° below the horizon and 45° up, seen from 10 m, and quotes the worst of them unless it says otherwise.

GPU times are timestamp queries around one dispatch, the median of 15, on an AMD RX 7900 XT (RDNA 3) through Vulkan. An
integrated or mobile GPU may take 20 to 50 times as long.

## Four wavelengths

Bruneton & Neyret computed three wavelengths, 680, 550 and 440 nm, and showed them as red, green and blue, as most
real-time skies have done since, osgHimmel's and Hillaire's included. But a color on a screen weighs the whole spectrum:
linear sRGB = ∫ CMF(λ) S(λ) dλ, with CMF the CIE 1931 color matching functions turned into sRGB. Bruneton's 2017
implementation computes some fifteen wavelengths and converts them exactly; it also has an approximate mode with three,
scaling each channel by a factor that assumes the spectrum is the sun's times λ⁻³.

**Method.** Spectra S(λ) = solar(λ) r(λ) with r(λ) from the model's physics: sunlight through some airmass of air
(Rayleigh, λ⁻⁴ by Bruneton's 1.24062 × 10⁻⁶ / λ⁴) and ozone (Bruneton's cross-section table, 300 Dobson units), scattered
by molecules (λ⁻⁴) or haze (flat, or Ångström exponent 1.3), through more air to the eye. True colors by integrating
from 360 to 830 nm in 1 nm steps, with the solar spectrum and ozone cross-section of Bruneton 2017 and the CMF by Wyman,
Sloan and Shirley's analytic fit (2013). Every conversion sees only S at its wavelengths. The color error is the
distance between the converted color and the true one at equal luminance, relative to the true one.

**Conversions tried with the three wavelengths** (named test spectra, mean and worst):

| conversion | mean | worst |
|---|---|---|
| the samples as RGB, white balanced on the sun | 12.4% | 35% |
| Bruneton 2017's approximate per-channel factors | 18.3% | 43% |
| a 3x3 matrix from interpolating r(λ) between the samples | 6.4% | 14.8% |
| a 3x3 matrix fitted by least squares (below) | 4.9% | 13.6% |

None wins: the interpolation is best for sunlight at the horizon, the plain samples for the twilight zenith, the fit
for most of the rest. Three samples see too little: 680 nm lies past red's peak sensitivity around 600 nm, and
ozone's Chappuis band, which colors twilight, peaks between two of them.

**A fourth wavelength.** The tables are rgba16float textures, and the transmittance and multiple-scattering tables left
alpha unused, so a fourth wavelength is free in memory and close to free in arithmetic, GPUs computing on four
components either way. With four, a matrix from the samples to RGB, fitted by least squares:

- Training: 85 spectra, the sun above the air and every combination of 7 sun airmasses (0 to 38), 4 view airmasses
  (0 to 6) and 3 haze shares, each normalized to unit luminance so the fit weighs hue rather than brightness; the sun
  weighted a thousandfold, so it stays white.
- Search: every set of four on 10 nm steps between 420 and 690 nm, 4788 sets, fitted and ranked by mean plus a quarter
  of the worst error on 72 validation spectra the fit never saw: other airmasses, half and one and a half times the
  ozone, haze with an Ångström exponent.
- Report: on 8 named spectra, neither training nor validation.

| wavelengths, nm | validation mean, worst | named mean, worst |
|---|---|---|
| **630 580 510 440** | **0.57%, 1.57%** | **0.54%, 1.70%** |
| 640 600 530 450 | 0.69%, 1.66% | 0.44%, 0.96% |
| 640 570 520 440 | 0.75%, 1.52% | 0.55%, 1.08% |
| 680 550 440, fitted 3x3 | | 4.94%, 13.6% |
| six wavelengths (for scale) | | 0.1%, 0.5% |

The best sets crowd together, so the choice is stable rather than a lucky one. Per named spectrum, at 630, 580, 510 and
440 nm: the sun overhead 0.10%, at 5° 0.23%, at the horizon 0.43%; a blue sky 0.59%, a hazy one 0.21%, a sunset sky
0.80%, the twilight zenith 1.70%, the horizon at noon 0.23%.

**In the package.** `spectral.ts` holds the data and the fit; `fitSpectrumToRgb(wavelengths)` runs once per set of
wavelengths, in a few milliseconds, so a model with other wavelengths gets its own matrix. Every coefficient of the
default model comes from the same data at the four wavelengths, which at 680, 550 and 440 nm reproduce Bruneton's and
Hillaire's values exactly (a test pins it). The tables and the ground light stay spectral; the matrix applies at the end,
in the sky pass, the cube map, the light meter and the sun's illuminance. The ground albedo is given in linear sRGB and
spread over the wavelengths through the primaries' dominant wavelengths. On the GPU, four wavelengths cost nothing
measurable over three: 0.072 ms per sky-view rebuild either way.

**New, as far as we know:** fitting the conversion to sky spectra, and choosing the wavelengths by it. The step from
three to four as a middle road between three used as RGB and full spectral rendering.

## Steps along a view ray

Hillaire's sky-view table divides each ray into equal steps. A horizontal ray runs some 300 km through the air, so at 30
samples a step is 10 km long, and the first one alone spans the whole haze layer, 1.2 km thick. Rays going up now take
steps growing with the square of the distance, t_k = T (k / N)², dense at the eye, where the air is densest; rays going
down, whose densest air lies along or at the end of them, keep equal steps. At 30 samples the sky view's worst error
fell from 11.6% to 0.8%, its mean from 0.65% to 0.1%, and 15 samples became better than 30 had been. Unreal's
implementation of Hillaire's method uses a similar nonlinear distribution; this is not new.

## The multiple-scattering table

**Stored as log2.** Measured by its effect on the sky, the table at 32x32 made skies with the sun 12° down 134% too
bright on average and up to thirteen times at worst. Its values fall by orders of magnitude across the terminator,
within a texel, and the linear filter leaks the lit side's light into the shadow. The table now holds log2 of its values,
plus 12 to keep half floats' steps fine: the filter then interpolates geometrically, as an exponential falloff does. At
32x32 the error fell to 9.5% on average; the remaining is resolution. **New, as far as we know.**

**Its shape.** Twilight leans on the sun's angle, not the altitude. With the sun 12° down, by the effect on the sky:

| size | mean | worst |
|---|---|---|
| 32x32, Hillaire's | 14.5% | 26.8% |
| 32x128 | 13.5% | 25.5% |
| 64x64 | 2.6% | 11.0% |
| 128x32 | 2.2% | 5.0% |
| 256x32 | 1.3% | 3.2% |
| **128x64** | **1.2%** | **2.6%** |

128x64 is the default: also best at every other sun, 0.1% and 0.3% with the sun at the horizon. 0.7 ms once per model.

**One workgroup per texel.** Hillaire's own implementation traces a texel's 64 directions in parallel; the port had one
invocation trace all 64, which left the GPU nearly idle on a table this small. A workgroup of 64 per texel and a sum over
it brought the 32x32 table from 1.30 ms to 0.066 ms, with the same values. The sum uses subgroup operations where the
device has them and a tree in workgroup memory where not: the same time, the parallelism is what counted.

## The sky-view table's shape

Its columns hold half a turn of azimuth from the sun, square-rooted towards it, its rows the angle from the horizon,
square-rooted towards it from both sides. At about the same number of texels, measured directly against a 1024x1024
table:

| size | mean | worst hundredth | worst |
|---|---|---|---|
| 192x108, Hillaire's | 0.12% | 1.89% | 27% |
| 256x144 | 0.068% | 1.02% | 21% |
| 144x256 | 0.028% | 0.33% | 11% |
| 64x256 | 0.036% | 0.38% | 11% |
| **128x256** | **0.028%** | **0.33%** | **11%** |
| 128x512 | 0.014% | 0.10% | 4% |

The rows need the texels, the columns hardly: 64x256 beats 192x108 with fewer texels. The worst single texels sit at the
edge of the sun's glow. 128x256 is the default, 0.07 ms per rebuild. **New, as far as we know**: Hillaire's 192x108 has
been the common choice.

## The transmittance table

256x64 affects the sky by 0.04% on average and 0.6% at worst; 128x32 triples the mean, 512x128 divides it by four, and
other shapes of as many texels (128x128, 512x32) measured no better. It stays at Bruneton's size.

Below 100 samples per ray its mean error is small (0.1% at 40), but single texels at the horizon's cutoff flip between
lit and dark: the sun's disappearance at the horizon moves by a texel. 100 samples, 0.015% on average, 0.2% at worst.

## Sample counts

| samples | 20 | 30 | 40 | 64 | 100 | 128 |
|---|---|---|---|---|---|---|
| transmittance, mean / worst | 0.38% / cutoff | | 0.10% / cutoff | 0.04% / cutoff | 0.015% / 0.22% | 0.009% / 0.18% |
| multiple scattering | 0.25% / 10% | | 0.08% / 3.1% | 0.04% / 3.6% | 0.03% / 3.3% | |
| sky view, worst sun | 1.2% / 10% | 0.42% / 4.8% | 0.39% / 2.8% | 0.30% / 2.6% | | 0.23% / 2.4% |

Beyond 64 the multiple scattering is limited by half floats; the sky view's remaining worst case is deep twilight.

## The sky's light on the ground

The ground below the horizon is lit by the sky as well as the sun: its irradiance, ∫ L μ dω over the hemisphere, read
from the sky-view table's upper half. First by Malley's method, points of Vogel's spiral on the disc lifted onto the
hemisphere. At low suns that misses: the sky's light then sits in a thin band of glow at the horizon, where a
cosine-weighted spiral puts hardly any points, and the error did not fall steadily with their number. Now it is
integrated texel by texel: each texel's luminance times the cosine-weighted solid angle it covers above the horizontal,
∫ μ dμ dφ = Δφ (μ₀² − μ₁²) / 2 over its extent, twice for both sides of the sun's meridian. Against a million spiral
points read bilinearly, on the CPU from the same table:

| sun | texel quadrature | spiral of 1024 |
|---|---|---|
| 1.7° up | 0.007% | 0.15% |
| 5.7° down | 0.005% | 0.07% |
| 12° down | 0.017% | 3.9% |
| 45° up | 0.001% | 0.03% |

Exact for the table, no sample count to choose, and a workgroup of 64 does the 16,000 texels in no time.

## Precision

- **The sky-view table, scaled to the sun.** Half floats hold some 30 stops in their normal range, from 6e-5 to
  65504. The table's brightest value falls by 37 stops from noon to the sun 30° down, and at noon it sat at 64740,
  0.1% below the top; with the sun 18° down nine of ten values were subnormal, stepping by up to half their value. It
  now holds the luminance times a power of two from the sun's altitude above the observer's horizon, which puts its
  brightest value near 2^10, 16 stops below the top and 24 above the bottom: its brightest value, measured from the
  ground to the top of the atmosphere, for this model and osgHimmel's, follows that altitude within 1.5 stops. It
  changes only with the table, and its readers divide by it. Tone mapped, the images are the same to the bit,
  but for the deepest twilight at the lowest exposures.
- **Altitudes, not radii.** In f32, a radius near 6360 km resolves only about half a meter. Every function near the
  ground takes the altitude instead, and differences of squares like r² − Rg² are factored from it. That took a floor
  out from under the observer, a band at the horizon, and, last, a jitter of the sun's cutoff there, from the
  transmittance lookup.
- **The golden angle, wrapped in integers.** Fibonacci and Vogel spirals take the azimuth i times the golden angle.
  WGSL's cos and sin are accurate only within [−π, π], and i times 2.4 radians leaves that from the second point on; a
  thousand points in, the GPU's cosine had drifted visibly. The azimuth is now wrapped exactly, i times 1640531527, the
  golden angle's share of a turn times 2³², in u32 arithmetic.
- **Rays from any projection.** The camera's rays run from the eye, which a perspective projection maps to
  (0, 0, c, 0), to the point halfway into the depth range: correct for depth in [0, 1] or [−1, 1], reversed and with an
  infinite far plane, where the far plane's w is 0.

## Refraction

The air's refractive index follows its density, and every ray bends as it is traced, by the ray equation, between the
same samples that integrate its scattering; Bouguer's invariant n r sin z decides where the ground starts. Near the
ground it lands within a few percent of Bennett's fit above 5°, and some 10% above it at the horizon, where the model's
single scale height makes the lowest air denser than the real one (tests/refraction.spec.ts). The transmittance table
is indexed by the true direction light arrives from, found by bisection over traced rays, the sky-view table by the
apparent one, storing how far each ray bent. **New, as far as we know**, in Hillaire's tables.

## Tone curves

Narkowicz's ACES fit, Khronos PBR Neutral and AgX in Wrensch's minimal fit, compared on the same skies by eye. ACES is
saturated and shifts bright hues towards yellow; AgX desaturates towards white as film does, and leaves the daytime sky
flatter without a grade on top; Neutral keeps the sky's blue as the model computes it and compresses only the
brightest. Neutral is the default, the other two options.

At first Neutral looked a stop too dark, its shadows near black. The exposure follows a camera's convention: by EV100
a light meter's reading lands at 1/9.6 of saturation, its calibration K = 12.5 over ISO 100 times 1.2. Narkowicz's fit
was made for that, mapping it to a normal mid-tone. Neutral and AgX expect scene middle gray at 0.18 instead, and
Neutral passes 0.104 almost through, less its toe. Both now take the exposed light times 0.18 × 9.6 = 1.728, which lands a
metered average on their middle gray; the meter and the exposure keys stay as they are.

## The exposure's lower bound

Metering is held within an EV100 range, so the night stays dark rather than exposed like day. Its lower bound was 8,
which the meter reaches with the sun 4.3° down: the earth's shadow and the belt of Venus, at their best between 2° and
6° down, were exposed up to two stops below the meter's reading. The whole sky then lay below 0.08 after the exposure,
in Khronos PBR Neutral's toe, which takes nearly the smallest channel off all three: it saturated the dark blue of the
earth's shadow to cyan and, measured with the sun 4.75° down, turned its luminance from 0.0129 below the belt of Venus
above it (0.0166) to 0.0094 above it (0.0079). The bound is now 4, reached at the end of civil twilight, 6° down, with
the default compensations. Without them the meter reads EV 13.9 with the sun 10° up, 11.7 at the horizon, 4.2 at 6°
down, -3.4 at 10° and -14.5 at 18° down (`research/measure.mjs` does not cover this; it was read from `meteredEV100`).

## The GPU tests

The WGSL tests run real shaders through Dawn in Node. For months they crashed or deadlocked a worker every few
evaluations, which was put down to the `webgpu` binding. It was the harness: the GPU instance from `create()` went
unreferenced, and the garbage collector took the device with it. Held for the process' life, the tests pass every time.
