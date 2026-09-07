/**
 * The generated door.
 *
 * Why this exists at all: `open_door.glb` is not an open door. Its whole
 * bounding box is 97.1 x 221.58 x 7.62cm -- decoded, the same frame, in-plane
 * leaf and hinges as the closed door with the doorknobs deleted -- so a 32in
 * leaf swung 90 degrees, which projects about 81cm, was never in that file.
 * Every assertion below that measures a projection is guarding against shipping
 * the same nothing a second time.
 */
import {describe, it, expect} from 'vitest';
import {Box3, Vector3} from 'three';
import {buildDoor, pocketFit, resolveHanding} from '../src/scripts/items/generated/door.js';
import {generatedKind, isGenerated} from '../src/scripts/items/generated/index.js';

/** The door the traced plan asks for: 32in wide, 80in tall, in a 2x4 wall. */
const SPEC = {kind: 'door', width: 81.28, height: 203.2, wallThickness: 11.43,
	hand: 'lo', swing: 'negative', openFraction: 0.75};

/** World-space bounds of a part, after its own transforms. */
function boundsOf(object)
{
	object.updateMatrixWorld(true);
	return new Box3().setFromObject(object);
}

function pivotOf(built)
{
	return built.parts.find((p) => p.name === 'door-leaf-pivot');
}

