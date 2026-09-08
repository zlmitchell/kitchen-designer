// @vitest-environment jsdom
/**
 * Appliances (ROADMAP.md phase 4, built as the last of phase 2's parts).
 *
 * The claim under test is the one the sink made about its mounts: five
 * appliances are ONE builder, and what differs is how the face divides and what
 * is bolted to the box. So most of these compare two subkinds rather than
 * measuring one, and the rest pin things a render found and a vertex count
 * could not - a filter buried inside its own canopy, a vent grille inside the
 * carcass, grates that missed the burners.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {Box3, Vector3} from 'three';
import {buildAppliance} from '../src/scripts/items/generated/appliance.js';
import {Model} from '../src/scripts/model/model.js';
import {resetAll} from './helpers/harness.js';
import {installCanvas2D} from './helpers/dom.js';

const bounds = (built) =>
{
	built.geometry.computeBoundingBox();
	return built.geometry.boundingBox;
};
const size = (built) => bounds(built).getSize(new Vector3());
const verts = (built) => built.geometry.attributes.position.count;

/**
 * The bounds of just the parts made of one material.
 *
 * `mergeMeshes` leaves one geometry group per material, so asking by material is
 * exact - and it is the only way to ask a merged mesh about one part of itself.
 * Copied from `cabinets.test.js` rather than shared: a test helper that has to
 * be imported is a test helper somebody has to go and read.
 */
function partBounds(built, materialId)
{
	const index = built.materials.findIndex((m) => m.userData.materialId === materialId);
	expect(index, `no ${materialId} in this appliance`).toBeGreaterThanOrEqual(0);
	const position = built.geometry.getAttribute('position');
	const box = new Box3();
	for (const group of built.geometry.groups)
	{
		if (group.materialIndex !== index) {continue;}
		for (let i = group.start; i < group.start + group.count; i++)
		{
			box.expandByPoint(new Vector3().fromBufferAttribute(position, i));
		}
	}
	return box;
}

function hasMaterial(built, materialId)
{
	return built.materials.some((m) => m.userData.materialId === materialId);
}

/**
 * How close the parts made of one material get to the appliance's middle.
 *
 * A pair of doors meets in the middle with a gap; a single door does not meet
 * anywhere. That is what a face layout IS, and it is measurable without caring
 * how many boxes any one panel is made of.
 *
 * NOTE the specs below hand the face its own material. On a stainless machine
 * the body, the face and the handles are all `metal-stainless`, materials pool
 * BY NAME in `mergeMeshes`, and so all three arrive as one group - which made
 * the first version of every measurement here report the whole appliance. The
 * same note is on `partBounds` in `cabinets.test.js` and it cost time twice.
 *
 * Sampling at a HEIGHT does not work either, and that is not obvious: a box has
 * vertices only at its own edges, so a probe halfway up a fridge door finds
 * nothing at all and reports Infinity.
 */
function nearestToCentre(built, materialId)
{
	const index = built.materials.findIndex((m) => m.userData.materialId === materialId);
	expect(index, `no ${materialId} in this appliance`).toBeGreaterThanOrEqual(0);
	const position = built.geometry.getAttribute('position');
	let closest = Infinity;
	for (const group of built.geometry.groups)
	{
		if (group.materialIndex !== index) {continue;}
		for (let i = group.start; i < group.start + group.count; i++)
		{
			closest = Math.min(closest, Math.abs(position.getX(i)));
		}
	}
	return closest;
}

