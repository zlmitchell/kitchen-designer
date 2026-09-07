// @ts-check
import {Box3, CylinderGeometry, Group, LatheGeometry, Mesh, Vector2, Vector3} from 'three';
import {mergeMeshes} from '../../core/geometry_merge.js';
import {materialsForSlots} from '../../core/materials.js';
import {boxGeometryFor} from '../../core/geometry_builders.js';

/**
 * A sink: a basin, and where it sits relative to the worktop.
 *
 * ## The mounts are one builder, not five models
 *
 * This is the whole design. `drop-in`, `undermount`, `farmhouse`, `vessel` and
 * `semi-recessed` are the same bowl at different heights against the slab, plus
 * at most one extra piece:
 *
 *   - **undermount** hangs below. The counter's cutout IS the bowl opening and
 *     the slab's cut edge is what you see, which is why `counter.js` walls its
 *     holes rather than hiding triangles.
 *   - **drop-in** has a rim flange resting ON the slab. Its cutout is
 *     *undersized* - the one case where the hole is smaller than the bowl, and
 *     therefore the one that catches a sign error.
 *   - **farmhouse** adds a thick front apron that replaces the cabinet front
 *     below it. That makes it a phase 3 dependency and not only a cutout.
 *   - **vessel** stands wholly above the slab. There is no bowl cutout at all,
 *     only a tailpiece hole - and it dictates the counter's height, because a
 *     vessel adds 5-7in and a vanity carrying one sits at 30-32in rather than
 *     34.5in. That is the thing that goes wrong with vessels in real life.
 *   - **semi-recessed** is the bath case in between, and falls out for free: a
 *     vessel with the cutout back and a `dropDepth` saying how far in it sits.
 *
 * ## Shape is a real geometry fork
 *
 * A kitchen sink is a rectangle and a bath vessel usually is not, and the two
 * are not one primitive with a parameter. A rectangle is panels, like a carcass.
 * A round one is a **lathe over a wall-section profile** - revolve a line that
 * runs down the outside, across the floor and back up the inside, and the
 * radius, the wall thickness, the floor slope and the rim roll all come out of
 * one profile in one call. Oval is that lathe scaled on one axis. It is less
 * code than the box case, not more.
 *
 * ## Wall thickness is the material
 *
 * A 2mm stainless bowl and a 25mm fireclay one are not the same object in a
 * different colour, and thinness is the thing you actually see. So the material
 * carries a thickness, and stainless is the one to look at first: it is the only
 * one where the wall is visibly thin, which is what proves the basin is real
 * geometry and not a box.
 */

const SLOTS = {
	basin: 'metal-stainless',
	apron: 'metal-stainless',
};

/**
 * How thick the wall is, per material, in centimetres.
 *
 * Not decoration. A fireclay farmhouse has a wall you could stand on and a
 * pressed stainless bowl has one you can flex with a thumb, and at any distance
 * you will look at these from, that difference is the difference.
 */
const WALL_THICKNESS = {
	'metal-stainless': 0.2,
	'metal-brushed-nickel': 0.2,
	'stone-soapstone': 2.2,
	'stone-marble-carrara': 2.2,
	'paint-white': 1.5,
	'lacquer-white': 1.5,
};
const DEFAULT_WALL = 1.2;

const DEFAULTS = {
	mount: 'undermount',
	shape: 'rect',
	/** 30in, the commonest single-bowl kitchen sink. */
	width: 76.2,
	/** Front to back. */
	frontToBack: 47.0,
	/** How deep the bowl is. 9.5in. */
	depth: 24.1,
	/**
	 * Bowl widths as fractions of the whole. `[1]` single, `[0.5, 0.5]` a 50/50,
	 * `[0.6, 0.4]` an offset double. Rectangles only: a round basin is single by
	 * construction.
	 */
	bowls: [1],
	/** The workstation rail step inside the rim, which most new sinks have. */
	ledge: false,
	/** How far a drop-in or semi-recessed rim stands above the slab. */
	proud: 1.0,
	/** How far a semi-recessed bowl drops into the slab. */
	dropDepth: 6.0,
	/** Farmhouse: how tall the apron is, and whether it sits proud of the front. */
	apronHeight: 25.4,
	apronReveal: 0,
	drain: true,
};

