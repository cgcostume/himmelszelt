# Data

## Tables

- `nutation.json`: the 63 terms of the IAU 1980 nutation, Meeus table 22.A.
- `moon.json`: the Moon's periodic terms for longitude, distance and latitude, Meeus tables 47.A and 47.B.
- `deltat.json`: the observed ΔT on January 1 of each year since 1962, from the IERS. Regenerate with
  `pnpm generate:deltat`, e.g. once a year.

Each table names its source and columns. All three are cross-checked in `tests/astronomia.spec.ts`.
