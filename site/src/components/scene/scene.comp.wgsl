// A small scene lit by an environment, to see how a sky lights things: a cube map in cd/m² for the background, nine
// spherical harmonics coefficients of it for the light from every direction, and the sun as a light of its own.
// Raytraced in a compute pass: the five Platonic solids on a pentagon around a sphere, over a round ground or over the
// backdrop's own ground, exact rather than triangulated. Each polyhedron is the intersection of the half-spaces behind
// its faces, the sphere is a sphere. The sun casts shadows, soft when its disc is sampled; the sky's light is dimmed by ambient occlusion from a few rays.
//
// Four camera rays per pixel, on the rotated grid of 4x multisampling, each with its shadow and occlusion rays turned
// its own way. One frame per change, nothing summed over time. The golden sets, `goldenSet8` and `goldenSet64`, are
// prepended by scene.js.
//
// Directions are ENU, z up, like the cube map's.

struct Params {
    eye: vec3f,
    tanHalfFov: f32,
    forward: vec3f,
    aspect: f32,
    right: vec3f,
    // What luminance in cd/m² is multiplied by, 1 / (1.2 * 2^EV100).
    exposure: f32,
    up: vec3f,
    sunAngularRadius: f32,
    // Towards the sun as it shows, refracted.
    sunDirection: vec3f,
    // Nonzero to draw the sun disc in the background.
    sunDisc: u32,
    // The sunlight reaching the scene, per channel in lux.
    sunIlluminance: vec3f,
    // Ambient occlusion rays per pixel, 0 for none.
    occlusionRays: u32,
    // Each polyhedron's orientation, object to world.
    rotations: array<mat3x3f, 5>,
    // Where each solid is, the polyhedra on their orbits and the sphere in their middle; w unused.
    centers: array<vec4f, 6>,
    // Shadow rays per point over the sun disc, 8 or 64, soft; 0 for none; otherwise one to its center, hard.
    shadowRays: u32,
    // Nonzero to show `background` behind the solids rather than the sky map.
    background: u32,
    // Radius of the round ground, in scene units: it fades out over its outer half into what lies behind it.
    groundRadius: f32,
    // Which lights shine on the scene: 1 the sun directly, 2 the sky by its coefficients.
    lights: u32,
    // The ground: 0 a round floor of the scene's own, 1 the backdrop's ground with the solids' shadows taken out of it.
    ground: u32,
    // How strong the sun's veil is, 0 for none to 1 for full: light ones are fainter and narrower.
    bloom: f32,
    // Samples along each camera ray through the haze for god rays, 0 for none.
    godRaySamples: u32,
    // The air's density around the camera relative to the ground's, and the haze's: the veil and the god rays thin out
    // with height and are gone in space.
    airDensity: f32,
    hazeDensity: f32,
    // Nonzero when the sky map is cubified, sampled through dkCubeFromSphere from dunstkreis' cube.wgsl.
    cubified: u32,
    // Nonzero to dither the 8-bit output against banding.
    dither: u32,
    // The tone curve, from dunstkreis' tonemap.wgsl: 1 Khronos PBR Neutral, 2 AgX, 3 Narkowicz's ACES fit, 4 none, cut off.
    toneCurve: u32,
    // The sun as the camera sees it, which may be far above the scene's ground: where its disc shows, and its
    // illuminance there, per channel in lux.
    discDirection: vec3f,
    // The z of the planet's horizon as the camera sees it: the backdrop shows ground below it, and hides the disc.
    horizonZ: f32,
    discIlluminance: vec3f,
    // What the sky map and its coefficients hold the light multiplied by, 1 for cd/m²: dunstkreis' skyViewScale, scaled.
    skyScale: f32,
    // How many times SDR white the display shows, for an HDR canvas; 1 for SDR.
    headroom: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sky: texture_cube<f32>;
@group(0) @binding(2) var skySampler: sampler;
@group(0) @binding(3) var<storage, read> sh: array<vec4f, 9>;
@group(0) @binding(4) var output: texture_storage_2d<OUTPUT_FORMAT, write>;
// The sky rendered live through the same camera, linear in cd/m², one texel per pixel.
@group(0) @binding(5) var background: texture_2d<f32>;
@group(0) @binding(6) var blueNoiseTexture: texture_2d<f32>;

// The sun's glare: a wide, soft veil around it, a share of the sunlight, its width in radians.
const GLARE_VEIL: vec2f = vec2f(0.03, 0.15);
// The haze the god rays show in: its scattering coefficient per meter, how far in front of the camera it reaches, in
// meters, and the forward lobe of its phase function.
const HAZE: f32 = 0.002;
const HAZE_DEPTH: f32 = 30.0;
const HAZE_FORWARD: f32 = 0.7;

const PI: f32 = 3.14159265358979;
const PHI: f32 = 1.61803398874989;
const IPHI: f32 = 0.61803398874989;
const FAR: f32 = 1e9;
// The atmosphere's ground albedo: the shadows taken out of its ground assume the same.
const GROUND_ALBEDO: f32 = 0.3;
// Circumradius of every solid: a meter across.
const SOLID_RADIUS: f32 = 0.5;

// Face normals, unnormalized: the tetrahedron's four, the cube's six, the icosahedron's twenty, which point to the
// vertices of the dodecahedron, its dual, and the dodecahedron's twelve, to the icosahedron's vertices. The octahedron's
// eight are the first eight of the icosahedron's, the corners of a cube.
var<private> planes: array<vec3f, 42> = array<vec3f, 42>(
    vec3f(1.0, 1.0, 1.0), vec3f(1.0, -1.0, -1.0), vec3f(-1.0, 1.0, -1.0), vec3f(-1.0, -1.0, 1.0),
    vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, -1.0, 0.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0),
    vec3f(1.0, 1.0, 1.0), vec3f(1.0, 1.0, -1.0), vec3f(1.0, -1.0, 1.0), vec3f(1.0, -1.0, -1.0),
    vec3f(-1.0, 1.0, 1.0), vec3f(-1.0, 1.0, -1.0), vec3f(-1.0, -1.0, 1.0), vec3f(-1.0, -1.0, -1.0),
    vec3f(0.0, IPHI, PHI), vec3f(0.0, IPHI, -PHI), vec3f(0.0, -IPHI, PHI), vec3f(0.0, -IPHI, -PHI),
    vec3f(IPHI, PHI, 0.0), vec3f(IPHI, -PHI, 0.0), vec3f(-IPHI, PHI, 0.0), vec3f(-IPHI, -PHI, 0.0),
    vec3f(PHI, 0.0, IPHI), vec3f(PHI, 0.0, -IPHI), vec3f(-PHI, 0.0, IPHI), vec3f(-PHI, 0.0, -IPHI),
    vec3f(0.0, 1.0, PHI), vec3f(0.0, 1.0, -PHI), vec3f(0.0, -1.0, PHI), vec3f(0.0, -1.0, -PHI),
    vec3f(1.0, PHI, 0.0), vec3f(1.0, -PHI, 0.0), vec3f(-1.0, PHI, 0.0), vec3f(-1.0, -PHI, 0.0),
    vec3f(PHI, 0.0, 1.0), vec3f(PHI, 0.0, -1.0), vec3f(-PHI, 0.0, 1.0), vec3f(-PHI, 0.0, -1.0),
);

