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
| 20 arcseconds about a sixth of a pixel, full HD over 60° | Earth | derived | 0.18 px | ok | 2026-10-11 |
| Horizon dips more than 3° at 10 km | Earth | lib | 3.21°, geometric | ok | 2026-10-11 |
| Parallax: Sun 8.8″, Moon up to a degree, two diameters | Coordinates | lib | 8.76″; 0.90° to 1.02° | ok | 2026-10-11 |
| Refraction at the horizon more than the Sun's diameter | Coordinates | lib | 34.5′ from apparent 0°, Sun 32′ | ok | 2026-10-11 |
| Celestial pole as high as the latitude | Coordinates | src | Meeus ch. 13 | ok | 2026-10-11 |
| Light from the Sun 8 min 20 s, sky turns 2° meanwhile | The Sun | derived | 499 s; 2.08° | ok | 2026-10-11 |
| Aberration 20.5″, under a ninetieth of the Sun's disc | The Sun | src, derived | Meeus 25; 1/94 | ok | 2026-10-11 |
| Moon's light 1.3 s, Moon moves 0.7″ meanwhile | The Sun | derived | 1.28 s; 0.70″ | ok | 2026-10-11 |
| Moon moves about 13° a day against the stars | The Sun | src | 13.18° | ok | 2026-10-11 |
| Equation of time: 16 min ahead in November, 14 behind in February | The Sun | src | Meeus ch. 28 | ok | 2026-10-11 |
| Eccentricity about 0.0167; 3% closer, 3% larger in January | The Sun | lib | 0.01670; 3.4% | ok | 2026-10-11 |
| Golden hour example finds sunrise before sunset anywhere | The Sun, code | lib | Los Angeles, Tokyo, Berlin | fixed | 2026-10-11 |
| Moon's orbit tilted about 5°, Sun pulls about twice as hard as Earth | The Moon | src | 5.14°; 2.2 times | ok | 2026-10-11 |
| Libration: a few degrees optical, hundredths physical | The Moon | lib | 8.1° and 6.9° max | ok | 2026-10-11 |
| Lit fraction is only a first measure of moonlight | The Moon | src | opposition surge | fixed | 2026-10-11 |
| Crescent lit from above implies daylight | The Moon | derived | elongation under 90° | ok | 2026-10-11 |
| `moon.brightLimbAngle` is the tilt in the observer's sky | The Moon, code | lib | chi minus q, topocentric | fixed | 2026-10-11 |
| Sun 400 times wider and 400 times farther | Eclipses | lib | 401; 389 | ok | 2026-10-11 |
| Moon recedes 3.8 cm a year | Eclipses | src | Dickey et al. 1994 | ok | 2026-10-11 |
| Last total solar eclipse in some 600 million years | Eclipses | derived | 609 million at 3.8 cm a year | ok | 2026-10-11 |
| Eclipse phase: 0.5 and 1 for the Moon at its center on the shadow edges | Eclipses | lib | `eclipse.ts` | fixed | 2026-10-11 |
| Every solar eclipse has a lunar one two weeks before or after | Eclipses | derived | limits 18.5° and about 17° | ok | 2026-10-11 |
| Total solar eclipse August 12, 2026; partial lunar August 28 | Eclipses | lib, web | umbral magnitude 0.91 | ok | 2026-10-11 |
| Next total lunar eclipse from late 2026: 2028-12-31, 16:18 UTC | Eclipses, code | lib | 16:18:49 UTC | ok | 2026-10-11 |
| True full moon up to 14 hours from the mean one | Eclipses, code | lib | 0.58 days | fixed | 2026-10-11 |
| Approximate Sun within 0.002°, Moon almost a tenth | Precise and approximate | lib | 0.0013°; 0.091° (Berlin, 2026) | ok | 2026-10-11 |
| Meeus: meteorologist at Brussels Airport until 1993, amateur astronomer | People | src | rasc2003, rasc2213 | ok | 2026-10-11 |
| Asteroid 2213 Meeus named for him | People | src | rasc2213 | ok | 2026-10-11 |
| Sæmundsson computed the University of Iceland's almanac for sixty years | People | src | helgadottir2023 | fixed | 2026-10-11 |
| Jensen et al.: Moon, stars, zodiacal light, airglow, with the atmosphere | People | src | jensen2001 abstract (measured data, not pure physics) | fixed | 2026-10-11 |
| van de Hulst predicted the 21 cm line in 1944 as a student; spin flip; found 1951; maps the Milky Way | People | src | hovenier2001 | ok | 2026-10-11 |
| van de Hulst's book gives the sphere's phase law behind `moon.earthshine` | People | lib | `moon.ts` comment, osgHimmel; book not seen | open | 2026-10-11 |
| Espenak: NASA Goddard until 2009, Mr. Eclipse, canons with Meeus | People | src | anderson2025 | ok | 2026-10-11 |

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
| Equation of time 16 min ahead, 14 behind | Local mean time | src | Meeus ch. 28 | fixed | 2026-10-11 |
| Golden hour 6° to -4°, blue hour -4° to -6° | Golden hour, Blue hour | lib | `daylight.ts` thresholds | ok | 2026-10-11 |
| Sternzeit: sidereal time, kept by the stars; German for Star Trek's stardate. "Since 1799" and "one culmination of a star to the next" (the stellar day, not the sidereal) removed | sternzeit | web | German dub: "Sternzeit" | fixed | 2026-10-11 |

## dunstkreis

### Text

| Claim | Where | Against | Result | Status | Checked |
|---|---|---|---|---|---|
| Bennett: professor of surveying in Sydney (UNSW), Sydney to Hobart navigator | Bent light | src | kelly2019 | ok | 2026-10-11 |
| Bennett 1982 written for navigators on programmable calculators | Bent light | src | bennett1982 abstract | ok | 2026-10-11 |
| Bennett 1982 author is the same George Gordon Bennett | Bent light | web | UNSW, Institute of Navigation fellow; affiliation in the paper not seen | open | 2026-10-11 |
