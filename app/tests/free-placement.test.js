// @vitest-environment jsdom
/**
 * An item on no wall at all (phase 3b, the unbuilt half).
 *
 * `WallItem` binds by distance: `closestWallEdge` takes the nearest half edge
 * and `changeWallEdge` sets `rotation.y` from that edge's normal. There is no
 * answer of "none of them" - so an island, which is a run with a counter, doors
 * on more than one side and NOTHING behind it, gets attached to whichever wall
 * of the room it happens to be least far from, and comes out square to a wall
 * three metres away with no way to turn it. A wall-bound item has `allowRotate`
 * off, because a rotation control would write a number the next bind discards.
 *
 * Free placement is therefore the absence of four things, and each of them is
 * pinned below because leaving any one in place produces a plausible wrong
 * answer: the rotation from the normal, the `boundMove` onto the wall plane, the
 * re-bind on drag, and membership of the wall's item list.
 *
 * The trap that is not obvious from that list: `visible`. A bound item does not
 * own that flag - `Edge` drives it through `updateEdgeVisibility` so the wall
 * you look through fades - and it does so by walking the wall's item lists. An
 * item that leaves those lists while the near face is hidden keeps
 * `visible === false` with nothing left that would ever set it back.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mount} from '@vue/test-utils';
import * as THREE from 'three';
import ItemInspector from '../src/app/inspector/ItemInspector.vue';
import {Model} from '../src/scripts/model/model.js';
import {FREE_STANDING} from '../src/scripts/items/wall_item.js';
import {resetAll, stubItemLoader} from './helpers/harness.js';
import {installCanvas2D} from './helpers/dom.js';

/** A four-metre room, so every wall is a long way from the middle of it. */
function design(items)
{
	return JSON.stringify({
		floorplan: {
			corners: {
				c1: {x: 0, y: 0, elevation: 0}, c2: {x: 400, y: 0, elevation: 0},
				c3: {x: 400, y: 400, elevation: 0}, c4: {x: 0, y: 400, elevation: 0},
			},
			walls: [
				{corner1: 'c1', corner2: 'c2'}, {corner1: 'c2', corner2: 'c3'},
				{corner1: 'c3', corner2: 'c4'}, {corner1: 'c4', corner2: 'c1'},
			],
			rooms: {}, units: 'cm', version: '2.0.0',
		},
		items: items,
	});
}

/**
 * One cabinet-shaped thing. Type 9 is `WallFloorItem` - on a wall, on the floor
 * - which is what a base cabinet and an appliance are, and is one of the two
 * types the roadmap names as wanting free placement.
 */
function cabinet(over)
{
	return Object.assign({
		item_name: 'base', item_type: 9, model_url: 'base.glb', format: 'gltf',
		xpos: 200, ypos: 25, zpos: 200, rotation: 0,
		scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
	}, over || {});
}

let model;

beforeEach(() =>
{
	resetAll();
	installCanvas2D(window);
	model = new Model('/');
	model.scene.setItemLoader(stubItemLoader(THREE));
});

afterEach(() => {model = null;});