struct Solid {
    first: u32,
    // No planes for the sphere.
    count: u32,
    // Distance of each face from the center, for a circumradius of SOLID_RADIUS; the sphere's radius.
    inradius: f32,
    albedo: f32,
}

// Tetrahedron, cube, octahedron, dodecahedron, icosahedron and the sphere. Duals share their inradius at the same
// circumradius. Where they are comes with the params.
var<private> solids: array<Solid, 6> = array<Solid, 6>(
    Solid(0u, 4u, SOLID_RADIUS / 3.0, 0.8),
    Solid(4u, 6u, SOLID_RADIUS * 0.57735027, 0.8),
    Solid(10u, 8u, SOLID_RADIUS * 0.57735027, 0.8),
    Solid(30u, 12u, SOLID_RADIUS * 0.79465447, 0.8),
    Solid(10u, 20u, SOLID_RADIUS * 0.79465447, 0.8),
    Solid(0u, 0u, SOLID_RADIUS, 0.8),
);

struct Hit {
    t: f32,
    normal: vec3f,
    albedo: f32,
}

// The nearest hit on one solid before `tMax`.
fn intersectSolid(index: u32, origin: vec3f, direction: vec3f, tMax: f32) -> Hit {
    var hit = Hit(FAR, vec3f(0.0), 0.0);
    let solid = solids[index];
    let offset = origin - params.centers[index].xyz;

    // Every solid fits in its circumsphere: rays that miss it are done.
    let b = dot(offset, direction);
    let c = dot(offset, offset) - SOLID_RADIUS * SOLID_RADIUS;
    let discriminant = b * b - c;
    if (discriminant < 0.0 || -b + sqrt(discriminant) < 0.0) {
        return hit;
    }
    if (solid.count == 0u) {
        let t = -b - sqrt(discriminant);
        if (t > 0.0 && t < tMax) {
            hit = Hit(t, normalize(offset + direction * t), solid.albedo);
        }
        return hit;
    }

    // Clipped by each face's plane in turn, in the solid's own frame: the ray is inside between the last plane it
    // enters and the first it leaves.
    let toLocal = transpose(params.rotations[index]);
    let o = toLocal * offset;
    let d = toLocal * direction;
    var tNear = -FAR;
    var tFar = FAR;
    var normal = vec3f(0.0);
    for (var k = 0u; k < solid.count; k = k + 1u) {
        let n = normalize(planes[solid.first + k]);
        let denominator = dot(n, d);
        let distance = solid.inradius - dot(n, o);
        if (abs(denominator) < 1e-9) {
            if (distance < 0.0) {
                return hit;
            }
            continue;
        }
        let t = distance / denominator;
        if (denominator < 0.0) {
            if (t > tNear) {
                tNear = t;
                normal = n;
            }
        } else {
            tFar = min(tFar, t);
        }
    }
    if (tNear > tFar || tNear <= 0.0 || tNear >= tMax) {
        return hit;
    }
    return Hit(tNear, params.rotations[index] * normal, solid.albedo);
}

