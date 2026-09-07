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
import {WINDOW_SCHEMA} from '../src/scripts/items/generated/window.js';
import CATALOG from '../src/catalog/catalog.json';

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

describe('a field that is hidden UNLESS something is true', () =>
{
	beforeEach(() => resetAll());

	// `when` cannot tell "set to false" from "not mentioned", and an optional
	// flag is routinely not mentioned. A window's height and sill were written
	// `when: {fullHeight: false}` and every catalog window omits the flag, so
	// `undefined === false` was false and the two size fields the panel exists to
	// offer never rendered. Nothing failed; the panel just had fewer rows in it.

	it('shows the field when the flag is absent', () =>
	{
		const {wrapper} = panelFor({kind: 'window', type: 'double-hung', width: 91.44,
			height: 152.4, sillHeight: 81.28, wallThickness: 11.43});
		expect(fieldNamed(wrapper, 'Opening height')).toBeTruthy();
		expect(fieldNamed(wrapper, 'Sill height')).toBeTruthy();
	});

	it('shows it when the flag is explicitly false', () =>
	{
		const {wrapper} = panelFor({kind: 'window', type: 'double-hung', width: 91.44,
			height: 152.4, sillHeight: 81.28, wallThickness: 11.43, fullHeight: false});
		expect(fieldNamed(wrapper, 'Opening height')).toBeTruthy();
		expect(fieldNamed(wrapper, 'Sill height')).toBeTruthy();
	});

	it('hides it only when the flag is actually true', () =>
	{
		// Floor to ceiling: both numbers belong to the wall, so neither is a choice.
		const {wrapper} = panelFor({kind: 'window', type: 'fixed', width: 91.44,
			height: 152.4, sillHeight: 81.28, wallThickness: 11.43, fullHeight: true});
		expect(fieldNamed(wrapper, 'Opening height')).toBeFalsy();
		expect(fieldNamed(wrapper, 'Sill height')).toBeFalsy();
		// The flag's own control stays, or there is no way back.
		expect(fieldNamed(wrapper, 'Floor to ceiling')).toBeTruthy();
	});
});

describe('a window offers the same style controls as a door and a cabinet', () =>
{
	beforeEach(() => resetAll());

	it('offers all three sizes, not just the width', () =>
	{
		const {wrapper} = panelFor({kind: 'window', type: 'double-hung', width: 91.44,
			height: 152.4, sillHeight: 81.28, wallThickness: 11.43, fullHeight: false});
		['Opening width', 'Opening height', 'Sill height'].forEach((label) =>
		{
			expect(fieldNamed(wrapper, label), label).toBeTruthy();
		});
	});

	it('carries a scope control, because the grille is a style', () =>
	{
		// The scope row only appears when a schema has at least one `shared` field,
		// and no window field had one - so the panel offered no way to put the same
		// glazing bars in every window, which is the only way anybody would want
		// them. A house with colonial bars in one window and none in the next is a
		// mistake, not a design.
		const {wrapper} = panelFor({kind: 'window', type: 'double-hung', width: 91.44,
			height: 152.4, wallThickness: 11.43});
		expect(wrapper.text()).toContain('This room');
	});

	it('marks the grille and every finish as shared, and the size as not', () =>
	{
		const shared = {};
		WINDOW_SCHEMA.fields.forEach((field) => {shared[field.key] = Boolean(field.shared);});
		expect(shared['grille.pattern']).toBe(true);
		expect(shared['material.glass']).toBe(true);
		expect(shared['material.sash']).toBe(true);
		expect(shared['material.hardware']).toBe(true);
		// A size belongs to the opening it was measured from. Only a LOOK travels.
		expect(shared.width).toBe(false);
		expect(shared.height).toBe(false);
		expect(shared.sillHeight).toBe(false);
		// And what the window IS stays local, the way a door's operation does.
		expect(shared.type).toBe(false);
	});
});

describe('a material control shows what the item is actually made of', () =>
{
	beforeEach(() => resetAll());

	/** The value the select for a named field is showing. */
	function finishOn(wrapper, label)
	{
		const field = fieldNamed(wrapper, label);
		return field ? field.find('select').element.value : null;
	}

	// A spec names a finish only for the slots somebody has CHANGED -
	// `materialsForSlots` keeps the builder's answer for every slot the spec is
	// silent about - so an item straight out of the catalog has no `material`
	// block at all, and every one of its finish dropdowns rendered with no option
	// selected. A blank Glazing control on a window built and drawn in clear
	// glass. Every generated kind did it.

	it('falls back to the builder default when the spec names no finish', () =>
	{
		const {wrapper} = panelFor({kind: 'window', type: 'double-hung', width: 91.44,
			height: 152.4, wallThickness: 11.43});
		expect(finishOn(wrapper, 'Glazing')).toBe('glass-clear');
		expect(finishOn(wrapper, 'Sash')).toBe('paint-white');
		expect(finishOn(wrapper, 'Hardware')).toBe('metal-brushed-nickel');
	});

	it('shows what the spec names, when it names one', () =>
	{
		const {wrapper} = panelFor({kind: 'window', type: 'double-hung', width: 91.44,
			height: 152.4, wallThickness: 11.43,
			material: {glass: 'glass-frosted'}});
		expect(finishOn(wrapper, 'Glazing')).toBe('glass-frosted');
		// And a slot it stays silent about still shows the default.
		expect(finishOn(wrapper, 'Sash')).toBe('paint-white');
	});

	it('falls back for an id this build has retired, rather than going blank', () =>
	{
		// A saved design outlives the library. `materialsForSlots` builds it with
		// the default; the panel should say so, not show an empty control naming a
		// finish that no longer exists.
		const {wrapper} = panelFor({kind: 'window', type: 'double-hung', width: 91.44,
			height: 152.4, wallThickness: 11.43,
			material: {glass: 'no-such-finish'}});
		expect(finishOn(wrapper, 'Glazing')).toBe('glass-clear');
	});

	it('leaves no finish blank on any generated item in the catalog', () =>
	{
		// The sweep, because this was never about windows. Seven builders, and the
		// panel could not name the default for any of them.
		const seen = new Set();
		const blank = [];
		CATALOG.items.filter((entry) => entry.format === 'generated').forEach((entry) =>
		{
			if (seen.has(entry.model)) {return;}
			seen.add(entry.model);
			const {wrapper} = panelFor(entry.spec);
			wrapper.findAll('.field').forEach((field) =>
			{
				const select = field.find('select');
				if (!select.exists() || !select.element.querySelector('optgroup')) {return;}
				if (!select.element.value) {blank.push(`${entry.name}: ${field.text().split('\n')[0]}`);}
			});
		});
		expect(seen.size).toBeGreaterThan(4);
		expect(blank).toEqual([]);
	});
});