describe('five appliances are one builder', () =>
{
	it('gives each one the trade size it has to have', () =>
	{
		// Not taste. An appliance that is the wrong size is what breaks a run: a
		// 30in range needs a 30in gap and a dishwasher is 24in everywhere.
		expect(size(buildAppliance({subkind: 'range'})).x).toBeCloseTo(76.2, 2);
		expect(size(buildAppliance({subkind: 'dishwasher'})).x).toBeCloseTo(60.96, 2);
		expect(size(buildAppliance({subkind: 'microwave', mount: 'over-range'})).x)
			.toBeCloseTo(76.2, 2);
		// A built-in fridge gives up depth to sit flush with the cabinet face, and
		// takes it back in height.
		const free = buildAppliance({subkind: 'fridge'});
		const built = buildAppliance({subkind: 'fridge', style: 'built-in'});
		expect(size(built).z).toBeLessThan(size(free).z);
		expect(size(built).y).toBeGreaterThan(size(free).y);
	});

	it('builds a real appliance from a spec still carrying the last one*s variant', () =>
	{
		// `subkind` is editable, so turning a range into a hood leaves `style` at
		// `freestanding`, which is not a hood. Guarded rather than trusted, or
		// every intermediate state of an edit is an empty group.
		const stale = buildAppliance({subkind: 'hood', style: 'freestanding'});
		const honest = buildAppliance({subkind: 'hood', style: 'under-cabinet'});
		expect(size(stale)).toEqual(size(honest));
		expect(verts(stale)).toBe(verts(honest));
	});

	it('divides the face differently and calls that the difference', () =>
	{
		// A French-door fridge is a pair over a drawer, so the two doors meet in
		// the middle; a dishwasher is one door and meets nothing. Measured at the
		// face rather than counted in triangles, because the count is the same
		// question asked in a way that cannot fail usefully.
		const french = buildAppliance(
			{subkind: 'fridge', doors: 'french', material: {face: 'wood-walnut'}});
		expect(nearestToCentre(french, 'wood-walnut')).toBeLessThan(1.2);

		const dishwasher = buildAppliance({subkind: 'dishwasher', material: {face: 'wood-walnut'}});
		expect(nearestToCentre(dishwasher, 'wood-walnut')).toBeGreaterThan(20);
	});

	it('splits a side-by-side off centre, because the freezer is the narrow one', () =>
	{
		const sbs = buildAppliance(
			{subkind: 'fridge', doors: 'side-by-side', material: {face: 'wood-walnut'}});
		// Well off the middle - which is the whole difference from a French pair,
		// where the two doors meet ON it.
		expect(nearestToCentre(sbs, 'wood-walnut')).toBeGreaterThan(4);
	});
});

describe('panel-ready is a cabinet front, not a colour', () =>
{
	it('builds the face with the cabinet*s own profile', () =>
	{
		// A shaker front is five boxes and a slab is one, so asking for shaker and
		// getting the same geometry as slab would mean this is painting a box
		// rather than fitting a door.
		const slab = buildAppliance({subkind: 'dishwasher', finish: 'panel-ready', front: 'slab'});
		const shaker = buildAppliance({subkind: 'dishwasher', finish: 'panel-ready', front: 'shaker'});
		expect(verts(shaker)).toBeGreaterThan(verts(slab));
	});

	it('makes the face a finish and not a metal', () =>
	{
		const steel = buildAppliance({subkind: 'dishwasher', finish: 'stainless'});
		const panel = buildAppliance({subkind: 'dishwasher', finish: 'panel-ready'});
		expect(hasMaterial(steel, 'metal-stainless')).toBe(true);
		expect(hasMaterial(panel, 'paint-white')).toBe(true);
		// And the body behind it stays dark, because in a run nobody sees it.
		expect(hasMaterial(panel, 'metal-matte-black')).toBe(true);
	});

	it('still gives it the kitchen*s long pull, not a knob', () =>
	{
		// The handle is what keeps a panel-ready machine legible as a machine. It
		// projects, so the envelope is deeper than the box plus its door.
		const panel = buildAppliance({subkind: 'dishwasher', finish: 'panel-ready'});
		expect(size(panel).z).toBeGreaterThan(61.0 + 1.9 + 5);
	});

	it('lets a named material beat the finish preset', () =>
	{
		const walnut = buildAppliance({
			subkind: 'fridge', finish: 'panel-ready', material: {face: 'wood-walnut'}});
		expect(hasMaterial(walnut, 'wood-walnut')).toBe(true);
		expect(hasMaterial(walnut, 'paint-white')).toBe(false);
	});
});