/**
 * @typedef {Object} SinkSpec
 * @property {('undermount'|'drop-in'|'farmhouse'|'vessel'|'semi-recessed')} [mount]
 * @property {('rect'|'round'|'oval')} [shape]
 * @property {number} [width] @property {number} [frontToBack] @property {number} [depth]
 * @property {Array<number>} [bowls]
 * @property {boolean} [ledge] @property {boolean} [drain]
 * @property {number} [apronHeight] @property {number} [apronReveal]
 * @property {Object} [material]
 */

function box(mat, x0, x1, y0, y1, z0, z1)
{
	var mesh = new Mesh(boxGeometryFor(mat, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)), mat);
	mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
	return mesh;
}

/**
 * One rectangular bowl: four walls, a floor, and the drain in it.
 *
 * The floor is dropped a few millimetres more at the drain end than at the
 * front. Sloping it costs nothing and is the difference between a basin and a
 * hole.
 */
function rectBowl(mat, x0, x1, z0, z1, top, depth, wall, drainMat, wantDrain)
{
	var parts = [];
	var floorY = top - depth;
	parts.push(box(mat, x0, x0 + wall, floorY, top, z0, z1));
	parts.push(box(mat, x1 - wall, x1, floorY, top, z0, z1));
	parts.push(box(mat, x0, x1, floorY, top, z0, z0 + wall));
	parts.push(box(mat, x0, x1, floorY, top, z1 - wall, z1));
	// The floor, tipped very slightly back toward the waste.
	var floor = box(mat, x0, x1, floorY, floorY + wall, z0, z1);
	floor.rotation.x = -0.012;
	parts.push(floor);
	if (wantDrain)
	{
		var drain = new Mesh(new CylinderGeometry(4.4, 4.4, wall * 1.6, 16), drainMat);
		drain.position.set((x0 + x1) / 2, floorY + wall, (z0 + z1) / 2);
		parts.push(drain);
	}
	return parts;
}

/**
 * A round or oval bowl, as a lathe over its own wall section.
 *
 * The profile runs: underside centre, out along the underside, up the outer
 * wall to the rim, back down the inner wall, and in along the inner floor to the
 * centre. Revolving that gives thickness, floor and rim in one object - which is
 * why this is shorter than the rectangle, not longer.
 */
function roundBowl(mat, radius, top, depth, wall, oval, drainMat, wantDrain)
{
	var floorY = top - depth;
	var profile = [
		new Vector2(0.01, floorY),
		new Vector2(radius, floorY),
		new Vector2(radius, top),
		new Vector2(radius - wall, top),
		new Vector2(radius - wall, floorY + wall),
		new Vector2(0.01, floorY + wall),
	];
	var mesh = new Mesh(new LatheGeometry(profile, 28), mat);
	if (oval !== 1)
	{
		// An oval is the same lathe, squeezed. Front to back, because that is the
		// axis a basin is narrower on.
		mesh.scale.z = oval;
	}
	// Typed as the general Mesh, not as whatever the first element happened to be
	// - an array literal takes its type from its initialiser, so `[mesh]` was
	// `Mesh<LatheGeometry>[]` and the drain, being a cylinder, could not join it.
	/** @type {Array<Mesh>} */
	var parts = [mesh];
	if (wantDrain)
	{
		var drain = new Mesh(new CylinderGeometry(4.4, 4.4, wall * 1.6, 16), drainMat);
		drain.position.set(0, floorY + wall, 0);
		parts.push(drain);
	}
	return parts;
}

/**
 * The footprint a bowl actually occupies, in centimetres.
 *
 * Exported because the worktop has to be cut to the bowl and not to the spec: a
 * round sink's spec says `width` 76.2 and `frontToBack` 47, and the bowl is a
 * 47cm circle. `items/fitting.js` cuts the hole and would otherwise cut a
 * rectangle 29cm wider than the thing going into it.
 *
 * @param {SinkSpec} spec
 * @returns {{width: number, depth: number}}
 */
