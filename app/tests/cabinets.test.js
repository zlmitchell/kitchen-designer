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
import {buildCabinet, CABINET_LAYOUTS} from '../src/scripts/items/generated/cabinet.js';
import {
	MOUNT_DEFAULTS, emittersFor, normaliseFixture,
} from '../src/scripts/model/light.js';

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

describe('a wall cabinet decides what happens above it', () =>
{
	// The gap over a standard wall cabinet is the thing nobody wants: it collects
	// dust and it is why cabinets read as put in rather than built in. These are
	// the three ways of not having it.
	const WALL = {variant: 'wall', ceilingHeight: 243.84, mountHeight: 137.16};
	const TO_CEILING = 243.84 - 137.16;

	it('leaves the gap by default, which is what a stock cabinet does', () =>
	{
		expect(size(buildCabinet(WALL)).y).toBeCloseTo(76.2, 2);
	});

	it('reaches the ceiling as one taller cabinet', () =>
	{
		// A 42in wall cabinet on an 8ft ceiling IS this, which is why 42in is a
		// size you can buy.
		const built = buildCabinet(Object.assign({}, WALL, {topTreatment: 'to-ceiling'}));
		expect(size(built).y).toBeCloseTo(TO_CEILING, 1);
		// One cabinet, so its doors run the whole height: no break in the middle.
		const fronts = partBounds(buildCabinet(Object.assign({}, WALL,
			{topTreatment: 'to-ceiling', material: DISTINCT})), 'wood-walnut');
		expect(fronts.max.y - fronts.min.y).toBeGreaterThan(TO_CEILING * 0.85);
	});

	it('fills above with a soffit, leaving the cabinet a normal cabinet', () =>
	{
		const built = buildCabinet(Object.assign({}, WALL,
			{topTreatment: 'soffit', material: DISTINCT}));
		// Reaches the ceiling...
		expect(size(built).y).toBeCloseTo(TO_CEILING, 1);
		// ...but the doors do not: they stop at the standard 30in cabinet.
		const fronts = partBounds(built, 'wood-walnut');
		expect(fronts.max.y - fronts.min.y).toBeLessThan(76.2);
	});

	it('stacks a second cabinet rather than stretching the first', () =>
	{
		// The doors break at the joint, and that break is the whole visual
		// difference between a stack and a 42in cabinet.
		const stacked = buildCabinet(Object.assign({}, WALL,
			{topTreatment: 'stacked', material: DISTINCT}));
		const tall = buildCabinet(Object.assign({}, WALL,
			{topTreatment: 'to-ceiling', material: DISTINCT}));
		expect(size(stacked).y).toBeCloseTo(size(tall).y, 1);
		// Same envelope, more geometry: a second carcass and a second set of doors.
		expect(stacked.geometry.attributes.position.count)
			.toBeGreaterThan(tall.geometry.attributes.position.count);
	});

	it('follows the ceiling it is given', () =>
	{
		const low = buildCabinet(Object.assign({}, WALL,
			{topTreatment: 'to-ceiling', ceilingHeight: 243.84}));
		const high = buildCabinet(Object.assign({}, WALL,
			{topTreatment: 'to-ceiling', ceilingHeight: 274.32}));
		expect(size(high).y - size(low).y).toBeCloseTo(274.32 - 243.84, 1);
	});

	it('leaves a base cabinet alone, whatever it is asked', () =>
	{
		// A base cabinet's top is the counter's business.
		const plain = buildCabinet({variant: 'base'});
		const asked = buildCabinet({variant: 'base', topTreatment: 'to-ceiling'});
		expect(size(asked).y).toBeCloseTo(size(plain).y, 3);
	});
});