describe('a cooktop is geometry, not a texture', () =>
{
	it('puts gas grates ABOVE the cooktop and over the burners', () =>
	{
		// Spread evenly across the width instead, the bars fall BETWEEN the
		// burners: the top-down render came out as five stripes and four dots.
		// Nothing about a triangle count says where a bar is.
		//
		// Slide-in, so the backguard is not in the way - it is trim too, and it
		// stands higher than the grate does. And the grate gets its own material,
		// because trim is also the toe kick, the liner and the control band.
		const gas = buildAppliance(
			{subkind: 'range', fuel: 'gas', style: 'slide-in', material: {trim: 'paint-navy'}});
		const trim = partBounds(gas, 'paint-navy');
		const body = partBounds(gas, 'metal-stainless');
		// Above the box, which is where a grate is.
		expect(trim.max.y).toBeGreaterThan(body.max.y);

		// The middle of a four-burner cooktop has no burner in it, so it has no
		// bar over it either. Spread evenly there WAS one, dead centre.
		const position = gas.geometry.getAttribute('position');
		const index = gas.materials.findIndex((m) => m.userData.materialId === 'paint-navy');
		let innermost = Infinity;
		for (const group of gas.geometry.groups)
		{
			if (group.materialIndex !== index) {continue;}
			for (let i = group.start; i < group.start + group.count; i++)
			{
				if (position.getY(i) < trim.max.y - 2) {continue;}
				innermost = Math.min(innermost, Math.abs(position.getX(i)));
			}
		}
		expect(innermost).toBeGreaterThan(6);
	});

	it('keeps an electric range*s rings on its own ceramic top', () =>
	{
		// The outer ring sat 1cm past the edge of the glass before the burners
		// were spread off the EDGE rather than off the centre.
		const electric = buildAppliance({subkind: 'range', fuel: 'electric'});
		const ceramic = partBounds(electric, 'glass-smoked');
		const rings = partBounds(electric, 'metal-stainless');
		expect(ceramic.max.x).toBeGreaterThan(30);
		// The rings are stainless, and so is the body - so this only says the
		// ceramic reaches wider than the burners do, which is the failure case.
		expect(ceramic.max.x).toBeLessThanOrEqual(rings.max.x);
		expect(Math.max(8, 76.2 / 2 - 19.0) + 9).toBeLessThan(ceramic.max.x);
	});

	it('makes gas and electric different objects', () =>
	{
		const gas = buildAppliance({subkind: 'range', fuel: 'gas'});
		const electric = buildAppliance({subkind: 'range', fuel: 'electric'});
		// A ceramic top is one slab that a gas range does not have anywhere.
		expect(partBounds(electric, 'glass-smoked').max.x)
			.toBeGreaterThan(partBounds(gas, 'glass-smoked').max.x);
	});

	it('stands a freestanding range*s backguard up behind it', () =>
	{
		// Its absence is what makes a range read as a slide-in, so it is the
		// geometry that tells the two styles apart.
		const free = buildAppliance({subkind: 'range', style: 'freestanding'});
		const slide = buildAppliance({subkind: 'range', style: 'slide-in'});
		// Not the backguard's full 17.78: a slide-in's envelope still carries the
		// grate standing over its cooktop, and the difference is what is left.
		expect(size(free).y).toBeGreaterThan(size(slide).y + 12);
	});
});