describe('the generated door', () =>
{
	it('names itself as generated, and only with a builder behind it', () =>
	{
		expect(isGenerated('generated:door')).toBe(true);
		expect(generatedKind('generated:door')).toBe('door');
		// An ordinary model must not be mistaken for one.
		expect(isGenerated('models/js-glb/open_door.glb')).toBe(false);
		expect(generatedKind('models/js-glb/open_door.glb')).toBe(null);
		// A prefix with nothing after it is not a builder name.
		expect(generatedKind('generated:')).toBe(null);
	});

	it('makes the item geometry the rough opening, not the casing outline', () =>
	{
		// This is the load-bearing one. three/edge.js cuts the wall's hole from
		// halfSize.x/.y, so if the casing were merged in, the hole would be wider
		// than the frame by the casing width on all four sides and daylight would
		// show around every door.
		const built = buildDoor(SPEC);
		built.geometry.computeBoundingBox();
		const box = built.geometry.boundingBox;
		const size = box.getSize(new Vector3());

		// Clear opening plus a jamb each side, and one over the head.
		expect(size.x).toBeCloseTo(81.28 + 2 * 1.9, 3);
		expect(size.y).toBeCloseTo(203.2 + 1.9, 3);
		// The frame fills the wall exactly: no scaling, so a 2x4 and a 2x6 wall
		// both come out right.
		expect(size.z).toBeCloseTo(11.43, 3);
	});

	it('centres its geometry, so Item does not shift the children out from under it', () =>
	{
		// Item's constructor recentres geometry on its bounding box in all three
		// axes (items/item.js:198) and does NOT recentre children. Authoring the
		// frame off-centre would therefore move the frame and leave the leaf
		// behind. Pre-centred makes that recentring a no-op.
		const built = buildDoor(SPEC);
		built.geometry.computeBoundingBox();
		const centre = built.geometry.boundingBox.getCenter(new Vector3());
		// To 4 places, not 6: positions are float32, so a 221cm extent cannot
		// resolve better than a few microns and the exact zero is not available.
		expect(centre.x).toBeCloseTo(0, 4);
		expect(centre.y).toBeCloseTo(0, 4);
		expect(centre.z).toBeCloseTo(0, 4);
	});

	it('keeps the leaf and casing out of the item geometry', () =>
	{
		const built = buildDoor(SPEC);
		expect(built.parts.length).toBeGreaterThan(0);
		expect(pivotOf(built)).toBeTruthy();
		expect(built.parts.filter((p) => p.name === 'door-casing')).toHaveLength(2);
	});

	it('swings the leaf out of the wall, which is the whole point', () =>
	{
		const shut = buildDoor(Object.assign({}, SPEC, {openFraction: 0}));
		const open = buildDoor(Object.assign({}, SPEC, {openFraction: 1}));

		const shutDepth = boundsOf(pivotOf(shut)).getSize(new Vector3()).z;
		const openDepth = boundsOf(pivotOf(open)).getSize(new Vector3()).z;

		// Shut, the leaf lies in the wall. Its 3.5cm thickness plus a knob standing
		// 3.2cm off each face, so 9.9 -- the knobs are under the pivot on purpose,
		// so they swing with the door rather than hanging in the opening.
		expect(shutDepth).toBeCloseTo(3.5 + 2 * 3.2, 1);
		// Open, it projects most of its own width. This is the assertion
		// open_door.glb fails: it manages 7.62cm in total.
		expect(openDepth).toBeGreaterThan(70);
	});

	it('opens toward -z for an in-swing and +z for an out-swing, on both hands', () =>
	{
		// Four handings, not the two a rotation can reach. Turning a door through
		// half a circle swaps which end is hinged AND which way it opens, so the
		// two have to be separate fields -- and rotation.y cannot carry either,
		// because WallItem.changeWallEdge overwrites it from the wall normal.
		for (const hand of ['lo', 'hi'])
		{
			const inward = boundsOf(pivotOf(buildDoor(
				Object.assign({}, SPEC, {hand, swing: 'negative', openFraction: 1}))));
			const outward = boundsOf(pivotOf(buildDoor(
				Object.assign({}, SPEC, {hand, swing: 'positive', openFraction: 1}))));

			expect(inward.min.z, `hand ${hand} negative-swing reaches -z`).toBeLessThan(-70);
			expect(inward.max.z, `hand ${hand} negative-swing stays out of +z`).toBeLessThan(5);
			expect(outward.max.z, `hand ${hand} positive-swing reaches +z`).toBeGreaterThan(70);
			expect(outward.min.z, `hand ${hand} positive-swing stays out of -z`).toBeGreaterThan(-5);
		}
	});

	it('hinges at the end the hand names', () =>
	{
		// The pivot is the hinge line, so its x IS the answer.
		const lo = pivotOf(buildDoor(Object.assign({}, SPEC, {hand: 'lo'})));
		const hi = pivotOf(buildDoor(Object.assign({}, SPEC, {hand: 'hi'})));
		expect(lo.position.x).toBeLessThan(0);
		expect(hi.position.x).toBeGreaterThan(0);
		expect(lo.position.x).toBeCloseTo(-hi.position.x, 6);
	});

	it('fits the frame to the wall it is given, at any thickness', () =>
	{
		// The measured walls on this plan run 7.7 to 19cm. A model has one depth
		// and had to be scaled to each of them, which is what flattened the leaf.
		for (const wallThickness of [7.7, 11.43, 18.41, 25.5])
		{
			const built = buildDoor(Object.assign({}, SPEC, {wallThickness}));
			built.geometry.computeBoundingBox();
			const size = built.geometry.boundingBox.getSize(new Vector3());
			expect(size.z).toBeCloseTo(wallThickness, 3);
			// And the leaf keeps its own thickness rather than being squashed with
			// the frame.
			const leafDepth = boundsOf(pivotOf(built)).getSize(new Vector3()).z;
			expect(leafDepth).toBeGreaterThan(3);
		}
	});

	it('keeps the item geometry handing-independent', () =>
	{
		// Only the frame is merged in, so re-handing on binding rebuilds three
		// small child groups and never touches the geometry the wall's hole was
		// cut from. Hinges belong to whichever jamb the handing picks, so they are
		// children too.
		const frameOnly = buildDoor(SPEC).materials;
		expect(frameOnly).toHaveLength(1);
		expect(frameOnly[0].userData.materialId).toBe('paint-white');

		const lo = buildDoor(Object.assign({}, SPEC, {hand: 'lo'}));
		const hi = buildDoor(Object.assign({}, SPEC, {hand: 'hi'}));
		lo.geometry.computeBoundingBox();
		hi.geometry.computeBoundingBox();
		expect(lo.geometry.boundingBox.min.x).toBeCloseTo(hi.geometry.boundingBox.min.x, 4);
		expect(lo.geometry.attributes.position.count).toBe(hi.geometry.attributes.position.count);
	});

	it('finishes each slot from the material library', () =>
	{
		// A tint could not tell white paint from white lacquer from white quartz:
		// same colour, three surfaces, and the difference is entirely roughness
		// and metalness. So a spec names a library id per slot.
		const built = buildDoor(Object.assign({}, SPEC, {
			material: {frame: 'wood-walnut', hardware: 'metal-matte-black'},
		}));
		expect(built.materials[0].userData.materialId).toBe('wood-walnut');
		expect(built.materials[0].roughness).toBeCloseTo(0.55, 3);

		const hardware = [];
		built.parts.forEach((part) => part.traverse((o) =>
		{
			if (o.isMesh && o.material.userData.materialId === 'metal-matte-black') {hardware.push(o);}
		}));
		expect(hardware.length).toBeGreaterThan(0);
		expect(hardware[0].material.metalness).toBe(1);

		// A slot the spec does not mention keeps the builder's own answer.
		expect(built.parts.some((part) =>
		{
			let found = false;
			part.traverse((o) => {if (o.isMesh && o.material.userData.materialId === 'paint-white') {found = true;}});
			return found;
		})).toBe(true);
	});

	it('falls back rather than throwing on a finish this build has retired', () =>
	{
		// A saved design outlives the library. Opening it should look wrong, not
		// fail - the tolerance resolveModelUrl extends to a retired model.
		const built = buildDoor(Object.assign({}, SPEC, {material: {frame: 'no-such-finish'}}));
		expect(built.materials[0].userData.materialId).toBe('paint-white');
	});

	it('a cased opening has no leaf at all', () =>
	{
		// An opening the drawing showed no swing arc in is a bypass slider or a
		// cased opening. Drawing one slab across it is worse than drawing nothing:
		// the three 48.7in closet openings on the traced plan came out as solid
		// 48.7in doors, so an opening that should read as open read as a wall.
		const cased = buildDoor(Object.assign({}, SPEC, {operation: 'cased'}));
		expect(cased.parts.find((p) => p.name === 'door-leaf-pivot')).toBeUndefined();
		expect(cased.parts.find((p) => p.name === 'door-hinges')).toBeUndefined();
		// The lining and its casing are still there - it is a finished opening.
		expect(cased.parts.filter((p) => p.name === 'door-casing')).toHaveLength(2);
		cased.geometry.computeBoundingBox();
		expect(cased.geometry.boundingBox.getSize(new Vector3()).z).toBeCloseTo(11.43, 3);
	});

	describe('handing is resolved against the plan, not the item', () =>
	{
		// The bug this fixes, measured on the traced plan: door-7 and door-9 carry
		// identical specs and their leaves ended up at world dz +35.9 and -28.9,
		// because each resolved its swing in its own local frame and the two
		// frames were 180 degrees apart. A wall has two half edges and
		// WallItem.changeWallEdge takes rotation.y from whichever one the item
		// bound to, so the item's axes are not the plan's axes.

		it('flips the local signs when the item binds rotated by half a turn', () =>
		{
			const spec = {hand: 'lo', swing: 'negative'};
			const facing = resolveHanding(spec, 0);
			const flipped = resolveHanding(spec, Math.PI);
			expect(flipped.hingeSign).toBe(-facing.hingeSign);
			expect(flipped.dirSign).toBe(-facing.dirSign);
		});

		it('resolves both axes independently, because vertical walls disagree', () =>
		{
			// Rotating by theta sends local +x to world (cos, 0, -sin) and local +z
			// to world (sin, 0, cos). On a wall running along world z those two
			// carry OPPOSITE signs, so treating the along-axis and the across-axis
			// as one flip is right on horizontal walls and wrong on vertical ones -
			// which shows up as half of one elevation hinged backwards.
			const spec = {hand: 'lo', swing: 'negative'};
			const horizontal = resolveHanding(spec, 0);
			expect(horizontal.hingeSign).toBe(-1);
			expect(horizontal.dirSign).toBe(-1);

			const vertical = resolveHanding(spec, Math.PI / 2);
			expect(vertical.hingeSign).toBe(1);
			expect(vertical.dirSign).toBe(-1);
		});

		it('puts the same plan spec on the same world side from either rotation', () =>
		{
			// The end-to-end statement of the bug: two doors, same spec, rotations
			// half a turn apart, leaves on the same side of the world.
			const spec = Object.assign({}, SPEC, {openFraction: 1});
			const sides = [0, Math.PI].map((rotationY) =>
			{
				const handing = resolveHanding(spec, rotationY);
				const built = buildDoor(Object.assign({}, spec, {
					hand: handing.hingeSign > 0 ? 'hi' : 'lo',
					swing: handing.dirSign > 0 ? 'positive' : 'negative',
				}));
				const pivot = pivotOf(built);
				const local = boundsOf(pivot).getCenter(new Vector3());
				// Into world, through the rotation the item bound with.
				return Math.sign(local.x * Math.sin(rotationY) + local.z * Math.cos(rotationY));
			});
			expect(sides[0]).toBe(sides[1]);
		});
	});
});

