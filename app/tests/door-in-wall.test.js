// @vitest-environment jsdom
/**
 * What a door learns from the wall it lands on.
 *
 * `buildDoor` is a pure function and `tests/generated-door.test.js` asserts it
 * as one. This file is the other half: the two things a door cannot know until
 * it is bound, which is the moment `WallItem.changeWallEdge` fires
 * `Item.onBound`.
 *
 *   - **How thick the wall is.** `extract.py` bakes `wallThickness` off the
 *     traced drawing and nothing had ever re-read it, so a door moved to a
 *     different wall kept the first wall's number and its lining stopped filling
 *     its opening. The frame is built to fit a wall, so the wall is what it
 *     should be asked.
 *   - **Whether a pocket will fit.** ROADMAP.md phase 5 asks the app to check and
 *     refuse rather than let somebody put a pocket door in a 3 1/2in partition
 *     and find out on site, on the grounds that the information is already in the
 *     model. Both halves of that are here: the thickness, and the run of wall the
 *     leaf has to slide into - which is side-dependent, and therefore a question
 *     about the handing as much as about the wall.
 *
 * The item is built through the real load path rather than by hand. A generated
 * item builds synchronously and without network - the generated branch in
 * `Scene.addItem` sits ahead of both the asset-manifest check and the
 * `itemLoader` seam - so a whole design loads inside vitest.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {Box3, Vector3} from 'three';
import {Model} from '../src/scripts/model/model.js';
import {resetAll} from './helpers/harness.js';
import {installCanvas2D} from './helpers/dom.js';

/** A room whose bottom wall is `thickness` thick, with one door in it. */
function roomWithDoor(thickness, spec, xpos)
{
	const model = new Model('/textures/');
	model.loadSerialized(JSON.stringify({
		floorplan: {
			version: '2.0.0', units: 'cm',
			corners: {
				a: {x: 0, y: 0, elevation: 250}, b: {x: 600, y: 0, elevation: 250},
				c: {x: 600, y: 400, elevation: 250}, d: {x: 0, y: 400, elevation: 250},
			},
			walls: [
				{corner1: 'a', corner2: 'b', thickness},
				{corner1: 'b', corner2: 'c', thickness},
				{corner1: 'c', corner2: 'd', thickness},
				{corner1: 'd', corner2: 'a', thickness},
			],
			rooms: {}, wallTextures: [], floorTextures: {}, newFloorTextures: {},
		},
		items: [
			{
				id: 'd1', item_name: 'Door', item_type: 7, format: 'generated',
				model_url: 'generated:door', xpos: (xpos === undefined) ? 300 : xpos,
				ypos: 102, zpos: 0, rotation: 0,
				scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
				spec: Object.assign({kind: 'door', width: 81.28, height: 203.2,
					wallThickness: 11.43}, spec),
			},
		],
	}));
	return model;
}

/** The one item in the design, once it has settled. */
async function doorIn(model)
{
	await new Promise((resolve) => {setTimeout(resolve, 60);});
	const items = model.scene.getItems();
	expect(items).toHaveLength(1);
	return items[0];
}

describe('a door fits itself to the wall it binds to', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
	});

	it('takes the wall thickness off the wall, not off the file', async () =>
	{
		// The spec says 11.43 - a 2x4 partition, which is what `extract.py` writes
		// when it cannot measure one - and the wall is a 2x6. The lining has to
		// fill the wall it is actually in.
		const item = await doorIn(roomWithDoor(19.05, {}));
		expect(item.metadata.spec.wallThickness).toBeCloseTo(19.05, 2);

		const size = new Box3().setFromObject(item).getSize(new Vector3());
		// The item's own geometry spans the wall. Children (leaf, casing) reach
		// further, so this is measured off the geometry rather than the object.
		item.geometry.computeBoundingBox();
		expect(item.geometry.boundingBox.getSize(new Vector3()).z).toBeCloseTo(19.05, 2);
		expect(size.z).toBeGreaterThan(0);
	});

	it('leaves a door alone when the file and the wall already agree', async () =>
	{
		const item = await doorIn(roomWithDoor(11.43, {}));
		expect(item.metadata.spec.wallThickness).toBeCloseTo(11.43, 2);
		expect(item.specNotices).toEqual([]);
	});

	it('refuses a pocket door in a partition too thin to hold the leaf', async () =>
	{
		// The case ROADMAP.md names. The spec is NOT rewritten - the drawing is the
		// user's, and silently turning a pocket door into a swing door would be
		// worse than the fault. What refuses is the drawing: a leaf with nowhere to
		// go does not open.
		const item = await doorIn(roomWithDoor(8.89, {operation: 'pocket', openFraction: 1}));
		expect(item.metadata.spec.operation).toBe('pocket');
		expect(item.specNotices).toHaveLength(1);
		expect(item.specNotices[0]).toMatch(/hold the leaf/i);

		const leaf = item.generatedParts.find((part) => part.name === 'door-leaf-pocket');
		expect(leaf).toBeTruthy();
		// Still filling its opening, because it cannot retract into a wall that has
		// no cavity in it.
		expect(Math.abs(leaf.position.x)).toBeLessThan(1);
	});

	it('accepts a pocket door in a wall that can take one', async () =>
	{
		const item = await doorIn(roomWithDoor(11.43, {operation: 'pocket', openFraction: 1}));
		expect(item.specNotices).toEqual([]);
		const leaf = item.generatedParts.find((part) => part.name === 'door-leaf-pocket');
		// Retracted a whole leaf width, out of the opening entirely.
		expect(Math.abs(leaf.position.x)).toBeGreaterThan(80);
	});

	it('refuses on the side the pocket is framed into, and not on the other', async () =>
	{
		// The run is side-dependent, so this is a question about the HANDING as
		// much as about the wall - and `hand` is stated in plan axes, so which
		// world direction it means is only known once the item has bound. A door
		// 60cm from the end of a 600cm wall has room on one side and not the other.
		const refused = [];
		for (const hand of ['lo', 'hi'])
		{
			const item = await doorIn(roomWithDoor(11.43,
				{operation: 'pocket', hand, openFraction: 1}, 60));
			if (item.specNotices.length) {refused.push(hand);}
		}
		expect(refused).toHaveLength(1);
		expect(refused[0]).toMatch(/^(lo|hi)$/);
	});
});
