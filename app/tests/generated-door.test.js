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
import {buildDoor, resolveHanding} from '../src/scripts/items/generated/door.js';
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
