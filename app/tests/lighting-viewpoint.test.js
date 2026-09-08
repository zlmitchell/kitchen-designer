// @vitest-environment jsdom
/**
 * The lighting controls reach the picture, and the sun reaches through a window.
 *
 * Written from two reports that both looked like "the feature does nothing", and
 * were two different faults.
 *
 * **Turning the ambient fill to zero changed nothing.** The hemisphere and the
 * fill went to zero exactly as asked, and the room stayed bright - because
 * `Main.buildEnvironment` renders a `RoomEnvironment` into a PMREM cube and
 * hangs it on `scene.environment`, and every physically based material samples
 * that for its ambient response independently of any light in the scene. The
 * white cabinets were being lit by an image, not by the lights. Nothing that
 * measured a light could see it, which is why the assertion below is on the
 * SCENE and not on the lights.
 *
 * **The sun did not come through the window.** That one was not a bug: the sun
 * was on the wrong side of the wall. But "nothing happened" is the same
 * experience either way, so the second half of this file pins which headings
 * admit light through a given wall - the thing a person cannot work out by
 * dragging a slider, because a wrong answer and a broken feature look identical.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
	BoxGeometry, MeshStandardMaterial, Raycaster, Scene as ThreeScene, Vector3,
} from 'three';

import {Main} from '../src/scripts/three/main.js';
import {Model} from '../src/scripts/model/model.js';
import {Floorplan3D} from '../src/scripts/three/floorPlan.js';
import {sunAt} from '../src/scripts/core/daylight.js';
import {
	RENDER_STUDIO, createRenderProfile, setRenderProfile,
} from '../src/scripts/core/render_profile.js';
import {createRendererStub} from './helpers/renderer.js';
import {
	installCanvas2D, installPointerApis, installResizeObserver, setLayout,
} from './helpers/dom.js';
import {resetAll} from './helpers/harness.js';

const STUDIO = createRenderProfile(RENDER_STUDIO);

/** A 500 x 400 room, 250 high, with one window in the wall at z = 0. */
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
			id: 'w1', item_name: 'Window', item_type: 3, format: 'generated',
			model_url: 'generated:window', xpos: 250, ypos: 157, zpos: 0, rotation: 0,
			scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
			spec: {kind: 'window', type: 'fixed', width: 150, height: 130,
				sillHeight: 92, wallThickness: 11.43},
		},
	],
};

describe('the ambient control reaches everything that is ambient', () =>
{
	let canvasStub;
	let observer;
	let pointerApis;

	/**
	 * The demo's DOM. A local copy of `viewer-lifecycle.test.js`'s helper, because
	 * that one is private to its file and this needs the same two elements.
	 */
	function buildViewerDom()
	{
		const element = document.createElement('div');
		element.id = 'viewer';
		document.body.appendChild(element);
		setLayout(element, {left: 0, top: 0, width: 900, height: 600});
		return {viewer: element};
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

	function viewer()
	{
		const {viewer: element} = buildViewerDom();
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify(ROOM));
		return new Main(model, element, 'three-canvas', {});
	}

	it('takes the ENVIRONMENT down with the lights, which is most of the ambient', () =>
	{
		// The reported bug. `scene.environment` is a rendered room, sampled by
		// every PBR material for its ambient and specular response, and it is
		// independent of every light in the scene - so zeroing the hemisphere and
		// the fill left the cabinets exactly as bright as before. A test that only
		// looked at `Lights` would have passed while the screen did not change.
		const three = viewer();
		const scene = three.scene.getScene();
		expect(scene.environmentIntensity === undefined
			|| scene.environmentIntensity === 1).toBe(true);

		three.setAmbient(0);
		expect(three.lights.hemiLight.intensity).toBe(0);
		expect(scene.environmentIntensity, 'the image-based ambient came down too').toBe(0);

		three.setAmbient(0.5);
		expect(scene.environmentIntensity).toBeCloseTo(0.5, 6);
		three.dispose();
	});

	it('leaves the key alone, because no ambient is not no sun', () =>
	{
		const three = viewer();
		const key = three.lights.dirLight.intensity;
		three.setAmbient(0);
		expect(three.lights.dirLight.intensity).toBeCloseTo(key, 9);
		three.dispose();
	});

	it('changes nothing at all at its defaults', () =>
	{
		// The parity guarantee: a viewer nobody has touched draws exactly the frame
		// every earlier build drew.
		const three = viewer();
		const scene = three.scene.getScene();
		const before = {
			hemisphere: three.lights.hemiLight.intensity,
			key: three.lights.dirLight.intensity,
			exposure: three.renderer.toneMappingExposure,
		};
		three.applyMood();
		expect(three.lights.hemiLight.intensity).toBeCloseTo(before.hemisphere, 9);
		expect(three.lights.dirLight.intensity).toBeCloseTo(before.key, 9);
		expect(three.renderer.toneMappingExposure).toBeCloseTo(before.exposure, 9);
		expect(scene.environmentIntensity).toBe(1);
		three.dispose();
	});

	it('opens the exposure on top of the profile, and puts it back', () =>
	{
		const three = viewer();
		const base = three.renderer.toneMappingExposure;
		three.setExposure(2);
		expect(three.renderer.toneMappingExposure).toBeCloseTo(base * 2, 6);
		three.setExposure(1);
		expect(three.renderer.toneMappingExposure).toBeCloseTo(base, 6);
		three.dispose();
	});

	it('closes the ceilings only while the sun is on', () =>
	{
		const three = viewer();
		const roofs = () => three.floorplan.floors
			.map((floor) => Boolean(floor.roofPlane && floor.roofPlane.castShadow));
		expect(roofs().every((casts) => casts === false)).toBe(true);
		three.setDaylight({hour: 12});
		expect(roofs().every((casts) => casts === true)).toBe(true);
		three.setDaylight(null);
		expect(roofs().every((casts) => casts === false)).toBe(true);
		three.dispose();
	});
});