fn intersectSolids(origin: vec3f, direction: vec3f, tMax: f32) -> Hit {
    var closest = Hit(tMax, vec3f(0.0), -1.0);
    for (var i = 0u; i < 6u; i = i + 1u) {
        let hit = intersectSolid(i, origin, direction, closest.t);
        if (hit.t < closest.t) {
            closest = hit;
        }
    }
    return closest;
}

fn intersectScene(origin: vec3f, direction: vec3f) -> Hit {
    var closest = intersectSolids(origin, direction, FAR);
    // The round ground, z = 0.
    if (params.ground == 0u && direction.z < 0.0) {
        let t = -origin.z / direction.z;
        if (t > 0.0 && t < closest.t && length((origin + direction * t).xy) < params.groundRadius) {
            closest = Hit(t, vec3f(0.0, 0.0, 1.0), GROUND_ALBEDO);
        }
    }
    return closest;
}

// Irradiance in lux for a surface facing `n`, from the coefficients convolved with the cosine lobe.
fn skyIrradiance(n: vec3f) -> vec3f {
    var basis = array<f32, 9>(
        0.282095,
        0.488603 * n.y,
        0.488603 * n.z,
        0.488603 * n.x,
        1.092548 * n.x * n.y,
        1.092548 * n.y * n.z,
        0.315392 * (3.0 * n.z * n.z - 1.0),
        1.092548 * n.x * n.z,
        0.546274 * (n.x * n.x - n.y * n.y),
    );
    var lobe = array<f32, 9>(PI, 2.094395, 2.094395, 2.094395, 0.785398, 0.785398, 0.785398, 0.785398, 0.785398);
    var irradiance = vec3f(0.0);
    for (var c = 0u; c < 9u; c = c + 1u) {
        irradiance = irradiance + lobe[c] * sh[c].rgb * basis[c];
    }
    return max(irradiance, vec3f(0.0)) / params.skyScale;
}

// Which of the pixel's four camera rays is being traced.
var<private> subsample: u32;

// Blue noise per pixel, two channels in [0, 1): 64x64 texels tiled over the image, from scripts/bluenoise.mjs, moved
// for each of the pixel's camera rays by the R2 sequence's steps (Roberts 2018), so the four stay evenly spread. It
// turns the shadow and occlusion rays from pixel to pixel: what one pattern would repeat everywhere becomes fine grain
// without clumps.
fn blueNoise(pixel: vec2u) -> vec2f {
    let texel = textureLoad(blueNoiseTexture, vec2i(pixel % 64u), 0).rg;
    return fract(texel + f32(subsample) * vec2f(0.7548776662, 0.5698402910));
}

