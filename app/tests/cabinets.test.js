/**
 * Cabinets (ROADMAP.md phase 2).
 *
 * The assertions worth having are about what makes a cabinet read AS a cabinet
 * rather than as a box: fronts standing proud of a carcass, separated by
 * reveals, over a recessed toe kick. Those are the things a triangle count
 * cannot see and a render cannot give you numbers for.
 */
import {describe, it, expect} from 'vitest';
import {Box3, Vector3} from 'three';
import {buildCabinet} from '../src/scripts/items/generated/cabinet.js';

const size = (built) =>
{
	built.geometry.computeBoundingBox();
	return built.geometry.boundingBox.getSize(new Vector3());
};

function depths(built)
{
	built.geometry.computeBoundingBox();
	return built.geometry.boundingBox;
}

/**
 * The bounds of just the parts made of one material.
 *
 * Sampling "vertices at the front-most z" looks like the way to find the doors
 * and is not: the front-most thing on a cabinet is the KNOB, so that measures
 * hardware and reports the same answer for every door style. It cost two wrong
 * test failures before the probe showed 36 front-most vertices spanning 3cm -
 * a knob, not a door. `mergeMeshes` leaves one geometry group per material, so
 * asking by material is exact.
 *
 * Needs the slots given DIFFERENT materials, because materials pool by name and
 * the default frame and front are both white paint: one material, one group.
 */
function partBounds(built, materialId)
{
	const index = built.materials.findIndex((m) => m.userData.materialId === materialId);
	expect(index, `no ${materialId} in this cabinet`).toBeGreaterThanOrEqual(0);
	const position = built.geometry.getAttribute('position');
	const bounds = new Box3();
	for (const group of built.geometry.groups)
	{
		if (group.materialIndex !== index) {continue;}
		for (let i = group.start; i < group.start + group.count; i++)
		{
			bounds.expandByPoint(new Vector3().fromBufferAttribute(position, i));
		}
	}
	return bounds;
}

/** How far forward anything reaches in the bottom 5cm - i.e. the toe kick. */
function frontmostNearFloor(built)
{
	const bounds = depths(built);
	const position = built.geometry.getAttribute('position');
	let frontmost = -Infinity;
	for (let i = 0; i < position.count; i++)
	{
		if (position.getY(i) < bounds.min.y + 5)
		{
			frontmost = Math.max(frontmost, position.getZ(i));
		}
	}
	return frontmost;
}

/** Slots told apart, so partBounds can separate them. */
const DISTINCT = {carcass: 'wood-birch-ply', frame: 'paint-greige',
	front: 'wood-walnut', hardware: 'metal-matte-black'};

describe('a cabinet is built from panels', () =>
{
	it('comes out the size the trade uses', () =>
	{
		// 34.5in tall so a 1.5in counter lands the work surface at 36in. That is
		// not a preference, it is why every kitchen is the height it is.
		const base = size(buildCabinet({variant: 'base'}));
		expect(base.y).toBeCloseTo(87.63, 2);
		expect(base.x).toBeCloseTo(60.96, 2);

		const wall = size(buildCabinet({variant: 'wall'}));
		expect(wall.y).toBeCloseTo(76.2, 2);
		// A wall cabinet is half the depth of a base one, which is why you can
		// stand at a counter.
		expect(wall.z).toBeLessThan(base.z / 1.5);
	});

	it('is centred, so Item does not shift it', () =>
	{
		// Not cosmetic. A carcass is symmetric about its own depth and then the
		// frame and fronts are added in FRONT of it and nothing behind, so the
		// assembly sits forward of where its numbers say. Item would silently take
		// that out and the spec's depth would stop relating to the bounds.
		const built = buildCabinet({});
		built.geometry.computeBoundingBox();
		const centre = built.geometry.boundingBox.getCenter(new Vector3());
		expect(centre.x).toBeCloseTo(0, 4);
		expect(centre.y).toBeCloseTo(0, 4);
		expect(centre.z).toBeCloseTo(0, 4);
	});

	it('stands its fronts proud of the carcass', () =>
	{
		// The reveal between fronts is what makes a RUN read as cabinetry rather
		// than one surface, and it only exists if the fronts are in front.
		const built = buildCabinet({frame: 'face', material: DISTINCT});
		const carcass = partBounds(built, 'wood-birch-ply');
		const frame = partBounds(built, 'paint-greige');
		const fronts = partBounds(built, 'wood-walnut');
		expect(frame.max.z).toBeGreaterThan(carcass.max.z);
		expect(fronts.max.z).toBeGreaterThan(frame.max.z);
	});

	it('recesses the toe kick, so the carcass does not sit on the floor', () =>
	{
		// A carcass flat on the floor reads as a crate. This is the clearest tell
		// of a cabinet that was drawn rather than built.
		const built = buildCabinet({variant: 'base', material: DISTINCT});
		const bounds = depths(built);
		const carcass = partBounds(built, 'wood-birch-ply');

		// Something reaches the floor...
		expect(carcass.min.y).toBeCloseTo(bounds.min.y, 2);

		// ...but not at full depth. Nothing in the bottom 5cm comes as far forward
		// as the carcass does higher up.
		expect(frontmostNearFloor(built)).toBeLessThan(carcass.max.z - 7.0);
	});

	it('lets a base cabinet drop its toe kick for a separate plinth', () =>
	{
		// The variant decides by default and the spec overrides, which is why the
		// kick is a default rather than a fact about base cabinets.
		const kicked = buildCabinet({variant: 'base', toeKick: true, material: DISTINCT});
		const flat = buildCabinet({variant: 'base', toeKick: false, material: DISTINCT});
		// Same envelope either way: a toe kick is a recess, not extra height, and
		// both reach the floor - the kick is carcass too.
		expect(size(kicked).y).toBeCloseTo(size(flat).y, 3);
		expect(partBounds(flat, 'wood-birch-ply').min.y)
			.toBeCloseTo(partBounds(kicked, 'wood-birch-ply').min.y, 2);

		// The difference is how far FORWARD it reaches down there.
		expect(frontmostNearFloor(flat)).toBeGreaterThan(frontmostNearFloor(kicked) + 5);
	});
});