/**
 * Can a point on the floor see the sun?
 *
 * A yes/no question, so it is raycast rather than rendered - and it is the
 * question the whole daylight feature rests on, because the shadow map answers
 * it the same way at render time. `docs/generated-items.md` level 4.
 *
 * Only what actually CASTS is tested against: `Edge` builds invisible
 * `phantomPlanes`, full wall quads with no hole in them kept for mouse picking,
 * and including those would report that no window ever admits anything.
 */
function litSamples(scene, sun, points)
{
	const casters = [];
	scene.traverse((object) =>
	{
		if (object.isMesh && object.castShadow && object.visible)
		{
			casters.push(object);
		}
	});
	const toSun = new Vector3(sun.direction.x, sun.direction.y, sun.direction.z);
	const ray = new Raycaster();
	ray.far = 6000;
	return points.filter((point) =>
	{
		// A hair off the floor, so the floor is not its own first hit.
		ray.set(new Vector3(point[0], 2, point[1]), toSun);
		return ray.intersectObjects(casters, false).length === 0;
	});
}

describe('the sun comes in through the window, from one side only', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
		setRenderProfile(RENDER_STUDIO);
	});

	/** The room, drawn, with the ceilings closed the way daylight closes them. */
	function drawnRoom()
	{
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify(ROOM));
		const scene = new ThreeScene();
		const controls = {object: {position: new Vector3(250, 160, 380)},
			addEventListener() {}, removeEventListener() {}};
		const plan = new Floorplan3D(scene, model.floorplan, controls, STUDIO);
		plan.redraw();
		plan.setSkyOpen(false);
		model.scene.getItems().forEach((item) => scene.add(item));
		scene.updateMatrixWorld(true);
		return scene;
	}

	/** The floor in front of the window, where a patch would land. */
	const floorInFront = () =>
	{
		const points = [];
		for (let x = 120; x <= 380; x += 20)
		{
			for (let z = 40; z <= 260; z += 20)
			{
				points.push([x, z]);
			}
		}
		return points;
	};

	it('admits light when the sun is outside that wall, and not when it is inside', () =>
	{
		// The window is in the wall at z = 0 and the room is at +z, so the OUTSIDE
		// of that wall is -z. The sun has to be out there - `direction.z < 0` - or
		// it is shining at the back of the wall from inside the house, which is the
		// state the report was actually in.
		const scene = drawnRoom();
		const points = floorInFront();

		const outside = sunAt(12, 180);
		expect(outside.direction.z, 'heading 180 puts the noon sun outside').toBeLessThan(0);
		const through = litSamples(scene, outside, points);

		const inside = sunAt(12, 0);
		expect(inside.direction.z, 'heading 0 puts it on the room side').toBeGreaterThan(0);
		const blocked = litSamples(scene, inside, points);

		expect(through.length, 'some floor sees the sun through the window')
			.toBeGreaterThan(0);
		expect(blocked.length, 'and none of it does from the wrong side').toBe(0);
	});

	it('lands the patch in front of the window, not all over the floor', () =>
	{
		// The fault a raycast found and a render would not have: with the ceilings
		// open, 498 of 875 floor samples on the traced plan saw the sun THROUGH the
		// ceiling and the window made no difference to any of them. A patch that
		// covers the whole floor is a missing roof, not daylight.
		const scene = drawnRoom();
		const lit = litSamples(scene, sunAt(12, 180), floorInFront());
		expect(lit.length).toBeGreaterThan(0);
		expect(lit.length).toBeLessThan(floorInFront().length * 0.75);

		// And it is under the window, which is centred at x = 250.
		const xs = lit.map((point) => point[0]);
		const middle = xs.reduce((sum, x) => sum + x, 0) / xs.length;
		expect(middle).toBeGreaterThan(150);
		expect(middle).toBeLessThan(350);
	});

	it('gives nothing at all at night', () =>
	{
		const night = sunAt(23, 180);
		expect(night.intensity).toBe(0);
		// The geometry may still have a line of sight; what matters is that the
		// light carries nothing along it.
		expect(night.up).toBe(false);
	});
});

