// Shared by the tables (tables.ts) and the controls (controls.ts).

// Degrees/minutes/seconds, the conventional astronomical notation. Every field is fixed-width (sign always
// present, degrees padded to 3 digits, minutes/seconds zero-padded) so the whole string is constant-width,
// which is what lets the deg column stay right-aligned like every other value column.
export function formatDMS(n: number) {
    const sign = n < 0 ? "-" : " ";
    const abs = Math.abs(n);
    const d = Math.floor(abs);
    const minFloat = (abs - d) * 60;
    const m = Math.floor(minFloat);
    const s = (minFloat - m) * 60;
    return `${sign}${String(d).padStart(3, " ")}° ${String(m).padStart(2, "0")}′ ${s.toFixed(2).padStart(5, "0")}″`;
}