/**
 * The seven other operations.
 *
 * ROADMAP.md phase 5 says `operation` is the axis the whole door question turns
 * on, and every assertion below is a statement about **what moves and where it
 * goes** - which is the only thing that separates them. None of it is about
 * triangle counts: a bypass drawn as one leaf running fully clear has exactly
 * the same triangles as one that stops halfway.
 */

/** Where a named part actually is, after its own transforms. */
function partNamed(built, name)
{
	let found = null;
	built.parts.forEach((part) => part.traverse((o) => {if (o.name === name && !found) {found = o;}}));
	return found;
}

/** Every material id anywhere under this build's children. */
function finishesIn(built)
{
	const ids = new Set();
	built.parts.forEach((part) => part.traverse((o) =>
	{
		if (o.isMesh && o.material && o.material.userData) {ids.add(o.material.userData.materialId);}
	}));
	return ids;
}

/** The x span a set of parts covers, unioned crudely by min and max. */
function spanOf(objects)
{
	const boxes = objects.map(boundsOf);
	return {
		min: Math.min(...boxes.map((b) => b.min.x)),
		max: Math.max(...boxes.map((b) => b.max.x)),
	};
}

/** Non-indexed vertices of the item's own geometry. */
function verticesOf(geometry)
{
	const flat = geometry.index ? geometry.toNonIndexed() : geometry;
	const pos = flat.attributes.position;
	const out = [];
	for (let i = 0; i < pos.count; i++)
	{
		out.push(new Vector3().fromBufferAttribute(pos, i));
	}
	return out;
}