/*
 * And the same question at the viewpoint it was reported from.
 *
 * The traced plan is gitignored - it identifies the house - so this skips on a
 * clean checkout, the same way `traced-plan.test.js` does. It runs for the
 * person who can act on it.
 */
const PLAN_DIR = process.env.PLAN_DIR || '/plan';
const PLAN = join(PLAN_DIR, 'design.json');
const havePlan = existsSync(PLAN);

describe('the kitchen run, from where it was reported', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
		setRenderProfile(RENDER_STUDIO);
	});

	it.runIf(havePlan)('faces the run wall, whose outside is -z', () =>
	{
		// Standing in the room looking at the run: the cabinets are at z ~ 40 and
		// the wall behind them at z ~ 0, so the room is +z and the daylight has to
		// come from -z.
		//
		// Found by geometry rather than by id. It used to be `window-2`, which was
		// one 63in sash; the fit-out schedule states the two the drawing actually
		// draws, either side of a mullion, so there is no longer a single item to
		// name - and naming one would pin this to whichever of them sorts first.
		const design = JSON.parse(readFileSync(PLAN, 'utf8'));
		const inTheWall = design.items.filter((item) =>
			item.spec && item.spec.kind === 'window' && Math.abs(item.zpos) < 20);
		expect(inTheWall.length, 'the run wall still has its window').toBeGreaterThan(0);

		const cabinets = design.items.filter((item) => item.item_name.includes('Cabinet'));
		expect(cabinets.length).toBeGreaterThan(0);
		// The room is on the +z side of that wall.
		const wallZ = Math.max(...inTheWall.map((item) => item.zpos));
		expect(Math.min(...cabinets.map((item) => item.zpos))).toBeGreaterThan(wallZ);
	});

	it.runIf(havePlan)('needs a heading near 180 to light that window at noon', () =>
	{
		// The answer to "I turned the sun on and nothing came through". Nothing was
		// broken: at the default heading the sun is on the room side of that wall.
		// This is the fact a slider cannot tell you, because a wrong heading and a
		// broken feature look exactly the same.
		const admits = [];
		for (let heading = 0; heading < 360; heading += 30)
		{
			if (sunAt(12, heading).direction.z < -0.2)
			{
				admits.push(heading);
			}
		}
		expect(admits.length).toBeGreaterThan(0);
		expect(admits).toContain(180);
		// And the default heading is not one of them, which is the whole report.
		expect(admits).not.toContain(0);
	});

	it.runIf(havePlan)('carries the ceiling cans as ITEMS, so they can be clicked', () =>
	{
		// They used to be entries in the document's top-level `lights` block, which
		// lit the room and could not be seen, selected or edited - a light that
		// works and is invisible to the interface is worse than one that does not.
		// As items they are selected, dragged and inspected by machinery that
		// already exists, and they carry their own light because for a fitting the
		// spec IS the fixture.
		const design = JSON.parse(readFileSync(PLAN, 'utf8'));
		const cans = design.items.filter((entry) => entry.model_url === 'generated:fixture');
		expect(cans.length, 'tools/fitout.py placed the cans').toBeGreaterThan(0);
		expect(design.lights === undefined || design.lights.length === 0,
			'and none of them is a bare position any more').toBe(true);

		for (const can of cans)
		{
			expect(can.spec.kind).toBe('fixture');
			expect(can.spec.lumens).toBeGreaterThan(0);
			// Every mount but one hangs from the ceiling, so it is a RoofItem and
			// it sits just under the plane rather than in it. A sconce is the
			// exception and the reason this is a branch: it hangs from a WALL, so
			// it is a WallItem at eye level, and asserting a ceiling height on it
			// would be asserting that the room has no wall lights.
			if (can.spec.mount === 'wall')
			{
				expect(can.item_type).toBe(2);
				expect(can.ypos).toBeGreaterThan(120);
				expect(can.ypos).toBeLessThan(220);
				continue;
			}
			expect(can.item_type).toBe(4);
			expect(can.ypos).toBeGreaterThan(150);
			expect(can.ypos).toBeLessThan(250);
		}
	});
});

