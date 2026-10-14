// The sky as a cube map, and what a user's own shader needs to show it: the cube lookup, the Sun's disc, a tone curve.
import { createSkyPass, precomputeAtmosphere, wgsl } from "../dist/index.js";

export async function skyCube(device) {
    const luts = await precomputeAtmosphere(device);
    const sky = await createSkyPass(device, { luts, format: "rgba16float" });
    return sky.createCubePass({ format: "rgba16float" });
}
export const display = [wgsl.cube, wgsl.sun, wgsl.tonemap].join("\n");