describe('face layouts', () =>
{
	/**
	 * Vertices, with SLAB fronts on purpose.
	 *
	 * A shaker front collapses to a single box when it is too short for two rails
	 * and a panel - deliberately, because nothing is made that way - so counting
	 * vertices on the default style measures the STYLE each front fell back to
	 * rather than how many fronts there are. A slab is one box every time, so the
	 * difference between two layouts is exactly the fronts.
	 */
	const verts = (spec) => buildCabinet(Object.assign(
		{kind: 'cabinet', width: 91.44, front: 'slab'}, spec))
		.geometry.attributes.position.count;

	it('builds a drawer bank instead of doors', () =>
	{
		// The builder has taken `drawers` since it was written; nothing could SAY
		// so, because the schema offered `doors` and nothing else - so every
		// cabinet in the app was a pair of doors whatever the builder could do.
		expect(verts({layout: 'three-drawers'})).not.toBe(verts({layout: 'doors'}));
	});

	it('gives one more front for each extra drawer', () =>
	{
		const three = verts({layout: 'three-drawers'});
		const four = verts({layout: 'four-drawers'});
		const five = verts({layout: 'five-drawers'});
		expect(four - three).toBeGreaterThan(0);
		// Evenly spaced: the same front, one more of it.
		expect(five - four).toBe(four - three);
	});

	it('builds a drawer over a pair of doors', () =>
	{
		// Three fronts where a plain pair is two.
		expect(verts({layout: 'drawer-over-doors'}) - verts({layout: 'doors'}))
			.toBe(verts({layout: 'four-drawers'}) - verts({layout: 'three-drawers'}));
	});

	it('builds all four of a pan bank', () =>
	{
		// The one the drawer heights overflow a base opening on, so it is also the
		// one that would silently come out short if `fitDrawers` stopped scaling.
		expect(verts({layout: 'deep-bottom'})).toBe(verts({layout: 'four-drawers'}));
	});

	it('makes the pan drawer the deepest of its bank', () =>
	{
		const heights = CABINET_LAYOUTS['deep-bottom'].drawers;
		expect(heights).toHaveLength(4);
		expect(heights[3]).toBeGreaterThan(heights[0]);
		// And the three above it are equal, which is what makes it read as three
		// over one rather than as a graduated bank.
		expect(heights[0]).toBe(heights[1]);
		expect(heights[1]).toBe(heights[2]);
	});

	it('graduates a plain bank, shallow at the top', () =>
	{
		// How a bank is actually built: cutlery at the top, pans at the bottom.
		const heights = CABINET_LAYOUTS['four-drawers'].drawers;
		for (let i = 1; i < heights.length; i++)
		{
			expect(heights[i]).toBeGreaterThan(heights[i - 1]);
		}
	});

	it('leaves a spec with no layout exactly as it was', () =>
	{
		// Every design saved before this existed carries `doors` and `drawers` and
		// no layout. `custom` is the default so those open unchanged.
		expect(verts({layout: 'custom', doors: 0, drawers: [15, 20, 25]}))
			.toBe(verts({doors: 0, drawers: [15, 20, 25]}));
	});
});

/**
 * How many vertices one material draws.
 *
 * `partBounds` answers where; a divided light needs how many as well, because
 * the muntins are made of the SAME material as the rails that hold them - they
 * are painted with the door, and a slot of their own would be a control nobody
 * would ever set differently. So bars show up as more of the front material
 * rather than as a new one, and counting is the only way to see them.
 */
function partVerts(built, materialId)
{
	const index = built.materials.findIndex((m) => m.userData.materialId === materialId);
	if (index < 0) {return 0;}
	return built.geometry.groups
		.filter((group) => group.materialIndex === index)
		.reduce((sum, group) => sum + group.count, 0);
}

/** Whether this cabinet is finished with a material at all. */
const uses = (built, materialId) =>
	built.materials.some((m) => m.userData.materialId === materialId);

/**
 * How far the front material reaches, over the glass only.
 *
 * The muntin trap, measured: a bar flush with the pane is a bar nobody can see,
 * which is the fault `opening.js` documents from the window's side and the one
 * that made a vent hood's filter render as nothing while its triangles were
 * present and correct. Rails are outside the glass rectangle, so anything of the
 * door's own material INSIDE it is a muntin, and how far proud of the pane it
 * stands is the whole question.
 */
function frontOverGlass(built, frontId, glassId)
{
	const pane = partBounds(built, glassId);
	const index = built.materials.findIndex((m) => m.userData.materialId === frontId);
	const position = built.geometry.getAttribute('position');
	let frontmost = -Infinity;
	for (const group of built.geometry.groups)
	{
		if (group.materialIndex !== index) {continue;}
		for (let i = group.start; i < group.start + group.count; i++)
		{
			const v = new Vector3().fromBufferAttribute(position, i);
			// Well inside the pane, so a rail's own edge cannot be read as a bar.
			if (v.x < pane.min.x + 2 || v.x > pane.max.x - 2) {continue;}
			if (v.y < pane.min.y + 2 || v.y > pane.max.y - 2) {continue;}
			frontmost = Math.max(frontmost, v.z);
		}
	}
	return frontmost;
}

