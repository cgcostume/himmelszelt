import type { SkyCubePass, SkyPanoramaPass, SkyPass } from "@himmelszelt/dunstkreis";
import { wgsl } from "@himmelszelt/dunstkreis";
import { showCode } from "../code";
import { find } from "../dom";
import { onDemand } from "../frame";
import { currentSky, display, gpu, gpuDevice, onDisplay, onSkyView, type Sky } from "./atmosphere";
import { cameraBasis, lookAround, project, type SkyCamera, type Vec3 } from "./skycamera";

/**
 * The sky in six ways of storing it, in textures of the sizes below, shown texel by texel, bilinearly or bicubically:
 * as stored, and from inside, looking around.
 * Over both, the texels' edges, and how densely each projection packs its texels against an even spread of the same
 * texels over what it covers.
 */

type Projection = "cube" | "cubified" | "equirectangular" | "octahedral" | "fisheye" | "sphere";
// In the shader's numbering.
const PROJECTIONS: Projection[] = ["cube", "cubified", "equirectangular", "octahedral", "fisheye", "sphere"];

/**
 * The sizes, in two tiers. XS to L compare the projections: about as many texels in each, 400, 1,600, 6,400 and
 * 25,600. HD and UHD are what maps commonly come in: faces of 1024 and 2048 for a cube map, 2048 and 4096 across for
 * the others.
 */
type Size = "xs" | "s" | "m" | "l" | "hd" | "uhd";
const LEVEL: Record<Size, number> = { xs: 0, s: 1, m: 2, l: 3, hd: 0, uhd: 0 };
const large = (size: Size) => size === "hd" || size === "uhd";

/** Each projection's texture at a size: width and height, six layers for a cube map. */
function sizeOf(projection: Projection, size: Size): [number, number] {
    if (large(size)) {
        const across = size === "uhd" ? 4096 : 2048;
        if (projection === "cube" || projection === "cubified") return [across / 2, across / 2];
        if (projection === "equirectangular") return [across, across / 2];
        return [across, across];
    }
    const level = LEVEL[size];
    const base: Record<Projection, [number, number]> = {
        cube: [8, 8],
        cubified: [8, 8],
        equirectangular: [28, 14],
        octahedral: [20, 20],
        fisheye: [20, 20],
        sphere: [20, 20],
    };
    const [width, height] = base[projection];
    return [width << level, height << level];
}
const layers = (projection: Projection) => (projection === "cube" || projection === "cubified" ? 6 : 1);
/** The shown shape: a cube map's six faces side by side, a flat panorama as stored. */
const ASPECT: Record<Projection, number> = {
    cube: 6,
    cubified: 6,
    equirectangular: 2,
    octahedral: 1,
    fisheye: 1,
    sphere: 1,
};

