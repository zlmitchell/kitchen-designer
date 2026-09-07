// @ts-check
import {computed, ref, watch} from 'vue';
import {TIMES_OF_DAY, clockOf, sunAt} from '../../scripts/core/daylight.js';

/**
 * The lighting controls: ambient fill, daylight, and exposure.
 *
 * ## Why these three and not a dozen
 *
 * Because they are the three that change what the room IS, and everything else
 * in phase 6 is a property of a fixture rather than of the scene.
 *
 * **Ambient** is the one that makes the rest of the phase visible. The studio
 * globals put a white floor at or over 1.0 before a single lamp is switched on,
 * so a placed can adds a lift you have to look for - the fixtures were built and
 * then hidden behind the fill. Turning it down is what makes them the light in
 * the room.
 *
 * **Daylight** replaces the fixed studio key with the sun at a time of day. The
 * payoff needs no new rendering: wall meshes already cast and receive shadows
 * under studio and a window's opening is a real hole in that geometry, so a low
 * sun throws a real patch across the floor. What was missing was a light from a
 * direction that means anything.
 *
 * **Exposure** is the third because the first two need it. A room with the fill
 * off wants the exposure opened rather than the lamps made dishonestly bright,
 * and ROADMAP.md asks for it by name so that comparing two fixtures is not
 * confounded by tone mapping.
 *
 * ## Not persisted
 *
 * These are view state, not design state - like the camera and the render
 * profile, and unlike a fixture, which is a thing in the room and is saved. Two
 * people opening the same file should see the same kitchen; what time of day
 * they last looked at it is not a property of the kitchen.
 *
 * @param {{three: import('vue').Ref<?Object>}} store The app store, for the viewer.
 */
export function useLighting(store)
{
	/** 0..1. 1 is the scene exactly as every earlier build drew it. */
	const ambient = ref(1);
	const daylightOn = ref(false);
	/** Hours, fractional. Late afternoon, because that is when a window shows. */
	const hour = ref(16);
	/** Degrees. Which way the building faces under the sun. */
	const heading = ref(0);
	const exposure = ref(1);

	const viewer = () => store.three.value;

	function apply()
	{
		const three = viewer();
		if (!three)
		{
			return;
		}
		three.setAmbient(ambient.value);
		three.setDaylight(daylightOn.value ? {hour: hour.value, heading: heading.value} : null);
		three.setExposure(exposure.value);
	}

	// One watcher over all of them rather than four: every change ends in the
	// same three calls, and the viewer holds the state anyway, so there is
	// nothing a per-field watcher could do more cheaply.
	watch([ambient, daylightOn, hour, heading, exposure], apply);
	// And once when the viewer arrives, because it is constructed after this.
	watch(() => store.three.value, apply);

	/** What the sun is doing right now, for the readout. */
	const sun = computed(() => sunAt(hour.value, heading.value));
	const clock = computed(() => clockOf(hour.value));

	/**
	 * Whether the room is lit by anything but placed fixtures.
	 *
	 * The honest warning for the state somebody will reach by accident: ambient
	 * off, daylight off, and no lamp in the design is a black viewport, and a
	 * black viewport reads as a broken app rather than as an unlit room.
	 */
	const dark = computed(() => ambient.value < 0.02
		&& (!daylightOn.value || sun.value.intensity < 0.01));

	function setAmbient(level) {ambient.value = level;}
	function setDaylight(on) {daylightOn.value = on;}
	function setHour(value) {hour.value = value;}
	function setHeading(value) {heading.value = value;}
	function setExposure(value) {exposure.value = value;}

	/** Everything back to the scene as it was before any of this existed. */
	function reset()
	{
		ambient.value = 1;
		daylightOn.value = false;
		hour.value = 16;
		heading.value = 0;
		exposure.value = 1;
	}

	return {
		ambient, daylightOn, hour, heading, exposure,
		sun, clock, dark, times: TIMES_OF_DAY,
		setAmbient, setDaylight, setHour, setHeading, setExposure, reset, apply,
	};
}
