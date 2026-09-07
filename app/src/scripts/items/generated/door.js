// @ts-check
import {Group, Object3D} from 'three';
import {mergeMeshes} from '../../core/geometry_merge.js';
import {disposeObject} from '../../core/resource_registry.js';
import {materialsForSlots} from '../../core/materials.js';
import {box, buildCasing as casingFor, buildLeaf, recentre, resolveHanding} from './opening.js';

/**
 * Re-exported so a door's handing stays reachable from the door.
 *
 * It lives in `opening.js` because a casement window asks the same question - on
 * which jamb, and out of which face - and a patio slider asks it a third time.
 * Callers that think about doors should not have to know that.
 */
export {resolveHanding};

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
 * ## `operation` is the axis the whole door question turns on
 *
 * ROADMAP.md phase 5 says so, and it is independent of the leaf style and of
 * whether the leaf is glazed. Eight of them, and what separates them is entirely
 * **what moves and where it goes**:
 *
 * | operation | leaves | what `openFraction` does |
 * |---|---|---|
 * | `cased`   | 0 | nothing - a lined opening is what an opening with no swing arc actually is |
 * | `swing`   | 1 | turns about a jamb |
 * | `french`  | 2 | each turns about its own jamb, meeting at the middle |
 * | `bypass`  | 2 | one slides BEHIND the other, so it never clears half |
 * | `sliding` | 2 | the same, glazed, on a sill track: the patio door |
 * | `pocket`  | 1 | slides into the wall, which is the one door that constrains its wall |
 * | `bifold`  | 2 or 4 | folds to a stack at a jamb |
 * | `barn`    | 1 | slides along the wall FACE, past the opening |
 *
 * The signature to get right on a bypass is the one ROADMAP.md names: **it never
 * clears more than about half its opening**, because one leaf is always in front
 * of the other. A slider drawn as a single leaf running fully clear looks wrong
 * immediately, and no measurement of travel says so - `travelFor` computes the
 * distance that lands one leaf exactly over the other and stops there.
 *
 * ## A barn door is not an in-wall item, and this builder still makes it
 *
 * It hangs on the wall **face** on a track above a `cased` opening and slides
 * clear beside it, so it is a `WallFloorItem` (type 9) standing on the floor
 * against the wall, not an `InWallFloorItem` (type 7) filling a hole. Its
 * geometry is therefore the track and the floor guide rather than a rough
 * opening, and the wall cuts nothing for it. Made here anyway because everything
 * else about it - the leaf, the styles, the finishes, the plan-space handing -
 * is the same object; only the placement differs, and placement is the catalog
 * entry's `type`, not the builder's business.
 *
 * The track is in the item's own geometry on purpose. `WallItem.boundMove`
 * clamps travel along the wall by `sizeX / 2`, so putting the full track length
 * in the bounds is what makes "a barn door needs clear wall to one side" true
 * without a line of validation: the drag simply will not put it where the track
 * would run off the end of the wall.
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
 * the head jamb, filling the wall's thickness, plus the sill track a patio
 * slider stands on. That is the hole the wall should cut, and it is the hole a
 * carpenter frames. Everything else is a child: the leaves because they move out
 * of the wall entirely, the casing because it laps onto the wall face and would
 * otherwise widen the hole on all four sides, and the hangers and hinges because
 * they belong to whichever jamb the handing picks.
 *
 * That last one matters: the item geometry is **handing-independent and
 * symmetric**, so re-handing a door rebuilds a few small child groups and never
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
 * those signs given the rotation the item actually bound with, and `applyDoorFit`
 * re-runs it whenever the item binds. See `Item.onBound`.
 *
 * `hand` means a different thing to each operation and the same thing to the
 * geometry: which end of the opening the moving part belongs to. It is the hinge
 * jamb of a swing, the sash that slides on a bypass, the side the pocket is
 * framed into, the jamb a bifold stacks against, and the side a barn door parks
 * on. One field, because it is one question.
 *
 * ## Centred on purpose
 *
 * `Item`'s constructor recentres geometry on its bounding box in all three axes
 * (`items/item.js:198`). Children are added afterwards and are NOT recentred, so
 * authoring the frame anywhere but centred would put the leaf in a frame shifted
 * out from under it by half the door. Everything below is built centred, which
 * makes that recentring a no-op and the child transforms mean what they say.
 *
 * The barn door is the one build whose honest geometry is asymmetric - its track
 * runs a leaf width past one jamb and stops at the other - so `recentre` moves
 * the origin to the geometry, geometry and children together.
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
	/** Stile and rail face width on a panelled or glazed leaf. 4 1/2in. */
	stile: 11.4,
	/** Gap between leaf and jamb, and leaf and head. 1/8in. */
	reveal: 0.3,
	/** Gap under the leaf. */
	floorGap: 1.0,
	/** How far open `openFraction: 1` means, in degrees. */
	openAngle: 90,
	/** How far two passing leaves are held apart across the wall. */
	clearance: 0.2,
	/** How far a bypass leaf laps its neighbour, so no gap shows between them. */
	overlap: 5.1,
	/** The height of a patio slider's sill track. Zero for every other door. */
	sill: 0,
	/** Glazing thickness, for a glazed leaf. */
	glassThickness: 1.8,
	/** Muntin bar width and how far it stands off the glass. */
	bar: 1.9,
	barProud: 0.5,
	operation: 'swing',
	/** `flush` | `two-panel` | `six-panel` | `glazed`. */
	leaf: 'flush',
	/** Bifold panel count: 2 stacking at one jamb, or 4 as two pairs. */
	leaves: 2,
	grille: {pattern: 'none', rows: 2, cols: 2},
	hand: 'lo',
	swing: 'negative',
	openFraction: 0,
	knob: true,
};