// Turns a 2D offset by an angle.
fn turned(v: vec2f, angle: f32) -> vec2f {
    let c = cos(angle);
    let s = sin(angle);
    return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

// How much of the sky the solids leave open above a point: cosine-weighted rays over its hemisphere, a spiral turned
// by a per-pixel angle. The ground is not counted: the coefficients already hold the planet's ground below the horizon.
fn openness(p: vec3f, n: vec3f, pixel: vec2u) -> f32 {
    let count = params.occlusionRays;
    if (count == 0u) {
        return 1.0;
    }
    let helper = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
    let tangent = normalize(cross(helper, n));
    let bitangent = cross(n, tangent);
    let turn = blueNoise(pixel).x * 2.0 * PI;
    var open = 0.0;
    for (var i = 0u; i < count; i = i + 1u) {
        let u = (f32(i) + 0.5) / f32(count);
        let radius = sqrt(u);
        let angle = f32(i) * 2.399963 + turn;
        let d = tangent * (radius * cos(angle)) + bitangent * (radius * sin(angle)) + n * sqrt(max(1.0 - u, 0.0));
        if (intersectSolids(p, d, 2.0).albedo < 0.0) {
            open = open + 1.0;
        }
    }
    return open / f32(count);
}

// How much of the sun the solids leave visible from a point: rays spread over its disc by a golden set, turned from
// pixel to pixel and from camera ray to camera ray, or one to its center. The golden set's offsets lie within half a unit of its
// center, so they scale by the disc's diameter.
fn sunVisibility(p: vec3f, pixel: vec2u) -> f32 {
    let sun = params.sunDirection;
    let count = params.shadowRays;
    if (count == 0u) {
        return 1.0;
    }
    if (count != 8u && count != 64u) {
        return select(0.0, 1.0, intersectSolids(p, sun, FAR).albedo < 0.0);
    }
    let helper = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(sun.x) > 0.9);
    let tangent = normalize(cross(helper, sun));
    let bitangent = cross(sun, tangent);
    let diameter = 2.0 * params.sunAngularRadius;
    let turn = blueNoise(pixel).y * 2.0 * PI;
    var visible = 0.0;
    for (var i = 0u; i < count; i = i + 1u) {
        let offset = turned(select(goldenSet64[i], goldenSet8[i % 8u], count == 8u), turn) * diameter;
        let d = normalize(sun + tangent * offset.x + bitangent * offset.y);
        if (intersectSolids(p, d, FAR).albedo < 0.0) {
            visible = visible + 1.0;
        }
    }
    return visible / f32(count);
}

// The sky pass' tone curves, sRGB encoded, beyond 1 up to the headroom on an HDR display.
fn toneMap(exposed: vec3f) -> vec3f {
    if (params.toneCurve == 2u) {
        return dkToneMapAgx(exposed);
    }
    if (params.toneCurve == 3u) {
        return dkToneMapAces(exposed);
    }
    if (params.toneCurve == 4u) {
        return dkToneMapClipHdr(exposed, params.headroom);
    }
    return dkToneMapNeutralHdr(exposed, params.headroom);
}

// Four rays per pixel on a rotated grid, as 4x multisampling places its samples: edges come out smooth in one frame.
var<private> subsamples: array<vec2f, 4> = array<vec2f, 4>(
    vec2f(-0.125, -0.375), vec2f(0.375, -0.125), vec2f(0.125, 0.375), vec2f(-0.375, 0.125),
);

// What lies behind the scene along a camera ray: the atmosphere rendered live for this pixel, sun disc included, or the
// sky map with a disc of its own.
fn backdrop(pixel: vec2u, direction: vec3f) -> vec3f {
    if (params.background != 0u) {
        return textureLoad(background, vec2i(pixel), 0).rgb;
    }
    // Trilinear: a compute pass has no derivatives, so the level is where a texel spans about as much as a pixel.
    let pixelAngle = 2.0 * params.tanHalfFov / f32(textureDimensions(output).y);
    let texelAngle = 0.5 * PI / f32(textureDimensions(sky).x);
    let level = clamp(log2(pixelAngle / texelAngle), 0.0, f32(textureNumLevels(sky) - 1u));
    let lookup = select(direction, dkCubeFromSphere(normalize(direction)), params.cubified != 0u);
    return textureSampleLevel(sky, skySampler, lookup, level).rgb / params.skyScale;
}

// How much of the sun disc a camera ray covers, as the share of its part of a pixel inside the disc's rim: the four rays
// of a pixel each stand for a quarter of it, about half a pixel across.
fn discCoverage(direction: vec3f, size: vec2u) -> f32 {
    let halfPixel = params.tanHalfFov / f32(size.y);
    return dkSunDiscCoverage(direction, params.discDirection, params.sunAngularRadius, halfPixel);
}