describe('a bypass never clears more than half its opening', () =>
{
	// The signature ROADMAP.md names, and the usual mistake: "a slider drawn as
	// one leaf sliding fully clear looks wrong immediately". Two leaves offset
	// ACROSS the wall and overlapping ALONG it is what makes that true, and it is
	// the one property of a bypass that a measurement of travel cannot see.
	const BYPASS = Object.assign({}, SPEC, {operation: 'bypass', width: 123.7, openFraction: 1});

	it('leaves at least half the opening covered when it is fully open', () =>
	{
		const built = buildDoor(BYPASS);
		const leaves = built.parts.filter((p) => p.name === 'door-leaf-lo' || p.name === 'door-leaf-hi');
		expect(leaves).toHaveLength(2);

		const covered = spanOf(leaves);
		const width = covered.max - covered.min;
		// One leaf lands exactly over the other, so what is covered is one leaf -
		// a shade over half - and what is open is the rest.
		expect(width / BYPASS.width).toBeGreaterThan(0.45);
		expect(width / BYPASS.width).toBeLessThan(0.6);
	});

	it('offsets the two leaves across the wall so they can pass', () =>
	{
		const built = buildDoor(Object.assign({}, BYPASS, {openFraction: 0}));
		const lo = boundsOf(partNamed(built, 'door-leaf-lo'));
		const hi = boundsOf(partNamed(built, 'door-leaf-hi'));
		// Apart across the wall - HARDWARE INCLUDED, which is the part that bites.
		// A finger pull proud of the inner face of each leaf put the two assemblies
		// 0.8cm through each other while both leaves were correctly placed.
		expect(lo.min.z).toBeGreaterThan(hi.max.z);
		// ...and lapping along it, so no daylight shows down the middle when shut.
		expect(lo.max.x).toBeGreaterThan(hi.min.x);
	});

	it('slides toward the other leaf and not out into the room', () =>
	{
		// Slid the other way a leaf leaves the opening entirely and hangs in free
		// air beside the door. Invisible in a measurement of travel; obvious in a
		// render.
		const shut = boundsOf(partNamed(buildDoor(Object.assign({}, BYPASS, {openFraction: 0})),
			'door-leaf-lo'));
		const open = boundsOf(partNamed(buildDoor(BYPASS), 'door-leaf-lo'));
		expect(open.min.x).toBeGreaterThan(shut.min.x);
		expect(open.max.x).toBeLessThan(BYPASS.width / 2 + 0.01);
	});

	it('hangs both leaves from one track', () =>
	{
		expect(partNamed(buildDoor(BYPASS), 'door-track')).toBeTruthy();
	});
});

