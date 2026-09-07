// @vitest-environment jsdom
/**
 * A wall item cuts a hole in the wall it is on.
 *
 * Regression for a defect that was silent in the worst way: every doorway in the
 * traced plan was solid, and nothing anywhere said so - no error, no warning,
 * just a wall you could not walk through.
 *
 * `ShapeUtils.triangulateShape` does not clip a hole that strays outside its
 * contour, it **discards** it entirely. A doorway's hole is meant to reach the
 * floor exactly, so an item resting on the floor has `position.y == halfSize.y`
 * and the hole's bottom edge sits exactly on the contour's. `halfSize` comes
 * from a float32 geometry bounding box and `position.y` from a float64 in the
 * save file, and on the traced plan the two disagreed by 3e-6 cm in the losing
 * direction. Three microns removed ten doorways.
 *
 * So the tests below deliberately place items at, just above, and just below the
 * floor line, because the middle case is the one that shipped.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import * as three from 'three';
import {Box3, Vector2, Vector3} from 'three';
import {Model} from '../src/scripts/model/model.js';
import {Edge} from '../src/scripts/three/edge.js';
import {resetAll} from './helpers/harness.js';
import {installCanvas2D} from './helpers/dom.js';

/** Edge.init subscribes to the orbit controls, and reads the camera position. */
function stubControls()
{
	return {
		object: {position: new Vector3(0, 160, 1000)},
		addEventListener() {},
		removeEventListener() {},
	};
}

/**
 * Is `point`, in the wall's own 2D face coordinates, covered by any triangle of
 * any of this edge's planes?
 *
 * Asked of the built geometry rather than of the Shape, so it tests what is
 * actually drawn. The planes are transformed back into world space by
 * `makeWall`, so they are compared in world space too.
 */
function faceCovers(edgeMesh, worldPoint)
{
	for (const plane of edgeMesh.planes)
	{
		if (!plane.geometry || !plane.geometry.attributes || !plane.geometry.attributes.position)
		{
			continue;
		}
		const flat = plane.geometry.index ? plane.geometry.toNonIndexed() : plane.geometry;
		const p = flat.attributes.position;
		for (let i = 0; i < p.count; i += 3)
		{
			const a = new Vector3().fromBufferAttribute(p, i);
			const b = new Vector3().fromBufferAttribute(p, i + 1);
			const c = new Vector3().fromBufferAttribute(p, i + 2);
			// Project onto the horizontal axis the wall runs along, plus height.
			const flatten = (v) => new Vector2(Math.abs(a.x - b.x) + Math.abs(a.x - c.x) > 0.01 ? v.x : v.z, v.y);
			const A = flatten(a);
			const B = flatten(b);
			const C = flatten(c);
			const P = flatten(worldPoint);
			const d = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
			if (Math.abs(d) < 1e-9) {continue;}
			const l1 = ((B.y - C.y) * (P.x - C.x) + (C.x - B.x) * (P.y - C.y)) / d;
			const l2 = ((C.y - A.y) * (P.x - C.x) + (A.x - C.x) * (P.y - C.y)) / d;
			const l3 = 1 - l1 - l2;
			if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) {return true;}
		}
	}
	return false;
}

/**
 * A 400x300 room with one item on its bottom wall, `lift` above the floor line.
 * Returns the Edge drawing that wall's inner face and where the opening's middle
 * is in world space.
 */
function roomWithOpening(lift)
{
	const model = new Model('/textures/');
	model.scene.setItemLoader((fileName, metadata, onLoad) =>
	{
		// Door-shaped: 85 wide, 205 tall, 12 deep.
		onLoad(new three.BoxGeometry(85, 205, 12), [new three.MeshBasicMaterial()]);
	});
	model.loadSerialized(JSON.stringify({
		floorplan: {
			version: '2.0.0', units: 'cm',
			corners: {
				a: {x: 0, y: 0, elevation: 250}, b: {x: 400, y: 0, elevation: 250},
				c: {x: 400, y: 300, elevation: 250}, d: {x: 0, y: 300, elevation: 250},
			},
			walls: [
				{corner1: 'a', corner2: 'b'}, {corner1: 'b', corner2: 'c'},
				{corner1: 'c', corner2: 'd'}, {corner1: 'd', corner2: 'a'},
			],
			rooms: {}, wallTextures: [], floorTextures: {}, newFloorTextures: {},
		},
		items: [{
			id: 'opening', item_name: 'Opening', item_type: 7, format: 'gltf',
			model_url: 'test.glb',
			// Half of 205 is 102.5. `lift` is the whole point of the fixture.
			xpos: 200, ypos: 102.5 + lift, zpos: 0,
			rotation: 0, scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
		}],
	}));

	const item = model.scene.getItems()[0];
	expect(item, 'the fixture item loaded').toBeTruthy();
	const edge = item.currentWallEdge;
	expect(edge, 'the fixture item bound to a wall').toBeTruthy();

	const scene = new three.Scene();
	const drawn = new Edge(scene, edge, stubControls(), null);
	// Middle of the opening, a little above the floor - inside the hole if there
	// is one, and inside the wall face if there is not.
	return {drawn, point: new Vector3(200, 60, 0)};
}

