# Fact checks

What has been checked in the chapters, against what, and when, so a review only rechecks what changed. One section per
chapter. A row is rechecked when its text changes, when the library code behind it changes, or when the source is
replaced; otherwise it stands. Checked against: `lib` is the library's own output (dist, at the date), `src` a cited
source, `derived` a computation from both, `web` a lookup outside the cited sources.

Status: `ok` holds, `fixed` was wrong and is corrected (the row shows the corrected claim), `open` could not be
confirmed yet.

## sternzeit

### Text

| Claim | Where | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| `julianDayUT(same)` is 2461305.25 | Counting time, code | lib | 2461305.25 | ok | 2026-10-11 |
| Julian Day today about 2.46 million | Counting time | lib | 2461325 | ok | 2026-10-11 |
| ΔT about a minute today, hours in antiquity | Counting time | lib | 69.1 s; 2.9 h at year 0 | ok | 2026-10-11 |
| Sidereal time gains almost a degree a day | Counting time | lib | 0.9856° | ok | 2026-10-11 |
| Sidereal day 23 h 56 min, 366 turns a year | Counting time | src | Meeus | ok | 2026-10-11 |
| 1582: ten days skipped | Counting time | web | Oct 4 to Oct 15, 1582 | ok | 2026-10-11 |
| Obliquity about 23.4°, nutation period 18.6 years | Earth | lib, src | 23.44°; Meeus ch. 22 | ok | 2026-10-11 |
| Nod and slide stay below 20 arcseconds | Earth | lib | Δψ max 18.9″, Δε max 9.9″ (2000 to 2018) | ok | 2026-10-11 |
| 20 arcseconds a hundredth of the Moon's width, covered by the Moon in half a minute | Earth | derived | 20″ / 1,865″ (mean diameter 31.1′) = 1/93; 360° / 27.32 d = 0.549″/s, 20″ in 36 s | ok | 2026-10-16 |
| Perihelion January 3, 2026, 147 million km (orbits Try) | Earth | lib | sun.distance minimum, hourly: 2026-01-03 18:00 UTC, 147.10 million km; aphelion 2026-07-05, 152.10 | ok | 2026-10-16 |
| Horizon dips more than 3° at 10 km | Earth | lib | 3.21°, geometric | ok | 2026-10-11 |
| Parallax: Sun 8.8″, Moon up to a degree, two diameters | Coordinates | lib | 8.76″; 0.90° to 1.02° | ok | 2026-10-11 |
| Refraction at the horizon more than the Sun's diameter | Coordinates | lib | 34.5′ from apparent 0°, Sun 32′ | ok | 2026-10-11 |
| Celestial pole as high as the latitude | Coordinates | src | Meeus ch. 13 | ok | 2026-10-11 |
| Light from the Sun 8 min 20 s, sky turns 2° meanwhile | The Sun | derived | 499 s; 2.08° | ok | 2026-10-11 |
| Aberration 20.5″, under a ninetieth of the Sun's disc | The Sun | src, derived | Meeus 25; 1/94 | ok | 2026-10-11 |
| Earth 30 km/s, 15,000 km in 8 min 20 s; aberration moves eclipse contacts by some 40 s | The Sun | derived | 29.8 km/s × 500 s = 14,900 km; 20.5″ / 0.51″/s (Moon against Sun) = 40 s | ok | 2026-10-12 |
| Moon 1.3 light seconds away, its shift under an arcsecond | The Sun | derived | 1.28 s; 0.70″ | ok | 2026-10-16 |
| Moon moves about 13° a day against the stars | The Sun | src | 13.18° | ok | 2026-10-11 |
| Equation of time: 16 min ahead in November, 14 behind in February | The Sun | src | Meeus ch. 28 | ok | 2026-10-11 |
| Eccentricity about 0.0167; 3% closer, 3% larger in January | The Sun | lib | 0.01670; 3.4% | ok | 2026-10-11 |
| Golden hour example finds sunrise before sunset anywhere | The Sun, code | lib | Los Angeles, Tokyo, Berlin | fixed | 2026-10-11 |
| Moon's orbit tilted about 5°, Sun pulls about twice as hard as Earth | The Moon | src | 5.14°; 2.2 times | ok | 2026-10-11 |
| Libration: a few degrees optical | The Moon | lib | 8.1° and 6.9° max | ok | 2026-10-16 |
| Lit fraction is only a first measure of moonlight | The Moon | src | opposition surge | fixed | 2026-10-11 |
| Crescent lit from above implies daylight | The Moon | derived | elongation under 90° | ok | 2026-10-11 |
| `moon.brightLimbAngle` is the tilt in the observer's sky | The Moon, code | lib | chi minus q, topocentric | fixed | 2026-10-11 |
| Sun 400 times wider and 400 times farther | Eclipses | lib | 401; 389 | ok | 2026-10-11 |
| Moon recedes 3.8 cm a year | Eclipses | src | Dickey et al. 1994 | ok | 2026-10-11 |
| Last total solar eclipse in some 600 million years | Eclipses | derived | 609 million at 3.8 cm a year | ok | 2026-10-11 |
| Eclipse phase: 0.5 and 1 for the Moon at its center on the shadow edges | Eclipses | lib | `eclipse.ts` | fixed | 2026-10-11 |
| Every solar eclipse has a lunar one two weeks before or after | Eclipses | derived | limits 18.5° and about 17° | ok | 2026-10-11 |
| Total solar eclipse August 12, 2026; partial lunar August 28 | Eclipses | lib, web | umbral magnitude 0.91 | ok | 2026-10-11 |
| Next total lunar eclipse from late 2026: 2028-12-31, 16:18 UTC | Eclipses, code | lib | 16:18:42 UTC by bisection (16:18:49 on the minute grid) | ok | 2026-10-12 |
| True full moon up to 14 hours from the mean one | Eclipses, code | lib | 0.58 days | fixed | 2026-10-11 |
| Totality lasts less than two hours, so it began within the hour of the deepest moment | Eclipses, code | web | longest total lunar eclipses about 106 minutes (July 16, 2000: 106.4 min) | ok | 2026-10-12 |
| Bisection: a day to the minute in 11 tests, a walk up to 1,440 | Glossary | derived | log2(1440) = 10.5 | ok | 2026-10-12 |
| Eclipse snippet: bisection matches the minute walk | Eclipses, code | lib | six starts 2000 to 2032, all within a minute; 934 instead of 25,428 calls, 3.8 instead of 92 ms | ok | 2026-10-12 |
| Sunrise snippet: altitudes once per minute | The Sun, code | lib | same four times at four places; 1,441 instead of 5,760 calls, 2.7 instead of 7.5 ms | ok | 2026-10-12 |
| Approximate Sun within 0.002°, Moon almost a tenth | Precise and approximate | lib | 0.0013°; 0.091° (Berlin, 2026) | ok | 2026-10-11 |
| Meeus: meteorologist at Brussels Airport until 1993, amateur astronomer | People | src | rasc2003, rasc2213 | ok | 2026-10-11 |
| Asteroid 2213 Meeus named for him | People | src | rasc2213 | ok | 2026-10-11 |
| Sæmundsson computed the University of Iceland's almanac for sixty years | People | src | helgadottir2023 | fixed | 2026-10-11 |
| Jensen et al.: Moon, stars, zodiacal light, airglow, with the atmosphere | People | src | jensen2001 abstract (measured data, not pure physics) | fixed | 2026-10-11 |
| van de Hulst predicted the 21 cm line in 1944 as a student; spin flip; found 1951; maps the Milky Way | People | src | hovenier2001 | ok | 2026-10-11 |
| van de Hulst's book gives the sphere's phase law behind `moon.earthshine` | People | lib | `moon.ts` comment, osgHimmel; book not seen | open | 2026-10-11 |
| Espenak: NASA Goddard until 2009, Mr. Eclipse, canons with Meeus | People | src | anderson2025 | ok | 2026-10-11 |
| A few microseconds per call; frame at 60 Hz over 16,000 µs | Opening | lib | measured, Ryzen 7 7800X3D, node, 1000 distinct moments: sun.direction 2.4, moon.direction 5.4 µs | ok | 2026-10-16 |
| Precise Sun about 2 µs, Moon about 5, approximate about 1; quick start fits a 60 Hz frame some two thousand times | Precise and approximate | lib | same run: 2.40, 5.39; approx 1.00, 1.23 µs; 16,667 / 7.8 = 2,100 | ok | 2026-10-16 |
| Sun alone about 4 kB, Sun and Moon under 6 kB, whole library under 7 kB, minified and compressed | Precise and approximate | lib | rolldown --minify, brotli 11: 3.9, 5.6, 6.7 kB (gzip 9: 4.4, 6.3, 7.5 kB); pnpm size | ok | 2026-10-16 |
| Positions do not depend on the browser's time zone | Counting time, code | lib | `fromDate` keeps the instant, offset only for the wall clock | ok | 2026-10-11 |
| Mixing UT and TT: Moon a fiftieth of its width off today, half in the year 1000 | Counting time | derived | 0.55°/h: 0.011° of 0.52°; 0.24° at ΔT 26.2 min | ok | 2026-10-11 |
| Earth closest to the Sun in early January | Earth | lib | perihelion 2026-01-04 | ok | 2026-10-11 |
| Full Moon about 1,900 arcseconds wide | Earth | lib | 1760″ to 2050″, 1798″ on 2026-09-21 | ok | 2026-10-11 |
| Moon rises some 50 minutes later every day, on average | The Moon | derived | 1440 min / (synodic month - 1) = 50.5 min | ok | 2026-10-11 |
| Moon about 14% wider at its closest than at its farthest | The Moon | lib | 0.489° to 0.558° over 19 years, ratio 1.14 | ok | 2026-10-12 |
| Over time we see 59% of the Moon's surface | The Moon | web | libration in longitude and latitude, standard figure | ok | 2026-10-12 |
| A half moon gives about a tenth of the full moon's light | The Moon | web | about 2.5 magnitudes fainter at phase angle 90° (opposition surge, crater shadows) | ok | 2026-10-12 |
| Moon's `sunDirection` within 0.16° of the Sun's from Earth, under a third of the Sun's width | The Moon | lib | 0.157° max over 19 years, Berlin; Sun 0.53° | ok | 2026-10-12 |
| Sunrise example: nothing found in midnight sun or polar night | The Sun, code | derived | no threshold crossing, `sunrise` undefined | ok | 2026-10-11 |
| Analemma's dots crowd at top and bottom: the solstices, Latin for the Sun standing still | The Sun | lib, web | monthly dots closest around June and December; solstitium from sol + sistere | ok | 2026-10-12 |

