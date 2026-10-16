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

## dunstkreis

### Text

| Claim | Where | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| Bennett: professor of surveying in Sydney (UNSW), Sydney to Hobart navigator | Bent light | src | kelly2019 | ok | 2026-10-11 |
| Bennett 1982 written for navigators on programmable calculators | Bent light | src | bennett1982 abstract | ok | 2026-10-11 |
| Bennett 1982 author is the same George Gordon Bennett | Bent light | web | UNSW, Institute of Navigation fellow; affiliation in the paper not seen | open | 2026-10-11 |