/**
 * What each operation assumes unless the spec says otherwise.
 *
 * A french door is glazed and a patio slider is glazed in a heavier frame -
 * those are not preferences, they are what the words mean, and defaulting them
 * here is what keeps `operation` the single field somebody actually sets. The
 * spec still wins on every one of them: a solid french door is a real thing.
 */
/** @type {Record<string, Object>} */
const PER_OPERATION = {
	french: {leaf: 'glazed', grille: {pattern: 'colonial', rows: 4, cols: 2}},
	// 60 to 96in wide and the one opening in the house big enough that phase 6's
	// daylight will notice it, so the frame is the heavy extruded section a patio
	// door actually has rather than 3/4in jamb stock.
	sliding: {leaf: 'glazed', jamb: 3.8, leafThickness: 4.4, stile: 7.6, sill: 3.2},
	// A closet leaf is thinner than a passage door, and a bifold thinner again.
	bypass: {leafThickness: 2.9},
	bifold: {leafThickness: 2.9},
	// A barn door is a slab hung on the wall face: full thickness, and it laps
	// the opening rather than filling it.
	barn: {leafThickness: 4.4},
};

/**
 * @typedef {Object} DoorSpec
 * @property {number} width Clear opening between the jamb faces, in cm. This is
 *           what the plan measures: the drafter draws the finished opening.
 * @property {number} height Clear opening height, in cm.
 * @property {number} wallThickness The wall this sits in, face to face. The
 *           frame fills it, so a 2x4 partition and a 2x6 wall both come out
 *           right without anything being scaled. Re-read off the wall the item
 *           binds to; see `applyDoorFit`.
 * @property {('cased'|'swing'|'french'|'bypass'|'sliding'|'pocket'|'bifold'|'barn')} [operation]
 *           What moves, and where it goes.
 * @property {('flush'|'two-panel'|'six-panel'|'glazed')} [leaf] The leaf style,
 *           orthogonal to the operation.
 * @property {number} [leaves] Bifold panel count: 2 or 4.
 * @property {('lo'|'hi')} [hand] Which end of the opening the moving part
 *           belongs to, **along the plan's axis**, not the item's. Resolved by
 *           `resolveHanding`.
 * @property {('positive'|'negative')} [swing] Which way it opens, **across the
 *           plan's axis**. Resolved by `resolveHanding`.
 * @property {number} [openFraction] 0 shut, 1 open.
 * @property {{pattern?: string, rows?: number, cols?: number}} [grille] Muntins
 *           in a glazed leaf. `none|colonial|prairie|craftsman`.
 * @property {number} [openAngle]
 * @property {number} [jamb]
 * @property {number} [casing]
 * @property {number} [casingProud]
 * @property {number} [leafThickness]
 * @property {number} [stile]
 * @property {number} [reveal]
 * @property {number} [floorGap]
 * @property {number} [sill]
 * @property {boolean} [knob]
 */

/**
 * What each slot is made of unless the spec says otherwise.
 *
 * A door is the lining, the leaf that moves in it, the trim that covers the
 * joint, and the ironmongery. They are routinely different materials - a walnut
 * leaf in a painted frame is a normal thing to want - and were three hardcoded
 * hex values before the library existed. `glass` joins them for the french and
 * patio leaves, and is separate from the rest because it is the one surface here
 * that is not a solid.
 */
const SLOTS = {
	frame: 'paint-white',
	leaf: 'paint-white',
	casing: 'paint-white',
	glass: 'glass-clear',
	hardware: 'metal-brushed-nickel',
};

/** The operations whose leaves are two panels passing across the wall. */
const PASSING = ['bypass', 'sliding'];

/**
 * A spec with the defaults its operation implies filled in.
 *
 * Three layers, in order: the millwork defaults, what the operation assumes, and
 * what the caller actually said. Written once here so no builder below has to
 * remember that a patio door has a sill and a passage door does not.
 */
function normalise(spec)
{
	var given = spec || {};
	var perOp = PER_OPERATION[given.operation] || {};
	var s = Object.assign({}, DEFAULTS, perOp, given);
	s.grille = Object.assign({}, DEFAULTS.grille, perOp.grille || {}, given.grille || {});
	return s;
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
		// The floor of the clear opening: the floor itself, or the top of a patio
		// slider's sill track.
		oyBot: -H / 2 + s.sill,
	};
}

/** A leaf's own size, given how many share the opening. */
function leafSizeOf(s, share)
{
	var f = frameOf(s);
	return {
		width: (s.width - 2 * s.reveal) / (share || 1),
		height: s.height - s.reveal - s.floorGap - s.sill,
		// Centre height, measured from the item's own origin.
		y: (f.oyBot + s.floorGap + (s.height - s.reveal - s.floorGap - s.sill) / 2),
	};
}

/**
 * How far a bypass leaf can slide, which is the number that makes it a bypass.
 *
 * Two leaves each lap the middle by `overlap`, so each is a little over half the
 * opening. Sliding one by exactly `leafWidth - overlap` lands its far edge on the
 * far jamb - which is to say, exactly over its neighbour - and there is nowhere
 * further to go. What is left open is `leafWidth - overlap`, a shade under half
 * the opening, and that is the signature ROADMAP.md says a slider drawn as one
 * leaf running fully clear gets wrong.
 *
 * @param {number} leafWidth
 * @param {number} overlap
 * @returns {number}
 */
export function travelFor(leafWidth, overlap)
{
	return Math.max(0, leafWidth - overlap);
}