// The display: the chart a direction falls into, its texel, the texel's edges by the chart's screen-space derivatives,
// and the texels per steradian by the chart's derivatives on the sphere, against those of an even spread.
const SOURCE = /* wgsl */ `
${wgsl.cube}
${wgsl.panorama}
${wgsl.tonemap}
${wgsl.sun}
${wgsl.grid}
struct Params {
    // The view's right, up and forward.
    rotation: mat3x3f,
    size: vec2u,
    // 0 cube, 1 cubified, 2 equirectangular, 3 octahedral, 4 fisheye, 5 sphere map.
    projection: u32,
    // 0 as stored, 1 the view from inside.
    inside: u32,
    edges: u32,
    density: u32,
    // An even spread's texels per steradian over what the projection covers.
    texelsPerSr: f32,
    // The view's image plane, half as wide as tx and half as high as ty, and the general perspective's d, as the sky
    // figure's camera has them.
    tx: f32,
    // 0 texel by texel, 1 bilinear by the hardware's sampler, as a renderer would, 2 bicubic by hand.
    sampling: u32,
    // The page's tone curve: 0 neutral, 1 AgX, 2 ACES, 3 none.
    curve: u32,
    ty: f32,
    d: f32,
    // The sky figure's grid over both views, the Sun's disc's radius in radians and its true direction for its symbol.
    grid: u32,
    pixelRatio: f32,
    sunAngularRadius: f32,
    sunDirection: vec3f,
    dither: u32,
    // The Sun's disc, drawn over the view from inside pixel by pixel, never stored: where it shows, bent by the air,
    // and its illuminance in the texture's units, times the sky's scale.
    apparentSun: vec3f,
    sunDisc: u32,
    sunIlluminance: vec3f,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d_array<f32>;
// The mean log2 luminance over the upper hemisphere, metered first.
@group(0) @binding(2) var<storage, read_write> metered: f32;
@group(0) @binding(3) var output: texture_storage_2d<rgba8unorm, write>;
// The same texture again for the sampler: as a cube for a cube map, its first layer for the others.
@group(0) @binding(4) var cubeSource: texture_cube<f32>;
@group(0) @binding(5) var flatSource: texture_2d<f32>;
// Linear, repeating across, as the equirectangular wraps, and clamped down.
@group(0) @binding(6) var linearSampler: sampler;

const PI: f32 = 3.141592653589793;
const LUMINANCE = vec3f(0.2126, 0.7152, 0.0722);
fn isCube() -> bool {
    return params.projection <= 1u;
}

fn majorAxis(d: vec3f) -> u32 {
    let a = abs(d);
    if (a.x >= a.y && a.x >= a.z) {
        return 0u;
    }
    return select(2u, 1u, a.y >= a.z);
}

struct Chart {
    // In texels from the texture's top left corner, continuous.
    texel: vec2f,
    layer: u32,
    covered: bool,
}

// d in the chart it falls into; a cube map's on the face of \`axis\`, so that its neighbors stay on that face.
// The face a point on the cube lies on, the one of the axis given, and its texel there, as dkCubePointAt lays the faces out.
fn cubeFaceChart(p: vec3f, axis: u32) -> Chart {
    var st: vec2f;
    var face: u32;
    switch axis {
        case 0u: { face = select(1u, 0u, p.x > 0.0); st = vec2f(select(p.z, -p.z, p.x > 0.0), -p.y); }
        case 1u: { face = select(3u, 2u, p.y > 0.0); st = vec2f(p.x, select(-p.z, p.z, p.y > 0.0)); }
        default: { face = select(5u, 4u, p.z > 0.0); st = vec2f(select(-p.x, p.x, p.z > 0.0), -p.y); }
    }
    return Chart((st * 0.5 + 0.5) * vec2f(params.size), face, true);
}

fn chartOn(d: vec3f, axis: u32) -> Chart {
    let size = vec2f(params.size);
    if (isCube()) {
        var p = d / abs(d[axis]);
        if (params.projection == 1u) {
            switch axis {
                case 0u: { p = dkCubifyFace(d.yzx).zxy; }
                case 1u: { p = dkCubifyFace(d.xzy).xzy; }
                default: { p = dkCubifyFace(d); }
            }
        }
        return cubeFaceChart(p, axis);
    }
    switch params.projection {
        case 2u: { return Chart(dkEquirectangularUv(d, 0.0) * size, 0u, true); }
        case 3u: { return Chart(dkOctahedralUv(d, 0.0) * size, 0u, true); }
        case 4u: { return Chart(dkFisheyeUv(d, 0.0) * size, 0u, d.z >= 0.0); }
        default: { return Chart(dkSphereMapUv(d, 0.0) * size, 0u, true); }
    }
}

// The chart at a point of the output: a flat panorama as stored, by the texture coordinates themselves; a cube map's
// faces, laid out by direction, and the view from inside by the direction.
fn chartAt(position: vec2f, axis: u32) -> Chart {
    if (params.inside == 0u && !isCube()) {
        let uv = position / vec2f(textureDimensions(output));
        return Chart(uv * vec2f(params.size), 0u, params.projection < 4u || length(uv * 2.0 - 1.0) <= 1.0);
    }
    return chartOn(directionAt(position).xyz, axis);
}

fn chart(d: vec3f) -> Chart {
    return chartOn(d, majorAxis(d));
}

// The step from one chart position to another, across the equirectangular's seam the short way.
fn chartStep(a: Chart, b: Chart) -> vec2f {
    var delta = b.texel - a.texel;
    if (params.projection == 2u) {
        delta.x = delta.x - round(delta.x / f32(params.size.x)) * f32(params.size.x);
    }
    return delta;
}

// Texels per steradian at d, from the chart's derivatives along two directions on the sphere. The octahedral's lower
// half is its upper half folded over, its texels as dense as at the mirrored direction.
fn texelsPerSr(direction: vec3f) -> f32 {
    var d = direction;
    if (params.projection == 3u) {
        d.z = abs(d.z);
    }
    let axis = majorAxis(d);
    let t1 = normalize(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(d.z) > 0.9), d));
    let t2 = cross(d, t1);
    let eps = 2e-3;
    let c = chartOn(d, axis);
    let a = chartStep(c, chartOn(normalize(d + eps * t1), axis));
    let b = chartStep(c, chartOn(normalize(d + eps * t2), axis));
    return abs(a.x * b.y - a.y * b.x) / (eps * eps);
}

// ColorBrewer's RdBu, from blue where texels are sparse through white where even to red where dense, saturated at
// four times either way, interpolated between its eleven stops.
const RD_BU = array<vec3f, 11>(
    vec3f(0.020, 0.188, 0.380),
    vec3f(0.129, 0.400, 0.675),
    vec3f(0.263, 0.576, 0.765),
    vec3f(0.573, 0.773, 0.871),
    vec3f(0.820, 0.898, 0.941),
    vec3f(0.969, 0.969, 0.969),
    vec3f(0.992, 0.859, 0.780),
    vec3f(0.957, 0.647, 0.510),
    vec3f(0.839, 0.376, 0.302),
    vec3f(0.698, 0.094, 0.169),
    vec3f(0.404, 0.000, 0.122),
);

fn densityColor(q: f32) -> vec3f {
    let t = (clamp(log2(q) / 2.0, -1.0, 1.0) * 0.5 + 0.5) * 10.0;
    let i = min(u32(t), 9u);
    var stops = RD_BU;
    return mix(stops[i], stops[i + 1u], t - f32(i));
}

// The direction a point on the cube stands for, as stored: through Nowell's mapping in a cubified cube map, so that its
// faces show their texels on a straight grid.
fn onCube(p: vec3f) -> vec4f {
    return vec4f(select(normalize(p), dkSphereFromCube(p), params.projection == 1u), 1.0);
}

// The direction a point of the output shows.
fn directionAt(position: vec2f) -> vec4f {
    let size = vec2f(textureDimensions(output));
    let uv = position / size;
    if (params.inside != 0u) {
        // The ray through the image plane, bent by the general perspective as the sky pass' dkProjectRay bends it.
        let forward = params.rotation[2];
        let offset = params.rotation * vec3f((uv.x * 2.0 - 1.0) * params.tx, (1.0 - uv.y * 2.0) * params.ty, 0.0);
        let rho = length(offset);
        if (params.d <= 0.0 || rho < 1e-7) {
            return vec4f(normalize(forward + offset), 1.0);
        }
        let k = rho / (params.d + 1.0);
        let cosTheta = (sqrt(1.0 + k * k * (1.0 - params.d * params.d)) - k * k * params.d) / (1.0 + k * k);
        let sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));
        return vec4f(forward * cosTheta + offset / rho * sinTheta, 1.0);
    }
    if (isCube()) {
        // The six faces in a row, north, east, south and west upright as seen from inside, so that the four join as the
        // horizon runs round, then the zenith, as if folded up from north, and the nadir, folded down from it.
        let slot = min(u32(uv.x * 6.0), 5u);
        let st = vec2f(fract(uv.x * 6.0), uv.y) * 2.0 - 1.0;
        let up = vec3f(0.0, 0.0, 1.0);
        let north = vec3f(0.0, 1.0, 0.0);
        let east = vec3f(1.0, 0.0, 0.0);
        if (slot < 4u) {
            let azimuth = f32(slot) * 0.5 * PI;
            let forward = vec3f(sin(azimuth), cos(azimuth), 0.0);
            let right = vec3f(cos(azimuth), -sin(azimuth), 0.0);
            return onCube(forward + st.x * right - st.y * up);
        }
        if (slot == 4u) {
            return onCube(up + st.x * east + st.y * north);
        }
        return onCube(-up + st.x * east - st.y * north);
    }
    // In panorama.wgsl's numbering, one less.
    return vec4f(dkPanoramaDirection(params.projection - 1u, uv, 0.0), 1.0);
}

// Catmull-Rom's weights for the four texels around a point a fraction f past the second one's center: through every
// texel's value, and smooth where the texels meet, where bilinear only joins them.
fn catmullRom(f: f32) -> vec4f {
    return vec4f(
        f * (-0.5 + f * (1.0 - 0.5 * f)),
        1.0 + f * f * (-2.5 + 1.5 * f),
        f * (0.5 + f * (2.0 - 1.5 * f)),
        f * f * (-0.5 + 0.5 * f),
    );
}

// A cube map's texel at a position on a face, in texels, which may lie past the face's edge: folded onto the neighboring
// face there, as the cube's net unfolds, the excess beyond the edge measured into the neighbor. In cube space, where a
// cubified cube map's texels are as evenly spaced as a plain one's. Past a corner, the larger excess is folded and the
// other held at the edge.
fn cubeTap(face: u32, position: vec2f) -> vec4f {
    var p = dkCubePointAt(face, position, params.size.x);
    let axis = face / 2u;
    let b = (axis + 1u) % 3u;
    let c = (axis + 2u) % 3u;
    let fold = select(c, b, abs(p[b]) >= abs(p[c]));
    if (abs(p[fold]) > 1.0) {
        let excess = abs(p[fold]) - 1.0;
        p[fold] = sign(p[fold]);
        p[axis] = sign(p[axis]) * (1.0 - excess);
    }
    p = clamp(p, vec3f(-1.0), vec3f(1.0));
    let tap = cubeFaceChart(p, majorAxis(p));
    let texel = clamp(vec2i(floor(tap.texel)), vec2i(0), vec2i(params.size) - 1);
    return textureLoad(source, texel, tap.layer, 0);
}

// A flat panorama's texel, which may lie past the texture's edge: the equirectangular wraps across, as round the
// azimuth; the octahedral folds, as its triangles meet across each edge, the texel mirrored along it; the others clamp.
fn flatTap(position: vec2i) -> vec4f {
    let size = vec2i(params.size);
    var texel = position;
    if (params.projection == 2u) {
        texel.x = ((texel.x % size.x) + size.x) % size.x;
    } else if (params.projection == 3u) {
        if (texel.x < 0 || texel.x >= size.x) {
            texel = vec2i(select(2 * size.x - 1 - texel.x, -1 - texel.x, texel.x < 0), size.y - 1 - texel.y);
        }
        if (texel.y < 0 || texel.y >= size.y) {
            texel = vec2i(size.x - 1 - texel.x, select(2 * size.y - 1 - texel.y, -1 - texel.y, texel.y < 0));
        }
    }
    return textureLoad(source, clamp(texel, vec2i(0), size - 1), 0, 0);
}

// Bilinear by hand over flatTap, for the octahedral, whose folds the hardware's sampler would clamp instead: at the
// texture's edge it blends with the texel across the fold, so the sky runs on there as it does on the sphere.
fn bilinearFlat(here: Chart) -> vec4f {
    let t = here.texel - 0.5;
    let base = vec2i(floor(t));
    let f = t - floor(t);
    let top = mix(flatTap(base), flatTap(base + vec2i(1, 0)), f.x);
    let bottom = mix(flatTap(base + vec2i(0, 1)), flatTap(base + vec2i(1, 1)), f.x);
    return mix(top, bottom, f.y);
}

// Bicubic by hand, 4 by 4 texels: past the texture's edge as flatTap reads, and on a cube map on across the faces. Interpolated in log2 of the luminance, as
// the eye sees it: Catmull-Rom's negative lobes overshoot a sharp edge such as the horizon or the Sun's glow, in HDR by
// far more than either side, but in the log by a share of the step. Held within the 16 texels, which a smooth sky never
// reaches, so the curve stays smooth where texels meet.
fn bicubic(here: Chart) -> vec4f {
    let t = here.texel - 0.5;
    let base = floor(t);
    let wx = catmullRom(t.x - base.x);
    let wy = catmullRom(t.y - base.y);
    var sum = vec3f(0.0);
    var low = vec3f(3.4e38);
    var high = vec3f(-3.4e38);
    for (var j = 0; j < 4; j = j + 1) {
        for (var i = 0; i < 4; i = i + 1) {
            let center = base + vec2f(f32(i - 1), f32(j - 1)) + 0.5;
            var value: vec4f;
            if (isCube()) {
                value = cubeTap(here.layer, center);
            } else {
                value = flatTap(vec2i(floor(center)));
            }
            let level = log2(max(value.rgb, vec3f(1e-30)));
            sum = sum + wx[i] * wy[j] * level;
            low = min(low, level);
            high = max(high, level);
        }
    }
    return vec4f(exp2(clamp(sum, low, high)), 1.0);
}

// Whether the view from inside shows d: its general perspective, as skycamera.ts projects, within the image plane.
fn inView(d: vec3f) -> bool {
    let forward = params.rotation[2];
    let cosTheta = dot(d, forward);
    if (params.d + cosTheta <= 1e-3 || (params.d <= 0.0 && cosTheta <= 0.0)) {
        return false;
    }
    let inPlane = d - forward * cosTheta;
    let sinTheta = length(inPlane);
    var scale = 1.0;
    if (sinTheta > 1e-9) {
        scale = (params.d + 1.0) / (params.d + cosTheta);
    }
    let x = dot(inPlane, params.rotation[0]) * scale / params.tx;
    let y = dot(inPlane, params.rotation[1]) * scale / params.ty;
    return abs(x) <= 1.0 && abs(y) <= 1.0;
}

// As stored, what the view from inside shows: the rest dimmed, and its edge outlined.
fn framed(color: vec3f, position: vec2f, d: vec3f, covered: bool) -> vec3f {
    if (params.inside != 0u) {
        return color;
    }
    let seen = covered && inView(d);
    let besideX = inView(directionAt(position + vec2f(1.0, 0.0)).xyz);
    let besideY = inView(directionAt(position + vec2f(0.0, 1.0)).xyz);
    if (covered && (seen != besideX || seen != besideY)) {
        return vec3f(1.0);
    }
    return select(color * 0.4, color, seen);
}

// How strongly the sky figure's grid covers a pixel, by the directions the neighboring pixels show; in the view from
// inside only.
fn gridCoverage(position: vec2f, d: vec3f) -> f32 {
    if (params.grid == 0u || params.inside == 0u) {
        return 0.0;
    }
    let right = directionAt(position + vec2f(1.0, 0.0)).xyz;
    let below = directionAt(position + vec2f(0.0, 1.0)).xyz;
    return dkGridCoverage(d, right, below, params.sunDirection, params.sunAngularRadius, params.pixelRatio);
}

// Written out, with dither as the sky pass has it: Jimenez's interleaved gradient noise, an 8-bit step, triangular.
fn put(p: vec2u, color: vec3f) {
    var c = color;
    if (params.dither != 0u) {
        let noise = fract(52.9829189 * fract(dot(vec2f(p), vec2f(0.06711056, 0.00583715)))) * 2.0 - 1.0;
        c = c + sign(noise) * (1.0 - sqrt(1.0 - abs(noise))) / 255.0;
    }
    textureStore(output, vec2i(p), vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0));
}

const THREADS: u32 = 256u;
const METER_SAMPLES: u32 = 4096u;

var<workgroup> sums: array<f32, THREADS>;

// The exposure, metered like a camera over the sky above the horizon at evenly spread directions, by a Fibonacci
// spiral: the same for every projection, whichever directions its texels crowd, and without the sky figure's range,
// so that the night shows as on a long exposure. In the texture's own units, scaled or not.
@compute @workgroup_size(THREADS)
fn meter(@builtin(local_invocation_index) index: u32) {
    var sum = 0.0;
    for (var i = index; i < METER_SAMPLES; i = i + THREADS) {
        let z = (f32(i) + 0.5) / f32(METER_SAMPLES);
        let azimuth = f32(i) * 2.399963229728653;
        let r = sqrt(max(1.0 - z * z, 0.0));
        let here = chart(vec3f(r * sin(azimuth), r * cos(azimuth), z));
        let texel = clamp(vec2i(floor(here.texel)), vec2i(0), vec2i(params.size) - 1);
        sum = sum + log2(max(dot(textureLoad(source, texel, here.layer, 0).rgb, LUMINANCE), 1e-30));
    }
    sums[index] = sum;
    workgroupBarrier();
    for (var stride = THREADS / 2u; stride > 0u; stride = stride / 2u) {
        if (index < stride) {
            sums[index] = sums[index] + sums[index + stride];
        }
        workgroupBarrier();
    }
    if (index == 0u) {
        metered = sums[0] / f32(METER_SAMPLES);
    }
}

// Exposed so that the metered mean lands where an EV100 meter puts it, 1/9.6 of saturation, as in the sky figure.
fn toneMap(c: vec3f) -> vec3f {
    let exposed = c / (9.6 * exp2(metered));
    switch params.curve {
        case 1u: { return dkToneMapAgx(exposed); }
        case 2u: { return dkToneMapAces(exposed); }
        case 3u: { return dkToneMapClip(exposed); }
        default: { return dkToneMapNeutral(exposed); }
    }
}

const BACKGROUND = vec3f(0.0);

@compute @workgroup_size(8, 8)
fn display(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let position = vec2f(id.xy) + 0.5;
    let at = directionAt(position);
    if (at.w == 0.0) {
        textureStore(output, vec2i(id.xy), vec4f(BACKGROUND, 1.0));
        return;
    }
    let d = at.xyz;
    let axis = majorAxis(d);
    // Outside what the projection covers: below the fisheye's horizon its corner texel, the ground, whichever filter,
    // and beyond the circles as stored, what their rims hold; shown without edges or density.
    let here = chartAt(position, axis);
    var stored: vec4f;
    if (params.projection == 4u && params.inside != 0u && !here.covered) {
        stored = textureLoad(source, vec2i(0), 0, 0);
    } else if (params.sampling == 2u) {
        stored = bicubic(here);
    } else if (params.sampling == 0u) {
        let texel = clamp(vec2i(floor(here.texel)), vec2i(0), vec2i(params.size) - 1);
        stored = textureLoad(source, texel, here.layer, 0);
    } else if (isCube()) {
        let lookup = select(d, dkCubeFromSphere(d), params.projection == 1u);
        stored = textureSampleLevel(cubeSource, linearSampler, lookup, 0.0);
    } else if (params.projection == 3u) {
        stored = bilinearFlat(here);
    } else {
        stored = textureSampleLevel(flatSource, linearSampler, here.texel / vec2f(params.size), 0.0);
    }
    var luminance = stored.rgb;
    if (params.sunDisc != 0u && params.inside != 0u) {
        let right = directionAt(position + vec2f(1.0, 0.0)).xyz;
        let below = directionAt(position + vec2f(0.0, 1.0)).xyz;
        let sun = params.apparentSun;
        luminance += dkSunDiscPixel(d, right, below, sun, params.sunAngularRadius, params.sunIlluminance);
    }
    var color = toneMap(luminance);
    // The grid over everything, the texel edges under it, so its lines run on unbroken across them.
    let grid = gridCoverage(position, d);
    if (!here.covered) {
        put(id.xy, framed(mix(color, vec3f(1.0), grid / DK_GRID_FAINT), position, d, false));
        return;
    }
    if (params.density != 0u) {
        let q = texelsPerSr(d) / params.texelsPerSr;
        color = densityColor(q) * (0.35 + 0.65 * dot(color, LUMINANCE));
    }
    // The texture as stored stays as it is: edges in the view from inside only.
    if (params.edges != 0u && params.inside != 0u) {
        // A texel's edge where the chart crosses a whole texel, a pixel wide, antialiased by the distance to it in
        // pixels: along the chart's gradient, from its steps to the neighboring pixels, so it is as wide whichever way
        // it runs. Dark, a third of the way to black. A step across a quarter of the texture is a seam, where the
        // chart jumps, and an edge too. Faded out from 8 pixels a texel down to 4, before the lines crowd into a moiré.
        let besideX = directionAt(position + vec2f(1.0, 0.0));
        let besideY = directionAt(position + vec2f(0.0, 1.0));
        let dx = chartStep(here, chartAt(position + vec2f(1.0, 0.0), axis));
        let dy = chartStep(here, chartAt(position + vec2f(0.0, 1.0), axis));
        let footprint = max(vec2f(length(vec2f(dx.x, dy.x)), length(vec2f(dx.y, dy.y))), vec2f(1e-6));
        let f = fract(here.texel);
        let pixels = min(f, 1.0 - f) / footprint;
        var edge = clamp(1.0 - min(pixels.x, pixels.y), 0.0, 1.0);
        let seam = 0.25 * f32(min(params.size.x, params.size.y));
        if (besideX.w == 0.0 || besideY.w == 0.0 || ((params.inside == 0u || !isCube()) && max(length(dx), length(dy)) > seam)) {
            edge = 1.0;
        }
        edge = edge * (1.0 - smoothstep(0.125, 0.25, max(footprint.x, footprint.y))) * (1.0 - min(grid * 10.0, 1.0));
        color = mix(color, vec3f(0.0), edge / 3.0);
    }
    put(id.xy, framed(mix(color, vec3f(1.0), grid / DK_GRID_FAINT), position, d, true));
}
`;