describe('a patio slider is a bypass at door scale, glazed, on a sill', () =>
{
	const PATIO = {kind: 'door', operation: 'sliding', width: 182.88, height: 203.2,
		wallThickness: 15.24, hand: 'lo', swing: 'negative'};

	/**
	 * Is there a horizontal member whose TOP is `sill` above the floor?
	 *
	 * Asked of the vertices rather than of a point inside the opening, because a
	 * box has vertices only at its corners - the first form of this test looked
	 * for geometry in the middle of the sill and found none, with the sill present
	 * and correct.
	 */
	function sillTopAt(built, sill)
	{
		built.geometry.computeBoundingBox();
		const floor = built.geometry.boundingBox.min.y;
		return verticesOf(built.geometry).some((v) => Math.abs(v.y - (floor + sill)) < 0.05);
	}

	it('puts a sill track in the ITEM geometry, where a passage door has floor', () =>
	{
		// The sill is part of the lining, so it belongs in the geometry the wall's
		// hole is cut from - and it is the one member that separates a patio door
		// from every other door in the house.
		expect(sillTopAt(buildDoor(PATIO), 3.2)).toBe(true);
		expect(sillTopAt(buildDoor(Object.assign({}, PATIO, {operation: 'bypass'})), 3.2))
			.toBe(false);
	});

	it('stands its leaves ON the sill rather than through it', () =>
	{
		// The lining grew a member, so the leaf has to lose the same height or it
		// runs into it. `leafSizeOf` takes the sill off the clear opening, which is
		// what a sill IS.
		const patio = buildDoor(PATIO);
		patio.geometry.computeBoundingBox();
		const floor = patio.geometry.boundingBox.min.y;
		const leaf = boundsOf(partNamed(patio, 'door-leaf-lo'));
		expect(leaf.min.y - floor).toBeGreaterThan(3.2);
	});

	it('glazes its leaves, and a flush door does not', () =>
	{
		// `leaf: 'glazed'` comes from the operation, not from the caller: a patio
		// door that is not glazed is not a patio door.
		expect(finishesIn(buildDoor(PATIO)).has('glass-clear')).toBe(true);
		expect(finishesIn(buildDoor(Object.assign({}, PATIO, {leaf: 'flush'})))
			.has('glass-clear')).toBe(false);
	});

	it('leaves one panel fixed', () =>
	{
		// One fixed light and one operable, which is what a patio door is. The
		// fixed one must not move when the door opens.
		const shut = boundsOf(partNamed(buildDoor(PATIO), 'door-leaf-hi'));
		const open = boundsOf(partNamed(buildDoor(Object.assign({}, PATIO, {openFraction: 1})),
			'door-leaf-hi'));
		expect(open.min.x).toBeCloseTo(shut.min.x, 4);
	});
});