/**
 * Where every leaf sits before anything opens, and what it is allowed to do.
 *
 * The same shape as `window.js`'s `sashLayout`, and for the same reason: the
 * placement is decidable from the spec alone, so it can be asserted without a
 * scene, and `buildLeaves` places what it is given without knowing which
 * operation asked.
 *
 * `moves` is `null` for a panel that is fixed - the far light of a patio slider
 * is not a door, it is a window that happens to be in a door frame.
 *
 * @param {Object} s A normalised spec.
 * @param {number} hingeSign Which local x end the moving part belongs to.
 * @returns {Array<{name: string, x: number, y: number, z: number, width: number,
 *          height: number, moves: ?string, travel: number, hinge: number,
 *          fold?: number}>}
 */
export function leafLayout(s, hingeSign)
{
	var f = frameOf(s);
	var one = leafSizeOf(s, 1);
	/** @type {Array<Object>} */
	var out = [];

	if (s.operation === 'cased')
	{
		return [];
	}

	if (s.operation === 'swing')
	{
		out.push({name: 'door-leaf-pivot', x: 0, y: one.y, z: 0,
			width: one.width, height: one.height, moves: 'swing', travel: 0, hinge: hingeSign});
		return out;
	}

	if (s.operation === 'french')
	{
		// Two leaves meeting at the middle, each hinged on its own jamb. The third
		// reveal is the joint between them.
		var half = (s.width - 3 * s.reveal) / 2;
		[-1, 1].forEach(function (side)
		{
			out.push({name: 'door-leaf-pivot', x: side * (half + s.reveal) / 2, y: one.y, z: 0,
				width: half, height: one.height, moves: 'swing', travel: 0, hinge: side});
		});
		return out;
	}

	if (PASSING.indexOf(s.operation) !== -1)
	{
		// Offset ACROSS the wall and overlapping ALONG it. That pair of facts is
		// the whole difference between a bypass and a single leaf, and it is what
		// caps the clear opening at half.
		var lw = (s.width + s.overlap) / 2 - s.reveal;
		var off = s.leafThickness / 2 + s.clearance;
		var run = travelFor(lw, s.overlap);
		[-1, 1].forEach(function (side)
		{
			out.push({
				name: (side < 0) ? 'door-leaf-lo' : 'door-leaf-hi',
				x: side * (f.ox - lw / 2 - s.reveal), y: one.y, z: -side * off,
				width: lw, height: one.height,
				// Both carry the travel; only the one the hand names may use it.
				moves: (side === hingeSign) ? 'slide' : null, travel: run, hinge: side,
			});
		});
		return out;
	}

	if (s.operation === 'pocket')
	{
		// One leaf on the wall centreline, which is what makes the pocket possible
		// at all - the cavity is the middle of the wall.
		out.push({name: 'door-leaf-pocket', x: 0, y: one.y, z: 0,
			width: one.width, height: one.height, moves: 'pocket',
			// A leaf width plus the jamb it passes, so `openFraction: 1` puts the
			// whole leaf past the opening rather than leaving a stripe of it showing.
			travel: one.width + s.jamb, hinge: hingeSign});
		return out;
	}

	if (s.operation === 'bifold')
	{
		// Two panels stack at one jamb; four are two such pairs, one at each.
		var pairs = (Number(s.leaves) >= 4) ? [hingeSign, -hingeSign] : [hingeSign];
		var panel = (s.width - 2 * s.reveal) / (2 * pairs.length);
		pairs.forEach(function (side, i)
		{
			out.push({name: 'door-leaf-fold-' + i,
				x: side * (f.ox - s.reveal), y: one.y, z: 0,
				width: panel, height: one.height, moves: 'fold', travel: 0, hinge: side});
		});
		return out;
	}

	// Barn. The leaf laps the opening rather than filling it, and it parks to the
	// side the hand names.
	var lap = barnLapOf(s);
	out.push({name: 'door-leaf-barn', x: 0, y: lap.y, z: lap.z,
		width: lap.width, height: lap.height, moves: 'slide-face',
		travel: lap.width, hinge: hingeSign});
	return out;
}

/**
 * A barn door's leaf and the track it hangs from, in the item's own frame before
 * `recentre` moves the origin.
 *
 * A barn leaf is bigger than its opening on three sides - it has to be, because
 * there is no rebate to close against - and it hangs clear of the wall on
 * rollers. Those two facts are what put it outside the wall's plane, and they
 * are why this is not an in-wall item.
 */
function barnLapOf(s)
{
	var f = frameOf(s);
	// 2in of lap each side and over the head, which is what stops daylight showing
	// round a barn door.
	var lap = 5.1;
	var height = s.height + lap;
	// The rollers hold the leaf off the wall face, and the face is at +z1 because
	// the geometry spans the wall's thickness before recentring.
	var standoff = 2.0;
	return {
		width: s.width + 2 * s.jamb + 2 * lap,
		height: height,
		y: f.floor + s.floorGap + height / 2,
		z: f.z1 + standoff + s.leafThickness / 2,
		standoff: standoff,
		trackY: f.floor + s.floorGap + height + 3.8,
	};
}

/**
 * The hardware a given operation is actually fitted with.
 *
 * Not one knob for everything. A bypass has a recessed finger pull because a
 * knob would foul the leaf passing in front of it; a pocket door has a flush
 * edge pull because the leaf has to go into a 1in slot; a patio slider has a
 * full-height pull. Fitting a knob to all of them is the sort of thing nothing
 * measures and every render shows.
 *
 * Added to the LEAF rather than to the frame, so it travels with the door.
 * Authored in the frame's coordinates instead, it is left hanging in the middle
 * of the empty opening the moment the leaf moves - which is exactly the fault
 * `window.js` records for a casement handle.
 */
