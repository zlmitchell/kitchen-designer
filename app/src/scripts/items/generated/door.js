// @ts-check
import {BoxGeometry, Group, Mesh, Object3D} from 'three';
import {mergeMeshes} from '../../core/geometry_merge.js';
import {disposeObject} from '../../core/resource_registry.js';
import {materialsForSlots} from '../../core/materials.js';

/**
 * A door, generated from a spec rather than loaded from a file.
 *
 * The first parametric opening, and the reason it exists is that no asset could
 * do the job. `open_door.glb` is not an open door: decoded, it is the same
 * frame, the same in-plane leaf and the same four hinges as
 * `closed-door28x80_baked.glb` with the three doorknob parts deleted, and its
 * whole bounding box is 97.1 x 221.58 x **7.62cm**. A 32in leaf swung 90
 * degrees projects about 81cm. Nothing in that file leaves the wall, so no
 * placement or rotation could ever have shown a door standing open.
 *
 * Three further things would have stopped a corrected asset working, and all
 * three are why this is generated instead of modelled:
 *
 *   - `items_for` scaled an opening's depth to its wall with
 *     `scale_z = thickness / model_depth`. Hand it a model whose depth includes
 *     an 81cm swing and it scales z by 7.7/89, flattening the leaf into the wall
 *     plane. A correct asset would have looked *worse* than the wrong one.
 *   - `Scene.addItem` merges the whole glTF hierarchy into one BufferGeometry
 *     (`mergeMeshes(gltfModel.scene)`), so a leaf authored as its own node -
 *     which is what Kenney's `doorway.glb` does - is baked in and cannot turn.
 *   - one rotation cannot carry a handing. See "handing is resolved on binding".
 *
 * ## What is in the item and what is in a child
 *
 * The split is load-bearing, not tidiness. `Item.bounds()` reads
 * `this.geometry.boundingBox` and nothing else, so a child mesh is invisible to
 * it - and three things downstream read those bounds:
 *
 *   - `three/edge.js` cuts the wall's hole from `halfSize.x` and `.y`
 *   - `WallItem.boundMove` clamps travel along the wall by `sizeX / 2`
 *   - `InWallItem.getWallOffset` centres the item across the wall
 *
 * So the item's own geometry is exactly the **rough opening**: the two jambs and
 * the head jamb, filling the wall's thickness. That is the hole the wall should
 * cut, and it is the hole a carpenter frames. Everything else is a child: the
 * leaf because it swings out of the wall entirely, the casing because it laps
 * onto the wall face and would otherwise widen the hole on all four sides, and
 * the hinges because they belong to whichever jamb the handing picks.
 *
 * That last one matters: the item geometry is **handing-independent and
 * symmetric**, so re-handing a door rebuilds three small child groups and never
 * touches the merged geometry or the bounds the wall was cut from.
 *
 * ## Handing is resolved on binding, not at build time
 *
 * `hand` and `swing` are stated in the **plan's** axes, because that is what the
 * drawing knows: `opening_truth.py` reads the swing arc's bounding box and says
 * which end is hinged (`lo`/`hi` along the wall) and which side it opens toward
 * (`positive`/`negative` across it).
 *
 * The item's own axes are not those axes. A wall has two half edges, and
 * `WallItem.changeWallEdge` sets `rotation.y` from the normal of whichever one
 * the item bound to - so two doors with identical specs on two walls come out
 * rotated 180 degrees from each other, and "swing toward local -z" points into
 * opposite rooms. Measured on the traced plan: `door-7` and `door-9` are both
 * `lo`/`in` and their leaves ended up at world dz +35.9 and -28.9. That is the
 * bug this design removes, and it is the same reason the swing side could never
 * live in the rotation either.
 *
 * So the builder takes SIGNS, `resolveHanding` turns a plan-space spec into
 * those signs given the rotation the item actually bound with, and `applyHanding`
 * re-runs it whenever the item binds. See `Item.onBound`.
 *
 * ## Centred on purpose
 *
 * `Item`'s constructor recentres geometry on its bounding box in all three axes
 * (`items/item.js:198`). Children are added afterwards and are NOT recentred, so
 * authoring the frame anywhere but centred would put the leaf in a frame shifted
 * out from under it by half the door. Everything below is built centred, which
 * makes that recentring a no-op and the child transforms mean what they say.
 */

/** Millwork sizes, in centimetres. Nominal, and all overridable by the spec. */
const DEFAULTS = {
	/** Jamb stock. 3/4in. */
	jamb: 1.9,
	/** Casing face width. 2 1/2in. */
	casing: 6.35,
	/** How far the casing stands off the wall face. 5/8in. */
	casingProud: 1.6,
	/** Leaf thickness. 1 3/8in, the interior standard. */
	leafThickness: 3.5,
	/** Gap between leaf and jamb, and leaf and head. 1/8in. */
	reveal: 0.3,
	/** Gap under the leaf. */
	floorGap: 1.0,
	/** How far open `openFraction: 1` means, in degrees. */
	openAngle: 90,
	/** `swing` leaf and hardware, or `cased` - a lined opening with no door. */
	operation: 'swing',
	hand: 'lo',
	swing: 'negative',
	openFraction: 0,
	knob: true,
};