describe('a wall item cuts a hole in its wall', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
	});

	it('cuts the opening when the item sits exactly on the floor line', () =>
	{
		// THE regression. `position.y === halfSize.y` is what a floor-standing
		// opening means, and it used to produce a solid wall.
		const {drawn, point} = roomWithOpening(0);
		expect(faceCovers(drawn, point)).toBe(false);
	});

	it('cuts the opening when float error puts the hole a hair below the floor', () =>
	{
		// The traced plan's actual case, and the one that has no visible cause:
		// three microns of float32 rounding on the bounding box.
		const {drawn, point} = roomWithOpening(-0.000003);
		expect(faceCovers(drawn, point)).toBe(false);
	});

	it('cuts the opening when the item is lifted clear of the floor', () =>
	{
		// The case that always worked - `boundMove` adds 0.01 when it places an
		// item itself, which is why this was never seen when dragging one in.
		const {drawn, point} = roomWithOpening(0.01);
		expect(faceCovers(drawn, point)).toBe(false);
	});

	it('still draws wall either side of the opening', () =>
	{
		// The complement, so "cuts a hole" cannot be passed by drawing no wall.
		const {drawn} = roomWithOpening(0);
		expect(faceCovers(drawn, new Vector3(40, 60, 0)), 'wall left of the opening').toBe(true);
		expect(faceCovers(drawn, new Vector3(360, 60, 0)), 'wall right of the opening').toBe(true);
		expect(faceCovers(drawn, new Vector3(200, 230, 0)), 'wall above the opening').toBe(true);
	});
});

