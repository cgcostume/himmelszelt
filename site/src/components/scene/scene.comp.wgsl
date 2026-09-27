// A small scene lit by an environment, to see how a sky lights things: a cube map in cd/m² for the background, nine
// spherical harmonics coefficients of it for the light from every direction, and the sun as a light of its own.
// Raytraced in a compute pass: a tetrahedron, a cube, an icosahedron and a sphere over a round ground, exact rather than
// triangulated. Each polyhedron is the intersection of the half-spaces behind its faces, the sphere is a sphere. The
// sun casts shadows, soft when its disc is sampled; the sky's light is dimmed by ambient occlusion from a few rays.
//
// Four camera rays per pixel, on the rotated grid of 4x multisampling. Progressive in the lighting only: each frame
// turns the shadow and occlusion rays and adds to a running sum, so their noise smooths out while nothing changes. The
// golden sets, `goldenSet8` and `goldenSet64`, are prepended by scene.js.
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
    // Each solid's orientation, object to world.
    rotations: array<mat3x3f, 4>,
    // Which frame of the running sum this is, from 0: its subpixel offset and its occlusion rays' turn.
    frame: u32,
    // Shadow rays per point over the sun disc, 8 or 64, soft; otherwise one to its center, hard.
    shadowRays: u32,
    // Nonzero to show `background` behind the solids rather than the sky map.
    background: u32,
    // Radius of the round ground, in scene units: it fades out over its outer half into what lies behind it.
    groundRadius: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sky: texture_cube<f32>;
@group(0) @binding(2) var skySampler: sampler;
@group(0) @binding(3) var<storage, read> sh: array<vec4f, 9>;
@group(0) @binding(4) var output: texture_storage_2d<rgba8unorm, write>;
// The running sum of luminance per pixel, in cd/m², row by row.
@group(0) @binding(5) var<storage, read_write> sum: array<vec4f>;
// The sky rendered live through the same camera, linear in cd/m², one texel per pixel.
@group(0) @binding(6) var background: texture_2d<f32>;

const PI: f32 = 3.14159265358979;
const PHI: f32 = 1.61803398874989;
const IPHI: f32 = 0.61803398874989;
const FAR: f32 = 1e9;
const GROUND_ALBEDO: f32 = 0.3;
const SOLID_RADIUS: f32 = 1.0;

// Face normals, unnormalized: the tetrahedron's four, the cube's six, and the icosahedron's twenty, which point to the
// vertices of the dodecahedron, its dual.
var<private> planes: array<vec3f, 30> = array<vec3f, 30>(
    vec3f(1.0, 1.0, 1.0), vec3f(1.0, -1.0, -1.0), vec3f(-1.0, 1.0, -1.0), vec3f(-1.0, -1.0, 1.0),
    vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, -1.0, 0.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0),
    vec3f(1.0, 1.0, 1.0), vec3f(1.0, 1.0, -1.0), vec3f(1.0, -1.0, 1.0), vec3f(1.0, -1.0, -1.0),
    vec3f(-1.0, 1.0, 1.0), vec3f(-1.0, 1.0, -1.0), vec3f(-1.0, -1.0, 1.0), vec3f(-1.0, -1.0, -1.0),
    vec3f(0.0, IPHI, PHI), vec3f(0.0, IPHI, -PHI), vec3f(0.0, -IPHI, PHI), vec3f(0.0, -IPHI, -PHI),
    vec3f(IPHI, PHI, 0.0), vec3f(IPHI, -PHI, 0.0), vec3f(-IPHI, PHI, 0.0), vec3f(-IPHI, -PHI, 0.0),
    vec3f(PHI, 0.0, IPHI), vec3f(PHI, 0.0, -IPHI), vec3f(-PHI, 0.0, IPHI), vec3f(-PHI, 0.0, -IPHI),
);

struct Solid {
    center: vec3f,
    first: u32,
    // No planes for the sphere.
    count: u32,
    // Distance of each face from the center, for a circumradius of SOLID_RADIUS; the sphere's radius.
    inradius: f32,
    albedo: f32,
}

// In a square, floating a little above the ground so they can turn freely and their shadows show.
var<private> solids: array<Solid, 4> = array<Solid, 4>(
    Solid(vec3f(-1.6, -1.6, 1.4), 0u, 4u, SOLID_RADIUS / 3.0, 0.8),
    Solid(vec3f(1.6, -1.6, 1.4), 4u, 6u, SOLID_RADIUS * 0.57735027, 0.8),
    Solid(vec3f(-1.6, 1.6, 1.4), 10u, 20u, SOLID_RADIUS * 0.79465447, 0.8),
    Solid(vec3f(1.6, 1.6, 1.4), 0u, 0u, SOLID_RADIUS, 0.8),
);

struct Hit {
    t: f32,
    normal: vec3f,
    albedo: f32,
}

fn intersectSolid(index: u32, origin: vec3f, direction: vec3f, tMax: f32) -> Hit {
    var hit = Hit(FAR, vec3f(0.0), 0.0);
    let solid = solids[index];
    let offset = origin - solid.center;

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
    if (tNear <= tFar && tNear > 0.0 && tNear < tMax) {
        hit = Hit(tNear, params.rotations[index] * normal, solid.albedo);
    }
    return hit;
}