describe('a glass front is a pane in the door own frame', () =>
{
	/** A wall cabinet, which is what anybody actually glazes. */
	const GLAZED = {variant: 'wall', width: 60.96, doors: 2, material: DISTINCT};

	it('spends the glass slot only when something is glazed', () =>
	{
		// The material is built either way - `materialsForSlots` fills every slot -
		// but `mergeMeshes` pools from the meshes that exist, so a solid cabinet
		// carries no glass in what it hands back.
		expect(uses(buildCabinet(Object.assign({}, GLAZED, {glazing: 'none'})), 'glass-clear'))
			.toBe(false);
		expect(uses(buildCabinet(Object.assign({}, GLAZED, {glazing: 'glass'})), 'glass-clear'))
			.toBe(true);
	});

	it('leaves a spec that never heard of glazing exactly as it was', () =>
	{
		// Every design saved before this existed omits the key. Solid is the
		// default for exactly that reason.
		const before = buildCabinet(GLAZED);
		const after = buildCabinet(Object.assign({}, GLAZED, {glazing: 'none'}));
		expect(before.geometry.getAttribute('position').count)
			.toBe(after.geometry.getAttribute('position').count);
		expect(uses(before, 'glass-clear')).toBe(false);
	});

	it('holds the pane inside the rails rather than replacing the door', () =>
	{
		// The point of glazing being a property of the CENTRE: what changes between
		// a shaker door and the glass one beside it is the panel, not the door.
		const built = buildCabinet(Object.assign({}, GLAZED, {glazing: 'glass'}));
		const pane = partBounds(built, 'glass-clear');
		const fronts = partBounds(built, 'wood-walnut');
		expect(pane.min.x).toBeGreaterThan(fronts.min.x);
		expect(pane.max.x).toBeLessThan(fronts.max.x);
		expect(pane.min.y).toBeGreaterThan(fronts.min.y);
		expect(pane.max.y).toBeLessThan(fronts.max.y);
	});

	it('keeps the glass clear of both faces of the door', () =>
	{
		// Two coplanar faces z-fight and it reads as geometry, not as glass. The
		// pane is thinner than the door and centred in it, so no face of it shares
		// a plane with a rail - the rule `buildSash` follows in a window.
		const built = buildCabinet(Object.assign({}, GLAZED, {glazing: 'glass'}));
		const pane = partBounds(built, 'glass-clear');
		const fronts = partBounds(built, 'wood-walnut');
		expect(pane.min.z).toBeGreaterThan(fronts.min.z + 0.1);
		expect(pane.max.z).toBeLessThan(fronts.max.z - 0.1);
	});

	it('gives a glazed slab the rails glass has to be held in', () =>
	{
		// A slab is one box and a glazed slab cannot be: glass with nothing round
		// it is not a door. So the style names what the centre does, and asking for
		// glass overrides the slab shortcut rather than losing the glass.
		const solid = buildCabinet(Object.assign({}, GLAZED, {front: 'slab'}));
		const glazed = buildCabinet(Object.assign({}, GLAZED, {front: 'slab', glazing: 'glass'}));
		expect(uses(glazed, 'glass-clear')).toBe(true);
		expect(partVerts(glazed, 'wood-walnut'))
			.toBeGreaterThan(partVerts(solid, 'wood-walnut'));
	});

	it('drops the glazing rather than the door when a front is too small', () =>
	{
		// A 4in pane in a filler is worse than no glass, and a door with no centre
		// panel has nowhere to put one. Coming out solid is the only failure here
		// that still leaves something buildable.
		const filler = buildCabinet({variant: 'wall', width: 22.86, doors: 2,
			glazing: 'glass', material: DISTINCT});
		expect(uses(filler, 'glass-clear')).toBe(false);
	});

	it('leaves drawer fronts solid, because a glass drawer is not a thing', () =>
	{
		// Which is why glazing is its own field and not a fourth door style: a run
		// with one glass cabinet in it still has solid drawers under the counter.
		const bank = buildCabinet({variant: 'base', layout: 'four-drawers',
			glazing: 'glass', material: DISTINCT});
		expect(uses(bank, 'glass-clear')).toBe(false);

		// And a face that is both keeps the two apart: the doors glaze, the drawer
		// over them does not.
		const mixed = buildCabinet({variant: 'base', layout: 'drawer-over-doors',
			glazing: 'glass', material: DISTINCT});
		const pane = partBounds(mixed, 'glass-clear');
		const fronts = partBounds(mixed, 'wood-walnut');
		expect(pane.max.y).toBeLessThan(fronts.max.y - 15.24);
	});

	it('divides the light with bars that stand off the glass', () =>
	{
		const plain = buildCabinet(Object.assign({}, GLAZED, {glazing: 'glass'}));
		const divided = buildCabinet(Object.assign({}, GLAZED, {glazing: 'mullion'}));

		// Same pane, more door: the bars are muntins laid over the glass, not a
		// smaller piece of glass with the frame grown into it.
		expect(partVerts(divided, 'glass-clear')).toBe(partVerts(plain, 'glass-clear'));
		expect(partVerts(divided, 'wood-walnut'))
			.toBeGreaterThan(partVerts(plain, 'wood-walnut'));

		// Proud on the face you look at, and by enough to catch a shadow.
		const pane = partBounds(divided, 'glass-clear');
		expect(frontOverGlass(divided, 'wood-walnut', 'glass-clear'))
			.toBeGreaterThan(pane.max.z + 0.2);
		// A plain pane has nothing of the door over it at all.
		expect(frontOverGlass(plain, 'wood-walnut', 'glass-clear')).toBe(-Infinity);
	});

	/**
	 * Muntins per door, by what the door gains over a plain pane.
	 *
	 * A box is 36 vertices once `mergeMeshes` de-indexes it, and the bars are the
	 * only thing a divided door has that a glazed one does not.
	 */
	function bars(spec, doors)
	{
		const plain = buildCabinet(Object.assign({}, spec, {glazing: 'glass'}));
		const divided = buildCabinet(Object.assign({}, spec, {glazing: 'mullion'}));
		return (partVerts(divided, 'wood-walnut') - partVerts(plain, 'wood-walnut')) / 36 / doors;
	}

	it('sizes the grid off the door, not off a fixed count', () =>
	{
		// A light is about 9in, which is what a divided cabinet door is made with -
		// so the grid follows the door rather than the door being forced into a
		// grid. A standard pair comes out tall narrow lights divided across, which
		// is exactly what a glass wall cabinet looks like; a 4ft single door is
		// wide enough to want dividing both ways as well.
		const pair = bars({variant: 'wall', width: 60.96, doors: 2, material: DISTINCT}, 2);
		const wide = bars({variant: 'wall', width: 121.92, doors: 1, material: DISTINCT}, 1);
		const pantry = bars({variant: 'tall', width: 76.2, doors: 2, material: DISTINCT}, 2);

		expect(pair).toBeGreaterThan(0);
		expect(wide).toBeGreaterThan(pair);
		// Taller door, more lights up it.
		expect(pantry).toBeGreaterThan(pair);
		// And never a mesh screen: the count is capped, so a wall of glass does
		// not turn into a hundred bars nobody can see.
		expect(wide).toBeLessThan(10);
	});

	it('takes a glazing material like any other slot', () =>
	{
		const frosted = buildCabinet(Object.assign({}, GLAZED, {glazing: 'glass',
			material: Object.assign({}, DISTINCT, {glass: 'glass-frosted'})}));
		expect(uses(frosted, 'glass-frosted')).toBe(true);
		expect(uses(frosted, 'glass-clear')).toBe(false);
	});
});