### Experiments in the captions

| Claim | Figure | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| June solstice: Sun 23.4° above the celestial equator | Armillary sphere | lib | δ 23.44° on 2026-06-21 12:00 UTC | ok | 2026-10-11 |
| Year 1000: ΔT 26 minutes, eclipse 6.5° of longitude off | ΔT | lib, derived | 1571 s; 15°/h × 26.2 min = 6.5° | ok | 2026-10-11 |
| Berlin, sunset June 21: northwest, azimuth 312°, 42° past west | Observer's frame | lib | 19:34 UTC, 312.4°; March 20 271°, December 21 231° | ok | 2026-10-11 |
| Sydney: path through the north, analemma on its head | Sun path | lib | noon azimuth 351° to 1° all year; big loop (January) at 77°, small (July) at 35° | ok | 2026-10-11 |
| Tromsø: Sun up May 18 to July 24, down November 28 to January 14 | Daylight | lib | upper limb at -0.833°, 2026/27 | ok | 2026-10-11 |
| A day and a half after new moon: earthshine at its bluest | Moon | lib | new moon 2026-11-09 07 UTC; 8.9% on Nov 10, 18 UTC | ok | 2026-10-11 |
| Moon almost 2% larger high in the sky than on the horizon | Moon | lib | 1 + sin π at most 1.0179, 2000-2100 | ok | 2026-10-15 |
| Total lunar eclipse 2026-03-03 11:34 UTC, a few weeks before the March equinox | Orbits | lib | phase 0.262, umbral magnitude 1.129; equinox March 20, 14:46 UTC | ok | 2026-10-15 |
| Burgos, August 12, 2026, 18:29 UTC: totality, Sun 8° up | Eclipses | lib | phase 0.153, magnitude 1.012, altitude 8.2° | ok | 2026-10-11 |
| Quito in December: evening crescents on their backs | Moon calendar | lib | bright limb 181° and 178.5° at 19:00 local, Dec 12 and 13 | ok | 2026-10-11 |