describe('setSpec rebuilds a generated item instead of scaling it', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
	});

	/** A door in a room, through the real load path, so it has a builder. */
	function doorInRoom(spec)
	{
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: {
				version: '2.0.0', units: 'cm',
				corners: {
					a: {x: 0, y: 0, elevation: 250}, b: {x: 400, y: 0, elevation: 250},
					c: {x: 400, y: 300, elevation: 250}, d: {x: 0, y: 300, elevation: 250},
				},
				walls: [
					{corner1: 'a', corner2: 'b', thickness: 11.43}, {corner1: 'b', corner2: 'c'},
					{corner1: 'c', corner2: 'd'}, {corner1: 'd', corner2: 'a'},
				],
				rooms: {}, wallTextures: [], floorTextures: {}, newFloorTextures: {},
			},
			items: [{
				id: 'd1', item_name: 'Door', item_type: 7, format: 'generated',
				model_url: 'generated:door',
				xpos: 200, ypos: 102.55, zpos: 0, rotation: 0,
				scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
				spec: Object.assign({
					kind: 'door', width: 81.28, height: 203.2, wallThickness: 11.43,
					hand: 'lo', swing: 'negative', openFraction: 0.5, operation: 'swing',
				}, spec),
			}],
		}));
		return model.scene.getItems()[0];
	}

	it('widens the opening without stretching the jambs', () =>
	{
		// The whole argument for generating rather than scaling. A model asked for
		// 40% more width gives 40% wider stiles and hardware; a builder asked the
		// same question gives a wider opening and the same 3/4in jamb.
		const item = doorInRoom();
		const before = item.getWidth();
		expect(item.scale.x).toBe(1);

		const spec = item.getSpec();
		spec.width = 114;
		expect(item.setSpec(spec)).toBe(true);

		// The opening grew by exactly what was asked, and nothing was scaled.
		expect(item.getWidth() - before).toBeCloseTo(114 - 81.28, 1);
		expect(item.scale.x).toBe(1);
		// Still a jamb each side: the rough opening is the clear opening plus two.
		expect(item.getWidth()).toBeCloseTo(114 + 2 * 1.9, 1);
	});

	it('keeps where it is while changing what it is', () =>
	{
		const item = doorInRoom();
		const {x, z} = item.position;
		const spec = item.getSpec();
		spec.openFraction = 1;
		item.setSpec(spec);

		// Along the wall and across it, untouched: this changes what the item is,
		// not where it is.
		expect(item.position.x).toBeCloseTo(x, 6);
		expect(item.position.z).toBeCloseTo(z, 6);
		// Vertically it re-seats, and should: `resized()` stands a floor-bound
		// item back on the floor. The 0.01 it adds is the same lift `boundMove`
		// uses, and it is what keeps the wall's hole clear of the contour edge.
		expect(item.position.y).toBeCloseTo(item.halfSize.y + 0.01, 4);
	});

	it('re-hands the rebuilt parts against the wall it is already on', () =>
	{
		// setSpec builds in plan space, exactly as a fresh load does. An item that
		// is already bound has known axes, so the rebuild has to be re-resolved or
		// a door flips its swing the first time anything else about it is edited.
		const item = doorInRoom();
		const swingSide = (it) =>
		{
			const pivot = it.children.find((c) => c.name === 'door-leaf-pivot');
			it.updateMatrixWorld(true);
			return Math.sign(new Box3().setFromObject(pivot).getCenter(new Vector3()).z - it.position.z);
		};
		const before = swingSide(item);
		const spec = item.getSpec();
		spec.width = 90;
		item.setSpec(spec);
		expect(swingSide(item)).toBe(before);
	});

	it('drops the leaf when the operation becomes a cased opening', () =>
	{
		const item = doorInRoom();
		expect(item.children.some((c) => c.name === 'door-leaf-pivot')).toBe(true);
		const spec = item.getSpec();
		spec.operation = 'cased';
		item.setSpec(spec);
		expect(item.children.some((c) => c.name === 'door-leaf-pivot')).toBe(false);
	});

	it('writes the new spec into what the item will save', () =>
	{
		const item = doorInRoom();
		const spec = item.getSpec();
		spec.material = {leaf: 'wood-walnut'};
		item.setSpec(spec);
		expect(item.getMetaData().spec.material.leaf).toBe('wood-walnut');
	});

	it('hands back a copy, so a half-edited spec never reaches the item', () =>
	{
		const item = doorInRoom();
		const spec = item.getSpec();
		spec.width = 999;
		expect(item.metadata.spec.width).toBe(81.28);
	});

	it('does nothing to an item that was loaded from a file', () =>
	{
		const model = new Model('/textures/');
		model.scene.setItemLoader((f, m, onLoad) =>
			onLoad(new three.BoxGeometry(10, 10, 10), [new three.MeshBasicMaterial()]));
		model.loadSerialized(JSON.stringify({
			floorplan: {version: '2.0.0', units: 'cm', corners: {}, walls: [], rooms: {},
				wallTextures: [], floorTextures: {}, newFloorTextures: {}},
			items: [{id: 'x', item_name: 'Box', item_type: 1, format: 'gltf',
				model_url: 'a.glb', xpos: 0, ypos: 5, zpos: 0, rotation: 0,
				scale_x: 1, scale_y: 1, scale_z: 1, fixed: false}],
		}));
		const item = model.scene.getItems()[0];
		expect(item.getSpec()).toBe(null);
		expect(item.setSpec({kind: 'door'})).toBe(false);
	});
});