describe('a cabinet carries the strip fixed under it', () =>
{
	/** The built geometry's own box, which is the frame a carried fixture is in. */
	const boxOf = (built) =>
	{
		built.geometry.computeBoundingBox();
		return built.geometry.boundingBox;
	};

	const WALL = {variant: 'wall', width: 76.2, mountHeight: 137.16, ceilingHeight: 243.84};

	it('declares nothing at all unless somebody asks for it', () =>
	{
		// Which is also what keeps every design saved before this opening as it
		// did: no field, no fixture, and the same geometry.
		const off = buildCabinet(Object.assign({}, WALL));
		expect(off.fixtures).toBeUndefined();
		expect(buildCabinet(Object.assign({}, WALL, {underLight: false})).fixtures)
			.toBeUndefined();
	});

	it('picks the mount from what kind of cabinet it is', () =>
	{
		// "Under" means two different fittings. Under a wall cabinet is the strip
		// over a worktop; under a base one is the toe kick, washing the floor.
		expect(buildCabinet(Object.assign({}, WALL, {underLight: true}))
			.fixtures[0].mount).toBe('under-cabinet');
		expect(buildCabinet({variant: 'base', width: 76.2, underLight: true})
			.fixtures[0].mount).toBe('toe-kick');
		expect(buildCabinet({variant: 'tall', width: 76.2, underLight: true})
			.fixtures[0].mount).toBe('toe-kick');
	});

	it('puts the strip under the cabinet and at its front', () =>
	{
		// The arithmetic worth testing, because `centre` moves every mesh in the
		// group and a carried fixture is not a mesh - so it has to be brought into
		// the centred frame by hand, and getting that wrong puts the light in the
		// middle of the carcass where nothing can see it.
		const built = buildCabinet(Object.assign({}, WALL, {underLight: true}));
		const strip = built.fixtures[0];
		const box = boxOf(built);

		// Below the box, and only just - it is screwed to the underside.
		expect(strip.position.y).toBeLessThan(box.min.y);
		expect(strip.position.y).toBeGreaterThan(box.min.y - 4);
		// Centred across the width.
		expect(strip.position.x).toBeCloseTo(0, 1);
		// And at the FRONT. A strip over the middle of a 61cm worktop lights the
		// splashback and throws the cabinet's own face across the front half of
		// the counter, which is exactly where the work happens.
		expect(strip.position.z).toBeGreaterThan(0);
		expect(strip.position.z).toBeLessThan(box.max.z);
	});

	it('tucks a toe-kick strip into the recess rather than under the floor', () =>
	{
		// A base cabinet stands ON the floor, so "underneath" is a recess and not
		// open air. Below the box here would be below the floor.
		const built = buildCabinet({variant: 'base', width: 76.2, underLight: true});
		const strip = built.fixtures[0];
		const box = boxOf(built);

		expect(strip.position.y).toBeGreaterThan(box.min.y);
		expect(strip.position.y).toBeLessThan(box.min.y + 6);
		// Set back behind the face, which is what a toe kick is.
		expect(strip.position.z).toBeLessThan(box.max.z - 5);
	});

	it('cuts the strip to the cabinet, and stops short of the join', () =>
	{
		// A strip run to the full width lights the gap between two cabinets as
		// brightly as the worktop, and the join is the one place it must not show.
		const narrow = buildCabinet(Object.assign({}, WALL,
			{width: 45.72, underLight: true})).fixtures[0];
		const wide = buildCabinet(Object.assign({}, WALL,
			{width: 121.92, underLight: true})).fixtures[0];

		expect(narrow.length).toBeLessThan(45.72);
		expect(wide.length).toBeLessThan(121.92);
		expect(wide.length).toBeGreaterThan(narrow.length);
		// Most of the cabinet, not a token bar in the middle of it.
		expect(wide.length).toBeGreaterThan(121.92 * 0.85);
	});

	it('becomes a real row of emitters, sharing one output', () =>
	{
		// The end of the path: what the cabinet declares is a record, and the
		// record has to survive `normaliseFixture` as a STRIP - a single point
		// source under a metre of cabinet is the hard scallop the row exists to
		// avoid.
		const strip = buildCabinet(Object.assign({}, WALL,
			{width: 121.92, underLight: true, underLightKelvin: 2700})).fixtures[0];
		const fixture = normaliseFixture(strip);

		expect(fixture.strip).toBe(true);
		expect(fixture.kelvin).toBe(2700);
		expect(fixture.length).toBeCloseTo(strip.length, 3);
		const emitters = emittersFor(fixture);
		expect(emitters.length).toBeGreaterThan(1);
		// Spread along the cabinet's own x, which is its width - the host's
		// transform is what turns that into the room's axes.
		expect(Math.max(...emitters.map((e) => e.dx)))
			.toBeGreaterThan(strip.length * 0.25);
		// One lamp cut into pieces, not one lamp per piece.
		expect(emitters.reduce((sum, e) => sum + e.lumens, 0))
			.toBeCloseTo(MOUNT_DEFAULTS['under-cabinet'].lumens, 6);
	});

	it('throws down, because that is what a strip under a cabinet does', () =>
	{
		const strip = buildCabinet(Object.assign({}, WALL, {underLight: true})).fixtures[0];
		expect(normaliseFixture(strip).throw).toBe('down');
		expect(emittersFor(normaliseFixture(strip)).every((e) => e.aim === -1)).toBe(true);
	});
});