const root = find("#projections");
const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
const stage = (name: string) => find(`[data-panel="${name}"]`, root);
const canvasOf = (name: string) => find<HTMLCanvasElement>("canvas", stage(name));
const chosen = (name: string, fallback: string) =>
    root.querySelector<HTMLInputElement>(`input[name="projections-${name}"]:checked`)?.value ?? fallback;
const chosenSize = () => chosen("budget", "xs") as Size;
const pressed = (name: string) => field(name).getAttribute("aria-pressed") === "true";
// Off, the compass, or the compass with the grid (see skyframe.ts).
const markLevel = () => Number(field("marks").dataset.level);

const DEG = Math.PI / 180;
// Looking south, a little above the horizon, 100° across the view's height, as the sky figure's camera measures it.
const camera: SkyCamera = { yaw: 180 * DEG, pitch: 25 * DEG, fov: 100 * DEG };

const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
    const l = Math.hypot(...a);
    return [a[0] / l, a[1] / l, a[2] / l];
};

// The forward maps from a texture's coordinates to the sphere, for the texels' solid angles in the status line.
function cubePoint(face: number, s: number, t: number): Vec3 {
    return (
        [
            [1, -t, -s],
            [-1, -t, s],
            [s, 1, t],
            [s, -1, -t],
            [s, -t, 1],
            [-s, -t, -1],
        ] as Vec3[]
    )[face] as Vec3;
}
function sphereFromCube([x, y, z]: Vec3): Vec3 {
    const [xx, yy, zz] = [x * x, y * y, z * z];
    return [
        x * Math.sqrt(1 - yy / 2 - zz / 2 + (yy * zz) / 3),
        y * Math.sqrt(1 - zz / 2 - xx / 2 + (zz * xx) / 3),
        z * Math.sqrt(1 - xx / 2 - yy / 2 + (xx * yy) / 3),
    ];
}
/** The direction at texture coordinates u, v in [0, 1], on a cube map's `layer`; null outside the projection. */
function directionOf(projection: Projection, layer: number, u: number, v: number): Vec3 | null {
    switch (projection) {
        case "cube":
            return normalize(cubePoint(layer, 2 * u - 1, 2 * v - 1));
        case "cubified":
            return sphereFromCube(cubePoint(layer, 2 * u - 1, 2 * v - 1));
        case "equirectangular": {
            const azimuth = u * 2 * Math.PI;
            const zenith = v * Math.PI;
            return [Math.sin(zenith) * Math.sin(azimuth), Math.sin(zenith) * Math.cos(azimuth), Math.cos(zenith)];
        }
        case "octahedral": {
            const [qx, qy] = [1 - 2 * u, 1 - 2 * v];
            const z = 1 - Math.abs(qx) - Math.abs(qy);
            if (z >= 0) return normalize([qx, qy, z]);
            const sign = (a: number) => (a >= 0 ? 1 : -1);
            return normalize([(1 - Math.abs(qy)) * sign(qx), (1 - Math.abs(qx)) * sign(qy), z]);
        }
        case "sphere": {
            const [qx, qy] = [1 - 2 * u, 1 - 2 * v];
            const rr = qx * qx + qy * qy;
            if (rr > 1) return null;
            const s = 2 * Math.sqrt(1 - rr);
            return [qx * s, qy * s, 1 - 2 * rr];
        }
        case "fisheye": {
            const [qx, qy] = [1 - 2 * u, 1 - 2 * v];
            const r = Math.hypot(qx, qy);
            if (r > 1) return null;
            const zenith = (r * Math.PI) / 2;
            return r === 0 ? [0, 0, 1] : [(qx / r) * Math.sin(zenith), (qy / r) * Math.sin(zenith), Math.cos(zenith)];
        }
    }
}

