import { luminanceOf, rgbOfSpectrum, solarIrradianceAt } from "@himmelszelt/dunstkreis";

/** The wavelengths the rainbow figures draw a ray or an arc in, in nm, red first. */
export const WAVELENGTHS = [660, 605, 550, 500, 450] as const;

/** A linear value as an sRGB byte, clipped at white. */
export const encode = (c: number) =>
    Math.round(255 * Math.min(1, c <= 0.0031308 ? 12.92 * Math.max(c, 0) : 1.055 * c ** (1 / 2.4) - 0.055));

const colors = new Map<number, string>();

/** A wavelength's own hue as a CSS color: drawn towards gray until a screen shows it, then as bright as it goes. */
export function wavelengthColor(nm: number): string {
    let color = colors.get(nm);
    if (!color) {
        const rgb = rgbOfSpectrum((wavelength) => (wavelength === nm ? 1 / solarIrradianceAt(wavelength) : 0));
        const gray = luminanceOf(rgb);
        const low = Math.min(...rgb);
        const kept = low < 0 ? gray / (gray - low) : 1;
        const shown = rgb.map((c) => Math.max(0, gray + kept * (c - gray)));
        const top = Math.max(...shown);
        color = `rgb(${shown.map((c) => encode(c / top)).join(" ")})`;
        colors.set(nm, color);
    }
    return color;
}