describe('a hood is a canopy and a flue', () =>
{
	it('hangs the filter BELOW the canopy, where it can be seen', () =>
	{
		// Set inside the canopy - which is where a real filter sits - it was
		// swallowed whole, because a canopy is a solid. The render from below
		// showed a blank cap and the vertex count showed a filter that was there.
		// The baffles across the filter are HARDWARE, which on a stainless hood is
		// the same material as the canopy - so they have to be told apart or the
		// canopy appears to reach as low as they do.
		const chimney = buildAppliance(
			{subkind: 'hood', style: 'wall-chimney', material: {hardware: 'metal-brass'}});
		const filter = partBounds(chimney, 'metal-matte-black');
		const canopy = partBounds(chimney, 'metal-stainless');
		expect(filter.min.y).toBeLessThan(canopy.min.y);
	});

	it('runs a ducted flue to the ceiling and stops a recirculating one short', () =>
	{
		// A ductless hood*s flue is a cover, and drawing it into the ceiling would
		// claim a duct that is not there.
		const ducted = buildAppliance({
			subkind: 'hood', style: 'wall-chimney', ceilingHeight: 243.84, mountHeight: 167.64});
		const loose = buildAppliance({
			subkind: 'hood', style: 'wall-chimney', ceilingHeight: 243.84, mountHeight: 167.64,
			ductless: true});
		// The flue reaches the ceiling; the envelope is that plus the filter, which
		// hangs proud below the canopy so it can be seen.
		// Not an exact equality: geometry positions are float32, so a 76.2cm extent
		// resolves to a few microns and `>= 76.2` fails on the nose.
		expect(size(ducted).y).toBeGreaterThan(243.84 - 167.64 - 0.01);
		expect(size(ducted).y).toBeLessThan(243.84 - 167.64 + 3);
		expect(size(loose).y).toBeLessThan(size(ducted).y - 10);
	});

	it('follows the ceiling it is told about', () =>
	{
		const low = buildAppliance({subkind: 'hood', style: 'wall-chimney', ceilingHeight: 243.84});
		const high = buildAppliance({subkind: 'hood', style: 'wall-chimney', ceilingHeight: 274.32});
		expect(size(high).y - size(low).y).toBeCloseTo(30.48, 1);
	});

	it('leans a wall hood*s canopy back and leaves an island*s symmetric', () =>
	{
		// A frustum is symmetric by construction and a wall hood is not: with the
		// symmetric one the flue overhung the canopy top by a third of the depth
		// and stood on nothing, which no dimension of either part reports.
		const wall = buildAppliance({subkind: 'hood', style: 'wall-chimney'});
		const island = buildAppliance({subkind: 'hood', style: 'island'});
		// The flue and the canopy top are the same rectangle in both, so the test
		// is where that rectangle IS: at the back for a wall hood, centred for an
		// island one. Read off the topmost slice of the body material.
		const backOf = (built) =>
		{
			const box = bounds(built);
			const position = built.geometry.getAttribute('position');
			let front = -Infinity;
			for (let i = 0; i < position.count; i++)
			{
				if (position.getY(i) > box.max.y - 1)
				{
					front = Math.max(front, position.getZ(i));
				}
			}
			return front;
		};
		expect(backOf(wall)).toBeLessThan(0);
		expect(backOf(island)).toBeGreaterThan(0);
	});

	it('gives a downdraft a vane and no canopy at all', () =>
	{
		const down = buildAppliance({subkind: 'hood', style: 'downdraft'});
		const under = buildAppliance({subkind: 'hood', style: 'under-cabinet'});
		// Deep front to back is a canopy; narrow and tall is a slot with a vane.
		expect(size(down).z).toBeLessThan(size(under).z / 2);
		expect(size(down).y).toBeGreaterThan(size(under).y);
	});
});

describe('a microwave*s mount is where it is and what it must do there', () =>
{
	it('puts the over-range vent and lights UNDER it', () =>
	{
		// At +0.5 the baffles were buried in the carcass and the underside
		// rendered as a plain dark rectangle. Under the range is the one place an
		// over-range microwave is looked at from.
		// Same material trap as the hood: the grille bars are hardware, and on a
		// stainless machine that is the body's material too.
		const otr = buildAppliance(
			{subkind: 'microwave', mount: 'over-range', material: {hardware: 'metal-brass'}});
		const body = partBounds(otr, 'metal-stainless');
		const vent = partBounds(otr, 'metal-matte-black');
		const grille = partBounds(otr, 'metal-brass');
		expect(vent.min.y).toBeLessThan(body.min.y);
		expect(grille.min.y).toBeLessThan(body.min.y);
		// And the lamps are a lens, not a smoked pane - they read as two black
		// holes otherwise, which is what the first render from below showed.
		expect(hasMaterial(otr, 'lacquer-white')).toBe(true);
	});

	it('gives a drawer a front and no swing door', () =>
	{
		// One front that pulls out, controls along its top edge, and no window: a
		// drawer microwave has no door to put one in.
		const drawer = buildAppliance({subkind: 'microwave', mount: 'drawer'});
		expect(hasMaterial(drawer, 'glass-smoked')).toBe(false);
		expect(hasMaterial(drawer, 'metal-matte-black')).toBe(true);
		const swing = buildAppliance({subkind: 'microwave', mount: 'counter'});
		expect(hasMaterial(swing, 'glass-smoked')).toBe(true);
	});

	it('stands a countertop one on feet', () =>
	{
		const counter = buildAppliance({subkind: 'microwave', mount: 'counter'});
		expect(size(counter).y).toBeGreaterThan(30.48);
		expect(size(counter).y).toBeLessThan(30.48 + 3);
	});
});