describe('a generated item is sized by its spec and nothing else', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
	});

	/** Load one item, as a design saved before this rule would have written it. */
	function loadPost(scale, spec)
	{
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: {version: '2.0.0', units: 'cm', corners: {}, walls: [], rooms: {},
				wallTextures: [], floorTextures: {}, newFloorTextures: {}},
			items: [{
				id: 'p1', item_name: 'Post', item_type: 1, format: 'generated',
				model_url: 'generated:post',
				xpos: 0, ypos: 60, zpos: 0, rotation: 0,
				scale_x: scale[0], scale_y: scale[1], scale_z: scale[2], fixed: false,
				spec: Object.assign({kind: 'post', width: 10.16, depth: 10.16,
					height: 106.68, profile: 'square', trim: 'none'}, spec),
			}],
		}));
		return model.scene.getItems()[0];
	}

	it('folds a saved mesh scale into the spec, keeping the object the same size', () =>
	{
		// The real case, from an exported design: a post stretched with the Item
		// panel's height field, which SCALES. It was drawn at 244cm while its spec
		// said 106.68, and the two would have multiplied on the next rebuild.
		const item = loadPost([0.9, 2.2857142857, 0.9]);

		// Same object as before, to the eye.
		expect(item.getHeight()).toBeCloseTo(243.84, 1);
		expect(item.getWidth()).toBeCloseTo(9.144, 2);
		// But the numbers now say so, and the scale is gone.
		expect(item.metadata.spec.height).toBeCloseTo(243.84, 1);
		expect(item.metadata.spec.width).toBeCloseTo(9.144, 2);
		expect(item.scale.x).toBe(1);
		expect(item.scale.y).toBe(1);
		expect(item.scale.z).toBe(1);
	});

	it('leaves an unscaled item alone', () =>
	{
		const item = loadPost([1, 1, 1]);
		expect(item.metadata.spec.width).toBeCloseTo(10.16, 3);
		expect(item.getHeight()).toBeCloseTo(106.68, 2);
	});

	it('writes the folded spec back out, so the file stops disagreeing with itself', () =>
	{
		const saved = loadPost([0.9, 2.2857142857, 0.9]).getMetaData();
		expect(saved.spec.height).toBeCloseTo(243.84, 1);
		expect(saved.scale_x).toBe(1);
		expect(saved.scale_y).toBe(1);
	});

	it('does not multiply a stale scale against the next spec edit', () =>
	{
		// What the fold prevents. Without it, asking for a 4in post on an item
		// somebody had stretched 2.29x gave 9in.
		const item = loadPost([0.9, 2.2857142857, 0.9]);
		const spec = item.getSpec();
		spec.height = 106.68;
		item.setSpec(spec);
		expect(item.getHeight()).toBeCloseTo(106.68, 2);
		expect(item.scale.y).toBe(1);
	});

	it('normalises the scale on any rebuild, even without a fold', () =>
	{
		const item = loadPost([1, 1, 1]);
		// However it got there.
		item.setScale(2, 2, 2);
		const spec = item.getSpec();
		spec.width = 20.32;
		item.setSpec(spec);
		expect(item.scale.x).toBe(1);
		expect(item.getWidth()).toBeCloseTo(20.32, 2);
	});
});