### Glossary and table tooltips

| Claim | Entry | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| Vernal equinox wobbles up to about 19″ | Vernal equinox | lib | 18.9″ | fixed | 2026-10-11 |
| Lunations vary up to about seven hours | Lunation, `MEAN_SYNODIC_MONTH` | src | 29.27 to 29.83 days | fixed | 2026-10-11 |
| Bradley published aberration in 1729 | Aberration | web | | fixed | 2026-10-11 |
| Euro coin: 2° at arm's length, 1′ from 80 m, 1″ from almost 5 km | Arcsecond | derived | 23.25 mm coin | ok | 2026-10-11 |
| Umbra about 4,600 km, penumbra 8,200 km at the Moon | Umbra / penumbra | lib | geometric shadow | ok | 2026-10-11 |
| Horizon dip 1° from 1000 m, 2.9° from 8000 m | Horizon dip | lib | 1.02°; 2.87° | ok | 2026-10-11 |
| ΔT about 69 s in 2026 | Delta T | lib | 69.1 s | ok | 2026-10-11 |
| ENU: x east, y north, z up, right-handed; y-up engines take (x, z, -y) | ENU | lib | `horizontalToDirection`, README conventions | ok | 2026-10-11 |
| Ephemeris time: atomic, today TT, ahead of UT by ΔT, about a minute | Ephemeris time | src, lib | iers; ΔT 69.1 s; `julianEphemerisDay` adds it | ok | 2026-10-11 |
| Equation of time 16 min ahead, 14 behind | Local mean time | src | Meeus ch. 28 | fixed | 2026-10-11 |
| Golden hour 6° to -4°, blue hour -4° to -6° | Golden hour, Blue hour | lib | `daylight.ts` thresholds | ok | 2026-10-11 |
| Apogee up to about 406,700 km, perigee down to about 356,400 km, 14% wider | Apogee, Perigee | lib | 356,437 to 406,705 km, 2000-2100; ratio 1.141 | ok | 2026-10-15 |
| L1 and L2 about 1.5 million km from Earth | Lagrange points | derived | (μ/3)^(1/3) AU with μ = 1/328,900: 1.50 million km | ok | 2026-10-15 |
| Sternzeit: sidereal time, kept by the stars; German for Star Trek's stardate. "Since 1799" and "one culmination of a star to the next" (the stellar day, not the sidereal) removed | sternzeit | web | German dub: "Sternzeit" | fixed | 2026-10-11 |

## helldunkel

### Text

| Claim | Where | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| Goethe, § 849 defines Helldunkel, clair-obscur; § 851 separates it from color; § 853 names highest light, middle tint, shadow | opening | web | textlog.de transcription, sense confirmed by merke.ch; wording not checked against a scholarly edition; the English is our translation | open | 2026-10-31 |
| Helldunkel: "das Zusammenspiel von Licht und Schatten", Malerei | glossary | web | Duden | ok | 2026-10-31 |
| Caravaggio and Rembrandt are chiaroscuro painters; clair-obscur and chiaroscuro are the same term | opening | web | de.wikipedia.org/wiki/Chiaroscuro | ok | 2026-10-31 |
| Clair Obscur: Expedition 33 is a game of 2025 | opening | web | en.wikipedia.org | ok | 2026-10-31 |

| sRGB primaries, D65 (0.3127, 0.329), reference white 80 cd/m²; BT.2408 203 cd/m²; Rec. 2020 and P3 primaries; D50 and A coordinates | Color spaces, High dynamic range, figure | web | from memory of the standards, not yet checked against them | open | 2026-10-31 |
| 8-bit sRGB holds 11.7 stops above its first step: log2(255 × 12.92) | High dynamic range, range figure | derived | 11.69 | ok | 2026-10-31 |
| Bloom chain: 13 taps, tent, no threshold | Bloom | src | jimenez2014, from memory, slides not reread | open | 2026-10-31 |

| Eight bits, 256 steps; a dither of one step keeps the mean right; dither after the sRGB curve, not before | Banding and dither | derived | standard practice, not cited beyond jimenez2014 | open | 2026-10-31 |

| White noise clumps; blue noise holds back low frequencies; gradient noise shows a diagonal order | Banding and dither | src, web | ulichney1988 by secondary sources, its text not read; the order seen in the figure | open | 2026-10-31 |

| Bayer 1973 and Jarzynski & Olano 2020: titles and venues | references | web | from memory, not looked up | open | 2026-10-31 |

## rundbild

### Text