/**
 * @typedef {Object} DoorSpec
 * @property {number} width Clear opening between the jamb faces, in cm. This is
 *           what the plan measures: the drafter draws the finished opening.
 * @property {number} height Clear opening height, in cm.
 * @property {number} wallThickness The wall this sits in, face to face. The
 *           frame fills it, so a 2x4 partition and a 2x6 wall both come out
 *           right without anything being scaled.
 * @property {('swing'|'cased')} [operation] `cased` builds the lined opening and
 *           no leaf - which is what an opening with no swing arc actually is.
 * @property {('lo'|'hi')} [hand] Which end is hinged, **along the plan's axis**,
 *           not the item's. Resolved by `resolveHanding`.
 * @property {('positive'|'negative')} [swing] Which way it opens, **across the
 *           plan's axis**. Resolved by `resolveHanding`.
 * @property {number} [openFraction] 0 shut, 1 open by `openAngle`.
 * @property {number} [openAngle]
 * @property {number} [jamb]
 * @property {number} [casing]
 * @property {number} [casingProud]
 * @property {number} [leafThickness]
 * @property {number} [reveal]
 * @property {number} [floorGap]
 * @property {boolean} [knob]
 */

/**
 * What each slot is made of unless the spec says otherwise.
 *
 * Four slots, because a door is four things: the lining, the leaf that swings in
 * it, the trim that covers the joint, and the ironmongery. They are routinely
 * different materials - a walnut leaf in a painted frame is a normal thing to
 * want - and were three hardcoded hex values before the library existed.
 */
const SLOTS = {
	frame: 'paint-white',
	leaf: 'paint-white',
	casing: 'paint-white',
	hardware: 'metal-brushed-nickel',
};

/**
 * A box spanning `[x0,x1] x [y0,y1] x [z0,z1]`.
 *
 * Written as extents rather than as size-and-centre because every dimension
 * below is naturally a pair of faces - a jamb runs from the opening edge to the
 * rough opening edge - and converting each one by hand is where sign errors
 * live.
 */
function box(mat, x0, x1, y0, y1, z0, z1)
{
	var mesh = new Mesh(new BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)), mat);
	mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
	return mesh;
}

/** The derived sizes every part below is placed against. */
function frameOf(s)
{
	var W = s.width + 2 * s.jamb;
	var H = s.height + s.jamb;
	return {
		W: W, H: H,
		x1: W / 2, y1: H / 2, z1: s.wallThickness / 2,
		ox: s.width / 2,
		oyTop: H / 2 - s.jamb,
		floor: -H / 2,
	};
}

/**
 * A plan-space handing, in the item's own axes.
 *
 * Rotating about y by `theta` sends local +x to world `(cos, 0, -sin)` and local
 * +z to world `(sin, 0, cos)`. A wall running along world x therefore has its
 * along-axis component in `cos` for both; a wall running along world z has the
 * along component of local +x in `-sin` and the across component of local +z in
 * `+sin`. Those two disagreeing on vertical walls is exactly the sort of thing
 * that is invisible until half the doors on one elevation are hinged backwards,
 * so both are computed rather than assumed equal.
 *
 * @param {DoorSpec} spec Plan-space `hand` and `swing`.
 * @param {number} rotationY The rotation the item actually bound with.
 * @returns {{hingeSign: number, dirSign: number}} `hingeSign` is which local x
 *          end carries the hinge; `dirSign` is which local z the leaf opens to.
 */
export function resolveHanding(spec, rotationY)
{
	var cos = Math.cos(rotationY || 0);
	var sin = Math.sin(rotationY || 0);
	// Which world axis this wall runs along, read off the item's own rotation.
	var alongX = Math.abs(cos) >= Math.abs(sin);
	var along = alongX ? cos : -sin;      // local +x, along the wall
	var across = alongX ? cos : sin;      // local +z, across the wall
	var hand = (spec.hand === 'hi') ? 1 : -1;
	var swing = (spec.swing === 'positive') ? 1 : -1;
	return {
		hingeSign: hand * (along < 0 ? -1 : 1),
		dirSign: swing * (across < 0 ? -1 : 1),
	};
}

/**
 * The handing-dependent children: hinges, the leaf on its pivot, and the knobs.
 *
 * Separate from the frame so that re-handing on binding rebuilds only this, and
 * never the merged geometry the wall's hole was cut from.
 *
 * @returns {Array<Object3D>}
 */