describe('a window sits on its sill, and a full-height one on the wall', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
	});

	/**
	 * A window in a 250cm room, through the real load path, so it has a builder,
	 * a wall to bind to, and an Edge drawing the face it is in.
	 */
	function windowInRoom(spec, ypos)
	{
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: {
				version: '2.0.0', units: 'cm',
				corners: {
					a: {x: 0, y: 0, elevation: 250}, b: {x: 400, y: 0, elevation: 250},
					c: {x: 400, y: 300, elevation: 250}, d: {x: 0, y: 300, elevation: 250},
				},
				walls: [
					{corner1: 'a', corner2: 'b', thickness: 11.43}, {corner1: 'b', corner2: 'c'},
					{corner1: 'c', corner2: 'd'}, {corner1: 'd', corner2: 'a'},
				],
				rooms: {}, wallTextures: [], floorTextures: {}, newFloorTextures: {},
			},
			items: [{
				id: 'w1', item_name: 'Window', item_type: 3, format: 'generated',
				model_url: 'generated:window',
				xpos: 200, ypos: (ypos === undefined) ? 157 : ypos, zpos: 0, rotation: 0,
				scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
				spec: Object.assign({
					kind: 'window', type: 'double-hung', width: 91.44, height: 152.4,
					sillHeight: 81.28, wallThickness: 11.43,
				}, spec),
			}],
		}));
		const item = model.scene.getItems()[0];
		expect(item, 'the window loaded').toBeTruthy();
		return {item, drawn: new Edge(new three.Scene(), item.currentWallEdge, stubControls(), null)};
	}

	it('lands on the sill height its spec asks for, not the ypos in the file', () =>
	{
		// A window is the first generated item whose POSITION is part of what it
		// is. The file's `ypos: 157` is what `extract.py` bakes for every window
		// on the plan; the spec is what the panel edits, and binding is where the
		// two are reconciled.
		const {item} = windowInRoom({sillHeight: 60}, 157);
		expect(item.position.y).toBeCloseTo(60 + 152.4 / 2, 3);
	});

	it('cuts a hole through the whole wall when it runs floor to ceiling', () =>
	{
		// `docs/generated-items.md` rule 4 says to expect the doorway trap at the
		// OTHER end of the wall here, and this is it: a full-height window's hole
		// reaches the contour on the floor edge AND the wall top, and
		// `ShapeUtils.triangulateShape` discards a hole that strays outside its
		// contour silently and in full.
		const {item, drawn} = windowInRoom({fullHeight: true});
		// The wall is 250 and the liner is 1.9 each end, so the clear opening is
		// 246.2 and the lining fills the wall exactly.
		expect(item.getHeight()).toBeCloseTo(250, 2);
		expect(item.position.y).toBeCloseTo(125, 2);
		// Through it at the floor, in the middle, and at the head.
		expect(faceCovers(drawn, new Vector3(200, 3, 0)), 'open at the floor').toBe(false);
		expect(faceCovers(drawn, new Vector3(200, 125, 0)), 'open in the middle').toBe(false);
		expect(faceCovers(drawn, new Vector3(200, 247, 0)), 'open at the head').toBe(false);
		// And still a wall either side, so this cannot pass by drawing nothing.
		expect(faceCovers(drawn, new Vector3(40, 125, 0)), 'wall left of it').toBe(true);
		expect(faceCovers(drawn, new Vector3(360, 125, 0)), 'wall right of it').toBe(true);
	});

	it('cuts the hole even when float error puts the head above the wall top', () =>
	{
		// The door's regression, at the other end of the wall, and it has to be
		// FORCED rather than hoped for: built to exactly the wall height, the
		// float32 bounding box happened to round the safe way and the hole was cut
		// with the clamp disabled. Three microns the other way is what removed ten
		// doorways on the traced plan, and there is nothing to say which way a
		// given wall height and liner will round.
		const {item, drawn} = windowInRoom({fullHeight: true});
		// Measured against the item's OWN half size rather than nudged by a fixed
		// epsilon: `halfSize` is float32 off a bounding box, so 3e-6 added to a
		// position that was already a micron short of the top lands back inside.
		// This puts the head three microns above the wall, deliberately.
		item.position.y = 250 - item.halfSize.y + 0.000003;
		const again = new Edge(new three.Scene(), item.currentWallEdge, stubControls(), null);
		expect(faceCovers(again, new Vector3(200, 125, 0)), 'open in the middle').toBe(false);
		expect(faceCovers(again, new Vector3(200, 247, 0)), 'open at the head').toBe(false);
		expect(faceCovers(again, new Vector3(40, 125, 0)), 'wall left of it').toBe(true);
		expect(drawn).toBeTruthy();
	});

	it('takes its height from the wall rather than from the spec, once bound', () =>
	{
		// The item declares a requirement of its host and the host answers - the
		// mechanism ROADMAP.md phase 3 wants, in the one place phase 5 needs it.
		// The saved height is deliberately wrong; the wall is what decides.
		const {item} = windowInRoom({fullHeight: true, height: 40});
		expect(item.getSpec().height).toBeCloseTo(246.2, 2);
	});

	it('writes a dragged sill height back into the spec', () =>
	{
		// The other direction. Without `onPlaced` the panel and the mouse hold two
		// different sill heights, and the next bind - a document load, a wall edit
		// - throws away whichever one the mouse set.
		const {item} = windowInRoom({sillHeight: 60}, 157);
		item.moveToPosition(new Vector3(200, 110, 0), item.currentWallEdge);
		expect(item.getSpec().sillHeight).toBeCloseTo(110 - 152.4 / 2, 1);
		// And it survives a re-bind, which is what the write-back is for.
		item.changeWallEdge(item.currentWallEdge);
		expect(item.position.y).toBeCloseTo(110, 1);
	});

	it('leaves a full-height window alone when it is moved', () =>
	{
		// Its sill is the floor by definition, and `boundMove` will happily push
		// it a centimetre up the wall.
		const {item} = windowInRoom({fullHeight: true});
		item.moveToPosition(new Vector3(180, 200, 0), item.currentWallEdge);
		expect(item.getSpec().sillHeight).toBeCloseTo(1.9, 2);
	});
});