describe('a window is a window and not a hole', () =>
{
	it('frames the oven pane inside its door', () =>
	{
		// A border of face metal round a pane, with the pane just proud of the
		// slab behind it - which is how an oven door is built, and what gives the
		// border its shadow line. Judged off the SHORTER side, because judging
		// each side separately gave a 7cm frame on a 75cm door: a black hole with
		// a pinstripe round it.
		const range = buildAppliance({subkind: 'range'});
		const pane = partBounds(range, 'glass-smoked');
		expect(pane.max.x).toBeLessThan(76.2 / 2 - 8);
		expect(pane.min.x).toBeGreaterThan(-76.2 / 2 + 8);
	});

	it('gives a panel-ready machine no window, because that is the point of it', () =>
	{
		const panel = buildAppliance({subkind: 'dishwasher', finish: 'panel-ready'});
		expect(hasMaterial(panel, 'glass-smoked')).toBe(false);
	});
});

describe('through the model layer', () =>
{
	beforeEach(() =>
	{
		resetAll();
		// jsdom has no 2D context, and Item builds two label canvases.
		installCanvas2D(window);
	});

	/**
	 * A design with one appliance in it, loaded the way the app loads one.
	 *
	 * No item loader is installed, on purpose: the generated branch in
	 * `Scene.addItem` sits ahead of both the asset-manifest check and the
	 * `itemLoader` seam, so an appliance has to arrive synchronously and without
	 * network. If that ever stopped being true this is what would say so.
	 */
	function roomWith(spec, type)
	{
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: {
				version: '2.0.0', units: 'cm',
				corners: {
					a: {x: 0, y: 0, elevation: 243.84}, b: {x: 400, y: 0, elevation: 243.84},
					c: {x: 400, y: 300, elevation: 243.84}, d: {x: 0, y: 300, elevation: 243.84},
				},
				walls: [
					{corner1: 'a', corner2: 'b'}, {corner1: 'b', corner2: 'c'},
					{corner1: 'c', corner2: 'd'}, {corner1: 'd', corner2: 'a'},
				],
				rooms: {}, wallTextures: [], floorTextures: {}, newFloorTextures: {},
			},
			items: [{
				id: 'appliance-1', item_name: 'Range', item_type: type, format: 'generated',
				model_url: 'generated:appliance', spec: spec,
				xpos: 200, ypos: 55, zpos: 10,
				rotation: 0, scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
			}],
		}));
		return model;
	}

	it('places a range against a wall and keeps the size the builder gave it', () =>
	{
		const model = roomWith({kind: 'appliance', subkind: 'range'}, 9);
		const item = model.scene.getItems()[0];
		expect(item, 'the appliance loaded').toBeTruthy();
		expect(item.currentWallEdge, 'it bound to a wall').toBeTruthy();
		// Never scaled - a generated item is rebuilt at the size it is asked for,
		// and a leftover scale would multiply against the next size.
		expect(item.scale.x).toBe(1);
		expect(item.getWidth()).toBeCloseTo(size(buildAppliance({subkind: 'range'})).x, 2);
	});

	it('round-trips its spec through a save', () =>
	{
		const model = roomWith(
			{kind: 'appliance', subkind: 'hood', style: 'island', ductless: true}, 2);
		const saved = JSON.parse(model.exportSerialized());
		expect(saved.items[0].spec.subkind).toBe('hood');
		expect(saved.items[0].spec.style).toBe('island');
		expect(saved.items[0].spec.ductless).toBe(true);
		expect(saved.items[0].model_url).toBe('generated:appliance');
	});
});