function fitHardware(group, s, place, mats)
{
	if (!s.knob)
	{
		return;
	}
	var f = frameOf(s);
	var hz = s.leafThickness / 2;
	var w = place.width / 2;
	// Hardware height is measured from the FLOOR - 36in is 36in whatever the door
	// is - and the leaf's own origin is its centre, so every y below is that
	// height brought back into the leaf's frame.
	var above = function (fromFloor) {return f.floor + fromFloor - place.y;};

	if (s.operation === 'swing' || s.operation === 'french')
	{
		// On the latch edge, 36in up, one each face.
		var knobX = -place.hinge * (w - 6.4);
		var knobY = above(91.4);
		[-1, 1].forEach(function (side)
		{
			group.add(box(mats.hardware, knobX - 2.9, knobX + 2.9, knobY - 2.9, knobY + 2.9,
				side * hz, side * (hz + 3.2)));
		});
		return;
	}

	// Two leaves that pass each other are the case where hardware cannot go on
	// both faces. A pull proud of the inner face sweeps through its neighbour -
	// which is exactly why real bypass hardware is a RECESSED finger pull, and a
	// recess is the one thing a box cannot be. So it goes on the face nothing
	// passes in front of. Measured: with a pull each side, a 2.9cm leaf at a
	// 0.2cm clearance had its two leaf assemblies overlapping across the wall by
	// 0.8cm, and no test of travel or of leaf position could see it.
	var outward = (PASSING.indexOf(s.operation) === -1) ? 0 : ((place.z >= 0) ? 1 : -1);

	if (s.operation === 'sliding')
	{
		// A patio slider's pull is a long stile-mounted bar on the leading edge, at
		// hand height.
		var pullX = -place.hinge * (w - s.stile / 2);
		group.add(box(mats.hardware, pullX - 1.6, pullX + 1.6, above(76), above(122),
			outward * hz, outward * (hz + 3.6)));
		return;
	}

	if (s.operation === 'bifold' || s.operation === 'barn')
	{
		// A bifold knob sits on the leading panel's free stile; a barn door's pull
		// is a long horizontal bar. Both stand off the room face only.
		if (s.operation === 'barn')
		{
			// A 20cm bar, set in far enough that it FITS. Placed 5cm in from the
			// leading edge like a knob, a bar of this length overhangs the leaf by
			// 7cm - which nothing measures, because the leaf is still the right size
			// and the bar is still on it.
			var barX = -place.hinge * (w - 14);
			group.add(box(mats.hardware, barX - 10, barX + 10, above(97), above(103), hz, hz + 4.0));
		}
		else
		{
			var knobAt = -place.hinge * (w - 5.0);
			group.add(box(mats.hardware, knobAt - 2.2, knobAt + 2.2, above(97), above(105),
				hz, hz + 2.6));
		}
		return;
	}

	// Bypass and pocket: a finger pull on the leading stile. Proud rather than
	// recessed, because a solid swallows anything put inside it - the fault that
	// made a vent hood's filter render as nothing at all while its triangles were
	// present and correct.
	var pullAt = -place.hinge * (w - 4.5);
	// A pocket leaf runs on the wall centreline with nothing beside it, so it
	// takes a pull on both faces; a bypass leaf takes one, outward.
	var faces = outward ? [outward] : [-1, 1];
	faces.forEach(function (side)
	{
		group.add(box(mats.hardware, pullAt - 1.4, pullAt + 1.4, above(94), above(106),
			side * hz, side * (hz + 0.6)));
	});
}

/**
 * The hinges a swinging leaf hangs on: three leaves on the hinge jamb, at the
 * heights a carpenter puts them.
 */
function buildHinges(s, place, mats)
{
	var f = frameOf(s);
	var hinges = new Group();
	hinges.name = 'door-hinges';
	hinges.userData.handed = true;
	var hingeX = place.x + place.hinge * place.width / 2;
	[f.floor + 27.9, (f.floor + f.oyTop) / 2, f.oyTop - 17.8].forEach(function (hy)
	{
		hinges.add(box(mats.hardware, hingeX - place.hinge * 0.4, hingeX + place.hinge * 1.0,
			hy - 5.1, hy + 5.1, -1.6, 1.6));
	});
	return hinges;
}

/**
 * A head track, for the operations that hang from one.
 *
 * A bypass, a pocket, a bifold and a barn door all run on a rail, and the rail
 * is the part that tells you at a glance which of them you are looking at.
 * Drawn proud of whatever it is fixed to for the usual reason: a rail flush with
 * the head is a rail nobody can see.
 */
function buildTrack(s, mats, from, to, y, z, depth)
{
	var track = new Group();
	track.name = 'door-track';
	track.userData.handed = true;
	track.add(box(mats.hardware, from, to, y - 3.2, y, z - depth / 2, z + depth / 2));
	return track;
}

/**
 * The handing-dependent children: the leaves, what they hang on, and what opens
 * them.
 *
 * Separate from the frame so that re-handing on binding rebuilds only this, and
 * never the merged geometry the wall's hole was cut from.
 *
 * @returns {Array<Object3D>}
 */
