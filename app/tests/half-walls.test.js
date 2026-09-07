/**
 * Half walls.
 *
 * A pony wall is the one thing on this plan the tracer cannot decide for itself
 * -- the drawing draws it as a single thin stroke below the thickness a wall can
 * be -- so it is a decision made in the editor. Everything below is what that
 * decision needs to be reliable.
 *
 * The cost of not having it, from AGENTS.md: the kitchen and great room read as
 * one 385 sqft space, because the wall between them is not there.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {Vector3} from 'three';
import {Floorplan} from '../src/scripts/model/floorplan.js';
import {buildPost} from '../src/scripts/items/generated/post.js';
import {EVENT_CORNER_ATTRIBUTES_CHANGED} from '../src/scripts/core/events.js';
import {resetAll} from './helpers/harness.js';

const FULL = 250;
const PONY = 107;

/** A square room, plus a spur wall running off one corner into open floor. */
function roomWithSpur()
{
	const floorplan = new Floorplan();
	const corners = [
		floorplan.newCorner(0, 0),
		floorplan.newCorner(400, 0),
		floorplan.newCorner(400, 300),
		floorplan.newCorner(0, 300),
	];
	for (let i = 0; i < corners.length; i++)
	{
		floorplan.newWall(corners[i], corners[(i + 1) % corners.length]);
	}
	// Into the room from the middle of the bottom wall's right corner.
	const tip = floorplan.newCorner(400, 150);
	const spur = floorplan.newWall(corners[1], tip);
	floorplan.update();
	return {floorplan, corners, spur, tip};
}

describe('a corner announces every elevation change', () =>
{
	beforeEach(() => resetAll());

	it('fires when raised, which it did not before', () =>
	{
		// The condition read `value - this._elevation < 1e-6`: a one-way test
		// wearing a two-way tolerance, true when the corner moved DOWN and false
		// when it moved UP. The floorplan turns this event into update() and so
		// into the ChangeSet the 3D view rebuilds from - so a wall could be
		// dropped to half height and never brought back. Nothing redrew, and
		// nothing said why.
		const {corners} = roomWithSpur();
		const corner = corners[0];
		corner.elevation = PONY;

		let fired = 0;
		corner.addEventListener(EVENT_CORNER_ATTRIBUTES_CHANGED, () => {fired++;});
		corner.elevation = FULL;
		expect(fired).toBe(1);
	});

	it('fires when lowered', () =>
	{
		const {corners} = roomWithSpur();
		let fired = 0;
		corners[0].addEventListener(EVENT_CORNER_ATTRIBUTES_CHANGED, () => {fired++;});
		corners[0].elevation = PONY;
		expect(fired).toBe(1);
	});
});

describe('a wall takes its height from its corners', () =>
{
	beforeEach(() => resetAll());

	it('reports the height it is actually drawn at', () =>
	{
		// `wall.height` used to be its own field, set once from the configured
		// default and never serialized, while the 3D view drew the wall to its
		// corners' elevations - which are. Two heights, one of them a phantom that
		// drove texture repeat and where a new wall item was first placed.
		const {corners} = roomWithSpur();
		const wall = corners[0].wallStarts[0];
		expect(wall.height).toBe(FULL);

		wall.getStart().elevation = PONY;
		wall.getEnd().elevation = PONY;
		expect(wall.height).toBe(PONY);
	});

	it('reads the taller end of a sloped wall', () =>
	{
		const {corners} = roomWithSpur();
		const wall = corners[0].wallStarts[0];
		wall.getStart().elevation = PONY;
		expect(wall.height).toBe(FULL);
	});
});