function buildSwingParts(s, hingeSign, dirSign, mats)
{
	if (s.operation === 'cased')
	{
		// No leaf, no hinges, no knob. An opening the drawing showed no swing arc
		// in is a cased opening or a bypass slider, and neither is a single slab
		// filling the hole - which is what drawing one anyway looked like: three
		// 48.7in closet openings on this plan came out as solid 48.7in doors.
		return [];
	}

	var f = frameOf(s);
	var metalMat = mats.hardware;
	var leafMat = mats.leaf;
	var parts = [];

	// Hinges: three leaves on the hinge jamb, at the heights a carpenter puts
	// them - 11in up from the floor, 7in down from the head, one between.
	var hinges = new Group();
	hinges.name = 'door-hinges';
	var hingeX = hingeSign * f.ox;
	[f.floor + 27.9, (f.floor + f.oyTop) / 2, f.oyTop - 17.8].forEach(function (hy)
	{
		hinges.add(box(metalMat, hingeX - hingeSign * 0.4, hingeX + hingeSign * 1.0,
			hy - 5.1, hy + 5.1, -1.6, 1.6));
	});
	parts.push(hinges);

	// The leaf, on a pivot at the hinge jamb. The pivot is an empty Object3D at
	// the hinge line and the leaf hangs off it, so opening the door is one
	// rotation of one node and needs no geometry rebuild - which is what makes
	// `openFraction` continuous and animatable for nothing.
	var leafW = s.width - 2 * s.reveal;
	var leafH = s.height - s.reveal - s.floorGap;
	var pivot = new Object3D();
	pivot.name = 'door-leaf-pivot';
	pivot.position.set(hingeSign * (f.ox - s.reveal), 0, 0);

	var leaf = new Group();
	// The leaf reaches from the pivot toward the other jamb, so its centre is
	// half its width away in -hingeSign.
	leaf.position.set(-hingeSign * leafW / 2, f.floor + s.floorGap + leafH / 2, 0);
	leaf.add(box(leafMat, -leafW / 2, leafW / 2, -leafH / 2, leafH / 2,
		-s.leafThickness / 2, s.leafThickness / 2));

	if (s.knob)
	{
		// On the latch edge, 36in up, one each face. Under the pivot so it swings
		// with the door rather than hanging in the opening.
		var knobX = -hingeSign * (leafW / 2 - 6.4);
		var knobY = f.floor + 91.4 - (f.floor + s.floorGap + leafH / 2);
		[-1, 1].forEach(function (side)
		{
			leaf.add(box(metalMat, knobX - 2.9, knobX + 2.9, knobY - 2.9, knobY + 2.9,
				side * s.leafThickness / 2, side * (s.leafThickness / 2 + 3.2)));
		});
	}
	pivot.add(leaf);

	// Which way it turns.
	//
	// Rotating the pivot by theta about y sends a local point (dx, y, 0) to
	// (dx cos, y, -dx sin). The leaf's centre is at dx = -hingeSign * leafW/2, so
	// its z after rotation is `hingeSign * leafW/2 * sin(theta)`. Opening toward
	// local +z therefore wants sin(theta) to carry hingeSign's own sign, which is
	// what this says.
	pivot.rotation.y = dirSign * hingeSign * (s.openFraction * s.openAngle * Math.PI / 180);
	parts.push(pivot);

	return parts;
}

/** The casing: a picture frame lapping the wall on each face. */
function buildCasing(s, mats)
{
	var f = frameOf(s);
	var casingMat = mats.casing;
	return [-1, 1].map(function (side)
	{
		var casing = new Group();
		casing.name = 'door-casing';
		var cz0 = side * f.z1;
		var cz1 = side * (f.z1 + s.casingProud);
		var cx = f.x1 + s.casing;
		var cy = f.y1 + s.casing;
		casing.add(box(casingMat, -cx, -f.ox, f.floor, cy, cz0, cz1));
		casing.add(box(casingMat, f.ox, cx, f.floor, cy, cz0, cz1));
		casing.add(box(casingMat, -cx, cx, f.y1, cy, cz0, cz1));
		return casing;
	});
}

/**
 * Rebuild a bound door's handing-dependent children.
 *
 * Called from `WallItem.changeWallEdge` through `Item.onBound`, because that is
 * the moment the item's rotation stops being the tracer's hint and becomes the
 * wall's answer. Everything it replaces is a child, so the merged geometry and
 * the bounds the wall's hole came from are untouched and no redraw is needed.
 *
 * @param {Object} item An Item carrying a `door` spec.
 */