| Claim | Where | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| Nine SH terms keep more than 99% of the irradiance for any environment | Lighting a scene | src | Ramamoorthi & Hanrahan 2001: error under 1% for the Lambertian kernel; "any sky" is their bound, not a measurement here | ok | 2026-10-17 |
| Cube map texels within 3√3, about 5.2 (a corner texel a fifth of a center one); cubified within exactly 4/3, a third more; equi-angular within √2, 41% more. At 128 a face: 5.11, 1.31, 1.41 | Lighting a scene, cube.wgsl | derived | Jacobian of each map over a face, pointwise and per texel at 8, 128 and 512 | fixed | 2026-10-22 |
| Equirectangular credited to Marinus of Tyre, around 100 CE | Flattening the sky | web | Esri's projection pages, citing snyder1987; the book's own text not seen | open | 2026-10-22 |
| At about 400 texels the largest texel over the smallest: equirectangular 8.9, fisheye 1.5 (cube 3.8, cubified 1.1, octahedral 4.2); at 1.6 million, octahedral 5.18 = (√3)³, cube 5.18, fisheye 1.57 = π/2 | Flattening the sky | lib, derived | projections figure, Jacobian over 6 by 6 points a texel; equirectangular exact 8.88 | fixed | 2026-10-22 |
| Fisheye texels within a factor of about 1.6 (π/2 in the limit); it leaves a fifth of its square empty | Flattening the sky | derived | 1 - π/4 = 21%; 84 of 400 texels | ok | 2026-10-22 |
| Sphere map: the horizon at sin 45° = 0.71 of the radius, every texel the same solid angle (largest over smallest 1.00 at 1,600 and 6,400 texels) | Flattening the sky | lib, derived | r = sin(zenith angle / 2), Lambert's azimuthal equal-area halved; projections figure | ok | 2026-10-22 |
| Cube face needs W/π to hold an equirectangular of width W: 2π/W against 2/N at the middle of a face | From one to the other | derived | | ok | 2026-10-31 |
| Midnight sun in Tromsø, June 21 22:46 UTC: glow due north, on the equirectangular's seam, at the fisheye's top | Projections caption | lib | screenshot of the figure | ok | 2026-10-22 |

## dunstkreis

### Text

| Claim | Where | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| Bennett: professor of surveying in Sydney (UNSW), Sydney to Hobart navigator | Bent light | src | kelly2019 | ok | 2026-10-11 |
| Bennett 1982 written for navigators on programmable calculators | Bent light | src | bennett1982 abstract | ok | 2026-10-11 |
| Bennett 1982 author is the same George Gordon Bennett | Bent light | web | UNSW, Institute of Navigation fellow; affiliation in the paper not seen | open | 2026-10-11 |
| Blue (440 nm) scattered nearly six times as strongly as red (680 nm): (680/440)⁴ = 5.7 | Why the sky is blue | derived | Rayleigh λ⁻⁴ | ok | 2026-10-17 |
| Rayleigh coefficients 3.3 × 10⁻² and 5.8 × 10⁻³ per km, scale height 8 km, Mie 1.2 km, g 0.8, ozone tent at 25 km | Why the sky is blue | lib | model.ts defaults | ok | 2026-10-17 |
| Horizon dip some 3° from 10 km and 20° from 408 km | From the ground to orbit | derived | acos(Rg / (Rg + h)): 3.2°, 19.8° | ok | 2026-10-17 |
| Table errors: transmittance 0.04% / 0.6%, multiple scattering 1.2% vs 14% at 32 by 32, sky view 128 by 256 vs 192 by 108 four times, 30 steps 0.4% / 5% | Resolution and sampling | lib | packages/dunstkreis/research/README.md | ok | 2026-10-17 |
| Rebuild in a quarter of a millisecond, tables in 0.6 ms, sky pass 0.05 ms at 1080p | opening, What to compute when | lib | research/README.md, review of 2026-10 | ok | 2026-10-17 |
| Bruneton's table 32 by 128 by 32 by 8; Hillaire's tables fit in half a megabyte | Precise and approximate | derived | 57k texels at 8 bytes = 460 kB | ok | 2026-10-17 |
| Hillaire's and Bruneton's skies differ by a few percent, mostly in twilight | Precise and approximate, Taking the sky apart | lib | not measured yet: Bruneton's table is not built | open | 2026-10-17 |
| Bruneton and Neyret at INRIA Grenoble; Hillaire at Epic Games in 2020; Nishita 1993 the first computed Earth through its atmosphere; Edlén at Lund; Ramamoorthi and Hanrahan at Stanford; Kopp and Lean 2011 | The people behind the numbers | src | affiliations on the papers; "first" for Nishita unverified | open | 2026-10-17 |
| Sunlight has crossed some 8 km worth of sea-level air; about a tenth scattered aside overhead | Why the sky is blue | derived | scale height 8 km; Rayleigh depth at 550 nm 0.11 plus Mie 0.004: 11% at the zenith | fixed | 2026-10-17 |
| Potsdam, 1 km, 2026-04-06: sunset 17:57 UTC, so 17:37 is 20 minutes before; at +30 minutes, looking east, Earth's shadow and the Belt of Venus show | Fig. sky, Try | lib | sternzeit sun.direction and apparentDirection at 1 km; rendered in the figure | ok | 2026-10-17 |
| Sun 408 km up over Potsdam, 2026-04-06 02:04 UTC: on the planet's rim, lower limb lifted by about a degree, the disc a sixth as tall as wide | planned refraction figure | lib | refractionAngle at 408 km; rendered | ok | 2026-10-17 |


## gewoelk

### Text