type Stats = { texels: number; above: number; ratio: number; sampled: boolean };
const statsCache = new Map<string, Stats>();

/** Texels in all, above the horizon, and the largest's solid angle over the smallest's, of the texels wholly inside. */
function statsOf(projection: Projection, size: Size): Stats {
    const key = `${projection},${sizeOf(projection, size)}`;
    const cached = statsCache.get(key);
    if (cached) return cached;
    const [width, height] = sizeOf(projection, size);
    // HD and UHD, millions of texels, every stride-th row and column, the edges always, where the extremes lie, and
    // from L on fewer points a texel, which hardly varies across. All points are moved off the texel's symmetric grid, unequally
    // across and down: on it, some fall onto the octahedral's edges, where the map has a kink.
    const stride = large(size) ? Math.ceil(Math.sqrt((width * height * layers(projection)) / 250_000)) : 1;
    const k = large(size) ? 2 : size === "l" ? 3 : 6;
    const h = 1e-4;
    const visit = (n: number) => [
        ...new Set([...Array(Math.ceil(n / stride)).keys()].map((i) => i * stride).concat(n - 1)),
    ];
    let [above, counted, smallest, largest] = [0, 0, Number.POSITIVE_INFINITY, 0];
    for (let layer = 0; layer < layers(projection); ++layer) {
        for (const y of visit(height)) {
            for (const x of visit(width)) {
                ++counted;
                const center = directionOf(projection, layer, (x + 0.5) / width, (y + 0.5) / height);
                if (center && center[2] > 0) ++above;
                // The solid angle by the map's Jacobian at k by k points of the texel, in texels.
                let solidAngle = 0;
                let whole = true;
                for (let j = 0; j < k && whole; ++j) {
                    for (let i = 0; i < k; ++i) {
                        const [u, v] = [(x + (i + 0.5) / k + 0.001) / width, (y + (j + 0.5) / k + 0.0023) / height];
                        const d = directionOf(projection, layer, u, v);
                        const du = directionOf(projection, layer, u + h / width, v);
                        const dv = directionOf(projection, layer, u, v + h / height);
                        if (!d || !du || !dv) {
                            whole = false;
                            break;
                        }
                        const a: Vec3 = [(du[0] - d[0]) / h, (du[1] - d[1]) / h, (du[2] - d[2]) / h];
                        const b: Vec3 = [(dv[0] - d[0]) / h, (dv[1] - d[1]) / h, (dv[2] - d[2]) / h];
                        solidAngle += Math.hypot(...cross(a, b)) / (k * k);
                    }
                }
                if (!whole) continue;
                smallest = Math.min(smallest, solidAngle);
                largest = Math.max(largest, solidAngle);
            }
        }
    }
    const texels = width * height * layers(projection);
    const stats = {
        texels,
        above: Math.round((above / counted) * texels),
        sampled: stride > 1,
        ratio: largest / smallest,
    };
    statsCache.set(key, stats);
    return stats;
}

