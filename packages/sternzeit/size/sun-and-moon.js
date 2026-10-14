// The chapter's first example, as a user's bundle would hold it: where the Sun and the Moon are, now.
import { fromDate, moon, sun } from "../dist/index.js";

const obs = { latitude: 52.39, longitude: 13.09 };
const now = fromDate(new Date());
export const toSun = sun.direction(now, obs);
export const toMoon = moon.direction(now, obs);