| Claim | Where | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| Nubis³ shipped at 2.2 to 4 ms at 960 by 540 on a PlayStation 5, halved at 60 Hz by a near/far split | Marching | src | Schneider 2023, slides 172 to 180: 2.2, 4.0, 4.0 ms; 4 to 2.1 ms with the split | ok | 2026-11-04 |
| Nubis³'s voxels are 8 m, its modeling data 512 x 512 x 64, its light grid 256 x 256 x 32 | Billows, Light | src | Schneider 2023, slides 79, 86, 126 | ok | 2026-11-04 |
| Nubis³ left evolving clouds and on-the-fly distance fields for the future | From a map | src | Schneider 2023, slide 193 | ok | 2026-11-04 |
| gewoelk's grid 256 x 256 x 32 over 16 km and 2.4 km: voxels some 60 m across | From a map, Billows | lib | 16 km / 256 = 62.5 m, 2.4 km / 32 = 75 m | ok | 2026-11-04 |
| The jump flood finds the nearest surface voxel in eight passes | From a map | lib | jumps 128, 64, ..., 1 for a grid 256 across | ok | 2026-11-04 |
| The profile reaches 1 some 150 m in | From a map | lib | `profileDepthKm` 0.15 | ok | 2026-11-04 |
| Steps 15 m at the first cloud, some 30 m ten kilometers out | Marching | lib | `stepMinKm` 0.015; 0.01 × sqrt(10) = 0.032 km | ok | 2026-11-04 |
| Cirrus 6 to 12 km up, of ice crystals | Two kinds, opening | web | WMO cloud atlas: cirrus in the high étage, 5 to 13 km in temperate latitudes | ok | 2026-11-04 |
| Cumulus flat below at the condensation level | From a map | web | lifting condensation level, standard meteorology | ok | 2026-11-04 |
| Perlin's original noise won an Academy Award twenty years before Improving Noise | People | web | Technical Achievement Award 1997, for work of 1983; "twenty years" is loose, 14 to 19 | open | 2026-11-04 |
| Henyey and Greenstein 1941 described the Milky Way's dust; Hart 1996; Beer 1852 | People | src | titles and venues of the papers | ok | 2026-11-04 |
| Schneider modeled Rio's clouds with fluid simulation | People | src | Schneider 2023, slide 3 | ok | 2026-11-04 |
| Potsdam 2026-06-21 19:36 UTC: Sun 1° below the horizon, cloud undersides at 2 km lit orange from below (Try) | Fig. clouds, Try | lib | sternzeit: −1.08° geometric; sunlight pass at 2.4 km nonzero and red; rendered in the figure | ok | 2026-11-04 |

## nachtgestirn

### Text