// The backdrop's own ground where a camera ray meets the plane z = 0, `t` along it, with what the solids keep from it
// taken out: their shadows and occlusion. The rest is the backdrop's, bright or hazy as it is: differential rendering
// after Debevec (1998). The backdrop is looked up by the view direction, its ground as if infinitely far.
fn backdropGround(pixel: vec2u, direction: vec3f, t: f32) -> vec3f {
    let point = params.eye + direction * t;
    let luminance = backdrop(pixel, direction);
    let up = vec3f(0.0, 0.0, 1.0);
    let p = point + up * max(1e-3, t * 1e-5);
    var kept = vec3f(0.0);
    if (params.sunDirection.z > 0.0 && (params.lights & 1u) != 0u) {
        kept = params.sunIlluminance * params.sunDirection.z * (1.0 - sunVisibility(p, pixel));
    }
    if ((params.lights & 2u) != 0u) {
        kept = kept + skyIrradiance(up) * (1.0 - openness(p, up, pixel));
    }
    return max(luminance - GROUND_ALBEDO / PI * kept, vec3f(0.0));
}

// The camera ray through a point of a pixel, `subsample` off its center.
fn cameraRay(pixel: vec2u, size: vec2u, subsample: vec2f) -> vec3f {
    let uv = (vec2f(pixel) + 0.5 + subsample) / vec2f(size) * 2.0 - 1.0;
    let across = params.right * (uv.x * params.tanHalfFov * params.aspect);
    return normalize(params.forward + across - params.up * (uv.y * params.tanHalfFov));
}

// A normalized long-tailed lobe over the sphere, per steradian, falling off with the cube of the angle beyond `width`,
// as measured veiling glare does (Spencer et al. 1995).
fn veil(angle: f32, width: f32) -> f32 {
    return width / (2.0 * PI * pow(angle * angle + width * width, 1.5));
}

// The sun's veil, in cd/m², looking along `direction`. It lies over whatever is in front, as glare does, and dims as
// far as the solids hide the sun from the eye, which eight fixed rays over its disc tell.
fn bloom(direction: vec3f) -> vec3f {
    var visible = 0.0;
    let sun = params.discDirection;
    let helper = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(sun.x) > 0.9);
    let tangent = normalize(cross(helper, sun));
    let bitangent = cross(sun, tangent);
    for (var i = 0u; i < 8u; i = i + 1u) {
        let offset = goldenSet8[i] * 2.0 * params.sunAngularRadius;
        if (intersectSolids(params.eye, normalize(sun + tangent * offset.x + bitangent * offset.y), FAR).albedo < 0.0) {
            visible = visible + 1.0 / 8.0;
        }
    }
    if (visible == 0.0) {
        return vec3f(0.0);
    }
    let angle = 2.0 * asin(min(length(direction - sun) / 2.0, 1.0));
    // The veil is the air's, scattering forward around the sun: it thins with the air around the camera, gone in space.
    let width = GLARE_VEIL.y * mix(0.5, 1.0, params.bloom);
    let spread = GLARE_VEIL.x * params.bloom * params.airDensity * veil(angle, width);
    return params.discIlluminance * spread * visible;
}

// The haze's light along a camera ray up to `end`: the sun's light it scatters towards the camera, wherever the solids
// leave it lit, sampled along it, the samples set off by blue noise, forward-peaked by Henyey and Greenstein's phase function. Where
// a solid's shadow crosses the ray, the haze stays dark: the shafts. Returns the light and the transmittance to `end`.
fn haze(pixel: vec2u, direction: vec3f, end: f32) -> vec4f {
    let samples = params.godRaySamples;
    let depth = min(end, HAZE_DEPTH);
    let step = depth / f32(samples);
    let offset = blueNoise(pixel).x;
    var lit = 0.0;
    for (var i = 0u; i < samples; i = i + 1u) {
        let p = params.eye + direction * (step * (f32(i) + offset));
        if (p.z > 0.0 && intersectSolids(p, params.sunDirection, FAR).albedo < 0.0) {
            lit = lit + step;
        }
    }
    let g = HAZE_FORWARD;
    let c = dot(direction, params.sunDirection);
    let phase = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * c, 1.5));
    let haze = HAZE * params.hazeDensity;
    return vec4f(params.sunIlluminance * haze * phase * lit, exp(-haze * depth));
}