export function openingFor(spec)
{
	var width = Math.max(10, spec.width === undefined ? DEFAULTS.width : spec.width);
	var ftb = Math.max(10, spec.frontToBack === undefined ? DEFAULTS.frontToBack : spec.frontToBack);
	if (spec.shape === 'round')
	{
		var diameter = Math.min(width, ftb);
		return {width: diameter, depth: diameter};
	}
	// A rect fills its span, and an oval is squeezed to it - both are `width` by
	// `frontToBack` at the rim.
	return {width: width, depth: ftb};
}

/**
 * Where the bowl's rim sits, given the mount.
 *
 * y = 0 is the top of the worktop throughout, which is what makes these five
 * one builder: every mount is an answer to "where is the rim relative to the
 * slab", and the extra pieces hang off that.
 *
 * @returns {{rimY: number, flange: boolean, apron: boolean}}
 */
function mounting(spec)
{
	switch (spec.mount)
	{
	case 'drop-in':
		// Rim above the slab, bowl below. The cutout is UNDERSIZED so the flange
		// has something to rest on.
		return {rimY: spec.proud, flange: true, apron: false};
	case 'vessel':
		// Wholly above. No bowl cutout at all - only a tailpiece hole.
		return {rimY: spec.depth, flange: false, apron: false};
	case 'semi-recessed':
		return {rimY: spec.depth - spec.dropDepth, flange: false, apron: false};
	case 'farmhouse':
		return {rimY: 0, flange: false, apron: true};
	default:
		// Undermount: the cutout IS the opening and the slab's cut edge shows.
		return {rimY: 0, flange: false, apron: false};
	}
}

/** What a panel may ask about a sink. */
export const SINK_SCHEMA = {
	label: 'Sink',
	fields: [
		{key: 'mount', label: 'Mount', type: 'choice', options: [
			{value: 'undermount', label: 'Undermount'},
			{value: 'drop-in', label: 'Drop-in'},
			{value: 'farmhouse', label: 'Farmhouse'},
			{value: 'vessel', label: 'Vessel'},
			// `mounting()` has answered for this one since the builder was written
			// and nothing could ask for it - the same gap the cabinet's drawers
			// were in. A bowl that drops part way into the slab and stands part way
			// proud of it, which is neither of the two either side of it here.
			{value: 'semi-recessed', label: 'Semi-recessed'},
		]},
		{key: 'shape', label: 'Shape', type: 'choice', options: [
			{value: 'rect', label: 'Rectangular'},
			{value: 'round', label: 'Round'},
			{value: 'oval', label: 'Oval'},
		]},
		{key: 'width', label: 'Width', type: 'length', min: 25, max: 120, step: 1},
		{key: 'frontToBack', label: 'Front to back', type: 'length', min: 20, max: 70, step: 1,
			when: {shape: 'rect'}},
		{key: 'depth', label: 'Bowl depth', type: 'length', min: 8, max: 40, step: 0.5},
		{key: 'apronHeight', label: 'Apron height', type: 'length', min: 10, max: 40, step: 1,
			when: {mount: 'farmhouse'}},
		{shared: true, key: 'material.basin', label: 'Basin', type: 'material'},
	],
};

/**
 * Build a sink.
 *
 * @param {SinkSpec} spec
 * @returns {import('./index.js').GeneratedBuild}
 */