describe('an item that binds to no wall', () =>
{
	it('is bound to some wall without it, which is the thing being fixed', () =>
	{
		model.loadSerialized(design([cabinet()]));
		const item = model.scene.getItems()[0];

		// Dead centre of the room, two metres from all four walls, and it still
		// picks one.
		expect(item.currentWallEdge).not.toBeNull();
		expect(item.allowRotate).toBe(false);
	});

	it('lets go of the wall, and stays where it was put', () =>
	{
		model.loadSerialized(design([cabinet()]));
		const item = model.scene.getItems()[0];
		const wall = item.currentWallEdge.wall;
		const where = item.position.clone();

		expect(item.setFreeStanding(true)).toBe(true);

		expect(item.currentWallEdge).toBeNull();
		expect(item.position.x).toBeCloseTo(where.x, 5);
		expect(item.position.z).toBeCloseTo(where.z, 5);
		// Off the wall's list too, or the wall keeps redrawing around an item that
		// is no longer on it.
		expect(wall.items).not.toContain(item);
		expect(wall.onItems).not.toContain(item);
	});

	it('can be turned, because nothing takes its facing from a normal now', () =>
	{
		model.loadSerialized(design([cabinet()]));
		const item = model.scene.getItems()[0];
		item.setFreeStanding(true);

		expect(item.allowRotate).toBe(true);
		item.rotation.y = Math.PI / 4;
		// A drag must not quietly re-bind it and overwrite that.
		item.moveToPosition(new THREE.Vector3(120, item.position.y, 300));
		expect(item.rotation.y).toBeCloseTo(Math.PI / 4, 5);
		expect(item.currentWallEdge).toBeNull();
	});

	it('goes where the drag says instead of onto a wall plane', () =>
	{
		model.loadSerialized(design([cabinet()]));
		const item = model.scene.getItems()[0];
		item.setFreeStanding(true);

		item.moveToPosition(new THREE.Vector3(137, item.position.y, 291));

		// `boundMove` would have pinned z to the wall offset and clamped x along
		// the edge. Both numbers survive intact.
		expect(item.position.x).toBeCloseTo(137, 5);
		expect(item.position.z).toBeCloseTo(291, 5);
	});

	it('stays visible after leaving the wall that was driving its visibility', () =>
	{
		model.loadSerialized(design([cabinet()]));
		const item = model.scene.getItems()[0];

		// What `Edge.updateVisibility` does to the items on a face turned away
		// from the camera. Both faces hidden is the state to free it from.
		item.updateEdgeVisibility(false, true);
		item.updateEdgeVisibility(false, false);
		expect(item.visible).toBe(false);

		item.setFreeStanding(true);
		expect(item.visible).toBe(true);
	});

	it('still stands on the floor', () =>
	{
		model.loadSerialized(design([cabinet()]));
		const item = model.scene.getItems()[0];
		expect(item.boundToFloor).toBe(true);

		item.setFreeStanding(true);

		const box = item.bounds();
		const half = 0.5 * (box.max.y - box.min.y) * item.scale.y;
		expect(item.position.y).toBeCloseTo(half + 0.01, 3);
	});
});

describe('saying so in the file', () =>
{
	it('writes the free marker in the field that names a wall', () =>
	{
		model.loadSerialized(design([cabinet()]));
		model.scene.getItems()[0].setFreeStanding(true);

		const record = JSON.parse(model.exportSerialized()).items[0];
		expect(record.wallEdge).toBe(FREE_STANDING);
	});

	it('cannot collide with a half edge id, which always has colons in it', () =>
	{
		model.loadSerialized(design([cabinet()]));
		const ids = model.floorplan.wallEdges().map((edge) => edge.id);

		expect(ids.length).toBeGreaterThan(0);
		expect(ids).not.toContain(FREE_STANDING);
		ids.forEach((id) => {expect(id).toContain(':');});
	});

	it('comes back free, rather than re-binding to the nearest wall', () =>
	{
		model.loadSerialized(design([cabinet()]));
		model.scene.getItems()[0].setFreeStanding(true);
		model.scene.getItems()[0].rotation.y = Math.PI / 3;
		const saved = model.exportSerialized();

		// A fresh model, so nothing survives but the file - which is the case that
		// matters, since a kept item across a reload never re-runs placement.
		const reloaded = new Model('/');
		reloaded.scene.setItemLoader(stubItemLoader(THREE));
		reloaded.loadSerialized(saved);

		const item = reloaded.scene.getItems()[0];
		expect(item.freeStanding).toBe(true);
		expect(item.currentWallEdge).toBeNull();
		expect(item.rotation.y).toBeCloseTo(Math.PI / 3, 5);
		expect(item.position.x).toBeCloseTo(200, 5);
		expect(item.position.z).toBeCloseTo(200, 5);
	});

	it('leaves a bound item naming its face, exactly as before', () =>
	{
		model.loadSerialized(design([cabinet()]));
		const record = JSON.parse(model.exportSerialized()).items[0];
		expect(record.wallEdge).toContain(':');
	});
});

describe('going back onto a wall', () =>
{
	it('re-binds to the nearest face and takes its facing from it again', () =>
	{
		model.loadSerialized(design([cabinet()]));
		const item = model.scene.getItems()[0];
		item.setFreeStanding(true);
		item.rotation.y = 1.234;

		expect(item.setFreeStanding(false)).toBe(true);

		expect(item.currentWallEdge).not.toBeNull();
		expect(item.freeStanding).toBe(false);
		expect(item.allowRotate).toBe(false);
		expect(item.rotation.y).not.toBeCloseTo(1.234, 3);
	});

	it('refuses when there is no wall to go back to', () =>
	{
		model.loadSerialized(design([cabinet()]));
		const item = model.scene.getItems()[0];
		item.setFreeStanding(true);
		// Every wall gone. `closestWallEdge` returns null and there is nothing
		// honest to do but stay free - the alternative is the TypeError
		// `placeInRoom` already guards against one method over.
		model.floorplan.getWalls().slice().forEach((wall) => {wall.remove();});

		expect(item.setFreeStanding(false)).toBe(false);
		expect(item.freeStanding).toBe(true);
	});
});

