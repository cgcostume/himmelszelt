import { phaseLaw } from "@himmelszelt/nachtgestirn";

// The ROLO model of the Moon's disk-equivalent reflectance (Kieffer & Stone 2005) at 553.8 nm, its polynomial in the phase
// angle in radians, its exponentials and cosine in degrees; the terms odd in the Sun's selenographic longitude, which part
// waxing from waning, cancel in the mean of the two, and the libration's are left out.
const A = [-2.12504, -1.6597, 0.38409, -0.20655];
const D = [0.37206, -0.10745, 0.00347];
const P = [4.06054, 12.8802, -30.5858, 16.7498];
/** The phase angles in degrees ROLO was fitted over. */
export const ROLO_RANGE = [1.55, 97] as const;
function lnReflectance(deg: number) {
    const g = (deg * Math.PI) / 180;
    const polynomial = (A[0] ?? 0) + g * ((A[1] ?? 0) + g * ((A[2] ?? 0) + g * (A[3] ?? 0)));
    const [p1, p2, p3, p4] = P as [number, number, number, number];
    return (
        polynomial +
        (D[0] ?? 0) * Math.exp(-deg / p1) +
        (D[1] ?? 0) * Math.exp(-deg / p2) +
        (D[2] ?? 0) * Math.cos((deg - p3) / p4)
    );
}
const AT_ZERO = lnReflectance(0);
/** The Moon's light at a phase angle in degrees over its light at 0, by ROLO, the mean of waxing and waning. */
export const rolo = (deg: number) => Math.exp(lnReflectance(deg) - AT_ZERO);
/** Whether ROLO holds at a phase angle in degrees: fitted from 1.55°, and carried on to 0, the last degree and a half. */
export const roloHolds = (deg: number) => deg <= ROLO_RANGE[1];
/** The measured Moon at a phase angle in degrees, relative to full: ROLO up to 97°, Allen's law beyond. */
export const measured = (deg: number) => (roloHolds(deg) ? rolo(deg) : phaseLaw(deg));