export function buildSink(spec)
{
	var s = Object.assign({}, DEFAULTS, spec || {});
	var mats = materialsForSlots(s.material, SLOTS);
	var basinId = (s.material && s.material.basin) || SLOTS.basin;
	var wall = (WALL_THICKNESS[basinId] === undefined) ? DEFAULT_WALL : WALL_THICKNESS[basinId];

	var width = Math.max(10, s.width);
	var ftb = Math.max(10, s.frontToBack);
	var depth = Math.max(3, s.depth);
	var place = mounting(s);
	var group = new Group();

	if (s.shape === 'rect')
	{
		// Bowls split the width. A divider is whatever is left between two of
		// them, so the walls of neighbouring bowls do the job with no extra part.
		var weights = (s.bowls && s.bowls.length) ? s.bowls : [1];
		var total = weights.reduce(function (sum, w) {return sum + Math.max(0.05, w);}, 0);
		var cursor = -width / 2;
		weights.forEach(function (weight)
		{
			var span = width * (Math.max(0.05, weight) / total);
			rectBowl(mats.basin, cursor, cursor + span, -ftb / 2, ftb / 2,
				place.rimY, depth, wall, mats.basin, s.drain)
				.forEach(function (mesh) {group.add(mesh);});
			cursor += span;
		});
	}
	else
	{
		// A ROUND bowl is round, so its diameter is the smaller of the two spans -
		// not the width. Taking `width` for both was the bug behind "round blows
		// out the front": a 76cm sink in a 47cm-deep opening came out 76cm deep
		// as well, which is 29cm of bowl hanging past a 63.5cm worktop and through
		// the cabinet face. An OVAL is the one that gets to use both, which is
		// what an oval is for.
		var diameter = (s.shape === 'oval') ? width : Math.min(width, ftb);
		roundBowl(mats.basin, diameter / 2, place.rimY, depth, wall,
			(s.shape === 'oval') ? Math.max(0.3, ftb / width) : 1, mats.basin, s.drain)
			.forEach(function (mesh) {group.add(mesh);});
	}

	if (place.flange)
	{
		// The rim that rests on the slab. This is what makes a drop-in read as a
		// drop-in: a visible lip all the way round.
		var lip = 1.9;
		var f0 = place.rimY - s.proud;
		group.add(box(mats.basin, -width / 2 - lip, width / 2 + lip, f0, place.rimY,
			-ftb / 2 - lip, -ftb / 2));
		group.add(box(mats.basin, -width / 2 - lip, width / 2 + lip, f0, place.rimY,
			ftb / 2, ftb / 2 + lip));
		group.add(box(mats.basin, -width / 2 - lip, -width / 2, f0, place.rimY,
			-ftb / 2, ftb / 2));
		group.add(box(mats.basin, width / 2, width / 2 + lip, f0, place.rimY,
			-ftb / 2, ftb / 2));
	}

	if (place.apron)
	{
		// The face that replaces the cabinet front below it. Thicker than the
		// bowl wall, because on a real farmhouse it is - and it is the part you
		// stand against.
		var apronThickness = Math.max(wall, 2.5);
		var front = ftb / 2 + s.apronReveal;
		group.add(box(mats.apron, -width / 2, width / 2,
			place.rimY - s.apronHeight, place.rimY, front, front + apronThickness));
	}

	// Centred, like every generated part. Which loses the "y = 0 is the worktop"
	// frame the mounts were reasoned in - so the shift is REPORTED rather than
	// simply thrown away, and `items/fitting.js` puts the datum back by reading
	// it. That comment used to end "phase 3's run is what will put it back";
	// this is the smallest piece of that run, built because three bugs were the
	// same bug: a drop-in that did not rise above the slab, a cutout that did not
	// follow the mount, and a cabinet front that ignored an apron.
	group.updateMatrixWorld(true);
	var middle = new Box3().setFromObject(group).getCenter(new Vector3());
	group.children.forEach(function (child) {child.position.sub(middle);});
	// Again: mergeMeshes recomputes each mesh from its parent's CURRENT world
	// matrix, so a shift after the last update would be ignored.
	group.updateMatrixWorld(true);

	var merged = mergeMeshes(group);
	return {
		geometry: merged.geometry,
		materials: merged.materials,
		parts: [],
		// How far the recentring above moved the builder's origin. Everything in
		// `mounting()` is expressed against "y = 0 is the top of the worktop", so
		// this is what a caller needs to put that plane back where it belongs:
		// the item's centre sits `datum.y` above it.
		datum: {y: middle.y},
	};
}
