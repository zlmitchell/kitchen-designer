// @vitest-environment jsdom
/**
 * The status bar says what the active tool is waiting for.
 *
 * Written for the walk hint, which is the one that cannot be discovered any
 * other way: walking locks the pointer, so there is no cursor to hover with and
 * no tooltip to find. Every other mode has a rail button with a tip on it.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {mount} from '@vue/test-utils';
import StatusBar from '../src/app/components/StatusBar.vue';
import {LAYOUT_PLAN, LAYOUT_VIEW} from '../src/app/composables/useLayout.js';
import {floorplannerModes} from '../src/scripts/floorplanner/floorplanner_view.js';

const bar = (props) => mount(StatusBar, {
	props: Object.assign({
		rooms: 1, walls: 4, items: 0, areaLabel: '20 m²', cursor: null,
		zoom: 100, mode: floorplannerModes.MOVE, layout: LAYOUT_PLAN, unitLabel: 'cm',
	}, props),
});

afterEach(() => {document.body.innerHTML = '';});

describe('the walk hint', () =>
{
	it('names every key a walker has, crouch included', () =>
	{
		// The reason this exists. Nobody guesses a key they cannot see, and crouch
		// is the control that answers "what does this look like from a child's
		// height, and can I see into that base cabinet".
		const text = bar({layout: LAYOUT_VIEW, walkthrough: true}).text();
		expect(text).toContain('W A S D');
		expect(text).toContain('Shift');
		expect(text).toContain('crouch');
		expect(text).toContain('Space');
		expect(text).toContain('Esc');
	});

	it('does not say Ctrl, which closes the tab', () =>
	{
		// Guards the fix as much as the hint: if the binding ever moves back to
		// Ctrl, this is the assertion that objects. Ctrl+W is walk-forward plus
		// the browser's close-tab shortcut.
		expect(bar({layout: LAYOUT_VIEW, walkthrough: true}).text()).not.toContain('Ctrl');
	});

	it('goes back to the orbit hint when the walk ends', () =>
	{
		const text = bar({layout: LAYOUT_VIEW, walkthrough: false}).text();
		expect(text).toContain('orbit');
		expect(text).not.toContain('crouch');
	});

	it('beats the plan hints, because the pointer is locked either way', () =>
	{
		// Walking from the split layout still locks the pointer, so a hint about
		// clicking to place corners would be describing something that cannot
		// happen.
		const text = bar({layout: LAYOUT_PLAN, walkthrough: true,
			mode: floorplannerModes.DRAW}).text();
		expect(text).toContain('crouch');
		expect(text).not.toContain('place corners');
	});
});
