// @vitest-environment jsdom
/**
 * A ceiling item can be moved.
 *
 * Written from a report with two halves -- "no arrows show for dragging, and
 * dragging doesn't move it" -- which turned out to be two separate faults in
 * `RoofItem`, both of which had been there since the class was written and
 * neither of which anything could see until phase 6 put a light on the ceiling
 * worth dragging.
 *
 * The interesting one is not visible from any single file. `Room.generateRoofPlane`
 * builds the picking plane as one triangle fan whose faces point DOWN, into the
 * room. `Controller.getIntersections` can drop any hit whose face normal agrees
 * with the ray -- which is right for a wall, and which silently deletes every hit
 * on the ceiling as soon as the camera is above it. `itemIntersection` then
 * returns null and `clickDragged` has nothing to move, so the item is immovable
 * from the angle the 3D view actually sits at and works fine from inside the
 * room looking up. Two files, each defensible on its own.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {Vector2} from 'three';

import {Main} from '../src/scripts/three/main.js';
import {Model} from '../src/scripts/model/model.js';
import {RENDER_STUDIO, setRenderProfile} from '../src/scripts/core/render_profile.js';
import {createRendererStub} from './helpers/renderer.js';
import {resetAll} from './helpers/harness.js';
import {
	installCanvas2D, installPointerApis, installResizeObserver, setLayout,
} from './helpers/dom.js';

const ROOM = {
	floorplan: {
		version: '2.0.0', units: 'cm',
		corners: {
			a: {x: 0, y: 0, elevation: 250}, b: {x: 500, y: 0, elevation: 250},
			c: {x: 500, y: 400, elevation: 250}, d: {x: 0, y: 400, elevation: 250},
		},
		walls: [
			{corner1: 'a', corner2: 'b', thickness: 11.43},
			{corner1: 'b', corner2: 'c', thickness: 11.43},
			{corner1: 'c', corner2: 'd', thickness: 11.43},
			{corner1: 'd', corner2: 'a', thickness: 11.43},
		],
		rooms: {}, wallTextures: [], floorTextures: {}, newFloorTextures: {},
	},
	items: [
		{
			id: 'can1', item_name: 'Recessed Can', item_type: 4, format: 'generated',
			model_url: 'generated:fixture', xpos: 250, ypos: 250, zpos: 200, rotation: 0,
			scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
			spec: {kind: 'fixture', mount: 'recessed', throw: 'down', kelvin: 3000,
				lumens: 800, beamAngle: 60, on: true},
		},
		// Something that is NOT on the ceiling, so the opt-out can be shown to be
		// an exception rather than a relaxed default.
		{
			id: 'w1', item_name: 'Window', item_type: 3, format: 'generated',
			model_url: 'generated:window', xpos: 250, ypos: 157, zpos: 0, rotation: 0,
			scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
			spec: {kind: 'window', type: 'fixed', width: 150, height: 130,
				sillHeight: 92, wallThickness: 11.43},
		},
	],
};

describe('a ceiling item can be picked up', () =>
{
	let canvasStub;
	let observer;
	let pointerApis;

	function buildViewerDom()
	{
		const element = document.createElement('div');
		element.id = 'viewer';
		document.body.appendChild(element);
		setLayout(element, {left: 0, top: 0, width: 900, height: 600});
		return element;
	}

	beforeEach(() =>
	{
		resetAll();
		canvasStub = installCanvas2D(window);
		observer = installResizeObserver(window);
		pointerApis = installPointerApis(window);
		Main.setRendererFactory(() => createRendererStub());
		setRenderProfile(RENDER_STUDIO);
	});

	afterEach(() =>
	{
		Main.setRendererFactory(null);
		pointerApis.restore();
		observer.restore();
		canvasStub.restore();
		document.body.innerHTML = '';
	});

	async function viewerWithCan()
	{
		const element = buildViewerDom();
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify(ROOM));
		const three = new Main(model, element, 'three-canvas', {});
		await new Promise((resolve) => setTimeout(resolve, 60));
		const item = model.scene.getItems().find((one) =>
			one.metadata && one.metadata.spec && one.metadata.spec.kind === 'fixture');
		expect(item, 'the can did not load').toBeTruthy();
		return {three, item};
	}

	/**
	 * Aim the camera at a point and put the pointer in the middle of the viewport.
	 *
	 * The centre of the element is NDC (0, 0), which is the camera's own forward
	 * ray -- so looking at the item IS pointing at it, with no projection
	 * arithmetic to get wrong in the test itself.
	 */
	function lookAt(three, from, at)
	{
		three.camera.position.set(from[0], from[1], from[2]);
		three.camera.lookAt(at[0], at[1], at[2]);
		three.camera.updateMatrixWorld(true);
		const middle = new Vector2(
			(three.widthMargin || 0) + (three.elementWidth || 900) / 2,
			(three.heightMargin || 0) + (three.elementHeight || 600) / 2);
		three.controller.mouse = middle;
		three.controller.alternateMouse = middle;
		return middle;
	}

	it('finds the ceiling under the pointer from ABOVE it, which is where the view sits', async () =>
	{
		// The reported bug, at the point it actually failed. Nothing about the item
		// or the room is wrong here; the hit existed and was thrown away.
		const {three, item} = await viewerWithCan();
		const middle = lookAt(three, [250, 520, -420], [250, 250, 200]);

		expect(three.controller.itemIntersection(middle, item)).toBeTruthy();
	});

	it('still finds it from inside the room looking up', async () =>
	{
		// The one angle that always worked, kept so the fix is an addition rather
		// than a swap of which side is broken.
		const {three, item} = await viewerWithCan();
		const middle = lookAt(three, [250, 120, 200], [250, 250, 200]);

		expect(three.controller.itemIntersection(middle, item)).toBeTruthy();
	});

	it('is the backface filter that decided it, and the item is what turns it off', async () =>
	{
		// The A/B, so the next person does not have to rediscover which of the two
		// files was doing this. Put the filter back on this one item and the hit
		// from above disappears again.
		const {three, item} = await viewerWithCan();
		const middle = lookAt(three, [250, 520, -420], [250, 250, 200]);

		item.dragCullsBackfaces = true;
		expect(three.controller.itemIntersection(middle, item)).toBeNull();
		item.dragCullsBackfaces = false;
		expect(three.controller.itemIntersection(middle, item)).toBeTruthy();
	});

	it('keeps the filter for everything that is not on the ceiling', async () =>
	{
		// A wall item needs it: the far face of a wall is not a surface you may
		// drag onto, and without the filter a picture binds to the room next door.
		// So the default stays on and only `RoofItem` opts out -- the point being
		// that this is an exception, not a rule that got relaxed.
		const {three, item} = await viewerWithCan();
		expect(item.dragCullsBackfaces).toBe(false);

		const others = three.model.scene.getItems()
			.filter((one) => one !== item);
		expect(others.length, 'nothing to compare the can against').toBeGreaterThan(0);
		for (const other of others)
		{
			expect(other.dragCullsBackfaces).toBe(true);
		}
	});

	it('draws a grip, because a ceiling fitting turns', async () =>
	{
		// The other half of the report. `allowRotate` was false, which also gates
		// the HUD handle -- so a selected ceiling light showed no affordance at all
		// and read as "cannot be moved". A strip runs ALONG a run and a fan has
		// blades, so the rotation is not decorative either.
		const {item} = await viewerWithCan();
		expect(item.allowRotate).toBe(true);
	});
});