/*
 * The three appliances a real kitchen named, and what each one needed.
 *
 * Not "add a Samsung": every one of these is a shape the builder could not make,
 * and each is asked for by more than one manufacturer. A four-door fridge is
 * French doors over TWO drawers; a beverage cooler is a fridge the height of a
 * base cabinet with glass in it; a five-burner top has a zone in the middle
 * where a four-burner top has the corner of four grates.
 */
describe('a four-door fridge is French doors over two drawers', () =>
{
	const four = (extra) => buildAppliance(Object.assign({
		subkind: 'fridge', doors: 'four-door', width: 90.68, height: 177.8,
		depth: 87.12, material: {face: 'paint-sage', hardware: 'metal-brass',
			body: 'metal-stainless', trim: 'metal-matte-black'},
	}, extra));

	/**
	 * The horizontal edges the face is divided at.
	 *
	 * Every front is one box, so its top and bottom are two of these - and the
	 * count is therefore how many horizontal BANDS the face has, times two. A
	 * bounding box cannot see a seam and a vertex count cannot say where one is;
	 * this can, and it is the measurement the layouts actually differ in.
	 */
	const faceEdges = (built) =>
	{
		const index = built.materials.findIndex((m) => m.userData.materialId === 'paint-sage');
		const position = built.geometry.getAttribute('position');
		const edges = [];
		for (const group of built.geometry.groups)
		{
			if (group.materialIndex !== index) {continue;}
			for (let i = group.start; i < group.start + group.count; i++)
			{
				const y = position.getY(i);
				if (!edges.some((e) => Math.abs(e - y) < 0.5)) {edges.push(y);}
			}
		}
		return edges.length;
	};

	it('carries two drawers where a French door carries one', () =>
	{
		// The whole difference, and the reason it is a fourth door rather than a
		// bigger freezer: a convertible compartment between the fridge and the
		// freezer, with its own front. Three horizontal bands against two, so six
		// horizontal edges against four - the pair of doors shares its band.
		expect(faceEdges(four({}))).toBe(6);
		expect(faceEdges(four({doors: 'french'}))).toBe(4);
	});

	it('is more face than a French door, not the same face relabelled', () =>
	{
		expect(verts(four({}))).toBeGreaterThan(verts(four({doors: 'french'})));
	});

	it('sets a beverage panel into a door when asked, and not otherwise', () =>
	{
		const plain = four({});
		const panelled = four({doorInDoor: true});
		expect(verts(panelled)).toBeGreaterThan(verts(plain));
		// It stands PROUD of the door it is set into, which is what makes the seam
		// round it catch the light - flush, it is one surface and reads as a
		// sticker. Measured on the face, because that is the surface it moves.
		expect(partBounds(panelled, 'paint-sage').max.z)
			.toBeGreaterThan(partBounds(plain, 'paint-sage').max.z);
	});
});

describe('a recessed handle is the absence of a bar', () =>
{
	const fridge = (handles) => buildAppliance({
		subkind: 'fridge', doors: 'french', handles: handles,
		material: {face: 'paint-sage', hardware: 'metal-brass'},
	});

	it('stands in the door rather than off it', () =>
	{
		// The flat-panel look, and the one measurement that IS it. Asked of the
		// HARDWARE against the FACE rather than of the whole bounding box: a bar
		// is in front of the door and a pocket is behind its front surface, and
		// that comparison says so in one line whatever else is on the appliance.
		const bar = fridge('bar');
		expect(partBounds(bar, 'metal-brass').max.z)
			.toBeGreaterThan(partBounds(bar, 'paint-sage').max.z);
		const flush = fridge('recessed');
		expect(partBounds(flush, 'metal-brass').max.z)
			.toBeLessThanOrEqual(partBounds(flush, 'paint-sage').max.z);
		// And the appliance is shallower for it.
		expect(bounds(bar).max.z).toBeGreaterThan(bounds(flush).max.z);
	});

	it('is still something you can see, unlike no handle at all', () =>
	{
		expect(hasMaterial(fridge('recessed'), 'metal-brass')).toBe(true);
		expect(hasMaterial(fridge('none'), 'metal-brass')).toBe(false);
	});
});

