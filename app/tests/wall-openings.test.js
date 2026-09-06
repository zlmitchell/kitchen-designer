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
import {Vector2, Vector3} from 'three';
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
