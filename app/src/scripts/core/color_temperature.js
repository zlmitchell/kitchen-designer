// @ts-check
import {Color} from 'three';

/**
 * Colour temperature, in kelvin, as a colour.
 *
 * Every fixture in the lighting phase carries a temperature rather than a hex,
 * because that is how lamps are sold and how the choice is actually made: 2700K
 * or 3000K under a cabinet is a real decision, and `#fff1e0` is not a way to
 * express it. One pure function, so it can be tested without a renderer.
 *
 * ## What this is an approximation of
 *
 * A black body at temperature T radiates a spectrum given by Planck's law, and
 * its colour is that spectrum integrated against the CIE observer. That is not
 * something to do per frame, so this is Tanner Helland's piecewise fit to the
 * result - the one every lighting tool uses - which stays within a couple of
 * points of 255 across the range that matters.
 *
 * Two things it is deliberately not:
 *
 *   - **not a physical intensity.** Colour only. A 2700K lamp is not dimmer than
 *     a 5000K one because of its temperature, and folding brightness in here
 *     would make every warm scene darker for no reason. Intensity is the
 *     fixture's lumens, kept separate.
 *   - **not normalised to equal luminance.** The values below peak at white
 *     around 6500K and fall away either side, which is what a black body does.
 *     Comparing two fixtures fairly is the exposure control's job, not this
 *     function's - see the note on `toneMappingExposure` in ROADMAP.md phase 6.
 *
 * ## sRGB, and why that is the honest answer
 *
 * The returned components are sRGB, so `new Color()` is fed the same kind of
 * number a hex literal would be and the renderer's colour management decodes it
 * exactly once. Returning linear values here would look right only while
 * somebody remembered not to decode them again.
 */

/** The range worth offering. Below is candlelight, above is daylight-blue. */
export const MIN_KELVIN = 1500;
export const MAX_KELVIN = 12000;

/** What the fixtures in a kitchen actually come in. */
export const COMMON_TEMPERATURES = [
	{kelvin: 2200, label: 'Candle / filament'},
	{kelvin: 2700, label: 'Warm white'},
	{kelvin: 3000, label: 'Soft white'},
	{kelvin: 3500, label: 'Neutral'},
	{kelvin: 4000, label: 'Cool white'},
	{kelvin: 5000, label: 'Daylight'},
];

function clamp255(value)
{
	return Math.max(0, Math.min(255, value));
}

/**
 * sRGB components, 0..1, for a black body at `kelvin`.
 *
 * @param {number} kelvin Clamped to `MIN_KELVIN`..`MAX_KELVIN`. A value outside
 *        that is a caller's slider being generous, not an error worth throwing
 *        over - the ends of the curve are flat anyway.
 * @returns {{r: number, g: number, b: number}}
 */
export function kelvinToRgb(kelvin)
{
	var t = Math.max(MIN_KELVIN, Math.min(MAX_KELVIN, Number(kelvin) || 0)) / 100;
	var r;
	var g;
	var b;

	if (t <= 66)
	{
		r = 255;
		g = 99.4708025861 * Math.log(t) - 161.1195681661;
		b = (t <= 19) ? 0 : (138.5177312231 * Math.log(t - 10) - 305.0447927307);
	}
	else
	{
		r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
		g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
		b = 255;
	}

	return {
		r: clamp255(r) / 255,
		g: clamp255(g) / 255,
		b: clamp255(b) / 255,
	};
}

/**
 * The same thing as a three `Color`.
 *
 * @param {number} kelvin
 * @param {Color} [target] Written into rather than allocated, for a caller
 *        updating a light every frame.
 * @returns {Color}
 */
export function kelvinToColor(kelvin, target)
{
	var rgb = kelvinToRgb(kelvin);
	var color = target || new Color();
	// setRGB's third argument is the colour space these components are in. Saying
	// sRGB is what makes the value agree with the same colour written as a hex.
	return color.setRGB(rgb.r, rgb.g, rgb.b, 'srgb');
}