fn intersectSolids(origin: vec3f, direction: vec3f, tMax: f32) -> Hit {
    var closest = Hit(tMax, vec3f(0.0), -1.0);
    for (var i = 0u; i < 4u; i = i + 1u) {
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
    if (direction.z < 0.0) {
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
    return max(irradiance, vec3f(0.0));
}

// A pseudo-random number in [0, 1] per point, from webgl-operate's sampling.glsl: it varies the sampling from pixel to
// pixel, so what one pattern repeats everywhere turns into fine noise, which the running sum smooths out.
fn rand(co: vec2f) -> f32 {
    return fract(sin(dot(co, vec2f(12.9898, 78.233))) * 43758.5453);
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
    let turn = (rand(vec2f(pixel)) + f32(params.frame) * 0.618034) * 2.0 * PI;
    var open = 0.0;
    for (var i = 0u; i < count; i = i + 1u) {
        let u = (f32(i) + 0.5) / f32(count);
        let radius = sqrt(u);
        let angle = f32(i) * 2.399963 + turn;
        let d = tangent * (radius * cos(angle)) + bitangent * (radius * sin(angle)) + n * sqrt(max(1.0 - u, 0.0));
        if (intersectSolids(p, d, 4.0).albedo < 0.0) {
            open = open + 1.0;
        }
    }
    return open / f32(count);
}

// How much of the sun the solids leave visible from a point: rays spread over its disc by a golden set, turned from
// pixel to pixel and frame to frame, or one to its center. The golden set's offsets lie within half a unit of its
// center, so they scale by the disc's diameter.
fn sunVisibility(p: vec3f, pixel: vec2u) -> f32 {
    let sun = params.sunDirection;
    let count = params.shadowRays;
    if (count != 8u && count != 64u) {
        return select(0.0, 1.0, intersectSolids(p, sun, FAR).albedo < 0.0);
    }
    let helper = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(sun.x) > 0.9);
    let tangent = normalize(cross(helper, sun));
    let bitangent = cross(sun, tangent);
    let diameter = 2.0 * params.sunAngularRadius;
    let turn = (rand(vec2f(pixel) + 17.0) + f32(params.frame) * 0.618034) * 2.0 * PI;
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

// Narkowicz's fit of the ACES filmic curve, then the sRGB encoding, as the sky pass does.
fn toneMap(exposed: vec3f) -> vec3f {
    let x = max(exposed, vec3f(0.0));
    let mapped = clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
    return select(1.055 * pow(mapped, vec3f(1.0 / 2.4)) - 0.055, mapped * 12.92, mapped <= vec3f(0.0031308));
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
    var luminance = textureSampleLevel(sky, skySampler, direction, 0.0).rgb;
    let radius = params.sunAngularRadius;
    if (params.sunDisc != 0u && length(direction - params.sunDirection) < radius) {
        luminance = luminance + params.sunIlluminance / (PI * radius * radius);
    }
    return luminance;
}

// The luminance along one camera ray, in cd/m².
fn trace(pixel: vec2u, size: vec2u, subsample: vec2f) -> vec3f {
    let uv = (vec2f(pixel) + 0.5 + subsample) / vec2f(size) * 2.0 - 1.0;
    let across = params.right * (uv.x * params.tanHalfFov * params.aspect);
    let direction = normalize(params.forward + across - params.up * (uv.y * params.tanHalfFov));

    let hit = intersectScene(params.eye, direction);
    if (hit.t >= FAR) {
        return backdrop(pixel, direction);
    }

    // Off the surface by a little more the farther away it is, where f32 resolves positions more coarsely.
    let p = params.eye + direction * hit.t + hit.normal * max(1e-3, hit.t * 1e-5);
    let facing = max(dot(hit.normal, params.sunDirection), 0.0);
    var sunlight = vec3f(0.0);
    if (facing > 0.0) {
        sunlight = params.sunIlluminance * facing * sunVisibility(p, pixel);
    }
    let skylight = skyIrradiance(hit.normal) * openness(p, hit.normal, pixel);
    // A Lambertian surface: albedo over pi of the irradiance, in cd/m².
    var luminance = hit.albedo / PI * (sunlight + skylight);
    // The round ground fades out over its outer half into what lies behind it, the planet's own ground, colored and
    // lit in the sky map and the live atmosphere alike: no edge where it ends.
    if (p.z < 1e-2) {
        let r = length(p.xy) / params.groundRadius;
        luminance = mix(luminance, backdrop(pixel, direction), smoothstep(0.5, 1.0, r));
    }
    return luminance;
}

@compute @workgroup_size(8, 8)
fn render(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    var luminance = vec3f(0.0);
    for (var i = 0u; i < 4u; i = i + 1u) {
        luminance = luminance + trace(id.xy, size, subsamples[i]) / 4.0;
    }

    // The running sum: shadows and occlusion turn their rays from frame to frame, the camera rays stay put.
    let index = id.y * size.x + id.x;
    var total = luminance;
    if (params.frame > 0u) {
        total = total + sum[index].rgb;
    }
    sum[index] = vec4f(total, 1.0);
    var color = toneMap(total / f32(params.frame + 1u) * params.exposure);
    let noise = rand(vec2f(id.xy) + f32(params.frame)) - rand(vec2f(id.xy) + vec2f(7.31, 3.17) + f32(params.frame));
    color = clamp(color + noise / 255.0, vec3f(0.0), vec3f(1.0));
    textureStore(output, vec2i(id.xy), vec4f(color, 1.0));
}