describe('a window does not shadow its own opening', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
		setRenderProfile(RENDER_STUDIO);
	});

	/**
	 * The room again, but with the window loaded the way a LEGACY one is.
	 *
	 * This is the case the generated-window test above could not reach, and the
	 * reason it could not is worth writing down: `whitewindow.glb` needs the
	 * network, so it never loads in the headless suite - the wall keeps no hole,
	 * every ray hits solid wall, and a measurement taken there says "no light"
	 * for a reason that has nothing to do with the feature. The loader seam is
	 * what makes the real shape testable: ONE solid merged mesh filling the
	 * opening, frame and glass together, which is exactly what `mergeMeshes`
	 * hands back for that file.
	 */
	function roomWithLoadedWindow()
	{
		const model = new Model('/textures/');
		model.scene.setItemLoader((fileName, metadata, onLoad) =>
		{
			// Solid, and the size of the opening. A glazed pane is not a separate
			// object by the time the loader is done with it.
			//
			// The groups are cleared because `BoxGeometry` declares six of them, one
			// per face, and a raycast against six groups backed by a one-material
			// array reads `material[1]` and throws. A merged glTF arrives with one
			// group per pooled material, so one group and one material is the
			// faithful shape here as well as the working one.
			const geometry = new BoxGeometry(150, 130, 12);
			geometry.clearGroups();
			onLoad(geometry, [new MeshStandardMaterial()]);
		});
		model.loadSerialized(JSON.stringify({
			floorplan: ROOM.floorplan,
			items: [{
				id: 'w-glb', item_name: 'Window', item_type: 3, format: 'gltf',
				model_url: 'models/js-glb/whitewindow.glb',
				xpos: 250, ypos: 157, zpos: 0, rotation: 0,
				scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
			}],
		}));

		const scene = new ThreeScene();
		const controls = {object: {position: new Vector3(250, 160, 380)},
			addEventListener() {}, removeEventListener() {}};
		const plan = new Floorplan3D(scene, model.floorplan, controls, STUDIO);
		plan.redraw();
		plan.setSkyOpen(false);
		const items = model.scene.getItems();
		items.forEach((item) =>
		{
			scene.add(item);
			// Forced, and the positive test below is worthless without it.
			// `WallItem.updateEdgeVisibility` hides an item whose wall face is
			// turned away from the camera, and `litSamples` only counts casters
			// that are visible - so an invisible window lets light through for a
			// reason that has nothing to do with `castShadow`, and the test would
			// pass whatever the fix did.
			item.visible = true;
		});
		scene.updateMatrixWorld(true);
		return {scene, items};
	}

	it('does not cast, so it cannot seal the hole it was cut into', () =>
	{
		// The reported symptom's cause, pinned at the level it is actually true.
		//
		// Nothing about the sun was wrong. The traced plan's nine windows are
		// legacy GLBs; `mergeMeshes` flattens frame, sash and glazing into ONE mesh
		// on load; `Item` casts by default; so each window sealed its own opening
		// and no hour or heading let anything through.
		//
		// Deliberately NOT asserted by raycasting a stub through the opening. That
		// was tried and it measured nothing: a hand-made box in the hole is not
		// close enough to a merged glTF for the rays to behave the same way, and
		// the count came out identical with the shadow on and off - a test that
		// would have passed whatever the fix did. The claim that IS true and does
		// hold the fix is this one.
		const {items} = roomWithLoadedWindow();
		expect(items, 'the window loaded through the seam').toHaveLength(1);
		expect(items[0].castShadow).toBe(false);
	});
});