describe('what may not be free', () =>
{
	it('a window may not, because it is a hole rather than a thing near a wall', () =>
	{
		// Type 3 is `InWallItem`: it cuts the opening it sits in, and an opening
		// with no wall around it is nothing at all.
		model.loadSerialized(design([cabinet({item_type: 3, ypos: 120})]));
		const item = model.scene.getItems()[0];

		expect(item.canBeFree).toBe(false);
		expect(item.setFreeStanding(true)).toBe(false);
		expect(item.currentWallEdge).not.toBeNull();
	});

	it('and a cabinet may', () =>
	{
		model.loadSerialized(design([cabinet()]));
		expect(model.scene.getItems()[0].canBeFree).toBe(true);
	});
});

describe('the cycle the panel drives', () =>
{
	it('offers no wall as the last stop, after the walls themselves', () =>
	{
		model.loadSerialized(design([cabinet({xpos: 200, zpos: 8})]));
		const item = model.scene.getItems()[0];
		const choices = item.wallEdgeChoices();

		expect(choices.length).toBeGreaterThan(1);
		expect(choices[choices.length - 1]).toBeNull();
		expect(choices.slice(0, -1).every((edge) => edge && edge.id)).toBe(true);
	});

	it('reaches free by pressing, and comes back round to a wall', () =>
	{
		model.loadSerialized(design([cabinet({xpos: 200, zpos: 8})]));
		const item = model.scene.getItems()[0];
		const stops = item.wallEdgeChoices().length;

		let sawFree = false;
		for (let i = 0; i < stops; i++)
		{
			expect(item.bindToNextWallEdge()).toBe(true);
			sawFree = sawFree || item.freeStanding;
		}
		// A full lap: free was one of the stops, and the last press left it back
		// on a wall rather than stuck.
		expect(sawFree).toBe(true);
		expect(item.freeStanding).toBe(false);
	});
});

/**
 * The panel, on a REAL item rather than a hand-built stub.
 *
 * `tests/item-rotation.test.js` builds a plain object, which is a deliberate
 * style here and right for a control that reads three numbers. It is the wrong
 * shape for this one: free placement is a state change that turns the rotation
 * control on and reaches into the wall's item list on the way, so a stub would
 * be asserting that the stub does what the stub was written to do.
 */
describe('the free-standing control', () =>
{
	function panel(record)
	{
		model.loadSerialized(design([cabinet(record)]));
		const item = model.scene.getItems()[0];
		return {item, wrapper: mount(ItemInspector, {props: {item}})};
	}

	function checkbox(wrapper, label)
	{
		const field = wrapper.findAll('.field, label').filter(
			(node) => new RegExp(label, 'i').test(node.text()));
		return field.length ? field[0].find('input[type=checkbox]') : {exists: () => false};
	}

	it('is offered for a cabinet', () =>
	{
		const {wrapper} = panel();
		expect(checkbox(wrapper, 'free-standing').exists()).toBe(true);
	});

	it('is not offered for a window, which cannot be off a wall', () =>
	{
		const {wrapper} = panel({item_type: 3, ypos: 120});
		expect(checkbox(wrapper, 'free-standing').exists()).toBe(false);
	});

	it('frees the item, and the rotation control appears with it', async () =>
	{
		const {item, wrapper} = panel();
		expect(wrapper.findAll('.field-label, label').some(
			(n) => /rotation/i.test(n.text()))).toBe(false);

		await checkbox(wrapper, 'free-standing').setValue(true);

		expect(item.freeStanding).toBe(true);
		expect(item.currentWallEdge).toBeNull();
		// The panel has to read back after the toggle, not just before: freeing an
		// item is what makes it rotatable, and a panel that only reads on selection
		// shows a freed island with no way to turn it until it is reselected.
		expect(wrapper.findAll('.field-label, label').some(
			(n) => /rotation/i.test(n.text()))).toBe(true);
	});

	it('hides the wall cycle while there is no wall to cycle', async () =>
	{
		const {wrapper} = panel({xpos: 200, zpos: 8});
		expect(wrapper.findAll('button').some((b) => /next wall/i.test(b.text()))).toBe(true);

		await checkbox(wrapper, 'free-standing').setValue(true);

		expect(wrapper.findAll('button').some((b) => /next wall/i.test(b.text()))).toBe(false);
	});

	it('puts it back on a wall, and takes the rotation control away again', async () =>
	{
		const {item, wrapper} = panel();
		await checkbox(wrapper, 'free-standing').setValue(true);
		await checkbox(wrapper, 'free-standing').setValue(false);

		expect(item.freeStanding).toBe(false);
		expect(item.currentWallEdge).not.toBeNull();
		expect(wrapper.findAll('.field-label, label').some(
			(n) => /rotation/i.test(n.text()))).toBe(false);
	});
});