describe('a pocket door goes into the wall, and the wall may refuse it', () =>
{
	const POCKET = Object.assign({}, SPEC, {operation: 'pocket', openFraction: 1});
	/** The fields `pocketFit` reads, as a spec that has been through no builder. */
	const FIT_SPEC = Object.assign({}, POCKET, {jamb: 1.9, reveal: 0.3});

	it('takes the leaf entirely out of the opening', () =>
	{
		const built = buildDoor(POCKET);
		const leaf = boundsOf(partNamed(built, 'door-leaf-pocket'));
		// Hand `lo` at a rotation of zero hinges to -x, so the pocket is at -x.
		expect(leaf.max.x).toBeLessThan(-SPEC.width / 2);
	});

	it('keeps the leaf on the wall centreline, because that is where a cavity is', () =>
	{
		const leaf = boundsOf(partNamed(buildDoor(Object.assign({}, POCKET, {openFraction: 0})),
			'door-leaf-pocket'));
		expect((leaf.min.z + leaf.max.z) / 2).toBeCloseTo(0, 4);
	});

	it('refuses a wall too thin to hold the leaf', () =>
	{
		// ROADMAP.md asks for this by name: the information is already in the
		// model, and finding out on site is expensive. A 3 1/2in partition is the
		// case it names.
		const thin = pocketFit(FIT_SPEC, {thickness: 8.89, run: 400});
		expect(thin.fits).toBe(false);
		expect(thin.reason).toMatch(/hold the leaf/i);

		// A standard 2x4 partition finishes at 4 1/2in and just holds one.
		expect(pocketFit(FIT_SPEC, {thickness: 11.43, run: 400}).fits).toBe(true);
	});

	it('refuses a wall with nowhere for the leaf to go', () =>
	{
		const cramped = pocketFit(FIT_SPEC, {thickness: 11.43, run: 60});
		expect(cramped.fits).toBe(false);
		expect(cramped.reason).toMatch(/slide into/i);
		// Half the opening, the jamb, the whole leaf, and the framing behind it.
		expect(cramped.needRun).toBeGreaterThan(SPEC.width);
	});

	it('says nothing when it is not asked about a wall at all', () =>
	{
		// An unbound door has no host to validate against, and a missing answer is
		// not a failing one.
		expect(pocketFit(FIT_SPEC, {thickness: null, run: null}).fits).toBe(true);
	});
});

describe('a french door is two leaves meeting in the middle', () =>
{
	const FRENCH = Object.assign({}, SPEC, {operation: 'french', width: 152.4});

	it('hinges one leaf on each jamb', () =>
	{
		const pivots = buildDoor(FRENCH).parts.filter((p) => p.name === 'door-leaf-pivot');
		expect(pivots).toHaveLength(2);
		expect(Math.sign(pivots[0].position.x)).toBe(-Math.sign(pivots[1].position.x));
	});

	it('fills the opening when it is shut', () =>
	{
		const pivots = buildDoor(Object.assign({}, FRENCH, {openFraction: 0}))
			.parts.filter((p) => p.name === 'door-leaf-pivot');
		const span = spanOf(pivots);
		// Two leaves and three reveals - the two jambs and the joint between them.
		expect(span.max - span.min).toBeGreaterThan(FRENCH.width - 4);
	});

	it('opens both leaves to the same side', () =>
	{
		const pivots = buildDoor(Object.assign({}, FRENCH, {openFraction: 1}))
			.parts.filter((p) => p.name === 'door-leaf-pivot');
		const sides = pivots.map((p) => Math.sign(boundsOf(p).getCenter(new Vector3()).z));
		expect(sides[0]).toBe(sides[1]);
		expect(sides[0]).toBe(-1);
	});

	it('is glazed unless the spec says otherwise', () =>
	{
		expect(finishesIn(buildDoor(FRENCH)).has('glass-clear')).toBe(true);
		expect(finishesIn(buildDoor(Object.assign({}, FRENCH, {leaf: 'six-panel'})))
			.has('glass-clear')).toBe(false);
	});
});