function buildLeaves(s, hingeSign, dirSign, mats)
{
	var f = frameOf(s);
	var open = Math.max(0, Math.min(1, s.openFraction));
	var angle = open * s.openAngle * Math.PI / 180;
	/** @type {Array<Object3D>} */
	var parts = [];
	var layout = leafLayout(s, hingeSign);

	if (!layout.length)
	{
		// No leaf, no track, no hardware. An opening the drawing showed no swing
		// arc in is a cased opening, and drawing a slab across it is worse than
		// drawing nothing: three 48.7in closet openings on this plan came out as
		// solid 48.7in doors, so an opening that should read as open read as a wall.
		return parts;
	}

	// `withHardware` is false for the panels that do not carry any: the fixed
	// light of a patio slider is a window in a door frame, and a bifold has ONE
	// knob, on the panel at the free end. Fitting one to every leaf is the same
	// mistake `window.js` records for a double hung, which came out with a second
	// lock up at the head where no window has one.
	var leafOf = function (place, name, withHardware)
	{
		var group = buildLeaf(mats, {
			width: place.width, height: place.height, thickness: s.leafThickness,
			style: s.leaf, stile: s.stile, glassThickness: s.glassThickness,
			bar: s.bar, barProud: s.barProud, grille: s.grille, name: name || place.name,
		});
		if (withHardware !== false)
		{
			fitHardware(group, s, place, mats);
		}
		return group;
	};

	layout.forEach(function (place, index)
	{
		if (place.moves === 'swing')
		{
			parts.push(buildHinges(s, place, mats));

			// The leaf on a pivot at the hinge jamb. The pivot is an empty Object3D
			// at the hinge line and the leaf hangs off it, so opening the door is one
			// rotation of one node and needs no geometry rebuild - which is what
			// makes `openFraction` continuous and animatable for nothing.
			var pivot = new Object3D();
			pivot.name = 'door-leaf-pivot';
			pivot.userData.handed = true;
			pivot.position.set(place.x + place.hinge * place.width / 2, 0, place.z);

			var leaf = leafOf(place);
			leaf.position.set(-place.hinge * place.width / 2, place.y, 0);
			pivot.add(leaf);
			// Rotating the pivot by theta about y sends a local point (dx, y, 0) to
			// (dx cos, y, -dx sin). The leaf's centre is at dx = -hinge * width/2, so
			// its z after rotation is `hinge * width/2 * sin(theta)`. Opening toward
			// local +z therefore wants sin(theta) to carry the hinge's own sign.
			pivot.rotation.y = dirSign * place.hinge * angle;
			parts.push(pivot);
			return;
		}

		if (place.moves === 'fold')
		{
			// A bifold is two rotations, not one. The outer panel turns theta about
			// the jamb; the inner one turns MINUS TWICE that about the joint between
			// them, which folds it back against its neighbour.
			//
			// The consequence worth knowing is that the free end stays on the track
			// line: its offset from the jamb comes out as `2 * panel * cos(theta)`
			// with the z components of the two rotations cancelling exactly. So it
			// runs along the head and does not swing out into the room, which is what
			// a bifold does and a pair of doors hinged to each other does not.
			var outer = new Object3D();
			outer.name = place.name;
			outer.userData.handed = true;
			outer.position.set(place.x, 0, place.z);
			outer.rotation.y = dirSign * place.hinge * angle;

			var first = leafOf(place, place.name + '-a', false);
			first.position.set(-place.hinge * place.width / 2, place.y, 0);
			outer.add(first);

			var joint = new Object3D();
			joint.name = place.name + '-joint';
			joint.position.set(-place.hinge * place.width, 0, 0);
			joint.rotation.y = -2 * dirSign * place.hinge * angle;
			var second = leafOf(Object.assign({}, place, {hinge: -place.hinge}), place.name + '-b');
			second.position.set(-place.hinge * place.width / 2, place.y, 0);
			joint.add(second);
			outer.add(joint);

			parts.push(outer);
			if (index === 0)
			{
				parts.push(buildTrack(s, mats, -f.ox, f.ox, f.oyTop, 0, s.leafThickness + 1.6));
			}
			return;
		}

		// A patio slider's fixed light carries no pull; a bypass leaf carries one
		// whether it is the leaf that moves or not, because both are pushed by hand.
		var leafGroup = leafOf(place, null, s.operation !== 'sliding' || Boolean(place.moves));
		leafGroup.userData.handed = true;
		var dx = 0;

		if (place.moves === 'slide')
		{
			// TOWARD the other leaf, never away from it. Slid the other way it leaves
			// the opening entirely and hangs in free air beside the door, which is
			// obvious in a render and invisible in a measurement of travel.
			dx = -Math.sign(place.x || place.hinge) * open * place.travel;
		}
		else if (place.moves === 'pocket')
		{
			// INTO the wall, on the side the hand names. Nothing hides it: the wall
			// is solid there, and a solid swallowing what is put inside it is for
			// once the effect wanted.
			dx = place.hinge * open * place.travel;
		}
		else if (place.moves === 'slide-face')
		{
			// Along the wall FACE, past the jamb, to the side the hand names.
			dx = place.hinge * open * place.travel;
		}

		leafGroup.position.set(place.x + dx, place.y, place.z);
		parts.push(leafGroup);

		if (place.moves === 'pocket')
		{
			parts.push(buildTrack(s, mats, -f.ox, f.ox, f.oyTop, 0, s.leafThickness + 1.6));
		}
		else if (place.moves === 'slide' && index === 0)
		{
			parts.push(buildTrack(s, mats, -f.ox, f.ox, f.oyTop, 0,
				2 * (s.leafThickness / 2 + s.clearance) + s.leafThickness));
		}
		else if (place.moves === 'slide-face')
		{
			// Two hangers on the top rail, riding the track that is in the item's own
			// geometry. They move with the leaf, so they are here rather than there.
			var hangers = new Group();
			hangers.name = 'door-hangers';
			hangers.userData.handed = true;
			[-1, 1].forEach(function (side)
			{
				var hx = place.x + dx + side * (place.width / 2 - 10);
				hangers.add(box(mats.hardware, hx - 1.6, hx + 1.6,
					place.y + place.height / 2, place.y + place.height / 2 + 6.5,
					place.z - 0.8, place.z + 0.8));
			});
			parts.push(hangers);
		}
	});

	return parts;
}