describe('setHeight splits a corner only where it has to', () =>
{
	beforeEach(() => resetAll());

	it('sets both ends when nothing else is attached', () =>
	{
		const {floorplan, spur} = roomWithSpur();
		const before = floorplan.getCorners().length;
		// The spur's far end carries nothing, but its near end meets the room.
		spur.setHeight(PONY);
		expect(spur.height).toBe(PONY);
		// One new corner: the junction with the room. The free end was just set.
		expect(floorplan.getCorners().length).toBe(before + 1);
	});

	it('leaves the wall it runs into standing', () =>
	{
		// The whole point. A wall takes its height from its corners and a corner is
		// shared with everything meeting there, so setting the corners directly
		// pulls the neighbours down too - making the pony wall by the sink 42in
		// dragged the end of the full-height wall it runs into with it.
		const {corners, spur} = roomWithSpur();
		const roomWalls = corners[1].wallStarts.concat(corners[1].wallEnds)
			.filter((wall) => wall !== spur);
		expect(roomWalls.length).toBeGreaterThan(0);

		spur.setHeight(PONY);

		expect(spur.height).toBe(PONY);
		for (const wall of roomWalls)
		{
			expect(wall.height, 'a wall that was not asked to move').toBe(FULL);
		}
	});

	it('does not split when the neighbours are coming along', () =>
	{
		// A run of walls lowered together stays one connected run. Splitting every
		// junction would leave a pony wall in three disconnected pieces.
		const {floorplan, corners} = roomWithSpur();
		// The bottom wall and the left wall, which meet at corner 0 and meet
		// nothing else there. Their FAR ends each run into a wall staying tall, so
		// those do have to split - which is the point: only the junctions that
		// need a corner get one.
		const bottom = corners[0].wallStarts[0];
		const left = corners[0].wallEnds[0];
		expect(bottom).toBeTruthy();
		expect(left).toBeTruthy();

		const before = floorplan.getCorners().length;
		bottom.setHeight(PONY, [left]);
		left.setHeight(PONY, [bottom]);

		expect(bottom.height).toBe(PONY);
		expect(left.height).toBe(PONY);
		// The corner they share was set, not split - they still meet there.
		expect(bottom.getStart()).toBe(left.getEnd());
		expect(bottom.getStart().elevation).toBe(PONY);
		// One new corner at each far end, and none at the junction between them.
		expect(floorplan.getCorners().length).toBe(before + 2);
	});

	it('is reversible', () =>
	{
		// It has to be: raising an elevation was the half of this that silently
		// did nothing.
		const {corners, spur} = roomWithSpur();
		spur.setHeight(PONY);
		expect(spur.height).toBe(PONY);
		spur.setHeight(FULL);
		expect(spur.height).toBe(FULL);
		for (const wall of corners[1].wallStarts.concat(corners[1].wallEnds))
		{
			expect(wall.height).toBe(FULL);
		}
	});
});

describe('two corners at one point at different heights stay two corners', () =>
{
	beforeEach(() => resetAll());

	it('does not fuse a new corner onto one at another height', () =>
	{
		// architect3d takes a wall's height from its two corners, so one corner
		// cannot be both 42in and 96in. tools/extract.py has keyed corners by
		// (x, y, height) since it first wrote a pony wall out; this is that rule
		// inside the editor, so a half wall survives being drawn as well as loaded.
		const {floorplan} = roomWithSpur();
		const existing = floorplan.getCorners()[0];
		const same = floorplan.newCorner(existing.x, existing.y, undefined, PONY);
		expect(same).not.toBe(existing);
		expect(same.elevation).toBe(PONY);
		expect(existing.elevation).toBe(FULL);
	});

	it('still fuses one at the same height, as it always did', () =>
	{
		const {floorplan} = roomWithSpur();
		const existing = floorplan.getCorners()[0];
		expect(floorplan.newCorner(existing.x, existing.y)).toBe(existing);
		expect(floorplan.newCorner(existing.x + 2, existing.y + 2)).toBe(existing);
	});
});