describe('a bifold folds along its track rather than swinging into the room', () =>
{
	const BIFOLD = Object.assign({}, SPEC, {operation: 'bifold', width: 123.7});

	it('keeps the leading edge on the track line at every angle', () =>
	{
		// The claim the two rotations exist for. The outer panel turns theta about
		// the jamb and the inner one turns MINUS TWICE that about the joint, and
		// the z components cancel exactly - so the free end runs along the head and
		// does not swing out into the room. Hinged to each other with one rotation
		// it describes an arc and leaves the wall, which is a pair of doors and not
		// a bifold.
		const panel = (BIFOLD.width - 2 * 0.3) / 2;
		for (const openFraction of [0, 0.25, 0.5, 0.75, 1])
		{
			const built = buildDoor(Object.assign({}, BIFOLD, {openFraction}));
			const joint = partNamed(built, 'door-leaf-fold-0-joint');
			// The far end of the inner panel, in the joint's own frame. Hand `lo`
			// stacks at -x, so the panels run toward +x.
			const end = new Vector3(panel, 0, 0).applyMatrix4(joint.matrixWorld);
			expect(Math.abs(end.z), `openFraction ${openFraction}`).toBeLessThan(0.05);
		}
	});

	it('stacks at the jamb, clearing the opening', () =>
	{
		const shut = spanOf(buildDoor(Object.assign({}, BIFOLD, {openFraction: 0}))
			.parts.filter((p) => p.name === 'door-leaf-fold-0'));
		const open = spanOf(buildDoor(Object.assign({}, BIFOLD, {openFraction: 1}))
			.parts.filter((p) => p.name === 'door-leaf-fold-0'));
		expect(shut.max - shut.min).toBeGreaterThan(BIFOLD.width - 2);
		// Folded flat against the jamb, the panels occupy about their own
		// thickness along the wall instead of the whole opening.
		expect(open.max - open.min).toBeLessThan(BIFOLD.width / 4);
	});

	it('makes four panels two pairs, one at each jamb', () =>
	{
		const built = buildDoor(Object.assign({}, BIFOLD, {leaves: 4}));
		const stacks = built.parts.filter((p) => p.name.indexOf('door-leaf-fold-') === 0);
		expect(stacks).toHaveLength(2);
		expect(Math.sign(stacks[0].position.x)).toBe(-Math.sign(stacks[1].position.x));
	});

	it('fits ONE knob, on the panel at the free end', () =>
	{
		// A knob on every panel is the same fault `window.js` records for a double
		// hung, which came out with a second lock at the head where no window has
		// one. The hardware gets its own material so a pooled one cannot hide it -
		// `docs/generated-items.md` trap 9.
		const built = buildDoor(Object.assign({}, BIFOLD, {
			material: {leaf: 'paint-white', hardware: 'metal-matte-black'},
		}));
		const withKnob = [];
		built.parts.forEach((part) => part.traverse((o) =>
		{
			if (!o.name || (o.name.slice(-2) !== '-a' && o.name.slice(-2) !== '-b')) {return;}
			let found = false;
			o.traverse((m) =>
			{
				if (m.isMesh && m.material.userData.materialId === 'metal-matte-black') {found = true;}
			});
			if (found) {withKnob.push(o.name);}
		}));
		expect(withKnob).toEqual(['door-leaf-fold-0-b']);
	});
});