/**
 * The casing: a picture frame lapping the wall on each face.
 *
 * No bottom run - a door stands on the floor and its casing dies into it. A
 * window gets the fourth side; see `opening.js`.
 */
function buildCasing(s, mats)
{
	var f = frameOf(s);
	return casingFor(mats.casing, {
		name: 'door-casing',
		x1: f.x1, y1: f.y1, ox: f.ox, z1: f.z1,
		casing: s.casing, proud: s.casingProud, bottom: false,
	});
}

/**
 * The smallest finished wall thickness a pocket door can live in, in cm.
 *
 * 4 1/4in. A pocket needs two skins of board, a stud split around the frame, and
 * a leaf running between them: a standard 2x4 partition finishes at 4 1/2in
 * (11.43cm) and just holds one, and a 3 1/2in partition does not. ROADMAP.md
 * asks for this check by name, on the grounds that the number is already in the
 * model and finding out on site is expensive.
 */
export const POCKET_MIN_THICKNESS = 10.8;

/**
 * Whether a wall can actually take this pocket door.
 *
 * Pure, and separately assertable, the same split `items/fitting.js` uses: this
 * computes and returns, `applyDoorFit` is the only thing that acts on it.
 *
 * `run` is how much wall there is beyond the door's own centre on the side the
 * pocket is framed into. What it has to cover is half the opening, the jamb, the
 * whole leaf, and the framing at the back of the cavity.
 *
 * @param {Object} s A normalised spec.
 * @param {{thickness: ?number, run: ?number}} host What the wall offers.
 * @returns {{fits: boolean, reason: ?string, needThickness: number, needRun: number}}
 */
export function pocketFit(s, host)
{
	var needRun = s.width / 2 + s.jamb + (s.width - 2 * s.reveal) + 5;
	/** @type {{fits: boolean, reason: ?string, needThickness: number, needRun: number}} */
	var out = {fits: true, reason: null, needThickness: POCKET_MIN_THICKNESS, needRun: needRun};

	if (typeof host.thickness === 'number' && host.thickness + 1e-6 < POCKET_MIN_THICKNESS)
	{
		out.fits = false;
		out.reason = 'This wall is ' + host.thickness.toFixed(1) + 'cm; a pocket needs at least '
			+ POCKET_MIN_THICKNESS.toFixed(1) + 'cm to hold the leaf.';
		return out;
	}
	if (typeof host.run === 'number' && host.run + 1e-6 < needRun)
	{
		out.fits = false;
		out.reason = 'There is ' + host.run.toFixed(0) + 'cm of wall on the pocket side; this leaf needs '
			+ needRun.toFixed(0) + 'cm to slide into.';
		return out;
	}
	return out;
}

/**
 * How much wall lies beyond a bound item's centre, on the side its local +x or
 * -x points to.
 *
 * `boundMove` already works in the edge's interior frame, where x runs from
 * `interiorStart` to `interiorEnd`, so the item's own along-wall coordinate is
 * one matrix multiply. Which of the two directions the item's local +x is
 * depends on which half edge it bound to - the same fact `resolveHanding`
 * exists for - so it is read off the edge rather than assumed.
 *
 * @param {Object} item
 * @param {number} sign Local x direction to measure toward.
 * @returns {?number} Centimetres, or null when the item is not on a wall.
 */
function wallRunBeyond(item, sign)
{
	var edge = item && item.currentWallEdge;
	if (!edge || !edge.interiorTransform || typeof edge.interiorDistance !== 'function')
	{
		return null;
	}
	var along = item.position.clone().applyMatrix4(edge.interiorTransform).x;
	var run = edge.interiorDistance();
	var start = edge.interiorStart();
	var end = edge.interiorEnd();
	// Local +x in world, from the rotation the item bound with: rotating by theta
	// sends local +x to (cos, 0, -sin).
	var cos = Math.cos(item.rotation.y || 0);
	var sin = Math.sin(item.rotation.y || 0);
	var forward = (end.x - start.x) * cos + (end.y - start.y) * -sin;
	var toward = sign * (forward < 0 ? -1 : 1);
	return (toward > 0) ? Math.max(0, run - along) : Math.max(0, along);
}

/** The thickness of the wall an item is actually on, or null. */
function wallThicknessOf(item)
{
	var edge = item && item.currentWallEdge;
	var thickness = edge && edge.wall && edge.wall.thickness;
	return (typeof thickness === 'number' && thickness > 0) ? thickness : null;
}

/**
 * Re-hand a bound door, fit it to the wall it landed on, and say so when it
 * cannot be fitted.
 *
 * Called from `WallItem.changeWallEdge` through `Item.onBound`, because that is
 * the moment the item's rotation stops being the tracer's hint and becomes the
 * wall's answer - and it is also the first moment there is a wall to ask how
 * thick it is.
 *
 * Three things happen here, in this order and for three different reasons.
 *
 * **The wall's thickness wins.** `spec.wallThickness` is baked by `extract.py`
 * off the traced drawing and nothing had ever re-read it, so a door dragged onto
 * a different wall kept the first wall's number and its frame stopped filling
 * its opening. The frame is built to fit a wall, so the wall is what it should
 * be asked. Routed through `setSpec` because the lining's geometry changes,
 * which means this recurses exactly once: `setSpec` calls `onBound` again and by
 * then the numbers agree, so the guard is false and the second pass falls
 * through to the rest.
 *
 * **The handing is resolved.** Everything the leaves depend on is a child, so
 * this replaces a few small groups and never touches the merged geometry the
 * wall's hole was cut from.
 *
 * **A pocket door that will not fit says so.** ROADMAP.md asks the app to check
 * and refuse rather than let somebody put a pocket door in a 3 1/2in partition
 * and find out on site. Refusing is not rewriting the spec - the drawing is the
 * user's, and a silent change to `operation` would be worse than the fault. It
 * is drawing the door SHUT, because a leaf with nowhere to go does not open, and
 * putting the reason where the panel can show it.
 *
 * @param {Object} item An Item carrying a `door` spec.
 */