export function applyHanding(item)
{
	var spec = item.metadata && item.metadata.spec;
	if (!spec || spec.kind !== 'door')
	{
		return;
	}
	var s = Object.assign({}, DEFAULTS, spec);
	var mats = materialsForSlots(s.material, SLOTS);
	var handing = resolveHanding(s, item.rotation.y);

	// Drop the old handing-dependent children. The casing is not among them - it
	// is symmetric - so it is left alone rather than rebuilt.
	var stale = item.generatedParts.filter(function (part)
	{
		return part.name === 'door-hinges' || part.name === 'door-leaf-pivot';
	});
	stale.forEach(function (part)
	{
		item.remove(part);
		disposeObject(part);
	});

	var fresh = buildSwingParts(s, handing.hingeSign, handing.dirSign, mats);
	fresh.forEach(function (part) {item.add(part);});
	item.generatedParts = item.generatedParts
		.filter(function (part) {return stale.indexOf(part) === -1;})
		.concat(fresh);
}

/**
 * What a panel may ask about a door, and how to ask it.
 *
 * Data rather than a Vue component, for the same reason `useCatalog` reads
 * `catalog.json`: adding an option to a door should be a change here and nowhere
 * else. `SpecInspector.vue` renders whatever this describes, so a new builder
 * gets a working inspector by exporting one of these and no UI work at all.
 *
 * `unit: 'length'` means the value is centimetres in the spec and is shown in
 * whatever the user picked - the panel converts, because `Dimensioning` is the
 * one place that knows how.
 */
export const DOOR_SCHEMA = {
	label: 'Door',
	fields: [
		{key: 'operation', label: 'Operation', type: 'choice', options: [
			{value: 'swing', label: 'Swinging'},
			{value: 'cased', label: 'Cased opening'},
		]},
		{key: 'width', label: 'Opening width', type: 'length', min: 40, max: 250, step: 1},
		{key: 'height', label: 'Opening height', type: 'length', min: 150, max: 300, step: 1},
		// Not editable: it is the wall's, and a door that disagrees with its wall
		// is a bug rather than a choice. Shown so the number is visible.
		{key: 'wallThickness', label: 'Wall thickness', type: 'length', readOnly: true},
		{key: 'hand', label: 'Hinged at', type: 'choice', when: {operation: 'swing'}, options: [
			{value: 'lo', label: 'Start of wall'},
			{value: 'hi', label: 'End of wall'},
		]},
		{key: 'swing', label: 'Opens toward', type: 'choice', when: {operation: 'swing'}, options: [
			{value: 'negative', label: 'One side'},
			{value: 'positive', label: 'The other'},
		]},
		{key: 'openFraction', label: 'How far open', type: 'fraction', when: {operation: 'swing'},
			min: 0, max: 1, step: 0.05},
		{key: 'material.leaf', label: 'Leaf', type: 'material', when: {operation: 'swing'}},
		{key: 'material.frame', label: 'Frame', type: 'material'},
		{key: 'material.casing', label: 'Casing', type: 'material'},
		{key: 'material.hardware', label: 'Hardware', type: 'material', when: {operation: 'swing'},
			group: 'metal'},
	],
};

/**
 * Build a door.
 *
 * The handing here is the spec's own, read against a rotation of zero. That is a
 * placeholder: the item is re-handed by `applyHanding` the moment it binds to a
 * wall, which is the only point at which its axes are known. Building it anyway
 * means a door that is never bound - in a test, or in a design with no walls -
 * still looks like a door.
 *
 * @param {DoorSpec} spec
 * @returns {{geometry: import('three').BufferGeometry, materials: Array,
 *           parts: Array<Object3D>, onBound: function(Object): void}}
 */
export function buildDoor(spec)
{
	var s = Object.assign({}, DEFAULTS, spec || {});
	var f = frameOf(s);
	var mats = materialsForSlots(s.material, SLOTS);
	var frameMat = mats.frame;

	// The item's own geometry: jambs and head, filling the wall. Symmetric, and
	// deliberately free of anything the handing decides.
	var frame = new Group();
	frame.add(box(frameMat, -f.x1, -f.ox, f.floor, f.oyTop, -f.z1, f.z1));
	frame.add(box(frameMat, f.ox, f.x1, f.floor, f.oyTop, -f.z1, f.z1));
	frame.add(box(frameMat, -f.x1, f.x1, f.oyTop, f.y1, -f.z1, f.z1));
	var merged = mergeMeshes(frame);

	var handing = resolveHanding(s, 0);
	// Built up rather than concatenated: `concat` on a Group[] narrows the result
	// to Group[], and the swing parts include a bare Object3D pivot.
	/** @type {Array<Object3D>} */
	var parts = [];
	buildCasing(s, mats).forEach(function (part) {parts.push(part);});
	buildSwingParts(s, handing.hingeSign, handing.dirSign, mats).forEach(function (part) {parts.push(part);});

	return {
		geometry: merged.geometry,
		materials: merged.materials,
		parts: parts,
		onBound: applyHanding,
	};
}
