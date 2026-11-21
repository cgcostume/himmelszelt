#!/usr/bin/env node
// Dev script: writes src/data/deltat.json, the observed ΔT on January 1 of each year since 1962, from the IERS:
// ΔT = 32.184 s + (TAI - UTC) - (UT1 - UTC). Run via `pnpm data:deltat`, e.g. once a year.

import { writeFileSync } from "node:fs";

const SOURCE = "IERS EOP C04 (UT1 - UTC) and USNO tai-utc.dat: ΔT = 32.184 s + (TAI - UTC) - (UT1 - UTC), in seconds";
const text = async (url) => (await fetch(url)).text();

// UT1 - UTC, daily, from the Paris Observatory. Columns: year, month, day, hour, MJD, x, y, UT1 - UTC.
const c04 = await text("https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now");
// TAI - UTC, with the drifting rates of the rubber seconds before 1972. Lines like
// " 1968 FEB  1 =JD 2439887.5  TAI-UTC=   4.2131700 S + (MJD - 39126.) X 0.002592 S".
const taiUtc = [
    ...(await text("https://maia.usno.navy.mil/ser7/tai-utc.dat")).matchAll(
        /=JD\s+([\d.]+)\s+TAI-UTC=\s+([\d.]+)\s*S \+ \(MJD - ([\d.]+)\) X ([\d.]+)/g,
    ),
].map(([, jd, offset, mjd0, rate]) => ({ mjd: jd - 2400000.5, offset: +offset, mjd0: +mjd0, rate: +rate }));

const deltaT = [];
for (const line of c04.split("\n")) {
    const [year, month, day, , mjd, , , ut1] = line.trim().split(/\s+/).map(Number);
    if (line.startsWith("#") || month !== 1 || day !== 1) continue;
    const step = taiUtc.findLast((s) => s.mjd <= mjd);
    deltaT.push(Math.round((32.184 + step.offset + (mjd - step.mjd0) * step.rate - ut1) * 100) / 100);
    if (year !== 1962 + deltaT.length - 1) throw new Error(`missing a year before ${year}`);
}

// Ten years to a line, two decimals each, so the columns line up.
const decades = Array.from({ length: Math.ceil(deltaT.length / 10) }, (_, i) => deltaT.slice(10 * i, 10 * i + 10));
const values = decades.map((decade) => `        ${decade.map((v) => v.toFixed(2)).join(", ")}`).join(",\n");
const json = `{\n    "source": ${JSON.stringify(SOURCE)},\n    "firstYear": 1962,\n    "deltaT": [\n${values}\n    ]\n}\n`;
writeFileSync(new URL("../src/data/deltat.json", import.meta.url), json);
console.log(`ΔT for January 1, 1962 to ${1962 + deltaT.length - 1}, last ${deltaT.at(-1)} s`);
