/** Where the figures that need no place look from: Earth's center, north up, so the face holds still over a day, without
 *  the parallax and the diurnal libration a place on the surface adds. The place only orients the sky's frame. */
export const ANY_PLACE = { latitude: 0, longitude: 0, heightM: 0, geocentric: true };

/** The Julian Day of a moment `Date.parse` reads, for a figure's own starting moment. */
export const julianDayOf = (moment: string) => Date.parse(moment) / 86_400_000 + 2_440_587.5;
