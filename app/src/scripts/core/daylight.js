// @ts-check

/**
 * Where the sun is, and what colour it is, at a time of day.
 *
 * ROADMAP.md phase 6's last item: "the existing key light becomes a sun with
 * azimuth and altitude from time of day; windows admit a daylight patch;
 * hemisphere drops at night." This is the arithmetic half - pure, no three, no
 * scene - so the sun can be asserted at every hour of the day without a
 * renderer.
 *
 * ## Why this is worth having at all
 *
 * The room is currently lit by a hemisphere at `0.38 * PI` and a key at
 * `0.8 * PI` from a fixed corner, and that is the whole story: it is the same
 * light at every hour, from a direction chosen because it makes a room read as a
 * room rather than because anything is over there. Two things follow, and both
 * are visible in the app right now.
 *
 * A **placed fixture cannot compete with it.** A white floor is already at or
 * over 1.0 before a lamp is switched on, so a 4in can adds a lift you have to
 * look for. Turning the ambient down is what makes the lighting phase pay off,
 * and it is the reason the ambient is a control rather than a constant.
 *
 * And **no window does anything.** The wall meshes already cast and receive
 * shadows under studio (`edge.js`), and a window's opening is a real hole in
 * that geometry - so a directional light coming in at a low angle throws a real
 * patch across the floor with no new code at all. What was missing was a light
 * that came from a *direction that means something*.
 *
 * ## The model, and what it is not
 *
 * A day arc, not an ephemeris. Sunrise at 06:00, sunset at 18:00, the equinox
 * everywhere - no latitude, no date, no equation of time. That is deliberate:
 * the question this answers is "which side of the house is the light coming in,
 * and how warm is it", and a full solar position model would be a great deal of
 * arithmetic to move a shadow by a few degrees. If a real orientation is ever
 * wanted, `heading` is the field it goes in and this is the function to replace.
 *
 * Compass convention: **+x is east and +z is south**, which is what the plan's
 * own axes already are - the floorplanner's y runs down the page and becomes
 * world z. `heading` rotates the building under the sun, so "which side gets the
 * morning light" is one number.
 */

/** Sunrise and sunset, in hours. The equinox, everywhere. */
export const SUNRISE = 6;
export const SUNSET = 18;

/** How high the sun gets at noon, in degrees. A temperate summer, roughly. */
export const NOON_ALTITUDE = 62;

/**
 * The warmest and coolest the sun gets, in kelvin.
 *
 * Low sun is warm because its light has come through more atmosphere - the same
 * scattering that makes the sky blue takes the blue out of the beam. 1900K is a
 * deep sunset; 5400K is noon daylight, which is what a "daylight" lamp is named
 * after.
 */
export const HORIZON_KELVIN = 1900;
export const NOON_KELVIN = 5400;

/**
 * How much hemisphere light there is at night.
 *
 * Not zero. A room with the sun below the horizon and no lamps on should be dim
 * and legible, not black - a modelling tool whose night view is an unusable
 * black rectangle has told the user nothing. This is moonlight-and-streetlight,
 * and it is the floor under the sky term.
 */
export const NIGHT_SKY = 0.05;

const DEG = Math.PI / 180;

/**
 * The sine of the noon altitude, which every other quantity is measured against.
 *
 * Without it `NOON_KELVIN` and full intensity are never actually reached: the
 * sun tops out at 62 degrees, `sin 62` is 0.883, and noon came out at 4990K
 * against a constant that says 5400. Normalising makes the constants mean what
 * they are named - and gives the whole feature a calibration worth having:
 * **daylight at noon is the scene as it was before daylight existed**, and every
 * other hour is a departure from it.
 */
const NOON_SINE = Math.sin(NOON_ALTITUDE * DEG);

/**
 * The sun at a given hour.
 *
 * `altitude` is negative at night, which is the single fact everything else
 * reads: `up` is `altitude > 0`, the intensity is its sine, and the sky term
 * fades through twilight rather than switching off at 18:00 exactly.
 *
 * @param {number} hour 0..24. Wrapped, so 25 is 01:00 rather than an error - it
 *        is a slider's value, and a slider is entitled to run off the end.
 * @param {number} [heading] Degrees to rotate the building under the sun. 0 puts
 *        the plan's -z at north.
 * @returns {{up: boolean, altitude: number, azimuth: number,
 *          direction: {x: number, y: number, z: number}, kelvin: number,
 *          intensity: number, sky: number}} `direction` is a unit vector FROM
 *          the scene TOWARD the sun, so a light goes at `centre + direction * d`.
 */
export function sunAt(hour, heading)
{
	var h = ((Number(hour) || 0) % 24 + 24) % 24;
	var turn = (h - SUNRISE) / (SUNSET - SUNRISE);

	// Zero at sunrise, one at noon, zero at sunset, negative through the night.
	// One expression for the whole 24 hours rather than a daytime branch and a
	// night one, because the interesting states are the ones near the boundary
	// and a branch puts a discontinuity exactly there.
	var altitude = NOON_ALTITUDE * DEG * Math.sin(Math.PI * turn);
	// East at sunrise, south at noon, west at sunset.
	var azimuth = (90 + 180 * turn + (Number(heading) || 0)) * DEG;

	var sinAltitude = Math.sin(altitude);
	var cosAltitude = Math.cos(altitude);
	var up = altitude > 0;

	// Warmth follows how much atmosphere the beam has crossed, which is what the
	// altitude stands for. Held at the horizon value below it so a sun a moment
	// from setting is not a different colour from one a moment after.
	var warmth = Math.max(0, sinAltitude) / NOON_SINE;
	var kelvin = HORIZON_KELVIN + (NOON_KELVIN - HORIZON_KELVIN) * warmth;

	// Twilight. The sky keeps some light for a while after the sun has gone, so
	// the fade runs on the altitude rather than on the clock - which is what
	// makes 18:30 dim and 22:00 dark from the same expression.
	var twilight = Math.max(0, 1 + sinAltitude * 6);
	var sky = Math.max(NIGHT_SKY,
		up ? Math.max(0.25, sinAltitude / NOON_SINE) : NIGHT_SKY + twilight * 0.2);

	return {
		up: up,
		altitude: altitude,
		azimuth: azimuth,
		// +x east, +z south: a sun in the east is at +x, one in the south at +z.
		direction: {
			x: cosAltitude * Math.sin(azimuth),
			y: sinAltitude,
			z: -cosAltitude * Math.cos(azimuth),
		},
		kelvin: kelvin,
		// Below the horizon it contributes nothing at all: a directional light
		// coming up through the floor lights every ceiling in the house.
		intensity: up ? sinAltitude / NOON_SINE : 0,
		sky: sky,
	};
}

/** The hours worth putting on a control, and what they look like. */
export const TIMES_OF_DAY = [
	{hour: 7, label: 'Early morning'},
	{hour: 9, label: 'Morning'},
	{hour: 12, label: 'Midday'},
	{hour: 15, label: 'Afternoon'},
	{hour: 17.5, label: 'Golden hour'},
	{hour: 21, label: 'Night'},
];

/**
 * `hour` as a clock, for a label.
 *
 * @param {number} hour
 * @returns {string} `HH:MM`.
 */
export function clockOf(hour)
{
	var h = ((Number(hour) || 0) % 24 + 24) % 24;
	var whole = Math.floor(h);
	var minutes = Math.round((h - whole) * 60);
	if (minutes === 60)
	{
		whole = (whole + 1) % 24;
		minutes = 0;
	}
	return `${String(whole).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