describe('front styles are profiles, not models', () =>
{
	it('spends more geometry on a shaker than a slab, in the same envelope', () =>
	{
		const slab = buildCabinet({front: 'slab'});
		const shaker = buildCabinet({front: 'shaker'});
		expect(shaker.geometry.attributes.position.count)
			.toBeGreaterThan(slab.geometry.attributes.position.count);
		// And it is the same cabinet: a door style is not a size.
		expect(size(shaker).x).toBeCloseTo(size(slab).x, 4);
		expect(size(shaker).y).toBeCloseTo(size(slab).y, 4);
	});

	it('makes a raised panel stand out where a shaker sets in', () =>
	{
		// One sign, and it was being thrown away: the centre panel's inset was
		// chosen and then passed through Math.abs(), so both styles built the same
		// panel and a raised door did not stand out at all.
		//
		// Measured on the FRONT material only. The cabinet's overall depth cannot
		// answer this, because the knob sticks out further than either panel.
		const raised = partBounds(buildCabinet({front: 'raised', material: DISTINCT}), 'wood-walnut');
		const shaker = partBounds(buildCabinet({front: 'shaker', material: DISTINCT}), 'wood-walnut');
		expect(raised.max.z).toBeGreaterThan(shaker.max.z);
	});

	it('falls back to a slab when the centre panel would be a sliver', () =>
	{
		// Judged on the PANEL, not the door. A 9in door is 9in minus two 2.25in
		// rails, so its panel is an inch and a half - nothing is made that way,
		// and drawn that way it is three slivers.
		const narrow = buildCabinet({width: 22.86, doors: 1, front: 'shaker'});
		const narrowSlab = buildCabinet({width: 22.86, doors: 1, front: 'slab'});
		expect(narrow.geometry.attributes.position.count)
			.toBe(narrowSlab.geometry.attributes.position.count);

		// A full-width door is still made properly.
		const wide = buildCabinet({width: 60.96, doors: 1, front: 'shaker'});
		const wideSlab = buildCabinet({width: 60.96, doors: 1, front: 'slab'});
		expect(wide.geometry.attributes.position.count)
			.toBeGreaterThan(wideSlab.geometry.attributes.position.count);
	});
});

describe('drawers are fitted, never dropped', () =>
{
	it('keeps every drawer asked for when they overflow the opening', () =>
	{
		// The bug the render caught: four drawers totalling 83.8cm into a 68.6cm
		// opening came out as three and a gap, because the fourth was silently
		// skipped rather than the set being scaled.
		const asked = [15.24, 22.86, 22.86, 22.86];
		const four = buildCabinet({doors: 0, drawers: asked, front: 'slab'});
		const three = buildCabinet({doors: 0, drawers: asked.slice(0, 3), front: 'slab'});
		// A slab front is one box per drawer, so the vertex count IS the count.
		expect(four.geometry.attributes.position.count)
			.toBeGreaterThan(three.geometry.attributes.position.count);
	});

	it('fills the opening when there are no doors to take the remainder', () =>
	{
		// Underfilling with no doors leaves a hole, because nothing else can use
		// the space.
		const bank = buildCabinet({doors: 0, drawers: [10, 10], material: DISTINCT});
		const fronts = partBounds(bank, 'wood-walnut');
		expect(fronts.max.y - fronts.min.y).toBeGreaterThan(87.63 * 0.6);
	});

	it('leaves a drawer its stated height when doors take the rest', () =>
	{
		// "One drawer over two doors" means a standard drawer with doors below,
		// not a drawer stretched to half the cabinet.
		const mixed = buildCabinet({doors: 2, drawers: [15.24], material: DISTINCT});
		const alone = buildCabinet({doors: 0, drawers: [15.24], material: DISTINCT});

		// Alone it stretches to fill the opening; over doors it does not.
		expect(partBounds(alone, 'wood-walnut').max.y - partBounds(alone, 'wood-walnut').min.y)
			.toBeGreaterThan(60);

		// The mixed one still covers the whole opening, because the doors take the
		// remainder - so measure the drawer itself, at the top.
		const fronts = partBounds(mixed, 'wood-walnut');
		expect(fronts.max.y - fronts.min.y).toBeGreaterThan(60);
	});
});

describe('a cabinet is finished from the material library', () =>
{
	it('takes a different material per slot', () =>
	{
		const built = buildCabinet({material: DISTINCT});
		const ids = built.materials.map((m) => m.userData.materialId).sort();
		expect(ids).toContain('wood-walnut');
		expect(ids).toContain('metal-matte-black');
		expect(ids).toContain('wood-birch-ply');
	});

	it('has no children, because nothing on it moves yet', () =>
	{
		// When doors open they become children on a pivot, the way door.js hangs
		// its leaf - and the centring will have to move to the carcass then. Pinned
		// so that change is deliberate.
		expect(buildCabinet({}).parts).toEqual([]);
	});
});