export function applyDoorFit(item)
{
	var spec = item.metadata && item.metadata.spec;
	if (!spec || spec.kind !== 'door')
	{
		return;
	}
	var s = normalise(spec);
	var thickness = wallThicknessOf(item);

	// A barn door hangs on the face and does not fill the wall, so its lining
	// thickness is nobody's business but its own.
	if (thickness && s.operation !== 'barn' && typeof item.setSpec === 'function' && item._specBuilder
		&& Math.abs(s.wallThickness - thickness) > 0.05)
	{
		var next = item.getSpec();
		next.wallThickness = Number(thickness.toFixed(4));
		item.setSpec(next);
		return;
	}

	var mats = materialsForSlots(s.material, SLOTS);
	var handing = resolveHanding(s, item.rotation.y);

	/** @type {Array<string>} */
	var notices = [];
	if (s.operation === 'pocket')
	{
		var fit = pocketFit(s, {
			thickness: thickness,
			run: wallRunBeyond(item, handing.hingeSign),
		});
		if (!fit.fits)
		{
			notices.push(fit.reason || '');
			// The spec is left alone. Only the drawing refuses.
			s = Object.assign({}, s, {openFraction: 0});
		}
	}
	item.specNotices = notices;

	// Drop the old handing-dependent children. The casing is not among them - it
	// is symmetric - so it is left alone rather than rebuilt.
	var stale = item.generatedParts.filter(function (part)
	{
		return part.userData && part.userData.handed;
	});
	stale.forEach(function (part)
	{
		item.remove(part);
		disposeObject(part);
	});

	var fresh = buildLeaves(s, handing.hingeSign, handing.dirSign, mats);
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
 * `hand` appears three times with three labels and three `when`s, because it is
 * one field that names three different things - the hinge jamb of a swing, the
 * leaf that moves on a slider, the side a pocket or a bifold or a barn door goes
 * to. Only one is ever visible. Calling all of them "Hinged at" would be wrong
 * on five operations out of eight, and splitting them into three spec fields
 * would be three ways to say the same thing.
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
			{value: 'french', label: 'French (two leaves)'},
			{value: 'bypass', label: 'Bypass (sliding closet)'},
			{value: 'sliding', label: 'Sliding patio'},
			{value: 'pocket', label: 'Pocket'},
			{value: 'bifold', label: 'Bifold'},
			{value: 'barn', label: 'Barn'},
			{value: 'cased', label: 'Cased opening'},
		]},
		{key: 'width', label: 'Opening width', type: 'length', min: 40, max: 300, step: 1},
		{key: 'height', label: 'Opening height', type: 'length', min: 150, max: 300, step: 1},
		// Not editable: it is the wall's, and a door that disagrees with its wall
		// is a bug rather than a choice. Shown so the number is visible - and for a
		// pocket door it is the number that decides whether it can be built.
		{key: 'wallThickness', label: 'Wall thickness', type: 'length', readOnly: true},
		{key: 'leaf', label: 'Leaf', type: 'choice', shared: true,
			when: {operation: ['swing', 'french', 'bypass', 'sliding', 'pocket', 'bifold', 'barn']},
			options: [
				{value: 'flush', label: 'Flush'},
				{value: 'two-panel', label: 'Two panel'},
				{value: 'six-panel', label: 'Six panel'},
				{value: 'glazed', label: 'Glazed'},
			]},
		{key: 'leaves', label: 'Panels', type: 'choice', when: {operation: 'bifold'}, options: [
			{value: 2, label: 'Two'},
			{value: 4, label: 'Four'},
		]},
		{key: 'hand', label: 'Hinged at', type: 'choice',
			when: {operation: ['swing', 'french']}, options: [
				{value: 'lo', label: 'Start of wall'},
				{value: 'hi', label: 'End of wall'},
			]},
		{key: 'hand', label: 'Leaf that slides', type: 'choice',
			when: {operation: ['bypass', 'sliding']}, options: [
				{value: 'lo', label: 'Start of wall'},
				{value: 'hi', label: 'End of wall'},
			]},
		{key: 'hand', label: 'Slides toward', type: 'choice',
			when: {operation: ['pocket', 'bifold', 'barn']}, options: [
				{value: 'lo', label: 'Start of wall'},
				{value: 'hi', label: 'End of wall'},
			]},
		{key: 'swing', label: 'Opens toward', type: 'choice',
			when: {operation: ['swing', 'french', 'bifold']}, options: [
				{value: 'negative', label: 'One side'},
				{value: 'positive', label: 'The other'},
			]},
		{key: 'openFraction', label: 'How far open', type: 'fraction',
			when: {operation: ['swing', 'french', 'bypass', 'sliding', 'pocket', 'bifold', 'barn']},
			min: 0, max: 1, step: 0.05},
		{key: 'grille.pattern', label: 'Grille', type: 'choice', shared: true,
			when: {leaf: 'glazed'}, options: [
				{value: 'none', label: 'None'},
				{value: 'colonial', label: 'Colonial'},
				{value: 'prairie', label: 'Prairie'},
				{value: 'craftsman', label: 'Craftsman'},
			]},
		{key: 'grille.rows', label: 'Lights high', type: 'fraction', min: 1, max: 8, step: 1,
			when: {leaf: 'glazed', 'grille.pattern': 'colonial'}},
		{key: 'grille.cols', label: 'Lights wide', type: 'fraction', min: 1, max: 6, step: 1,
			when: {leaf: 'glazed', 'grille.pattern': 'colonial'}},
		{key: 'material.leaf', label: 'Leaf finish', type: 'material', shared: true,
			when: {operation: ['swing', 'french', 'bypass', 'sliding', 'pocket', 'bifold', 'barn']}},
		{key: 'material.glass', label: 'Glazing', type: 'material', group: 'glass',
			when: {leaf: 'glazed'}},
		{key: 'material.frame', label: 'Frame', type: 'material', shared: true},
		{key: 'material.casing', label: 'Casing', type: 'material', shared: true},
		{key: 'material.hardware', label: 'Hardware', type: 'material', shared: true,
			when: {operation: ['swing', 'french', 'bypass', 'sliding', 'pocket', 'bifold', 'barn']},
			group: 'metal'},
	],
};