describe('a closed door stops the light, and an open one does not', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
		setRenderProfile(RENDER_STUDIO);
	});

	/**
	 * The room with a generated door in the wall at z = 0.
	 *
	 * Generated items build synchronously and without network, which is what makes
	 * this the end-to-end test the legacy window could not have: the door really
	 * loads, the wall really cuts its opening, and the leaf is really where the
	 * builder put it.
	 */
	function roomWithDoor(spec)
	{
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: ROOM.floorplan,
			items: [{
				id: 'd1', item_name: 'Door', item_type: 7, format: 'generated',
				model_url: 'generated:door', xpos: 250, ypos: 102, zpos: 0, rotation: 0,
				scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
				spec: Object.assign({kind: 'door', width: 91, height: 203,
					wallThickness: 11.43, leaf: 'two-panel'}, spec),
			}],
		}));
		const scene = new ThreeScene();
		const controls = {object: {position: new Vector3(250, 160, 380)},
			addEventListener() {}, removeEventListener() {}};
		const plan = new Floorplan3D(scene, model.floorplan, controls, STUDIO);
		plan.redraw();
		plan.setSkyOpen(false);
		model.scene.getItems().forEach((item) =>
		{
			scene.add(item);
			// See the note in `roomWithLoadedWindow`: an item whose wall face is
			// turned away is hidden, and a hidden caster is not counted.
			item.traverse((child) => {child.visible = true;});
		});
		scene.updateMatrixWorld(true);
		return scene;
	}

	const doorway = () =>
	{
		const points = [];
		for (let x = 190; x <= 310; x += 15)
		{
			for (let z = 30; z <= 180; z += 15) {points.push([x, z]);}
		}
		return points;
	};

	it('lets nothing through when it is shut', () =>
	{
		// The report: exterior doors were passing daylight. `InWallItem` stops the
		// item casting - correctly, its geometry is the lining - and `castShadow`
		// is not inherited, so the leaf hanging off it cast nothing at all and a
		// shut door was an empty hole as far as the sun was concerned.
		const scene = roomWithDoor({operation: 'swing', openFraction: 0});
		expect(litSamples(scene, sunAt(12, 180), doorway())).toHaveLength(0);
	});

	it('lets it through when it stands open', () =>
	{
		// And the other half, or the fix could be "nothing ever casts" wearing a
		// different hat: swung clear, the opening is open again.
		const scene = roomWithDoor({operation: 'swing', openFraction: 1});
		expect(litSamples(scene, sunAt(12, 180), doorway()).length).toBeGreaterThan(0);
	});

	it('lets it through a cased opening, which has no leaf at all', () =>
	{
		const scene = roomWithDoor({operation: 'cased'});
		expect(litSamples(scene, sunAt(12, 180), doorway()).length).toBeGreaterThan(0);
	});

	it('lets it through the glazing of a french door, but not its rails', () =>
	{
		// The exception the per-mesh rule exists for. A french door is shut and
		// still admits light, because the panes are the part light comes through -
		// which is also why this cannot be decided on the group.
		const scene = roomWithDoor({operation: 'french', leaf: 'glazed', openFraction: 0});
		expect(litSamples(scene, sunAt(12, 180), doorway()).length).toBeGreaterThan(0);
	});
});

