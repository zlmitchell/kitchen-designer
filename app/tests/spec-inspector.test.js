// @vitest-environment jsdom
/**
 * The panel that renders a generated item's schema.
 *
 * The first tests this component has had, and they exist because of a rendering
 * rule that is invisible until it breaks: a `choice` field is a row of pills,
 * `.segmented` is an inline flex row with no wrapping, and every choice in the
 * app was two or three options until a cabinet grew seven face layouts. Then the
 * row ran straight out of the side of the panel - painted outside its own box,
 * with nothing to catch it.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {mount} from '@vue/test-utils';
import SpecInspector from '../src/app/inspector/SpecInspector.vue';
import {resetAll} from './helpers/harness.js';

/** A stand-in for a placed generated item, which is all the panel reads. */
function fakeItem(spec)
{
	return {
		metadata: {spec: Object.assign({}, spec), itemName: 'Thing'},
		getSpec()
		{
			return JSON.parse(JSON.stringify(this.metadata.spec));
		},
		setSpec(next)
		{
			this.metadata.spec = next;
			return true;
		},
	};
}

function panelFor(spec)
{
	const item = fakeItem(spec);
	const wrapper = mount(SpecInspector, {props: {item: item, items: [item]}});
	return {item, wrapper};
}

/** The control rendered for a labelled field, whichever kind it turned out to be. */
function fieldNamed(wrapper, label)
{
	return wrapper.findAll('.field').find((field) => field.text().startsWith(label));
}

describe('a choice with many options', () =>
{
	beforeEach(() => resetAll());

	it('is a dropdown rather than a row that overflows', () =>
	{
		// A cabinet's face layouts: doors, drawer over doors, four bank sizes, a
		// pan bank and custom. Eight pills do not fit a panel this wide, and the
		// row does not wrap - it is simply drawn past the edge.
		const {wrapper} = panelFor({kind: 'cabinet', width: 91.44, layout: 'doors'});
		const face = fieldNamed(wrapper, 'Face');

		expect(face, 'the Face control is rendered').toBeTruthy();
		expect(face.find('select').exists()).toBe(true);
		expect(face.findAll('.segment')).toHaveLength(0);

		wrapper.unmount();
	});

	it('leaves a short choice as a row of pills', () =>
	{
		// Three options is what the segmented control is for, and it should stay.
		const {wrapper} = panelFor({kind: 'cabinet', width: 91.44, layout: 'doors'});
		const type = fieldNamed(wrapper, 'Type');

		expect(type.findAll('.segment').length).toBeGreaterThan(1);
		expect(type.find('select').exists()).toBe(false);

		wrapper.unmount();
	});

	it('writes the choice through when one is picked', () =>
	{
		const {item, wrapper} = panelFor({kind: 'cabinet', width: 91.44, layout: 'doors'});
		const select = fieldNamed(wrapper, 'Face').find('select');

		select.setValue('three-drawers');

		expect(item.metadata.spec.layout).toBe('three-drawers');
		wrapper.unmount();
	});

	it('turns the sink mounts into a dropdown as well', () =>
	{
		// Five, now that semi-recessed is offered - the same row that was about to
		// overflow next.
		const {item, wrapper} = panelFor({
			kind: 'sink', mount: 'undermount', width: 76.2, frontToBack: 47,
		});
		const field = fieldNamed(wrapper, 'Mount');

		expect(field.find('select').exists()).toBe(true);
		field.find('select').setValue('farmhouse');
		expect(item.metadata.spec.mount).toBe('farmhouse');

		wrapper.unmount();
	});

	it('keeps a numeric option a number', () =>
	{
		// A `<select>` deals only in strings, and some of these values are numbers
		// - `doors` is 0, 1 or 2. Storing "2" in a spec leaves whoever reads it to
		// guess, and `doors <= 0` is the guess that decides whether a drawer bank
		// fills its own opening. The pills write the option's own value, and the
		// dropdown has to match them rather than hand back what the DOM said.
		const {item, wrapper} = panelFor({kind: 'cabinet', width: 91.44, layout: 'doors'});
		const doors = fieldNamed(wrapper, 'Doors');

		doors.findAll('.segment')[0].trigger('click');
		expect(typeof item.metadata.spec.doors).toBe('number');

		wrapper.unmount();
	});
});

describe('the drawer layouts a cabinet offers', () =>
{
	beforeEach(() => resetAll());

	it('offers every arrangement a base cabinet is actually built in', () =>
	{
		// Doors, a drawer over doors, banks of two to five, and three over a pan
		// drawer. The builder has taken all of these since it was written; the
		// panel offered `doors` and nothing else.
		const {wrapper} = panelFor({kind: 'cabinet', width: 91.44, layout: 'doors'});
		const labels = fieldNamed(wrapper, 'Face').findAll('option').map((o) => o.text());

		expect(labels).toContain('Doors');
		expect(labels).toContain('Drawer over doors');
		expect(labels).toContain('5 drawers');
		expect(labels).toContain('3 over a pan drawer');
	});

	it('hides the door count once the face is a drawer bank', () =>
	{
		// A bank has no doors, and offering the control there offers a number the
		// layout discards.
		const {wrapper} = panelFor({kind: 'cabinet', width: 91.44, layout: 'four-drawers'});
		expect(fieldNamed(wrapper, 'Doors')).toBeFalsy();
	});

	it('shows it again for a face that has doors', () =>
	{
		const {wrapper} = panelFor({kind: 'cabinet', width: 91.44, layout: 'drawer-over-doors'});
		expect(fieldNamed(wrapper, 'Doors')).toBeTruthy();
	});
});