/** An even spread's texels per steradian: the texels covering what the projection covers, over its solid angle. */
function evenTexelsPerSr(projection: Projection, size: Size) {
    const [width, height] = sizeOf(projection, size);
    const texels = width * height * layers(projection);
    if (projection === "fisheye") return ((Math.PI / 4) * texels) / (2 * Math.PI);
    if (projection === "sphere") return ((Math.PI / 4) * texels) / (4 * Math.PI);
    return texels / (4 * Math.PI);
}

// Where the compass directions and the zenith show, as stored, in [0, 1] of the panel.
type Mark = [string, number, number];
const FLAT_MARKS: Record<Projection, Mark[]> = {
    // The faces in a row, each named by where it looks.
    cube: ["N", "E", "S", "W", "zenith", "nadir"].map((name, slot): Mark => [name, (slot + 0.5) / 6, 0.5]),
    cubified: [],
    equirectangular: [
        ["N", 0, 0.5],
        ["E", 0.25, 0.5],
        ["S", 0.5, 0.5],
        ["W", 0.75, 0.5],
        ["N", 1, 0.5],
        ["zenith", 0.5, 0],
        ["nadir", 0.5, 1],
    ],
    octahedral: [
        ["N", 0.5, 0],
        ["E", 0, 0.5],
        ["S", 0.5, 1],
        ["W", 1, 0.5],
        ["zenith", 0.5, 0.5],
    ],
    fisheye: [
        ["N", 0.5, 0],
        ["E", 0, 0.5],
        ["S", 0.5, 1],
        ["W", 1, 0.5],
        ["zenith", 0.5, 0.5],
    ],
    // The horizon at sin 45° of the radius, the nadir all round the rim.
    sphere: [
        ["N", 0.5, 0.1464],
        ["E", 0.1464, 0.5],
        ["S", 0.5, 0.8536],
        ["W", 0.8536, 0.5],
        ["zenith", 0.5, 0.5],
    ],
};
FLAT_MARKS.cubified = FLAT_MARKS.cube;
const VIEW_MARKS: [string, Vec3][] = [
    ["N", [0, 1, 0]],
    ["E", [1, 0, 0]],
    ["S", [0, -1, 0]],
    ["W", [-1, 0, 0]],
    ["zenith", [0, 0, 1]],
    ["nadir", [0, 0, -1]],
];

