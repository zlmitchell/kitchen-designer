/**
 * A wall whose two corners are the same point is not a wall.
 *
 * It has no length, so it has no direction, so it has no faces - and yet it is
 * a wall in the file, with a thickness and a height like any other.
 * `tools/fitout.py` has dropped these on sight since it was written; nothing in
 * the app did, which is how one reached the kitchen plan and stayed there.
 *
 * ## The route in, which is not the obvious one
 *
 * `Floorplanner` already guards the gesture everybody blames: clicking the
 * corner you are drawing FROM. That guard is `existing === this.lastNode`, an
 * IDENTITY test, so it catches one corner used twice and nothing else.
 *
 * Two DIFFERENT corners standing on the same point walk straight past it, and
 * at a pony wall that is the ordinary case rather than a freak one.
 * `newCorner` welds by position AND elevation, deliberately - a corner cannot
 * be both 42in and 96in, and that rule is what makes a pony wall possible - so
 * clicking where a corner already exists at another height mints a second
 * corner on top of it rather than returning the one that is there.
 *
 * ## Why a stub that draws nothing did visible damage
 *
 * Measured on the kitchen plan: three corners on one point (250, 243.84 and the
 * pony wall's 106.68) with a zero-length wall between the first two. The stub
 * itself draws nothing. What did the damage is that it had been born at the
 * CONFIGURED DEFAULT of 250 - `newCorner` with no elevation takes it - and the
 * 82cm wall running into that corner then stood 250 tall, because a wall is as
 * tall as its taller corner. Its top ramped 243.84 -> 250 through a ceiling at
 * 243.84: z-fighting where it grazed, daylight where it climbed clear.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {Floorplan} from '../src/scripts/model/floorplan.js';
import {resetAll} from './helpers/harness.js';

/** Two corners on one point at two heights, and a wall joining them. */
function stubDesign()
{
	return {
		corners: {
			// The pair that coincide. Different elevations, so they do not weld.
			tall: {x: 832.866, y: 361.4953, elevation: 250},
			short: {x: 832.866, y: 361.4953, elevation: 243.84},
			west: {x: 750.7, y: 361.4953, elevation: 243.84},
		},
		walls: [
			{corner1: 'west', corner2: 'tall'},
			// The stub.
			{corner1: 'tall', corner2: 'short'},
		],
		rooms: {}, units: 'cm', version: '2.0.0',
	};
}

let plan;

beforeEach(() => {resetAll(); plan = new Floorplan();});
afterEach(() => {plan = null; vi.restoreAllMocks();});

describe('drawing one', () =>
{
	it('refuses a wall between two corners on the same point', () =>
	{
		const a = plan.newCorner(400, 400, undefined, 250);
		const b = plan.newCorner(400, 400, undefined, 243.84);

		// Two corners, because the elevations differ - which is the rule that
		// makes a pony wall meeting a full wall possible, and is not negotiable.
		expect(b).not.toBe(a);

		expect(plan.newWall(a, b)).toBeNull();
		expect(plan.getWalls()).toHaveLength(0);
	});

	it('refuses a corner joined to itself, which is the other way in', () =>
	{
		const a = plan.newCorner(400, 400, undefined, 250);
		expect(plan.newWall(a, a)).toBeNull();
		expect(plan.getWalls()).toHaveLength(0);
	});

	it('refuses a near miss too, not only an exact coincidence', () =>
	{
		// Float noise is not what this guards - two corners at one CLICK are - so
		// the bound is a centimetre rather than an epsilon.
		const a = plan.newCorner(400, 400, undefined, 250);
		const b = plan.newCorner(400.4, 400, undefined, 243.84);
		expect(plan.newWall(a, b)).toBeNull();
	});

	it('still builds every wall that has a length', () =>
	{
		const a = plan.newCorner(0, 0, undefined, 250);
		const b = plan.newCorner(400, 0, undefined, 250);
		const wall = plan.newWall(a, b);

		expect(wall).not.toBeNull();
		expect(plan.getWalls()).toHaveLength(1);
		expect(wall.wallSize).toBeCloseTo(400, 4);
	});

	it('builds a short wall that is genuinely a wall', () =>
	{
		// 5cm is absurd for a house and is still a wall. The guard must not creep
		// up towards `cornerTolerance`, which is 20cm and welds CORNERS.
		const a = plan.newCorner(0, 0, undefined, 250);
		const b = plan.newCorner(5, 0, undefined, 243.84);
		expect(plan.newWall(a, b)).not.toBeNull();
	});
});

describe('opening a design that already has one', () =>
{
	it('drops the stub and keeps the rest', () =>
	{
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		plan.loadFloorplan(stubDesign());

		expect(plan.getWalls()).toHaveLength(1);
		const [wall] = plan.getWalls();
		expect(wall.wallSize).toBeCloseTo(82.166, 2);
		expect(warn).toHaveBeenCalled();
	});

	it('says so, rather than losing a wall in silence', () =>
	{
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		plan.loadFloorplan(stubDesign());

		expect(warn.mock.calls.some(([message]) => /zero-length wall/.test(message))).toBe(true);
	});

	it('leaves a design with no stub in it completely alone', () =>
	{
		const clean = stubDesign();
		clean.walls = [{corner1: 'west', corner2: 'tall'}];
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		plan.loadFloorplan(clean);

		expect(plan.getWalls()).toHaveLength(1);
		expect(warn.mock.calls.some(([message]) => /zero-length/.test(message))).toBe(false);
	});
});
