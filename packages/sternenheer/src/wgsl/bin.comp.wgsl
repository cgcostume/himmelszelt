// Every star of the catalog onto the target: where it shows, lifted by the air, how bright, dimmed by it and
// twinkling, how wide its image is, and into which tiles of the target it reaches, so the compose pass sums only the
// stars near each pixel. Requires `params.wgsl`, `camera.wgsl` (dunstkreis'), `glare.wgsl` (helldunkel's) and
// `stars.wgsl`.

@group(0) @binding(0) var<uniform> shParams: ShParams;
@group(0) @binding(1) var<storage, read> shCatalog: array<f32>;
@group(0) @binding(2) var<storage, read_write> shSplats: array<ShSplat>;
@group(0) @binding(3) var<storage, read_write> shTileCounts: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> shTileEntries: array<u32>;

@compute @workgroup_size(64, 1, 1)
fn shBin(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i >= arrayLength(&shCatalog) / SH_STAR_FIELDS) {
        return;
    }
    let p = shParams;
    let magnitude = shStarMagnitude(i);
    if (magnitude > p.magnitudeLimit) {
        return;
    }
    var direction = shStarDirection(i);
    var transmittance = vec3f(1.0);
    var apparentAltitude = shAltitude(direction);
    if ((p.flags & SH_FLAG_AIR) != 0u) {
        direction = shLift(direction);
        apparentAltitude = shAltitude(direction);
        if (apparentAltitude < p.airHorizon) {
            return;
        }
        transmittance = shTransmittance(apparentAltitude);
    }
    if (direction.z < p.horizonZ) {
        return;
    }
    let projected = shProject(direction);
    if (projected.z <= 0.0) {
        return;
    }
    let pixel = projected.xy;
    let light = shIlluminance(magnitude) * p.starLight * shStarColor(i) * transmittance * shTwinkle(i, apparentAltitude);
    let pixelsPerRadian = shPixelsPerRadian(direction, pixel);
    // The image's width in pixels: the point spread's, at least a little over half a pixel, so no star falls between
    // pixels. On the sky it narrows as the view zooms in, and the star brightens, as it does in a telescope.
    let sigma = max(p.psfPixels, 0.6);
    let sigmaRadians = sigma / pixelsPerRadian;
    let peak = 1.0 / (2.0 * SH_PI * sigmaRadians * sigmaRadians);
    let brightest = max(max(light.r, light.g), light.b);
    // Cut where the exposed image falls below the threshold: the Gaussian's radius there, or the veil's.
    let ratio = brightest * peak * p.exposure / p.threshold;
    if (ratio <= 1.0) {
        return;
    }
    var radius = sigma * sqrt(2.0 * log(ratio));
    if (p.glare > 0.0) {
        // The veil's 10 / θ² in degrees of the viewer's field: where it falls to the threshold.
        let degrees = sqrt(10.0 * p.glare * brightest * p.exposure / p.threshold);
        radius = max(radius, degrees / p.screenDegreesPerPixel);
    }
    radius = min(radius, p.maxRadius);
    if (pixel.x + radius < 0.0 || pixel.y + radius < 0.0 || pixel.x - radius > f32(p.width) || pixel.y - radius > f32(p.height)) {
        return;
    }
    shSplats[i] = ShSplat(pixel, sigma, radius, light, peak, pixelsPerRadian, 0.0, 0.0, 0.0);
    let tile = f32(p.tileSize);
    let tilesY = (p.height + p.tileSize - 1u) / p.tileSize;
    let x0 = u32(clamp(floor((pixel.x - radius) / tile), 0.0, f32(p.tilesX - 1u)));
    let x1 = u32(clamp(floor((pixel.x + radius) / tile), 0.0, f32(p.tilesX - 1u)));
    let y0 = u32(clamp(floor((pixel.y - radius) / tile), 0.0, f32(tilesY - 1u)));
    let y1 = u32(clamp(floor((pixel.y + radius) / tile), 0.0, f32(tilesY - 1u)));
    for (var y = y0; y <= y1; y = y + 1u) {
        for (var x = x0; x <= x1; x = x + 1u) {
            let t = y * p.tilesX + x;
            let slot = atomicAdd(&shTileCounts[t], 1u);
            if (slot < p.capacity) {
                shTileEntries[t * p.capacity + slot] = i;
            }
        }
    }
}