function placeMarks(panel: string, marks: Mark[]) {
    const holder = find(".projections-marks", stage(panel));
    holder.replaceChildren(
        ...marks.map(([text, x, y]) => {
            const span = document.createElement("span");
            span.textContent = text;
            // Within the panel, by half a mark at the edges.
            span.style.left = `${Math.min(Math.max(x, 0.03), 0.97) * 100}%`;
            span.style.top = `${Math.min(Math.max(y, 0.06), 0.94) * 100}%`;
            return span;
        }),
    );
}

function showMarks(projection: Projection) {
    placeMarks("flat", FLAT_MARKS[projection]);
    // Projected as the shader projects, kept where they fall within the view.
    const canvas = canvasOf("inside");
    const [width, height] = [canvas.clientWidth || 1, canvas.clientHeight || 1];
    const basis = cameraBasis(camera, width / height);
    const marks: Mark[] = [];
    for (const [text, d] of markLevel() >= 1 ? VIEW_MARKS : []) {
        const at = project(d, basis, width, height);
        if (at && at.x > 0 && at.x < width && at.y > 0 && at.y < height)
            marks.push([text, at.x / width, at.y / height]);
    }
    placeMarks("inside", marks);
}

// The calls that compute the shown texture, at most 80 columns.
function call(projection: Projection, [width, height]: [number, number]) {
    const cube = layers(projection) === 6;
    const format = '    format: "rgba16float",';
    const options = {
        cube: [],
        cubified: ["cubify: true,"],
        equirectangular: ['projection: "equirectangular",'],
        octahedral: ['projection: "octahedral",'],
        fisheye: ['projection: "fisheye",'],
        sphere: ['projection: "sphere",'],
    }[projection];
    return [
        "const texture = device.createTexture({",
        `    size: [${width}, ${height}${cube ? ", 6" : ""}],`,
        format,
        "    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,",
        "});",
        `const pass = await sky.${cube ? "createCubePass" : "createPanoramaPass"}({`,
        ...options.map((line) => `    ${line}`),
        format,
        "    samples: 8,",
        "    scaled: true, // half floats hold the night as finely as the day",
        "});",
        "pass.encode(encoder, texture);",
        "const scale = sky.skyViewScale; // read now: cd/m² = texel / scale",
    ].join("\n");
}

