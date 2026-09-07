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
//
// `design.traced.json` in preference to `design.json`, because they are not the
// same artifact. `design.json` is what the app OPENS and a human is free to edit
// it, export over it, or dress it with `tools/fitout.py`; the traced copy is what
// the extractor produced and nothing else. This file is the seam between the
// extractor and the loader, so it has to read the latter - fitting out a kitchen
// otherwise failed this suite on cabinets it was never about.
const PLAN_DIR = process.env.PLAN_DIR || '/plan';
const TRACED = join(PLAN_DIR, 'design.traced.json');
const PLAN = existsSync(TRACED) ? TRACED : join(PLAN_DIR, 'design.json');
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

		// No corner is welded onto another -- unless they are at different
		// heights, which is deliberate. A pony wall meeting a full-height wall
		// needs its own corner at the same spot, because a corner carries one
		// elevation and the two walls do not share it.
		const points = Object.values(floorplan.corners);
		const tooClose = points.flatMap((a, i) => points.slice(i + 1)
			.filter((b) => Math.hypot(a.x - b.x, a.y - b.y) < 3 * 2.54
				&& Math.abs(a.elevation - b.elevation) < 0.01));
		expect(tooClose).toEqual([]);

		// Ceiling height, or a pony wall. A corner carries the height of the
		// walls meeting it (wall.js:394), so a half wall needs its own corners
		// at the same spot as the full wall it runs into - which is why the
		// extractor keys corners by height as well as position.
		const PONY_CM = 42 * 2.54;
		// The editor's own default counts too. `Floorplan.newCorner` starts a
		// corner at the CONFIGURED wall height, and a design that has been opened
		// and edited - which is the useful one to keep in data/ - carries corners
		// the editor made alongside the ones the tracer did. Asserting only the
		// tracer's two heights would be asserting that nobody had touched the plan.
		const EDITOR_DEFAULT_CM = 250;
		for (const corner of points)
		{
			const known = [CEILING_CM, PONY_CM, EDITOR_DEFAULT_CM]
				.some((height) => Math.abs(corner.elevation - height) < 0.01);
			expect(known, `elevation ${corner.elevation} is none of them`).toBe(true);
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

		// Openings only. This file describes what the TRACER produces, and a design
		// in data/ may also have been fitted out - `tools/fitout.py` puts cabinets,
		// a counter and a sink in it, and none of those is an opening, sits on a
		// wall line, or has a wall thickness to fill.
		const openings = items.filter((entry) => entry.item_type === 3 || entry.item_type === 7);
		expect(openings.length).toBeGreaterThan(0);

		for (const item of openings)
		{
			if (item.format === 'generated')
			{
				// A generated opening is TOLD its size rather than stretched to it,
				// so the believability check moves from the scale factor to the
				// width itself - which is the same question asked of the number
				// that now carries the answer, and asked in centimetres rather
				// than in multiples of whatever the model happened to be.
				expect(item.model_url).toMatch(/^generated:/);
				expect(item.scale_x).toBe(1);
				expect(item.scale_y).toBe(1);
				expect(item.scale_z).toBe(1);
				// 20in is a closet door, 96in a pair of patio sliders. Outside that
				// the drawing was measured wrong.
				expect(item.spec.width).toBeGreaterThan(50);
				expect(item.spec.width).toBeLessThan(250);
				// And it fills a wall somebody could build, rather than a default.
				expect(item.spec.wallThickness).toBeGreaterThan(5);
				expect(item.spec.wallThickness).toBeLessThan(40);
				continue;
			}
			expect(item.model_url).toMatch(/\.glb$/);
			// Scaled from the drawing's rough opening to the model's own size. The
			// window model is 4ft wide, so a run of patio glazing legitimately
			// lands near 2x; an order of magnitude either way would mean one of
			// the two was measured wrong.
			expect(item.scale_x).toBeGreaterThan(0.15);
			expect(item.scale_x).toBeLessThan(3.0);
		}

		// On a wall LINE, not on a wall segment. An opening is a gap, so the
		// centreline through a doorway is traced as two pieces with the door
		// between them - and an opening placed correctly in that gap belongs to
		// neither piece. Testing against segments failed a window that was
		// exactly where it should be.
		//
		// What this still catches is the failure that matters: a window floating
		// in the middle of a room, which is what happens when the glazing test
		// matches a cabinet run.
		const CM = 2.54;
		const lines = {horizontal: new Map(), vertical: new Map()};
		for (const wall of walls)
		{
			const a = corners[wall.corner1];
			const b = corners[wall.corner2];
			const horizontal = Math.abs(a.y - b.y) < 0.01;
			const key = Math.round((horizontal ? a.y : a.x) * 100) / 100;
			const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
			const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
			const into = horizontal ? lines.horizontal : lines.vertical;
			const span = into.get(key);
			into.set(key, span ? [Math.min(span[0], lo), Math.max(span[1], hi)] : [lo, hi]);
		}

		for (const item of openings)
		{
			const onAWall = [
				[lines.horizontal, item.zpos, item.xpos],
				[lines.vertical, item.xpos, item.zpos],
			].some(([into, across, along]) =>
				[...into.entries()].some(([coord, [lo, hi]]) =>
					Math.abs(across - coord) <= 8 * CM
					&& along >= lo - 12 * CM && along <= hi + 12 * CM));

			expect(onAWall, `${item.item_name} at (${item.xpos}, ${item.zpos}) is on no wall line`).toBe(true);
		}
	});
});