describe('a post is an item, not a very short wall', () =>
{
	beforeEach(() => resetAll());

	it('is not a wall for reasons that outlive the bug that prompted it', () =>
	{
		// The measurement that prompted this was that a wall could not be made
		// short enough: `cornerTolerance` is 20cm and two corners closer than that
		// fused, so asking for 6in destroyed the wall. That is fixed now - see
		// "a wall is never welded to itself" below - and a 4in wall is possible.
		//
		// A post is still not a wall, and the surviving reasons are the better
		// ones. Rooms are found by walking closed loops of walls, so a column in
		// open floor is a run that goes nowhere and has to be argued back out -
		// part of what extract.py's drop_islands exists for. A post also has no
		// inside and outside, no items in it, and no need of two half edges. And
		// with snap-to-grid on you still cannot DRAG one shorter than the grid.
		const floorplan = new Floorplan();
		const wall = floorplan.newWall(floorplan.newCorner(0, 0), floorplan.newCorner(200, 0));
		floorplan.update();
		wall.wallSize = 10.16;

		// A 4in wall now survives...
		expect(wall.wallLength()).toBeCloseTo(10.16, 1);
		// ...and is still two corners and two half edges pretending to be a stick.
		expect(floorplan.getCorners().length).toBe(2);
		expect(buildPost({width: 10.16}).parts).toEqual([]);
	});

	it('builds at 4in, which is the whole point', () =>
	{
		const built = buildPost({width: 10.16, depth: 10.16, height: 106.68});
		built.geometry.computeBoundingBox();
		const size = built.geometry.boundingBox.getSize(new Vector3());
		expect(size.x).toBeCloseTo(10.16, 3);
		expect(size.z).toBeCloseTo(10.16, 3);
		expect(size.y).toBeCloseTo(106.68, 3);
	});

	it('centres itself, so FloorItem stands it on the floor', () =>
	{
		const built = buildPost({height: 100});
		built.geometry.computeBoundingBox();
		const centre = built.geometry.boundingBox.getCenter(new Vector3());
		expect(centre.x).toBeCloseTo(0, 4);
		expect(centre.y).toBeCloseTo(0, 4);
		expect(centre.z).toBeCloseTo(0, 4);
	});

	it('has no children, unlike a door', () =>
	{
		// Nothing moves and nothing should escape its bounds - the exact opposite
		// of a door, and worth pinning so the distinction stays deliberate.
		expect(buildPost({}).parts).toEqual([]);
	});

	it('takes its diameter from width when round', () =>
	{
		const built = buildPost({profile: 'round', width: 20, depth: 5, height: 100});
		built.geometry.computeBoundingBox();
		const size = built.geometry.boundingBox.getSize(new Vector3());
		expect(size.x).toBeCloseTo(20, 1);
		// depth is ignored for a round post, which is why the schema hides it.
		expect(size.z).toBeCloseTo(20, 1);
	});

	it('keeps its height when trim is added', () =>
	{
		// A post with its trim removed should be the same post, not a shorter one.
		const plain = buildPost({height: 100, trim: 'none'});
		const banded = buildPost({height: 100, trim: 'both'});
		plain.geometry.computeBoundingBox();
		banded.geometry.computeBoundingBox();
		expect(banded.geometry.boundingBox.getSize(new Vector3()).y)
			.toBeCloseTo(plain.geometry.boundingBox.getSize(new Vector3()).y, 3);
		// But it is wider, because the bands stand proud.
		expect(banded.geometry.boundingBox.getSize(new Vector3()).x)
			.toBeGreaterThan(plain.geometry.boundingBox.getSize(new Vector3()).x);
	});
});

describe('a wall is never welded to itself', () =>
{
	beforeEach(() => resetAll());

	it('survives being made shorter than the corner tolerance', () =>
	{
		// It used to cease to exist. `cornerTolerance` is 20cm and
		// `mergeWithIntersected` fused any two corners closer than that - including
		// a wall's own two ends, which does not shorten the wall, it deletes it.
		// Silently: asked for 6in you got no wall, no error and no message.
		for (const askedCm of [15.24, 10.16, 5.08])
		{
			const floorplan = new Floorplan();
			const wall = floorplan.newWall(floorplan.newCorner(0, 0), floorplan.newCorner(200, 0));
			floorplan.update();
			wall.wallSize = askedCm;
			expect(floorplan.getCorners().length, `${askedCm}cm keeps its corners`).toBe(2);
			expect(wall.wallLength(), `${askedCm}cm comes out that long`).toBeCloseTo(askedCm, 1);
		}
	});

	it('still fuses two different walls that meet', () =>
	{
		// The case the merge exists for, and the one that must not change: drawing
		// a corner onto another wall's corner joins them.
		const floorplan = new Floorplan();
		const a = floorplan.newCorner(0, 0);
		const b = floorplan.newCorner(200, 0);
		floorplan.newWall(a, b);
		const c = floorplan.newCorner(200, 300);
		const second = floorplan.newWall(c, floorplan.newCorner(400, 300));
		floorplan.update();
		const before = floorplan.getCorners().length;

		// Drag the second wall's free start onto the first wall's end.
		second.getStart().move(b.x + 2, b.y + 2);
		expect(floorplan.getCorners().length).toBeLessThan(before);
	});
});
