// The browser knows where, not how high: coords.altitude is null on anything but a GPS fix, and ellipsoidal where it
// is not. Open-Meteo's elevation endpoint answers with the Copernicus DEM (90 m grid) above sea level, no key needed;
// it is asked only when the location button is pressed, and a failure just leaves the height as it was.
export async function lookupElevation(latitude: number, longitude: number) {
    try {
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${latitude}&longitude=${longitude}`;
        const answer = await (await fetch(url)).json();
        const elevation = answer?.elevation?.[0];
        return typeof elevation === "number" ? Math.max(0, Math.round(elevation)) : null;
    } catch {
        return null;
    }
}
