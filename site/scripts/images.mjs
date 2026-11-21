// Makes the site's two photographs for the web from their originals in src/data: the corona, gray, 1024 pixels square,
// and the sunrise from the ISS, 1536 wide, with Gaussian noise of two 8-bit levels added before it is rounded to 8 bits,
// so its smooth gradients do not band. Rerunnable: `pnpm images`. Needs sharp.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SITE = fileURLToPath(new URL("../", import.meta.url));
// The noise's standard deviation in 16-bit levels, as ImageMagick's `-attenuate 0.1 +noise Gaussian` measured.
const NOISE = 512;

/**
 * An 8-bit original resized to fit `size` square in 16 bits, as ImageMagick did, and given back in 16 bits: its 8 bits
 * widened by 257 here, as sharp's own steps between 8 and 16 bits are not exact.
 */
async function resized(file, size, kernel) {
    const { data, info } = await sharp(join(SITE, "src/data", file), { ignoreIcc: true })
        .raw()
        .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const scale = Math.min(size / width, size / height);
    const [toWidth, toHeight] = [Math.round(width * scale), Math.round(height * scale)];
    const wide = await sharp(
        Uint16Array.from(data, (v) => v * 257),
        { raw: { width, height, channels } },
    )
        .resize(toWidth, toHeight, { fit: "fill", kernel })
        .toColourspace(channels === 1 ? "grey16" : "rgb16")
        .raw({ depth: "ushort" })
        .toBuffer();
    return {
        samples: new Uint16Array(wide.buffer, wide.byteOffset, wide.length / 2),
        info: { width: toWidth, height: toHeight, channels },
    };
}
const webp = (bytes, { width, height, channels }) => sharp(bytes, { raw: { width, height, channels } });

// The corona's PNG has a palette, which ImageMagick resized with its Mitchell filter, not Lanczos.
const corona = await resized("corona-2023-04-20-exmouth-phil-hart.png", 1024, "mitchell");
await webp(
    Uint8Array.from(corona.samples, (v) => Math.round(v / 257)),
    corona.info,
)
    .webp({ quality: 80, effort: 6 })
    .toFile(join(SITE, "public/images/corona-2023-04-20-exmouth.webp"));

const sunrise = await resized("sunrise-2015-07-30-iss044e025484-scott-kelly.jpg", 1536, "lanczos3");
// A fixed seed, so every run writes the same file: mulberry32, and Box-Muller pairs.
let seed = 0x5eed;
const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const { samples } = sunrise;
const bytes = new Uint8Array(samples.length);
for (let i = 0; i < samples.length; i += 2) {
    const [radius, angle] = [Math.sqrt(-2 * Math.log(1 - random())), 2 * Math.PI * random()];
    const noise = [Math.cos(angle), Math.sin(angle)];
    for (let k = 0; k < 2 && i + k < samples.length; k++)
        bytes[i + k] = Math.min(255, Math.max(0, Math.round((samples[i + k] + NOISE * radius * noise[k]) / 257)));
}
// The preset "icon" turns off spatial noise shaping and the loop filter, which would smooth the noise away.
await webp(bytes, sunrise.info)
    .webp({ quality: 90, effort: 6, preset: "icon" })
    .toFile(join(SITE, "public/images/sunrise-2015-07-30-iss.webp"));
console.log("wrote corona-2023-04-20-exmouth.webp and sunrise-2015-07-30-iss.webp");