/**
 * The "Move to next wall" cycle, and the way it used to stop being a cycle.
 *
 * Reported from the kitchen plan: a cabinet by the pony wall "goes only to the
 * opposite side" however many times the button is pressed. The mechanism is
 * that `bindToNextWallEdge` reads its candidates from where the item is NOW and
 * then `boundMove` carries it through the wall - so the next press is computed
 * from the new position, finds the face it just left one thickness away and
 * therefore nearest, and goes straight back. Two faces of one wall, for ever,
 * with the return wall in the corner never reached.
 *
 * It needs TWO rooms to reproduce, which is why the first fixture written for it
 * could not: a wall on the outside of a single closed room has one half edge,
 * not two, because nothing stands on the other side of it. The far face this is
 * about only exists on a wall between two rooms - which every wall in a kitchen
 * that opens onto a great room is.
 */
describe('cycling between walls rather than through one', () =>
{
	/**
	 * Two rooms, one above the other, sharing the wall at z = 400 - and a return
	 * wall at x = 0 meeting it, so a cabinet in that corner has somewhere else to
	 * go. The shared wall is the one with two faces.
	 */
	function tworooms(items)
	{
		return JSON.stringify({
			floorplan: {
				corners: {
					a1: {x: 0, y: 0, elevation: 250}, a2: {x: 600, y: 0, elevation: 250},
					b1: {x: 0, y: 400, elevation: 250}, b2: {x: 600, y: 400, elevation: 250},
					c1: {x: 0, y: 800, elevation: 250}, c2: {x: 600, y: 800, elevation: 250},
				},
				walls: [
					{corner1: 'a1', corner2: 'a2'}, {corner1: 'a2', corner2: 'b2'},
					{corner1: 'b2', corner2: 'b1'}, {corner1: 'b1', corner2: 'a1'},
					{corner1: 'b2', corner2: 'c2'}, {corner1: 'c2', corner2: 'c1'},
					{corner1: 'c1', corner2: 'b1'},
				],
				rooms: {}, units: 'cm', version: '2.0.0',
			},
			items: items,
		});
	}

	/** In the lower room, hard into the corner where the shared wall meets the west wall. */
	function inTheCorner()
	{
		model.loadSerialized(tworooms([cabinet({xpos: 45, zpos: 440})]));
		const item = model.scene.getItems()[0];
		const shared = item.currentWallEdge;
		const far = item.nearbyWallEdges().find(
			(edge) => edge.wall === shared.wall && edge !== shared);
		return {item, shared, far};
	}

	it('has a fixture that actually has a far face to offer', () =>
	{
		const {far} = inTheCorner();
		expect(far).toBeTruthy();
	});

	it('puts the far face of its own wall behind every other wall', () =>
	{
		const {item, shared, far} = inTheCorner();
		const choices = item.wallEdgeChoices().filter((edge) => edge !== null);
		const others = choices.filter(
			(edge) => edge !== far && edge.wall !== shared.wall);
		expect(others.length).toBeGreaterThan(0);

		// Every other wall's face is reached before the far side of this one.
		expect(choices.indexOf(far)).toBeGreaterThan(
			Math.max(...others.map((edge) => choices.indexOf(edge))));
		// And by distance alone it beat at least one of them, which is why the
		// ordering had to be spelled out rather than left to `nearbyWallEdges`.
		const byDistance = item.nearbyWallEdges();
		expect(others.some((edge) => byDistance.indexOf(edge) > byDistance.indexOf(far)))
			.toBe(true);
	});

	it('reaches a different wall on the first press', () =>
	{
		const {item, shared} = inTheCorner();

		expect(item.bindToNextWallEdge()).toBe(true);
		expect(item.currentWallEdge.wall).not.toBe(shared.wall);
	});

	it('still offers it, because a pony wall has cabinets on both sides', () =>
	{
		const {item, far} = inTheCorner();
		expect(item.wallEdgeChoices()).toContain(far);
	});
});