describe('a beverage cooler is a fridge the size of a base cabinet', () =>
{
	const cooler = buildAppliance({subkind: 'fridge', style: 'undercounter',
		material: {face: 'paint-sage', glass: 'glass-clear'}});

	it('is worktop height, so the counter runs over it', () =>
	{
		// 34.5in, which is a base carcass - not a number chosen here but the one
		// every cabinet beside it already is.
		expect(size(cooler).y).toBeCloseTo(87.15, 1);
		expect(size(cooler).x).toBeLessThan(61);
	});

	it('has glass in its one door, because that is what it is for', () =>
	{
		expect(hasMaterial(cooler, 'glass-clear')).toBe(true);
		// One door, not two: the pane is off centre because the door is the whole
		// face and its handle is on one side.
		const glass = partBounds(cooler, 'glass-clear');
		expect(glass.max.x - glass.min.x).toBeGreaterThan(30);
	});

	it('is a solid-fronted fridge in every other style', () =>
	{
		expect(hasMaterial(buildAppliance({subkind: 'fridge',
			material: {glass: 'glass-clear'}}), 'glass-clear')).toBe(false);
	});
});

describe('a five-burner top has a zone in the middle', () =>
{
	const range = (extra) => buildAppliance(Object.assign({
		subkind: 'range', fuel: 'gas', width: 76.2,
		material: {trim: 'metal-matte-black', body: 'metal-stainless'},
	}, extra));

	it('puts something where a four-burner top has the corner of four grates', () =>
	{
		const four = verts(range({burners: 4}));
		const five = verts(range({burners: 5}));
		expect(five).toBeGreaterThan(four);
	});

	it('lays a griddle over it rather than a grate, when asked', () =>
	{
		// Both cover the middle; only one of them is a plate. The griddle is solid
		// and a grate is three bars, so the griddle is the one with FEWER parts
		// over the same area - which is the opposite of what a count usually says
		// and the reason to assert it.
		expect(verts(range({burners: 5, griddle: true})))
			.toBeLessThan(verts(range({burners: 5, griddle: false})));
	});

	it('leaves a four-burner top alone', () =>
	{
		// Griddle is meaningless without the zone under it, and asking for one
		// must not draw a plate across the middle of four burners.
		expect(verts(range({burners: 4, griddle: true})))
			.toBe(verts(range({burners: 4, griddle: false})));
	});

	it('takes six on a wide range, which is the same rule with three columns', () =>
	{
		expect(verts(range({burners: 6, width: 91.44})))
			.toBeGreaterThan(verts(range({burners: 4, width: 91.44})));
	});
});