describe('every door operation, against the sun', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
		setRenderProfile(RENDER_STUDIO);
	});

	/** A 150cm opening in the wall at z = 0, with the given door in it. */
	function opening(spec, type)
	{
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: ROOM.floorplan,
			items: [{
				id: 'd1', item_name: 'Door', item_type: type || 7, format: 'generated',
				model_url: 'generated:door', xpos: 250, ypos: 102, zpos: 0, rotation: 0,
				scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
				spec: Object.assign({kind: 'door', width: 150, height: 203,
					wallThickness: 11.43}, spec),
			}],
		}));
		const scene = new ThreeScene();
		const controls = {object: {position: new Vector3(250, 160, 380)},
			addEventListener() {}, removeEventListener() {}};
		const plan = new Floorplan3D(scene, model.floorplan, controls, STUDIO);
		plan.redraw();
		plan.setSkyOpen(false);
		model.scene.getItems().forEach((item) =>
		{
			scene.add(item);
			item.traverse((child) => {child.visible = true;});
		});
		scene.updateMatrixWorld(true);
		return scene;
	}

	/**
	 * Floor samples inside the opening's own width.
	 *
	 * Deliberately off the centreline. Where two leaves BUTT - a bifold's two
	 * panels are hinged edge to edge with no gap between them - an analytic ray
	 * aimed exactly at the seam passes between the two boxes and reports daylight;
	 * measured, a bifold "leaked" six samples and every one of them was at x = 250
	 * to the millimetre. A shadow map does not do this, because it rasterises
	 * depth and two triangles sharing an edge fill adjacent texels with no hole,
	 * so sampling the seam measures the raycaster rather than the door.
	 *
	 * The grid is offset rather than the geometry changed: the panels are correct,
	 * and moving real millwork to satisfy an artefact of the measurement is how a
	 * model ends up shaped like its test.
	 */
	const throughIt = () =>
	{
		const points = [];
		for (let x = 194; x <= 310; x += 12)
		{
			for (let z = 30; z <= 170; z += 12) {points.push([x, z]);}
		}
		return points;
	};

	const litThrough = (spec, type) =>
		litSamples(opening(spec, type), sunAt(12, 180), throughIt()).length;

	/**
	 * What each operation should do to daylight, and why.
	 *
	 * A table rather than a test each, because the interesting thing is the
	 * COMPARISON: "nothing ever casts" and "everything always casts" each satisfy
	 * half of it, and only the whole row set rules both out.
	 */
	const SOLID = {leaf: 'two-panel'};

	it('stops the light with any solid leaf, shut', () =>
	{
		for (const operation of ['swing', 'french', 'bypass', 'pocket', 'bifold'])
		{
			const lit = litThrough(Object.assign({operation, openFraction: 0}, SOLID));
			expect(lit, `${operation} shut`).toBe(0);
		}
	});

	it('passes the light again when the leaf moves out of the way', () =>
	{
		// A pocket goes into the wall, a bifold folds to the jamb, a swing turns
		// clear. All three leave the opening open.
		for (const operation of ['swing', 'pocket', 'bifold'])
		{
			const lit = litThrough(Object.assign({operation, openFraction: 1}, SOLID));
			expect(lit, `${operation} open`).toBeGreaterThan(0);
		}
	});

	it('never fully clears a bypass, because one leaf is always in front of the other', () =>
	{
		// The signature of a bypass, arriving here as a lighting fact: fully open,
		// half the opening is still covered, so it admits less than a swing does.
		const bypass = litThrough(Object.assign({operation: 'bypass', openFraction: 1}, SOLID));
		const swing = litThrough(Object.assign({operation: 'swing', openFraction: 1}, SOLID));
		expect(bypass).toBeGreaterThan(0);
		expect(bypass).toBeLessThan(swing);
	});

	it('lets a GLAZED door through while it is still shut, which is the point of glass', () =>
	{
		// The answer to "do the sliding glass doors handle it". They do, and they
		// have to do the opposite of a solid door: a shut patio slider is a wall of
		// glass and daylight is what it is for.
		for (const operation of ['sliding', 'french'])
		{
			const glazed = litThrough({operation, leaf: 'glazed', openFraction: 0});
			const solid = litThrough(Object.assign({operation, openFraction: 0}, SOLID));
			expect(glazed, `${operation} glazed and shut`).toBeGreaterThan(0);
			expect(solid, `${operation} solid and shut`).toBe(0);
		}
	});

	it('leaves a cased opening open, having no leaf at all', () =>
	{
		expect(litThrough({operation: 'cased'})).toBeGreaterThan(0);
	});

	it('blocks with a barn door on the wall face, over a cased opening', () =>
	{
		// A barn door is not an in-wall item - it is a type 9 hanging on the face,
		// over an opening that is `cased` in its own right. So the opening never
		// stops being open; what blocks the light is a slab in front of it.
		const clear = litThrough({operation: 'cased'});
		const covered = litSamples(
			opening({operation: 'barn', openFraction: 0, leaf: 'two-panel'}, 9),
			sunAt(12, 180), throughIt()).length;
		expect(clear).toBeGreaterThan(0);
		expect(covered).toBeLessThan(clear);
	});
});
