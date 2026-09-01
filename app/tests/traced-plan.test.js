/**
 * The plan `tools/extract.py` traces out of the architect's PDF, checked
 * against the loader that has to open it.
 *
 * This is not a unit test of the extractor -- the extractor is Python and
 * lives outside this package. It is the seam between the two: a design that
 * `DesignDocument.parse` rejects is a broken boot, and the extractor is the
 * only thing in the project that writes a design by hand rather than by
 * round-tripping one the library wrote. Re-implementing the schema in Python
 * to check it there would test the re-implementation, not the loader.
 *
 * The traced plan is gitignored -- it identifies the house -- and compose
 * mounts it at /plan. So it is absent on a clean checkout and on CI,
 * and these skip rather than fail. That is the point of the assertions in
 * `it.runIf`: they only run for somebody who has actually run the extractor,
 * which is exactly who can act on a failure.
 */
import {describe, expect, it} from 'vitest';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {DesignDocument} from '../src/scripts/model/document.js';

// Where compose mounts data/. Same default the vite middleware and nginx use.
const PLAN = join(process.env.PLAN_DIR || '/plan', 'design.json');
const traced = existsSync(PLAN);

/** Inches, measured off the elevations. See plans/NOTES.md. */
const CEILING_CM = 96 * 2.54;

describe('the traced plan', () =>
{
	it.runIf(traced)('loads without errors or warnings', () =>
	{
		const result = DesignDocument.parse(readFileSync(PLAN, 'utf8'));

		// The message is worth more than the boolean when this fails: an
		// extractor bug shows up as one bad field, and the path names it.
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
		// A warning here means the units declaration is one this build does not
		// know, which would silently rescale the whole house.
		expect(result.warnings).toEqual([]);
	});

	it.runIf(traced)('is a connected plan at the measured ceiling height', () =>
	{
		const {floorplan} = JSON.parse(readFileSync(PLAN, 'utf8'));

		expect(floorplan.units).toBe('cm');
		expect(Object.keys(floorplan.corners).length).toBeGreaterThan(3);
		expect(floorplan.walls.length).toBeGreaterThan(3);

		// Every wall names a corner that exists. The loader checks this too, but
		// it reports the first failure and stops being useful; a dangling
		// reference is the extractor's most likely regression and the count of
		// them is what says how bad it is.
		const dangling = floorplan.walls.filter(
			(wall) => !floorplan.corners[wall.corner1] || !floorplan.corners[wall.corner2]);
		expect(dangling).toEqual([]);

		// No corner is welded onto another: the extractor's weld radius is 3in,
		// so anything closer than that is two corners it should have merged.
		const points = Object.values(floorplan.corners);
		const tooClose = points.flatMap((a, i) => points.slice(i + 1)
			.filter((b) => Math.hypot(a.x - b.x, a.y - b.y) < 3 * 2.54));
		expect(tooClose).toEqual([]);

		for (const corner of points)
		{
			expect(corner.elevation).toBeCloseTo(CEILING_CM, 2);
		}
	});

	it.runIf(traced)('carries a carbon sheet aligned to the same origin', () =>
	{
		const {carbonSheet, corners} = JSON.parse(readFileSync(PLAN, 'utf8')).floorplan;

		// Without this the drawing underneath is decorative rather than a
		// straightedge, and mistraced walls stop being obvious - which is the
		// whole reason the extractor emits it.
		expect(carbonSheet.url).toMatch(/underlay\.png$/);
		expect(carbonSheet.width).toBeGreaterThan(0);
		expect(carbonSheet.height).toBeGreaterThan(0);

		// The sheet has to cover the walls traced off it.
		const xs = Object.values(corners).map((c) => c.x);
		const ys = Object.values(corners).map((c) => c.y);
		expect(carbonSheet.width).toBeGreaterThanOrEqual(Math.max(...xs));
		expect(carbonSheet.height).toBeGreaterThanOrEqual(Math.max(...ys));
	});
});
