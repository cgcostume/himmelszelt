// Shared by the star passes: where a catalog star stands in the sky and on the target. Requires `params.wgsl`,
// `camera.wgsl`, `air.wgsl` and `seeing.wgsl` (dunstkreis'), and the bindings `shParams`, `shCatalog` (words, the full
// layout's floats as bits), `shFaint` and `shFaintColors` from the pass.

// Which layout each catalog comes in, as the pass sets them: compact, the default, or full. The branches of the one not
// used fold away when the pipeline is made.
override SH_COMPACT_CATALOG: bool = true;
override SH_COMPACT_FAINT: bool = true;
override SH_COMPACT_DEEP: bool = true;

// A packed star: its J2000 equatorial unit vector, its magnitude, 1e30 for an empty slot, and its color index's code,
// hundredths of B-V from -0.5, as `shFaintColors` lists them.
struct ShPacked {
    direction: vec3f,
    magnitude: f32,
    color: u32,
}

// A faint or deep star of the full layout, its two words: the right ascension in 24 bits and the magnitude in 8,
// sixteenths from -2, the declination in 24 bits and the color index in 8. Both words all ones for an empty slot.
fn shFullStar(position: u32, info: u32) -> ShPacked {
    let rightAscension = f32(position & 0xffffffu) * (2.0 * SH_PI / 16777216.0);
    let declination = f32(info & 0xffffffu) * (SH_PI / 16777215.0) - 0.5 * SH_PI;
    let direction = vec3f(cos(declination) * cos(rightAscension), cos(declination) * sin(rightAscension), sin(declination));
    let magnitude = select(f32(position >> 24u) * 0.0625 - 2.0, 1e30, position == 0xffffffffu);
    return ShPacked(direction, magnitude, info >> 24u);
}

// A faint or deep star of the compact layout: its cell of the cube, the six faces cut 8 by 8, its place in it, 16 bits
// across and 16 up, and its codes, the magnitude's in the low 8 bits of `codes` and the color index's in the high 8,
// all ones for an empty slot. No trigonometry: the point on the cube's face, normalized.
fn shCompactStar(cell: u32, place: u32, codes: u32) -> ShPacked {
    let face = cell / 64u;
    let uv = (vec2f(f32(cell % 8u), f32((cell / 8u) % 8u)) + (vec2f(f32(place & 0xffffu), f32(place >> 16u)) + 0.5) / 65536.0) * 0.25 - 1.0;
    var point = vec3f(select(1.0, -1.0, (face & 1u) == 1u), uv);
    if (face / 2u == 1u) {
        point = point.zxy;
    } else if (face / 2u == 2u) {
        point = point.yzx;
    }
    let magnitude = select(f32(codes & 0xffu) * 0.0625 - 2.0, 1e30, codes == 0xffffu);
    return ShPacked(normalize(point), magnitude, codes >> 8u);
}

// The codes of the `local`th star of a compact block from its word of codes. A block is `SH_BLOCK_WORDS` words: its
// cell, its 64 stars' places, then their codes, two stars a word.
fn shBlockCodes(word: u32, local: u32) -> u32 {
    return (word >> ((local & 1u) * 16u)) & 0xffffu;
}

// Stars from the catalog's count on are the faint ones, in `shFaint`.
fn shCatalogCount() -> u32 {
    return arrayLength(&shCatalog) / select(SH_STAR_FIELDS, SH_COMPACT_STAR_WORDS, SH_COMPACT_CATALOG);
}

fn shStarIsFaint(i: u32) -> bool {
    return i >= shCatalogCount();
}

fn shFaintStar(i: u32) -> ShPacked {
    let j = i - shCatalogCount();
    if (SH_COMPACT_FAINT) {
        let base = (j / 64u) * SH_BLOCK_WORDS;
        let local = j % 64u;
        return shCompactStar(shFaint[base], shFaint[base + 1u + local], shBlockCodes(shFaint[base + 65u + local / 2u], local));
    }
    return shFullStar(shFaint[j * 2u], shFaint[j * 2u + 1u]);
}

// A catalog star's J2000 equatorial vector, moved by its proper motion over `shParams.years`.
fn shCatalogDirection(i: u32) -> vec3f {
    var rightAscension = 0.0;
    var declination = 0.0;
    if (SH_COMPACT_CATALOG) {
        let at = i * SH_COMPACT_STAR_WORDS;
        let motion = shCatalog[at + 2u];
        // Milliarcseconds a year, Int16 each, over the years, in radians.
        let moved = vec2f(f32(bitcast<i32>(motion << 16u) >> 16u), f32(bitcast<i32>(motion) >> 16u)) * (shParams.years * SH_PI / 648000000.0);
        let declination0 = f32(shCatalog[at + 1u] & 0x7fffffu) * (SH_PI / 8388607.0) - 0.5 * SH_PI;
        declination = declination0 + moved.y;
        rightAscension = f32(shCatalog[at] & 0x3fffffu) * (2.0 * SH_PI / 4194304.0) + moved.x / max(cos(declination0), 1e-6);
    } else {
        let at = i * SH_STAR_FIELDS;
        let fields = bitcast<vec4f>(vec4u(shCatalog[at + 1u], shCatalog[at + 2u], shCatalog[at + 3u], shCatalog[at + 4u]));
        declination = radians(fields.y + fields.w * shParams.years / 3600.0);
        rightAscension = radians(fields.x + fields.z * shParams.years / 3600.0 / max(cos(radians(fields.y)), 1e-6));
    }
    return vec3f(cos(declination) * cos(rightAscension), cos(declination) * sin(rightAscension), sin(declination));
}