| Claim | Where | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| Lambert reflects a slant of 80° at a sixth of face on | Sunlight on dust | derived | cos 80° = 0.174 | ok | 2026-11-04 |
| Lommel-Seeliger at full Moon: a half at the center and at the rim | Sunlight on dust | derived | mu0 / (mu0 + mu) with mu0 = mu | ok | 2026-11-04 |
| Opposition surge a factor 2 at 0, gone by 90° | Sunlight on dust | src, lib | Hapke's B(g, 0.6) as Jensen et al. 2001; `ngRetrodirective` | ok | 2026-11-04 |
| osgHimmel's scattering term makes the quarters a stop too bright | Sunlight on dust | derived | Hapke66's S at 90°: 0.477 against Jensen's 0.418, times the same LS integral: 0.18 vs 0.077 of full, about 1.2 stops | ok | 2026-11-04 |
| Geometric albedo 0.12, Earth's 0.367 | Sunlight on dust, Earthshine, glossary | src | NASA fact sheets | ok | 2026-11-04 |
| Full Moon some 4,900 cd/m² before the air | Sunlight on dust | lib | `meanLuminance(0)` = 4,889 | ok | 2026-11-04 |
| A quarter Moon gives a tenth, by the phase law | Sunlight on dust | src, lib | Cox 2000: 10^(-0.4 (0.026 a + 4e-9 a^4)); `phaseLaw(90)` = 0.091 | ok | 2026-11-04 |
| Phase angle at full Moon stays a few degrees | Sunlight on dust | lib | `moon.phaseAngle` on 2026-11-24 18:00 UTC: 5.2°; 0.3° in the eclipse of 2028-12-31 | ok | 2026-11-04 |
| Mare Crisium on the right with north up, selenographic east | The face we see | web, lib | SVS map centered on 0°, Crisium right of center; `moonOrientation` test puts +90° east on the disc's right; render of 2026-11-24 compared with sternzeit's Moon view | ok | 2026-11-04 |
| LROC WAC mosaic from over 100,000 images, color map remade December 2025 | The face we see, people | web | svs.gsfc.nasa.gov/4720 | ok | 2026-11-04 |
| Maps 4096 and 2048 texels around | The face we see | lib | `scripts/maps.mjs` output | ok | 2026-11-04 |
| Sets of 230 KB, 840 KB and 11.5 MB, enough up to a disc of some 160 and 330 pixels | The face we see | lib | color 41 / 106 / 1,362 KB, heights 190 / 731 / 10,196 KB; `mapWidthFor(163)` = 512, `mapWidthFor(326)` = 1,024 | ok | 2026-11-04 |
| Heights from the altimeter's 64 texels per degree | The face we see | src | svs4720: ldem_64_uint.tif, 23040 x 11520 | ok | 2026-11-04 |
| Moon's B-V 0.92, the Sun's 0.65; the Moon redder than sunlight | The face we see | src | cox2000 (Allen's): Moon B-V 0.92, Sun 0.65; B/V reflectance 10^(-0.4 x 0.27) = 0.78 | ok | 2026-11-04 |
| The color map nearly neutral | The face we see | lib | near side mean linear 0.4125, 0.3924, 0.3828: R/G 1.05, B/G 0.98 | ok | 2026-11-04 |
| Mare Tranquillitatis bluer, titanium-rich | The face we see | src | LROC WAC color; high-Ti basalts are bluer (common knowledge in lunar spectroscopy) | ok | 2026-11-04 |
| Near side mean reflectance 0.396 | Quick start | lib | `scripts/maps.mjs` | ok | 2026-11-04 |
| A full Earth lights the Moon with some 13 lux, a ten thousandth of the Sun | Earthshine | lib | `earthshineIlluminance(0, 384400)` = 12.9 lx; 12.9 / 128,000 = 1.0e-4 | ok | 2026-11-04 |
| About fifty times what a full Moon gives Earth | Earthshine | derived | full Moon 4,889 cd/m² times 0.71 air times 6.5e-5 sr = 0.23 lx; 12.9 / 0.23 = 56 | ok | 2026-11-04 |
| Earth four times wider and three times brighter | Earthshine | src | radii 6,371 / 1,737 = 3.7; albedo 0.367 / 0.12 = 3.1 | ok | 2026-11-04 |
| Night side half a candela per square meter, thirteen stops below | Earthshine | derived | 0.12 / pi times 12.9 = 0.49 cd/m²; 4,889 / 0.49 = 10,000 = 13.3 stops | ok | 2026-11-04 |
| March 21, 2026, 19:30 local, Berlin: a crescent of a tenth 21° up in the west, end of twilight | Earthshine | lib | 18:30 UTC: lit 9.7 %, altitude 21.3°, azimuth 271°, Sun -11.1° | ok | 2026-11-04 |
| Penumbra some 8,200 km wide, umbra 4,600 km in radius | Earth's shadow | lib | sternzeit's glossary; `eclipse.lunar` radii | ok | 2026-11-04 |
| A degree of parallax moves the Moon by 6,700 km | Earth's shadow | derived | 384,400 km times 1° in radians = 6,709 km | ok | 2026-11-04 |
| Umbra some ten thousand times fainter than full | Earth's shadow | lib | the model's 1e-5 at the axis to 3e-4 at the edge, about 1e-4 on average | ok | 2026-11-04 |
| Danjon scale, dust from volcanoes | Earth's shadow | src | Espenak & Meeus 2009, the canon's introduction | ok | 2026-11-04 |
| Earth's center at most a degree from the observer, seen from the Moon | Earthshine | derived | asin(6,371 / 384,400) = 0.95° | ok | 2026-11-04 |
| Lower limb lifted some 6′ more on the horizon, squeezed to four fifths; from orbit to a quarter | Through the air | lib | Bennett: 34.5′ at 0°, 28.7′ at 0.5°; dunstkreis' `refractionAngle` from 1 m: 0.81; from 165 km at -13.58°: 0.236 | ok | 2026-11-04 |
| Full Moon some 0.3 lux above the air, a four hundred thousandth of the Sun | Through the air | lib | `moonIlluminance(0)` = 0.31 lx; 128,000 / 0.31 = 410,000; magnitude -12.74 against -26.74 gives 0.32 | ok | 2026-11-04 |
| Full Moon exposes around 14, looney 11 | Through the air | lib | `ev100ForLuminance(4889)` - 1 = 14.3, 13.8 through 71 % air; f/11 at 1/100 s is EV100 log2(121 · 100) = 13.6 | ok | 2026-11-04 |
| Hapke 1963 and 1966, Jensen et al. 2001, van de Hulst 1980 | People | src | the references | ok | 2026-11-04 |
| A Lambert sphere gives two thirds of a flat disc's light at full, a third of its own full at a quarter | Sunlight on dust | derived | disc integral of mu0 / pi: 2/3 at g = 0; (sin g + (pi - g) cos g) / pi = 1 / pi at 90° | ok | 2026-11-04 |
| Hapke's law within a quarter of a stop of Allen's law from full to a thin crescent | Sunlight on dust, Fig. laws | lib | disc integral of `ngHapke` against `phaseLaw`: 0.01 at 5°, 0.13 at 60°, 0.24 at 90°, 0.21 at 120°, 0.20 at 150°, 0.43 at 170° | ok | 2026-11-04 |
| Lambert's half Moon more than twice too bright | Sunlight on dust | derived | Lambert 2.24 stops below full against 3.46 measured: 2.3 times | ok | 2026-11-04 |
| Oren-Nayar's half Moon nearly twice too bright | Sunlight on dust | lib | disc integral of `ngOrenNayar` (lobes.ts `discLight`) against `phaseLaw` at 90°: +0.87 stops, 1.8 times | ok | 2026-11-09 |
| Hapke 2012 model: two-lobed phase function, multiple scattering, roughness of some 24° | Sunlight on dust | src | Hapke 2012 book; Hapke 1984 (roughness); Sato 2014 fixed theta 23.657° (PDS WAC_HAPKEPARAMMAP readme) | ok | 2026-11-09 |
| Sato et al. fitted some 66,000 WAC images, tile by tile | Sunlight on dust | src | PDS readme: ~66,000 WAC observations, 1° tiles | ok | 2026-11-09 |
| Near side medians at 566 nm: w 0.3231, b 0.2366, c 0.3344, BS0 1.75, hS 0.05309; Bc0 0, phi 1 fixed | surface.wgsl, lobes.ts | src | WAC_HAPKEPARAMMAP_7BAND.IMG, band 4, |lon| < 90°, median | ok | 2026-11-09 |
| Hapke 2012 renders no slower than 1963 | Sunlight on dust | lib | Dawn, 2048 px plain disc, interleaved medians of 56: 1 ray 1.729 vs 1.729 ms, 4 rays 6.552 vs 6.596 ms | ok | 2026-11-09 |
| Hapke 2012 against Allen: a quarter to half a stop under from 10° to 120°, a stop under by 150° | Sunlight on dust, Fig. phases | lib | `discLight` (matches the shader: GPU test, quarter 0.76 to 0.86 of Allen): -0.46 at 10°, -0.47 at 30°, -0.40 at 60°, -0.31 at 90°, -0.28 at 120°, -1.06 at 150° | ok | 2026-11-09 |
| Allen's law has no steep peak at opposition | Sunlight on dust | derived | 10^(-0.4 (0.026 a + 4e-9 a^4)): linear in magnitude near 0 | ok | 2026-11-09 |
| First quarter: Hapke 1963 bright to the terminator, Hapke 2012 fades into it | Fig. laws, Try | lib | rendered November 17, 2026, 12:00 UTC, phase angle 89.7° | ok | 2026-11-09 |
| ROLO: over a thousand observations fitted to a percent, phase angles 1.55° to 97° | Sunlight on dust | src | Kieffer & Stone 2005 abstract (USGS conference version: over 1000 observations per wavelength, mean residual under 1%); validity range as in the ESO sky model and astrogo implementations | ok | 2026-11-09 |
| ROLO coefficients at 553.8 nm | measured.ts | src | ESO SkyCalc moonalbedo.dat (sdss/lvmsky) and TuSKan/astrogo rolo.go agree | ok | 2026-11-09 |
| ROLO's quarter Moon a fifteenth of full | Sunlight on dust | lib | `rolo(90)` = 2^-3.93 = 0.066 | ok | 2026-11-09 |
| Against ROLO: Lambert's half Moon three times too bright, Oren-Nayar's two and a half, Hapke 1963 a quarter to two fifths of a stop over, Hapke 2012 within a fifth of a stop to 97° | Sunlight on dust | lib | `discLight` / `rolo` at 90°: +1.69, +1.34, +0.23, +0.16; Hapke 1963 +0.17 to +0.42 over 1.55° to 97°; Hapke 2012 0.00 to +0.18 | ok | 2026-11-09 |
| First quarter, November 17, 2026: Hapke 2012 a sixth of a stop over ROLO, 1963 a quarter, Lambert more than one and a half | Fig. phases, Try | lib | phase angle 89.7°: +0.15, +0.23, +1.69 | ok | 2026-11-09 |
| Coherent backscatter added by Hapke in 2002 | Sunlight on dust | src | Hapke 2002, Icarus 157, 523-534; crossref | ok | 2026-11-09 |
| Ciechanowski's Moon: soil sphere flattening, grains hiding shadows, two grains in step | Sunlight on dust | web | ciechanow.ski/moon/#lunar-brightness | ok | 2026-11-09 |
| Danjon's limit: the eye loses the crescent within some 7° of the Sun, phase angle 173°; Danjon blamed the relief, later work the twilight's glare | Sunlight on dust | src | Schaefer 1991 QJRAS 32, 265 (ADS abstract); the-moon.us Danjon Limit; Fatoohi et al. 1998 revise to 7.5° | ok | 2026-11-10 |
| Hapke 2012 a stop under Allen by 150°, through −14 stops by 168°; Allen's law never reaches zero | Sunlight on dust | lib | `discLight` with 48 and 400 samples alike: −8.92 vs Allen −7.87 at 150°, −13.87 at 168°, −14.89 at 170°; Allen −11.5 at 178° | ok | 2026-11-10 |
| First quarter, November 17, 2026: Hapke within a quarter stop, Lambert more than a stop over | Fig. phases, Try | lib | `discLight` against `phaseLaw` at 90°: Hapke -0.24, Lambert +1.22 | ok | 2026-11-09 |
| Perigee 33.5′ against apogee 29.4′, 14% wider; a third more light | Near and far | lib | 2 asin(1737.1 / 356,500) and / 406,700; (406,700 / 356,500)^2 = 1.30 | ok | 2026-11-04 |
| Overhead an Earth radius nearer, almost 2% wider; the rising Moon 1.7% smaller | Near and far, glossary | derived | 6,371 / 384,400 = 1.66%; sternzeit's caption says the same | ok | 2026-11-04 |
| Over a night the face turns by up to a degree, which sternzeit does not follow | The face we see | derived | diurnal libration: asin(6,371 / 384,400) = 0.95°; `moon.librations` is geocentric | ok | 2026-11-04 |
| The umbra twelve to seventeen stops below the sunlight | Earth's shadow | lib | the model's 1e-5 at the axis = -16.6 stops, 3.2e-4 at the edge = -11.6 | ok | 2026-11-04 |
| Everything on, a disc up to four times as long, under a millisecond, 134 MB where 2 do; defaults off on 1 or 2 in 100 pixels, mostly rims along the terminator a pixel off without displacement | Cheap and full, Figure (budget) | lib | Chromium 153, Vulkan, RX 7900 XT, 1920x1080, gibbous, medians of 101 frames, two runs within 3%; defaults vs large maps with shadowsFrom, displacementFrom, softShadowsFrom 0: 64 px 0.049 vs 0.093 ms, 2.1 vs 134.3 MB; 127: 0.050 vs 0.136; 256: 0.061 vs 0.255, 8.9 vs 134.7 MB; 1023: 0.213 vs 0.897; 4095: 1.06 vs 1.06 (remeasured after the shader review). Pixels over 1/3 stop off, linear, coverage > 0.5, floor 1% of the 95th percentile: 1.59, 1.52, 1.19, 1.53, 0.21%; displacement alone brings 64 px to 0.34%, 1023 to 0.08%; error maps show rim pairs along the terminator and the limb | ok | 2026-11-11 |
| compress: BC1 color map an eighth of its memory, 39 MB less for the large maps, a hundredth of a stop off; no time, no pixel a third of a stop off | Cheap and full, Figure (budget) | lib | same setup, loadMoonMaps compress: color 44.74 to 5.59 MB (large), 0.70 to 0.087 (small), 2.80 to 0.35 (medium); frame times within noise (0.897 vs 0.881 ms at 1023); everything on with BC1 vs without: mean 0.008 to 0.014 stops, p99 0.05 to 0.07, none over 1/3; OKLab x100 mean 0.22 to 0.33, p99 1.1 to 1.4 | ok | 2026-11-11 |
| Ciechanowski's Moon, December 17, 2024 | Opening, references | web | ciechanow.ski/archives | ok | 2026-11-04 |

### Experiments in the captions

| Claim | Where | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| New Year's Eve 2028, 17:00 UTC, Berlin: total eclipse, the Moon 16° up in the east-northeast, two hours after sunset | Moon figure | lib | umbral magnitude 1.21, altitude 15.9°, azimuth 73°; Sun -0.6° at 15:00 UTC, -16.7° at 17:00 | ok | 2026-11-04 |
| An hour and a half back, the shadow's edge crosses the disc | Moon figure | lib | 15:30 UTC: umbral magnitude 0.33, the Moon 4.0° up | ok | 2026-11-04 |
| First quarter, November 17, 2026, 12:00 UTC: Lambert a third of its full, Hapke a tenth | Fig. laws, Try | lib | phase angle 89.7°, lit 0.502; curves -2.2 (Lambert, -1.7 of its own full) and -3.7 stops | ok | 2026-11-04 |
| The supermoon of November 25, 2034, 22:00 UTC: a full Moon within hours of a close perigee | Fig. near-far, Try | lib | `moon.distance` 356,448 km, phase angle 4.8° | ok | 2026-11-04 |
| New Year's Eve 2028, 17:00 UTC: the Moon's center halfway in from the umbra's edge; in the umbra 16:09 to 19:35 local | Fig. eclipse-row, Try | lib | axis offset 2,135 km of 4,601; the figure's bisection on `umbralMagnitude` | ok | 2026-11-04 |
| Mare Orientale: "Eastern Sea", on the western limb since the IAU's 1961 switch to the astronauts' east and west | The Eastern Sea | web | en.wikipedia.org/wiki/Mare_Orientale; Gazetteer origin "Eastern sea." | ok | 2026-11-10 |
| Youngest of the great basins, younger than Imbrium's 3.85 billion years | The Eastern Sea | web | en.wikipedia.org/wiki/Mare_Orientale (not dated directly; younger than Imbrium, ~3.85 Ga) | ok | 2026-11-10 |
| Three rings, the outer Montes Cordillera some 960 km across, the mare a third as wide | The Eastern Sea | src | Gazetteer: Montes Cordillera 963.5 km, Mare Orientale 294.2 km; Wikipedia gives 930 km for the ring | ok | 2026-11-10 |

## sternenheer

### Text

| Claim | Where | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| Some two thousand stars seen at once, a magnitude 0 star 2.6 millionths of a lux, the faintest a four hundredth | Opening | lib, derived | `illuminanceFromMagnitude(0)` = 2.58e-6 lx from the Sun's 128,000 lux at -26.74; 10^(-0.4 · 6.5) = 1/398; half of the 8,403 naked-eye stars are above the horizon | ok | 2026-11-04 |
| Sirius -1.46, the Sun -26.74, Sirius ten millionths of a lux, 6.5 six billionths | Nine thousand stars | lib, src | catalog; Cox 2000; 9.9e-6 lx, 6.5e-9 lx | ok | 2026-11-04 |
| 9,093 stars to magnitude 7.1, 8,403 within 6.5, 291 KB, together magnitude -5.0, Venus at its brightest | Nine thousand stars | lib, src | `data/brightstars.bin` 290,976 bytes; faintest row 7.1; sum of fluxes 96 magnitude-0 stars = -4.96; Venus at most -4.9 | ok | 2026-11-04 |
| In a view of the whole sky Sirius peaks at a fraction of a cd/m², a thousand times the night sky | Points of light | derived | 0.8 px at 180° over 900 px is 2.8e-3 rad: 9.9e-6 lx / (2π (2.8e-3)²) = 0.2 cd/m², at 120° 0.45; a dark sky 2.75e-4 cd/m², 700 to 1,600 times | ok | 2026-11-04 |
| Sirius' veil a degree wide | Points of light | derived | CIE: 10 E / θ² = 1e-4 cd/m² at 1°, a third of the dark sky | ok | 2026-11-04 |
| Precession some 50 arcseconds a year; Vega 11 arcminutes from its catalog place, a third of the Moon's width | The sky turning | src, lib | Meeus ch. 21; `stars.apparentPosition` of Vega on 2026-08-12: 10.7′ | ok | 2026-11-04 |
| Groombridge 1830 the fastest in the catalog, a Moon's width in 260 years | The sky turning | lib, derived | largest proper motion in the CSV 7.06″/yr at RA 11h53m, dec +37.7°, mag 6.45; 31′ / 7.06″ = 263 years | ok | 2026-11-04 |
| A degree a day, four minutes earlier each night | The sky turning | src | the sidereal day, Meeus ch. 12 | ok | 2026-11-04 |
| Ballesteros: Vega 10,100 K, the Sun 5,800 K, Betelgeuse 3,300 K; Jensen: 12,500 and 2,900 | Colors, Precise and approximate | lib | `temperatureFromColorIndex(0)` = 10,125, (0.65) = 5,778, (1.85) = 3,333; approx 12,500, 2,905 | ok | 2026-11-04 |
| Refraction on the horizon some 35 arcminutes, a star truly on the horizon half a degree up | Through the air | lib | dunstkreis' `refractionAngle` from 1 m: 0.623° at 0°; `liftedDirection` of a star at 0°: 30.2′ | ok | 2026-11-04 |
| Zenith 87% green, 77% blue; 5° a quarter and a sixteenth; horizon under one percent | Through the air | lib | `airTransmittance`: 90°: 0.905, 0.868, 0.770; 5°: 0.397, 0.239, 0.063; 0°: 0.038, 0.006, 0.000 | ok | 2026-11-04 |
| Twinkling a fifth at the zenith, doubling by 30° and saturating | Through the air | lib, src | `scintillationIndex(90)` = 0.18, (30) = 0.6 the cap; Young's 0.09 D^(-2/3) X^1.75 (2Δt)^(-1/2), Dravins et al. 1998 | ok | 2026-11-04 |
| Stars fainter than the eleventh magnitude, 1.7 billion | The Milky Way | src | svs4851: Tycho-2 to 11.5, Gaia DR2 1.7 billion stars | ok | 2026-11-04 |
| 23.2 mag/arcsec² at the zenith of 40° N, a fifth of the natural sky | The Milky Way | src, derived | Masana et al. 2021 table 4: 75 nW/m²/sr, 21.7%; -2.5 log10(75e-9 / 143.1685) = 23.20 | ok | 2026-11-04 |
| Galactic center 21.0 mag/arcsec², the poles 25.5, a dark sky 21.5 | The Milky Way | lib | map texel 0.256 and 0.004 times 1.756e-3 cd/m²; `surfaceBrightnessFromLuminance` | ok | 2026-11-04 |
| Approximate precession within an arcsecond of Meeus' over this century | Precise and approximate | lib | sternzeit's `stars.spec.ts` | ok | 2026-11-04 |
| Hoffleit and Warren 1991, Dravins et al. three papers in the nineties | People | src | the references; Dravins et al. 1997a, 1997b, 1998 | ok | 2026-11-04 |

### Experiments in the captions

| Claim | Against | Result | Status | Checked |
|---|---|---|---|---|
| August 12, 2026, 22:00 UTC, Berlin: the Milky Way from Cygnus overhead to Sagittarius on the south-southwestern horizon, no Moon | lib | galactic center 2.1° up at azimuth 213°; Sun -21°; Moon 0% lit, -21.5° | ok | 2026-11-04 |