type Panel = { context: GPUCanvasContext; params: GPUBuffer };
let panels: Record<"flat" | "inside", Panel> | null = null;
let pipelines: { meter: GPUComputePipeline; display: GPUComputePipeline; layout: GPUBindGroupLayout } | null = null;
let metering: GPUBuffer | null = null;
let sampler: GPUSampler | null = null;
let noCube: GPUTexture | null = null;
// Params: a mat3x3f, twelve scalars, then three vec3f with a scalar after each, padded to 16 bytes.
const PARAMS_SIZE = 160;

function setUp() {
    const device = gpuDevice();
    const layout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" },
            },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            {
                binding: 3,
                visibility: GPUShaderStage.COMPUTE,
                storageTexture: { format: "rgba8unorm", viewDimension: "2d" },
            },
            { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { viewDimension: "cube" } },
            { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { viewDimension: "2d" } },
            { binding: 6, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
        ],
    });
    const module = device.createShaderModule({ label: "sternwarte:projections", code: SOURCE });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const create = (entryPoint: string) =>
        device.createComputePipeline({
            label: `sternwarte:projections:${entryPoint}`,
            layout: pipelineLayout,
            compute: { module, entryPoint },
        });
    pipelines = { meter: create("meter"), display: create("display"), layout };
    metering = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE });
    const panel = (name: string): Panel => {
        const context = canvasOf(name).getContext("webgpu");
        if (!context) throw new Error("No WebGPU canvas context");
        context.configure({
            device,
            format: "rgba8unorm",
            alphaMode: "opaque",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
        });
        return {
            context,
            params: device.createBuffer({ size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        };
    };
    panels = { flat: panel("flat"), inside: panel("inside") };
    sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "repeat",
        addressModeV: "clamp-to-edge",
    });
    // A panorama has no cube to bind.
    noCube = device.createTexture({
        size: [1, 1, 6],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
}

// The passes made for a sky pass, one per projection, and the texture built last.
const passes = new WeakMap<SkyPass, Map<Projection, Promise<SkyCubePass | SkyPanoramaPass>>>();
function passFor(sky: SkyPass, projection: Projection) {
    let made = passes.get(sky);
    if (!made) {
        made = new Map();
        passes.set(sky, made);
    }
    let pass = made.get(projection);
    if (!pass) {
        // Scaled by the sky's power of two, so that half floats hold the night as finely as the day.
        const options = { format: "rgba16float", samples: 8, scaled: true } as const;
        pass =
            projection === "cube" || projection === "cubified"
                ? sky.createCubePass({ ...options, cubify: projection === "cubified" })
                : sky.createPanoramaPass({ ...options, projection });
        made.set(projection, pass);
    }
    return pass;
}

let built: { texture: GPUTexture; projection: Projection; sky: Sky; scale: number } | null = null;
let building = false;
// The sunlight where the observer is, in lux, for the disc, read back once per sky.
let sunIlluminance: number[] = [0, 0, 0];
let litBy: Sky | null = null;

async function build(sky: Sky, projection: Projection, size: Size) {
    building = true;
    const pass = await passFor(sky.pass, projection);
    const [width, height] = sizeOf(projection, size);
    const device = gpuDevice();
    const texture = device.createTexture({
        label: `sternwarte:projections:${projection}`,
        size: [width, height, layers(projection)],
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const encoder = device.createCommandEncoder({ label: "sternwarte:projections" });
    pass.encode(encoder, texture);
    device.queue.submit([encoder.finish()]);
    // Only the chosen map at the chosen size is computed, again whenever the sky moves: how long it takes, as the sky
    // figure tells its own, from the submit until the GPU is done.
    const submitted = performance.now();
    device.queue.onSubmittedWorkDone().then(() => {
        const ms = performance.now() - submitted;
        field("timing").textContent = `· computed in ${ms < 10 ? ms.toFixed(1) : Math.round(ms)}\u202fms`;
    });
    built?.texture.destroy();
    // The scale it was written with, read now, before the sky moves on.
    built = { texture, projection, sky, scale: sky.pass.skyViewScale };
    building = false;
    requestDraw();
}

function draw() {
    const sky = currentSky();
    if (!sky) return;
    const projection = chosen("projection", "cube") as Projection;
    const size = chosenSize();
    const [wanted] = sizeOf(projection, size);
    if (!built || built.sky !== sky || built.projection !== projection || built.texture.width !== wanted) {
        if (!building) build(sky, projection, size);
        return;
    }
    if (litBy !== sky) {
        litBy = sky;
        sky.pass.sunIlluminance().then((lux) => {
            sunIlluminance = [...lux];
            requestDraw();
        });
    }
    // Locked, the view looks where the Sun truly is.
    if (pressed("lock")) {
        const [x, y, z] = sky.sunDirection;
        camera.yaw = Math.atan2(x, y);
        camera.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, Math.asin(z)));
    }
    if (!pipelines || !panels || !sampler || !noCube || !metering) setUp();
    if (!pipelines || !panels || !sampler || !noCube || !metering) return;
    const device = gpuDevice();
    const { texture, scale } = built;
    const encoder = device.createCommandEncoder({ label: "sternwarte:projections" });
    let first = true;
    for (const name of ["flat", "inside"] as const) {
        const { context, params } = panels[name];
        const canvas = canvasOf(name);
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
        const data = new ArrayBuffer(PARAMS_SIZE);
        const floats = new Float32Array(data);
        const uints = new Uint32Array(data);
        // The view from inside's own shape for both, so that the stored texture outlines what it shows.
        const inside = canvasOf("inside");
        const { r, u, f, tx, ty, d } = cameraBasis(camera, inside.clientWidth / Math.max(inside.clientHeight, 1));
        floats.set([...r, 0, ...u, 0, ...f, 0]);
        uints.set([texture.width, texture.height, PROJECTIONS.indexOf(projection), name === "inside" ? 1 : 0], 12);
        uints.set([pressed("edges") ? 1 : 0, pressed("density") ? 1 : 0], 16);
        floats[18] = evenTexelsPerSr(projection, size);
        floats[19] = tx;
        floats[22] = ty;
        floats[23] = d;
        uints[20] = ["nearest", "linear", "cubic"].indexOf(chosen("filter", "nearest"));
        uints[21] = ["neutral", "agx", "aces", "clip"].indexOf(display.toneCurve);
        uints[24] = markLevel() === 2 ? 1 : 0;
        floats[25] = dpr;
        floats[26] = (sky.sunAngularDiameter / 2) * DEG;
        floats.set(sky.sunDirection, 28);
        uints[31] = pressed("dither") ? 1 : 0;
        floats.set(sky.apparentSun, 32);
        uints[35] = pressed("sunDisc") ? 1 : 0;
        floats.set(
            sunIlluminance.map((lux) => lux * scale),
            36,
        );
        device.queue.writeBuffer(params, 0, data);
        const bindGroup = device.createBindGroup({
            layout: pipelines.layout,
            entries: [
                { binding: 0, resource: { buffer: params } },
                { binding: 1, resource: texture.createView({ dimension: "2d-array" }) },
                { binding: 2, resource: { buffer: metering } },
                { binding: 3, resource: context.getCurrentTexture().createView() },
                {
                    binding: 4,
                    resource: (layers(projection) === 6 ? texture : noCube).createView({ dimension: "cube" }),
                },
                { binding: 5, resource: texture.createView({ dimension: "2d", arrayLayerCount: 1 }) },
                { binding: 6, resource: sampler },
            ],
        });
        const pass = encoder.beginComputePass({ label: `sternwarte:projections:${name}` });
        // Metered once, through the projection itself, before either view is drawn.
        if (first) {
            pass.setPipeline(pipelines.meter);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(1);
            first = false;
        }
        pass.setPipeline(pipelines.display);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
    }
    device.queue.submit([encoder.finish()]);
    showMarks(projection);
}

function describe() {
    const projection = chosen("projection", "cube") as Projection;
    const dimensions = sizeOf(projection, chosenSize());
    stage("flat").style.setProperty("--aspect", String(ASPECT[projection]));
    find(".projections-legend", root).hidden = !pressed("density");
    const { texels, above, sampled, ratio } = statsOf(projection, chosenSize());
    const shape = layers(projection) === 6 ? `6 faces of ${dimensions[0]}²` : `${dimensions[0]} × ${dimensions[1]}`;
    const count = (n: number) => (n < 1e6 ? n.toLocaleString("en") : `${(n / 1e6).toFixed(1)} million`);
    field("info").textContent =
        `${shape}, ${count(texels)} texels, ${sampled ? "about " : ""}${count(above)} of them above the horizon; ` +
        `the largest covers ${ratio.toFixed(2)} times the solid angle of the smallest`;
    showCode(field("call"), call(projection, dimensions));
}

const requestDraw = onDemand(draw, root);

if (gpu.error) {
    find(".projections-view", root).insertAdjacentHTML("beforebegin", `<p class="note">${gpu.error}</p>`);
} else {
    onSkyView(requestDraw);
    onDisplay(requestDraw);
    for (const input of root.querySelectorAll<HTMLInputElement>("input[type=radio]")) {
        input.addEventListener("change", () => {
            describe();
            requestDraw();
        });
    }
    for (const name of ["edges", "density", "lock", "dither", "sunDisc"]) {
        field(name).addEventListener("click", () => {
            field(name).setAttribute("aria-pressed", String(!pressed(name)));
            describe();
            requestDraw();
        });
    }
    field("marks").addEventListener("click", requestDraw);
    for (const name of ["flat", "inside"]) new ResizeObserver(requestDraw).observe(canvasOf(name));
    lookAround(canvasOf("inside"), camera, {
        onChange: requestDraw,
        onDrag: () => field("lock").setAttribute("aria-pressed", "false"),
    });
    describe();
    requestDraw();
}