describe('a cabinet hood is millwork, not an appliance in a run', () =>
{
	/** Distinct slots, so the front can be told from the box behind it. */
	const SLOTS = {body: 'wood-birch-ply', face: 'wood-walnut',
		trim: 'metal-matte-black', hardware: 'paint-greige'};

	const hood = (spec) => buildAppliance(Object.assign({
		subkind: 'hood', style: 'cabinet-front', front: 'shaker',
		ceilingHeight: 243.84, mountHeight: 167.64, material: SLOTS,
	}, spec));

	/** How many vertices one material draws. A box is 36 once de-indexed. */
	function partVerts(built, materialId)
	{
		const index = built.materials.findIndex((m) => m.userData.materialId === materialId);
		if (index < 0) {return 0;}
		return built.geometry.groups
			.filter((group) => group.materialIndex === index)
			.reduce((sum, group) => sum + group.count, 0);
	}

	/**
	 * Boxes drawn in the cabinet finish.
	 *
	 * The box AND its front, because a cabinet hood is one piece of millwork:
	 * unlike a panel-ready dishwasher, whose dark carcass is buried in the run,
	 * this thing's sides and top are in the room and are the same painted stock
	 * as its face.
	 */
	const boxes = (built) => partVerts(built, 'wood-walnut') / 36;

	it('wears the run door front, built by the run own builder', () =>
	{
		// The whole claim. Not a colour that matches - a front built by
		// `cabinet.js`'s `frontPanel`, which is the same call a panel-ready
		// dishwasher makes and the reason that function is exported. So a shaker
		// kitchen gets a shaker hood without anybody keeping the two in step.
		//
		// A section is its own box plus its front: one more box for a slab, five
		// for a shaker. Two sections in a plain cabinet hood.
		expect(boxes(hood({front: 'slab'}))).toBe(2 * (1 + 1));
		expect(boxes(hood({front: 'shaker'}))).toBe(2 * (1 + 5));
	});

	it('is panel-ready whatever the finish says', () =>
	{
		// There is no such thing as a stainless hood with a shaker profile on it,
		// so the style settles the finish rather than letting the two disagree.
		// It is also what makes the panel-style control appear, since the schema
		// shows that for a panel-ready appliance.
		const steel = hood({finish: 'stainless'});
		expect(hasMaterial(steel, 'metal-stainless')).toBe(false);
	});

	it('drops back to the uppers depth above the canopy', () =>
	{
		// The step is the point. The canopy keeps the hood's own depth, because
		// that is what captures over a cooktop; the mantel above it comes back to
		// the wall cabinets' depth so its face lands in their plane and the run
		// does not step at the hood.
		const built = hood({depth: 50.8, upperDepth: 30.48});
		const box = bounds(built);
		const pos = built.geometry.getAttribute('position');

		// Front-most point in the bottom band, and in the top one.
		const frontmostAbove = (from, to) =>
		{
			let z = -Infinity;
			for (let i = 0; i < pos.count; i++)
			{
				const y = pos.getY(i);
				if (y >= from && y <= to) {z = Math.max(z, pos.getZ(i));}
			}
			return z;
		};
		const canopy = frontmostAbove(box.min.y + 5, 20);
		const mantel = frontmostAbove(box.max.y - 20, box.max.y);

		expect(canopy).toBeGreaterThan(mantel);
		// And by about the difference between the two depths.
		expect(canopy - mantel).toBeCloseTo((50.8 - 30.48) / 1, 0);
	});

	it('puts a cupboard over the mantel when asked, as a third front', () =>
	{
		// Same box, one more front, with a reveal between them - which is what
		// makes a cupboard read as a cupboard rather than as more mantel.
		// Two sections against three, at six boxes a shaker section.
		expect(boxes(hood({style: 'cabinet-front'}))).toBe(2 * 6);
		expect(boxes(hood({style: 'cabinet-over'}))).toBe(3 * 6);
	});

	it('runs the mantel on rather than fitting a cupboard nobody can use', () =>
	{
		// A low ceiling leaves a gap that is a filler, not a cupboard. Coming out
		// as a plain mantel is the honest answer, and it is the same fallback
		// `frontPanel` makes for a door too narrow to hold a centre panel.
		const low = hood({style: 'cabinet-over', ceilingHeight: 213.36});
		const plain = hood({style: 'cabinet-front', ceilingHeight: 213.36});
		expect(partVerts(low, 'wood-walnut')).toBe(partVerts(plain, 'wood-walnut'));
	});

	it('still has a filter under it, because it is a hood', () =>
	{
		// A wood hood is a wood BOX round a metal liner, and the liner is the only
		// part of it that is an appliance at all. Without it this is a cupboard
		// over a cooker.
		const built = hood({});
		const filter = partBounds(built, 'metal-matte-black');
		expect(filter.min.y).toBeLessThan(0);
		// Proud of the canopy, not swallowed by it - the fault that made the metal
		// hood's filter render as a blank cap.
		expect(filter.max.y).toBeLessThan(5);
	});

	it('reaches the ceiling it is told about', () =>
	{
		const tall = hood({ceilingHeight: 274.32});
		const short = hood({ceilingHeight: 243.84});
		expect(size(tall).y).toBeGreaterThan(size(short).y);
		expect(size(short).y).toBeCloseTo(243.84 - 167.64 + 1.6, 0);
	});
});
