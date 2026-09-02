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

	it.runIf(traced)('carries an underlay in units that mean one thing', () =>
	{
		const {underlay, carbonSheet, corners} = JSON.parse(readFileSync(PLAN, 'utf8')).floorplan;

		// Without an aligned underlay the drawing beneath the plan is decorative
		// rather than a straightedge, and a mistraced wall stops being obvious -
		// which is the whole reason the extractor emits one.
		expect(underlay.url).toMatch(/underlay\.png$/);
		expect(underlay.widthCm).toBeGreaterThan(0);
		expect(underlay.heightCm).toBeGreaterThan(0);

		// The suffixes are the point. carbonsheet.js reads width/height in the
		// display unit and anchorX/Y in raw image pixels, and a plain `width`
		// silently became metres - a sheet 100x too big, drawn off screen, which
		// looked exactly like an image that had failed to load.
		expect(Object.keys(underlay).sort())
			.toEqual(['anchorXPx', 'anchorYPx', 'heightCm', 'transparency', 'url', 'widthCm']);

		// And the block loadFloorplan reads is left inert on purpose, so it
		// cannot apply those numbers in the wrong unit before we apply them in
		// the right one.
		expect(carbonSheet.url).toBe('');

		// The sheet has to cover the walls traced off it.
		const xs = Object.values(corners).map((c) => c.x);
		const ys = Object.values(corners).map((c) => c.y);
		expect(underlay.widthCm).toBeGreaterThanOrEqual(Math.max(...xs));
		expect(underlay.heightCm).toBeGreaterThanOrEqual(Math.max(...ys));
	});

	it.runIf(traced)('places its openings on real walls, at believable sizes', () =>
	{
		const {items, floorplan} = JSON.parse(readFileSync(PLAN, 'utf8'));
		const {corners, walls} = floorplan;

		expect(items.length).toBeGreaterThan(0);

		for (const item of items)
		{
			expect(item.model_url).toMatch(/\.glb$/);
			// Scaled from the drawing's rough opening to the model's own size. The
			// window model is 4ft wide, so a run of patio glazing legitimately
			// lands near 2x; an order of magnitude either way would mean one of
			// the two was measured wrong.
			expect(item.scale_x).toBeGreaterThan(0.15);
			expect(item.scale_x).toBeLessThan(3.0);
		}

		// Every opening has to sit on a wall. A window floating in the middle of
		// a room means the glazing test matched a cabinet run, which is the
		// failure mode this detection has.
		const CM = 2.54;
		for (const item of items)
		{
			const onAWall = walls.some((wall) =>
			{
				const a = corners[wall.corner1];
				const b = corners[wall.corner2];
				const horizontal = Math.abs(a.y - b.y) < 0.01;
				const across = horizontal ? Math.abs(item.zpos - a.y) : Math.abs(item.xpos - a.x);
				const along = horizontal ? item.xpos : item.zpos;
				const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
				const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
				return across <= 8 * CM && along >= lo - 12 * CM && along <= hi + 12 * CM;
			});
			expect(onAWall, `${item.item_name} at (${item.xpos}, ${item.zpos}) is on no wall`).toBe(true);
		}
	});
});