/**
 * The lining: what the wall's hole is cut from.
 *
 * Two jambs and a head, filling the wall, plus the sill track a patio slider
 * stands on. Symmetric, and deliberately free of anything the handing decides.
 */
function buildFrame(s, mats)
{
	var f = frameOf(s);
	var frame = new Group();
	frame.add(box(mats.frame, -f.x1, -f.ox, f.floor, f.oyTop, -f.z1, f.z1));
	frame.add(box(mats.frame, f.ox, f.x1, f.floor, f.oyTop, -f.z1, f.z1));
	frame.add(box(mats.frame, -f.x1, f.x1, f.oyTop, f.y1, -f.z1, f.z1));
	if (s.sill > 0)
	{
		// The one member that separates a patio door from every other door in the
		// house. The clear opening starts on top of it, which is why `leafSizeOf`
		// takes the sill off the leaf height rather than leaving it to stand in mid
		// air.
		frame.add(box(mats.frame, -f.ox, f.ox, f.floor, f.oyBot, -f.z1, f.z1));
	}
	return frame;
}

/**
 * A barn door's own geometry: the track it hangs from and the guide at the
 * floor.
 *
 * Both are real parts, and putting them in the geometry rather than in a child
 * is what makes the bounds mean something for a face-mounted item. `boundToFloor`
 * seats the item by half its own height, so the guide is what puts the leaf on
 * the floor; `boundMove` clamps along the wall by half its own width, so the
 * track is what stops the door being dragged somewhere its track would run off
 * the end of the wall. Neither needed a line of validation.
 *
 * The result is deliberately ASYMMETRIC - the track runs a leaf width past one
 * jamb and stops at the other - so `recentre` moves the origin onto it.
 */
function buildBarnCarriage(s, hingeSign, mats)
{
	var lap = barnLapOf(s);
	var frame = new Group();
	var over = 7.6;
	var parked = hingeSign * lap.width;
	var from = Math.min(-lap.width / 2, -lap.width / 2 + parked) - over;
	var to = Math.max(lap.width / 2, lap.width / 2 + parked) + over;
	var z0 = lap.z - s.leafThickness / 2 - lap.standoff;
	var z1 = lap.z + s.leafThickness / 2;

	// The rail, and a pair of standoff blocks holding it off the wall face.
	frame.add(box(mats.hardware, from, to, lap.trackY, lap.trackY + 5.1, z0 + 0.6, z0 + 2.4));
	[0.15, 0.85].forEach(function (t)
	{
		var bx = from + t * (to - from);
		frame.add(box(mats.hardware, bx - 3.2, bx + 3.2, lap.trackY, lap.trackY + 5.1, z0, z0 + 0.6));
	});
	// A floor guide at the jamb the door parks past - which is where an installer
	// screws one, because it is the point the leaf passes in both positions. It is
	// also what carries the bounds down to the floor, and therefore what
	// `boundToFloor` seats the whole item by.
	var floor = frameOf(s).floor;
	var gx = hingeSign * (s.width / 2 + s.jamb);
	frame.add(box(mats.hardware, gx - 4.0, gx + 4.0, floor, floor + 1.6, z0 + 0.4, z1));
	return frame;
}

/**
 * Build a door.
 *
 * The handing here is the spec's own, read against a rotation of zero. That is a
 * placeholder: the item is re-handed by `applyDoorFit` the moment it binds to a
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
	var s = normalise(spec);
	var mats = materialsForSlots(s.material, SLOTS);
	var handing = resolveHanding(s, 0);

	// Built up rather than concatenated: `concat` on a Group[] narrows the result
	// to Group[], and the leaf parts include bare Object3D pivots.
	/** @type {Array<Object3D>} */
	var parts = [];
	var frame;

	if (s.operation === 'barn')
	{
		frame = buildBarnCarriage(s, handing.hingeSign, mats);
	}
	else
	{
		frame = buildFrame(s, mats);
		buildCasing(s, mats).forEach(function (part) {parts.push(part);});
	}

	var merged = mergeMeshes(frame);
	buildLeaves(s, handing.hingeSign, handing.dirSign, mats).forEach(function (part) {parts.push(part);});
	// Geometry and children together, or the frame moves and the leaf stays put.
	recentre(merged.geometry, parts);

	return {
		geometry: merged.geometry,
		materials: merged.materials,
		parts: parts,
		onBound: applyDoorFit,
	};
}
