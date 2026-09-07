// @vitest-environment jsdom
/**
 * The lighting menu opens, and its controls reach the app.
 *
 * Written because it did not. The trigger was wrapped in `AppTip`, which is
 * itself a `TooltipTrigger as-child` - so two components were merging props onto
 * the same single element and the popover's own handler did not survive it. The
 * button rendered, looked right, and did nothing when clicked, which is the
 * failure mode a screenshot cannot tell from a working menu.
 *
 * So the assertion that matters is not "the button exists". It is **click it and
 * the controls appear**, and then **move a control and the event carries the
 * value**. `spec-inspector.test.js` pins a panel the same way and for the same
 * reason.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {mount} from '@vue/test-utils';
import LightingMenu from '../src/app/components/LightingMenu.vue';
import {TIMES_OF_DAY} from '../src/scripts/core/daylight.js';

/** Reka renders the content in a portal, so it lands on the body, not the wrapper. */
const inBody = (selector) => Array.from(document.body.querySelectorAll(selector));
const labelled = (label) => inBody(`[aria-label="${label}"]`)[0] || null;

/** Mounted attached to the document, or the portal has nowhere to go. */
function open(props)
{
	const panel = mount(LightingMenu, {
		attachTo: document.body,
		props: Object.assign({
			ambient: 1, daylight: false, hour: 16, heading: 0, exposure: 1,
			clock: '16:00', dark: false, studio: true, times: TIMES_OF_DAY,
		}, props),
	});
	return panel;
}

afterEach(() =>
{
	document.body.innerHTML = '';
});

describe('the lighting menu', () =>
{
	it('opens when the trigger is clicked', async () =>
	{
		const panel = open();
		// Shut, there is nothing but the trigger.
		expect(labelled('Ambient fill')).toBeNull();

		await panel.get('button[title="Lighting"]').trigger('click');
		await new Promise((resolve) => {setTimeout(resolve, 0);});

		// This is the assertion the AppTip nesting failed. Everything below it
		// depends on the menu actually being open, so they all failed with it -
		// which is why one broken wrapper looked like "the feature does nothing".
		expect(labelled('Ambient fill'), 'the menu opened').not.toBeNull();
		expect(labelled('Exposure')).not.toBeNull();
		panel.unmount();
	});

	it('carries the ambient value out as a number', async () =>
	{
		const panel = open();
		await panel.get('button[title="Lighting"]').trigger('click');
		await new Promise((resolve) => {setTimeout(resolve, 0);});

		const slider = /** @type {HTMLInputElement} */ (labelled('Ambient fill'));
		slider.value = '0.2';
		slider.dispatchEvent(new window.Event('input', {bubbles: true}));
		await panel.vm.$nextTick();

		const sent = panel.emitted('set-ambient');
		expect(sent).toBeTruthy();
		// A number, not the string an input gives up. The viewer clamps and
		// multiplies with it, and `'0.2' * base` is NaN territory one operator away.
		expect(sent[sent.length - 1][0]).toBeCloseTo(0.2, 6);
		expect(typeof sent[sent.length - 1][0]).toBe('number');
		panel.unmount();
	});

	it('turns the sun on, and only then offers a time of day', async () =>
	{
		const off = open({daylight: false});
		await off.get('button[title="Lighting"]').trigger('click');
		await new Promise((resolve) => {setTimeout(resolve, 0);});
		// No hour control while the sun is off: it would be a slider with nothing
		// to move.
		expect(labelled('Time of day')).toBeNull();

		const sun = inBody('button').find((button) => button.textContent.trim() === 'Sun');
		expect(sun).toBeTruthy();
		sun.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
		await off.vm.$nextTick();
		expect(off.emitted('set-daylight')[0]).toEqual([true]);
		off.unmount();
		document.body.innerHTML = '';

		// And with it on, the hour and the heading are there.
		const on = open({daylight: true});
		await on.get('button[title="Lighting"]').trigger('click');
		await new Promise((resolve) => {setTimeout(resolve, 0);});
		expect(labelled('Time of day')).not.toBeNull();
		expect(labelled('Which way the building faces')).not.toBeNull();
		on.unmount();
	});

	it('offers no sliders at all under classic, and says why', async () =>
	{
		// Classic's walls are MeshBasicMaterial and cannot be lit. A slider that
		// does nothing is worse than a sentence explaining that it would.
		const panel = open({studio: false});
		await panel.get('button[title="Lighting"]').trigger('click');
		await new Promise((resolve) => {setTimeout(resolve, 0);});

		expect(labelled('Ambient fill')).toBeNull();
		expect(document.body.textContent).toMatch(/Studio/);
		panel.unmount();
	});

	it('warns when nothing is lighting the room', async () =>
	{
		// The state somebody reaches by accident: fill off, sun off, no lamps. A
		// black viewport reads as a broken app rather than as an unlit room.
		const panel = open({ambient: 0, dark: true});
		await panel.get('button[title="Lighting"]').trigger('click');
		await new Promise((resolve) => {setTimeout(resolve, 0);});
		expect(document.body.textContent).toMatch(/Nothing is lighting this room/);
		panel.unmount();
	});
});