// How far a camera ray goes before it meets something: a solid, the ground, or nothing.
fn rayLength(direction: vec3f) -> f32 {
    let hit = intersectScene(params.eye, direction);
    let t = -params.eye.z / direction.z;
    return select(select(FAR, t, direction.z < 0.0 && t > 0.0), hit.t, hit.t < FAR);
}

// The luminance of what a camera ray meets, in cd/m².
// The luminance of what a camera ray meets, in cd/m², and 1 if that is the open sky, where the sun disc may show.
fn shade(pixel: vec2u, direction: vec3f) -> vec4f {
    let hit = intersectScene(params.eye, direction);
    if (hit.t >= FAR) {
        let t = -params.eye.z / direction.z;
        // The backdrop's ground plane is flat, the planet is not: from high up, the sky reaches below z = 0.
        let sky = select(0.0, 1.0, direction.z > params.horizonZ);
        if (params.ground != 0u && direction.z < 0.0 && t > 0.0) {
            return vec4f(backdropGround(pixel, direction, t), sky);
        }
        return vec4f(backdrop(pixel, direction), sky);
    }

    // Off the surface by a little more the farther away it is, where f32 resolves positions more coarsely.
    let p = params.eye + direction * hit.t + hit.normal * max(1e-3, hit.t * 1e-5);
    let facing = max(dot(hit.normal, params.sunDirection), 0.0);
    var sunlight = vec3f(0.0);
    if (facing > 0.0 && (params.lights & 1u) != 0u) {
        sunlight = params.sunIlluminance * facing * sunVisibility(p, pixel);
    }
    var skylight = vec3f(0.0);
    if ((params.lights & 2u) != 0u) {
        skylight = skyIrradiance(hit.normal) * openness(p, hit.normal, pixel);
    }
    // A Lambertian surface: albedo over pi of the irradiance, in cd/m².
    var luminance = hit.albedo / PI * (sunlight + skylight);
    // The round ground fades out over its outer half into what lies behind it, the planet's own ground, colored and
    // lit in the sky map and the live atmosphere alike: no edge where it ends.
    if (p.z < 1e-2) {
        let r = length(p.xy) / params.groundRadius;
        luminance = mix(luminance, backdrop(pixel, direction), smoothstep(0.5, 1.0, r));
    }
    return vec4f(luminance, 0.0);
}

@compute @workgroup_size(8, 8)
fn render(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    var luminance = vec3f(0.0);
    var disc = 0.0;
    for (var i = 0u; i < 4u; i = i + 1u) {
        subsample = i;
        let direction = cameraRay(id.xy, size, subsamples[i]);
        let surface = shade(id.xy, direction);
        luminance = luminance + surface.rgb / 4.0;
        if (surface.w > 0.0 && params.sunDisc != 0u) {
            disc = disc + discCoverage(direction, size) / 4.0;
        }
    }
    subsample = 0u;
    let center = cameraRay(id.xy, size, vec2f(0.0));
    // The haze, marched once per pixel along its center: god rays are soft, they need no four.
    if (params.godRaySamples > 0u && params.sunDirection.z > 0.0) {
        let air = haze(id.xy, center, rayLength(center));
        luminance = luminance * air.w + air.rgb;
    }
    if (params.bloom > 0.0 && params.discIlluminance.g > 0.0) {
        luminance = luminance + bloom(center);
    }
    var color = toneMap(luminance * params.exposure);
    // The sun disc, far beyond white in most exposures: added to what lies behind it, tone mapped apart and mixed in by
    // how much of the pixel it covers, so its edge is smooth rather than a pixel's worth of white wherever it touches.
    // A disc no light reaches adds nothing: it never darkens the sky.
    if (disc > 0.0) {
        let sun = dkSunDiscLuminance(params.discIlluminance, params.sunAngularRadius);
        color = mix(color, toneMap((luminance + sun) * params.exposure), disc);
    }
    // Triangular dither of one 8-bit step, the difference of the two channels.
    if (params.dither != 0u) {
        let noise = dot(blueNoise(id.xy), vec2f(1.0, -1.0));
        color = color + noise / 255.0;
    }
    color = clamp(color, vec3f(0.0), dkEncodeSrgbExtended(vec3f(params.headroom), params.headroom));
    textureStore(output, vec2i(id.xy), vec4f(color, 1.0));
}