// A star's direction in the observer's frame, ENU.
fn shStarDirection(i: u32) -> vec3f {
    var equatorial: vec3f;
    if (shStarIsFaint(i)) {
        equatorial = shFaintStar(i).direction;
    } else {
        equatorial = shCatalogDirection(i);
    }
    return normalize(shParams.skyRotation * equatorial);
}

fn shStarMagnitude(i: u32) -> f32 {
    if (shStarIsFaint(i)) {
        return shFaintStar(i).magnitude;
    }
    if (SH_COMPACT_CATALOG) {
        return f32(shCatalog[i * SH_COMPACT_STAR_WORDS] >> 22u) * 0.01 - 2.0;
    }
    return bitcast<f32>(shCatalog[i * SH_STAR_FIELDS]);
}

fn shStarColor(i: u32) -> vec3f {
    if (shStarIsFaint(i)) {
        return max(shFaintColors[shFaintStar(i).color].rgb, vec3f(0.0));
    }
    if (SH_COMPACT_CATALOG) {
        return max(shFaintColors[shCatalog[i * SH_COMPACT_STAR_WORDS + 1u] >> 23u].rgb, vec3f(0.0));
    }
    let at = i * SH_STAR_FIELDS;
    return max(bitcast<vec3f>(vec3u(shCatalog[at + 5u], shCatalog[at + 6u], shCatalog[at + 7u])), vec3f(0.0));
}

// The illuminance at the eye of a star of apparent magnitude `magnitude`, in lux, above the air.
fn shIlluminance(magnitude: f32) -> f32 {
    return SH_MAGNITUDE_ZERO_LUX * pow(10.0, -0.4 * magnitude);
}


// The ray through a point of the target, in pixels from its top left corner, on dunstkreis' camera.
fn shPixelRay(position: vec2f) -> vec3f {
    let uv = position / vec2f(f32(shParams.width), f32(shParams.height));
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(shParams.inverseViewProjection, ndc, clamp(shParams.projectionDistance, 0.0, 1.0));
}

// A point of the image plane, by clip-space coordinates, from the eye: the plane halfway into the depth range.
fn shPlanePoint(ndc: vec2f) -> vec3f {
    let p = shParams.inverseViewProjection;
    let eye = p[2].xyz / p[2].w;
    let point = p * vec4f(ndc, 0.5, 1.0);
    return point.xyz / point.w - eye;
}

// Where a direction shows on the target, in pixels, and whether it shows at all: behind what the projection reaches
// for a third value of 0 or less, past 90° from the axis only for a rectilinear view, further the more it bends. The
// inverse of `dkProjectRay`: the angle from the axis to the image plane's radius.
fn shProject(direction: vec3f) -> vec3f {
    let center = shPlanePoint(vec2f(0.0));
    let right = shPlanePoint(vec2f(1.0, 0.0)) - center;
    let up = shPlanePoint(vec2f(0.0, 1.0)) - center;
    let forward = normalize(center);
    let along = dot(direction, forward);
    let d = clamp(shParams.projectionDistance, 0.0, 1.0);
    // Behind the camera: past 90° from the axis for a rectilinear view, past where the bent projection runs out.
    if (d + along <= 1e-6) {
        return vec3f(0.0, 0.0, -1.0);
    }
    let offset = direction - forward * along;
    let sinTheta = length(offset);
    let rho = (d + 1.0) * sinTheta / (d + along);
    var point = center;
    if (sinTheta > 1e-9) {
        point = center + offset / sinTheta * (rho * length(center));
    }
    let a = dot(point - center, right) / dot(right, right);
    let b = dot(point - center, up) / dot(up, up);
    return vec3f((a + 1.0) * 0.5 * f32(shParams.width), (1.0 - b) * 0.5 * f32(shParams.height), d + along);
}

// How many pixels a radian of sky spans at a direction: the image of a direction turned a little.
fn shPixelsPerRadian(direction: vec3f, pixel: vec2f) -> f32 {
    let center = normalize(shPlanePoint(vec2f(0.0)));
    var across = cross(direction, center);
    if (length(across) < 1e-4) {
        across = cross(direction, vec3f(0.0, 0.0, 1.0));
    }
    if (length(across) < 1e-4) {
        across = cross(direction, vec3f(1.0, 0.0, 0.0));
    }
    let turned = normalize(direction + normalize(across) * 1e-3);
    return length(shProject(turned).xy - pixel) / 1e-3;
}

// The size of the halos' grid in texels: the target and its margin, at the grid's scale.
fn shHaloSize() -> vec2u {
    return (vec2u(shParams.width, shParams.height) + 2u * SH_HALO_MARGIN + SH_HALO_SCALE - 1u) / SH_HALO_SCALE;
}