describe('a barn door hangs on the wall face, not in a hole in it', () =>
{
	// ROADMAP.md: "do not try to make it type 7; it will fight `boundMove` and the
	// hole-cutting both." So its geometry is the track and the floor guide - both
	// real parts - and the leaf is the child that moves.
	const BARN = Object.assign({}, SPEC, {operation: 'barn'});

	it('puts the whole track in the bounds, which is what needs clear wall', () =>
	{
		const built = buildDoor(BARN);
		built.geometry.computeBoundingBox();
		const size = built.geometry.boundingBox.getSize(new Vector3());
		// Twice the leaf, so the drag clamp will not put it where the track would
		// run off the end of the wall. No validation code: `boundMove` clamps
		// travel along the wall by `sizeX / 2` and this IS sizeX.
		expect(size.x).toBeGreaterThan(2 * SPEC.width);
		// And down to the floor, because `boundToFloor` seats the item by half its
		// own height and the guide is what reaches down there.
		expect(size.y).toBeGreaterThan(SPEC.height);
	});

	it('centres its origin on that asymmetric geometry', () =>
	{
		// The one build here whose honest geometry is not symmetric. `Item`'s
		// constructor recentres geometry and NOT children, so the builder has to do
		// both together or the track moves and the leaf stays behind.
		const built = buildDoor(BARN);
		built.geometry.computeBoundingBox();
		const centre = built.geometry.boundingBox.getCenter(new Vector3());
		expect(centre.x).toBeCloseTo(0, 3);
		expect(centre.y).toBeCloseTo(0, 3);
		expect(centre.z).toBeCloseTo(0, 3);
	});

	it('laps the opening rather than filling it', () =>
	{
		// There is no rebate to close against, so a barn leaf is wider and taller
		// than its opening or daylight shows all round it.
		const leaf = boundsOf(partNamed(buildDoor(BARN), 'door-leaf-barn'));
		expect(leaf.max.x - leaf.min.x).toBeGreaterThan(SPEC.width + 5);
		expect(leaf.max.y - leaf.min.y).toBeGreaterThan(SPEC.height);
	});

	it('stands the leaf off the wall face on rollers', () =>
	{
		const built = buildDoor(BARN);
		built.geometry.computeBoundingBox();
		const leaf = boundsOf(partNamed(built, 'door-leaf-barn'));
		// The back of the carriage is the wall face; the leaf is in front of it.
		expect(leaf.min.z).toBeGreaterThan(built.geometry.boundingBox.min.z);
		expect(partNamed(built, 'door-hangers')).toBeTruthy();
	});

	it('slides a full leaf width clear', () =>
	{
		// openFraction stated, not inherited: the shared SPEC leaves a door three
		// quarters open, and "shut" measured from that is not shut.
		const shut = boundsOf(partNamed(buildDoor(Object.assign({}, BARN, {openFraction: 0})),
			'door-leaf-barn'));
		const open = boundsOf(partNamed(buildDoor(Object.assign({}, BARN, {openFraction: 1})),
			'door-leaf-barn'));
		// Nowhere overlapping its own shut position, which is the whole point of
		// the track being twice as long as the door.
		expect(open.max.x).toBeLessThan(shut.min.x + 0.01);
		expect(shut.min.x - open.min.x).toBeCloseTo(shut.max.x - shut.min.x, 1);
	});
});

describe('the leaf style is orthogonal to the operation', () =>
{
	it('holds a panel inside the leaf, not flush with its face', () =>
	{
		// A panel flush with the stiles is a panel nobody can see - the same fault
		// that made a vent hood's filter render as nothing at all while its
		// triangles were present and correct.
		const flush = buildDoor(Object.assign({}, SPEC, {leaf: 'flush'}));
		const panelled = buildDoor(Object.assign({}, SPEC, {leaf: 'six-panel'}));
		const count = (built) =>
		{
			let n = 0;
			built.parts.forEach((part) => part.traverse((o) => {if (o.isMesh) {n++;}}));
			return n;
		};
		expect(count(panelled)).toBeGreaterThan(count(flush));
		// And the leaf is no thicker for it: the panel is recessed, not applied.
		const depthOf = (built) => boundsOf(partNamed(built, 'door-leaf-pivot')).getSize(new Vector3()).z;
		expect(depthOf(panelled)).toBeCloseTo(depthOf(flush), 3);
	});

	it('reaches the same four styles from every operation that has a leaf', () =>
	{
		for (const operation of ['swing', 'french', 'bypass', 'sliding', 'pocket', 'bifold', 'barn'])
		{
			for (const leaf of ['flush', 'two-panel', 'six-panel', 'glazed'])
			{
				const built = buildDoor(Object.assign({}, SPEC, {operation, leaf}));
				expect(built.parts.length, `${operation} / ${leaf}`).toBeGreaterThan(0);
				expect(finishesIn(built).has('glass-clear'), `${operation} / ${leaf}`)
					.toBe(leaf === 'glazed');
			}
		}
	});

	it('has no leaf at all, in any style, for a cased opening', () =>
	{
		const cased = buildDoor(Object.assign({}, SPEC, {operation: 'cased', leaf: 'six-panel'}));
		expect(cased.parts.every((p) => p.name === 'door-casing')).toBe(true);
	});
});
