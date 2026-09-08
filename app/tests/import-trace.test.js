/**
 * The tracer: a drawing in, an architect3d design out.
 *
 * `src/app/import/` is a port of `tools/`, so the standard it is held to is
 * not "does it look right" but "does it agree with the Python". Both were run
 * over `tests/drawings/plan.pdf` and over a real 525-path architectural sheet
 * while this was written, and they agreed exactly: the same structure layer,
 * the same 55 wall boxes, the same 83 corners and 77 walls, the same items.
 *
 * The real sheet cannot be committed - `plans/` is our house - so what is
 * pinned here is the synthetic one, whose answer is known by construction
 * rather than by having been observed:
 *
 *     envelope     20 x 15ft outside, 6in walls  -> 19.5 x 14.5ft of centreline
 *     partitions   one vertical, two horizontal, all 4in
 *     openings     a 36in window and three 32in doors
 *
 * Every number below is derived from those, not copied from a run. A test that
 * records what the code happened to do cannot tell a regression from a change.
 */
import {describe, expect, it} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {openDrawing} from '../src/app/import/readers/index.js';
import {listLayers, structure} from '../src/app/import/layers.js';
import {trace} from '../src/app/import/walls.js';
import {findOpenings} from '../src/app/import/symbols.js';
import {traceSheet} from '../src/app/import/trace.js';
import {paint, regions} from '../src/app/import/spaces.js';
import {pyRound} from '../src/app/import/round.js';
import {regionCanvas} from '../src/app/import/raster.js';
import {DesignDocument} from '../src/scripts/model/document.js';
import {bridgeOpenings, itemsFor} from '../src/app/import/design.js';

const require = createRequire(import.meta.url);
const DRAWINGS = join(import.meta.dirname, 'drawings');

/** The fixture, and the region and scale it is drawn at. */
const CLIP = [0, 0, 400, 310];
const SCALE = 2 / 3;             // 1/4in = 1ft, in real inches per point
const CM = 2.54;

/** What the fixture IS, in the units the design comes out in. */
const WIDTH_CM = 19.5 * 12 * CM;   // 594.36
const HEIGHT_CM = 14.5 * 12 * CM;  // 441.96
const CEILING_CM = 96 * CM;

async function parsers()
{
	return {
		pdfjs: await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')),
		DxfParser: (await import('dxf-parser')).default,
	};
}

async function sheetFor(name)
{
	return openDrawing(new Uint8Array(readFileSync(join(DRAWINGS, name))), name, await parsers());
}

/** Deterministic corner ids, so two runs can be compared. */
function counter()
{
	let at = 0;
	return () => `c${(at += 1)}`;
}

async function traced(name, options = {})
{
	const sheet = await sheetFor(name);
	return traceSheet({
		sheet, page: 1, clip: CLIP, scale: SCALE, newId: counter(), ...options,
	});
}

describe('pyRound', () =>
{
	it('rounds a half to even, as Python does and JavaScript does not', () =>
	{
		// Not pedantry: the tracer buckets thicknesses onto quarters, and a
		// drawing is full of walls exactly 4.5in thick. Math.round would put
		// that bucket one step out, and a thickness with too little wall
		// behind it is discarded as a coincidence.
		expect(pyRound(2.5)).toBe(2);
		expect(pyRound(3.5)).toBe(4);
		expect(pyRound(-2.5)).toBe(-2);
		expect(pyRound(2.675, 2)).toBe(2.67);
		expect(Math.round(2.5)).toBe(3);
	});
});

describe('the layer split', () =>
{
	it('picks the pen the walls are drawn with', async () =>
	{
		const sheet = await sheetFor('plan.pdf');
		const found = structure(await sheet.paths(1), CLIP, SCALE, null);
		// Black at 0.5pt is the wall pen; grey at 0.35 is jambs and swings.
		expect(found.key).toBe('#000000,0.5,none');
		expect(found.horizontal).toHaveLength(14);
		expect(found.vertical).toHaveLength(8);
	});

	it('offers the other pens, because the ranking is wrong sometimes', async () =>
	{
		const sheet = await sheetFor('plan.pdf');
		const listed = listLayers(await sheet.paths(1), CLIP, SCALE);
		expect(listed.map((entry) => entry.key)).toEqual(['#000000,0.5,none', '#808080,0.35,none']);
		// The wall pen wins by two orders of magnitude. The symbol pen scores
		// at all because its jambs pair at 3in, which is a buildable width -
		// what separates them is ink, straightness and reach, which is the
		// whole of the ranking rule.
		expect(listed[0].structure).toBeGreaterThan(listed[1].structure * 20);
	});

	it('honours an override, and says so when the key is not there', async () =>
	{
		const sheet = await sheetFor('plan.pdf');
		const paths = await sheet.paths(1);
		expect(structure(paths, CLIP, SCALE, '#808080,0.35,none').key).toBe('#808080,0.35,none');
		expect(() => structure(paths, CLIP, SCALE, '#ff0000,9,none')).toThrow(/no layer/i);
	});

	it('refuses a region with no structure in it rather than inventing one', async () =>
	{
		const sheet = await sheetFor('plan.pdf');
		const paths = await sheet.paths(1);
		// The margin: blank paper.
		expect(() => structure(paths, [0, 0, 15, 15], SCALE, null))
			.toThrow(/looks like the structure/i);
	});
});

describe('the wall tracer', () =>
{
	it('measures the thicknesses the drawing was drawn with', async () =>
	{
		const sheet = await sheetFor('plan.pdf');
		const found = structure(await sheet.paths(1), CLIP, SCALE, null);
		const walls = trace(found.horizontal, found.vertical);
		// Discovered, not declared: 6in envelope and 4in partitions.
		expect(walls.thicknesses).toEqual([4, 6]);
		// Nine boxes, because the window and the three doors each break a wall
		// into two stretches that are bridged later.
		expect(walls.boxes).toHaveLength(9);
		expect(walls.boxes.every((box) => box.drawn_hi > box.drawn_lo)).toBe(true);
	});
});

describe('adjacent window sashes', () =>
{
	// The reported bug: a twin and a triple window each arrived as ONE window.
	// `extract.find_openings` welds neighbouring window spans together on the
	// grounds that a mullion is drawn as a jamb - and in doing so reports a
	// 20 + 51 + 20 triple as a single 91in pane. Measured on the reference
	// sheet, which is where those three numbers come from.
	const WALL = [[0, 0, 100, 6]];
	// A jamb at each end and a mullion in the middle, each spanning the wall
	// face to face.
	const JAMBS = [[20, -3, 3], [50, -3, 3], [80, -3, 3]];
	// Glazing running the full width of both sashes: what makes them windows
	// rather than doors.
	const GLAZING = [[0, 20, 50], [0, 50, 80]];
	// The wall's own faces, present either side and absent across the opening.
	const FACES = [[0, 0, 20], [0, 80, 100]];

	it('stays two windows, not one twice as wide', () =>
	{
		const found = findOpenings(WALL, JAMBS, GLAZING, FACES, [], true);
		expect(found).toHaveLength(2);
		expect(found.map((one) => one[0])).toEqual(['window', 'window']);
		expect(found.map((one) => Math.round(one[3]))).toEqual([30, 30]);
		// The failure this replaces: one opening of 60in, centred on the
		// mullion, where the drawing has two units and a mullion between them.
		expect(found.some((one) => one[3] > 50)).toBe(false);
	});

	it('still reads a single sash as one window', () =>
	{
		const found = findOpenings(
			[[0, 0, 100, 6]], [[20, -3, 3], [50, -3, 3]], [[0, 20, 50]], FACES, [], true);
		expect(found).toHaveLength(1);
		expect(found[0][0]).toBe('window');
		expect(Math.round(found[0][3])).toBe(30);
	});
});

describe('the rooms fill', () =>
{
	it('finds the inside of a closed box, and calls the outside outside', () =>
	{
		const boxes = [
			{horizontal: true, centre: 0, thickness: 6, drawn_lo: 0, drawn_hi: 120},
			{horizontal: true, centre: 120, thickness: 6, drawn_lo: 0, drawn_hi: 120},
			{horizontal: false, centre: 0, thickness: 6, drawn_lo: 0, drawn_hi: 120},
			{horizontal: false, centre: 120, thickness: 6, drawn_lo: 0, drawn_hi: 120},
		];
		const {grid, wide, high} = paint(boxes, [-20, -20, 140, 140]);
		const {found} = regions(grid, wide, high);
		const inside = found.filter((region) => !region.outside);
		expect(found.some((region) => region.outside)).toBe(true);
		expect(inside).toHaveLength(1);
		// 114in square inside the faces, in square feet.
		expect(inside[0].area_sqft).toBeGreaterThan(80);
		expect(inside[0].area_sqft).toBeLessThan(95);
	});
});

describe('tracing the fixture end to end', () =>
{
	it('produces the house that was drawn', async () =>
	{
		const {design, stats} = await traced('plan.pdf');

		expect(stats.layer).toBe('#000000,0.5,none');
		expect(stats.thicknesses).toEqual([4, 6]);
		expect(stats.widthFt).toBeCloseTo(19.5, 6);
		expect(stats.heightFt).toBeCloseTo(14.5, 6);
		// Every wall is square to the page, which is the box model's guarantee
		// rather than a hope.
		expect(stats.offAxisIn).toBe(0);
		expect(stats.openings).toEqual({window: 1, door: 3});

		const corners = Object.values(design.floorplan.corners);
		expect(corners).toHaveLength(10);
		expect(design.floorplan.walls).toHaveLength(11);
		expect(Math.max(...corners.map((corner) => corner.x))).toBeCloseTo(WIDTH_CM, 2);
		expect(Math.max(...corners.map((corner) => corner.y))).toBeCloseTo(HEIGHT_CM, 2);
		expect(corners.every((corner) => corner.elevation === CEILING_CM)).toBe(true);
	});

	it('carries each wall its own measured thickness', async () =>
	{
		const {design} = await traced('plan.pdf');
		const thicknesses = [...new Set(design.floorplan.walls.map((wall) => wall.thickness))].sort();
		// 4in and 6in, in centimetres - not architect3d's configured default.
		expect(thicknesses).toEqual([4 * CM, 6 * CM]);
	});

	it('writes openings as items on the walls, not as gaps in them', async () =>
	{
		const {design} = await traced('plan.pdf');
		expect(design.items).toHaveLength(4);

		const window = design.items.find((item) => item.item_name === 'Window');
		// Type 3 is InWallItem, and GENERATED - not `whitewindow.glb` scaled.
		// A model has one width, so `scale_x` stretched the stiles with the
		// glass and `scale_z` squashed a 14.75cm sash into a 7.7cm wall.
		expect(window.item_type).toBe(3);
		expect(window.model_url).toBe('generated:window');
		expect(window.format).toBe('generated');
		expect([window.scale_x, window.scale_y, window.scale_z]).toEqual([1, 1, 1]);
		// The opening the drawing measured, and the wall's own thickness. The
		// builder makes a lining that fits both.
		expect(window.spec.kind).toBe('window');
		expect(window.spec.width).toBeCloseTo(36 * CM, 1);
		expect(window.spec.wallThickness).toBeCloseTo(6 * CM, 1);
		// Height and sill are the standard: a plan view gives a width and says
		// nothing else. They live in the SPEC rather than baked into `ypos`, so
		// the inspector and a drag up the wall hold one number between them.
		expect(window.spec.height).toBe(152.4);
		expect(window.spec.sillHeight).toBe(81.28);
		expect(window.ypos).toBeCloseTo(81.28 + 152.4 / 2, 2);
		// No symbol beyond glazing means double-hung; the tracer does not guess.
		expect(window.spec.type).toBe('double-hung');

		const doors = design.items.filter((item) => item.item_name === 'Door');
		expect(doors).toHaveLength(3);
		for (const door of doors)
		{
			// Generated, not a model that gets stretched.
			expect(door.model_url).toBe('generated:door');
			expect(door.item_type).toBe(7);
			expect(door.spec.width).toBeCloseTo(32 * CM, 0);
			expect(door.spec.wallThickness).toBeCloseTo(4 * CM, 1);
			// The drawing drew a swing arc for each, so each is hinged.
			expect(door.spec.operation).toBe('swing');
			expect(['lo', 'hi']).toContain(door.spec.hand);
			expect(['positive', 'negative']).toContain(door.spec.swing);
		}
	});

	it('leaves a door shut when it is asked to', async () =>
	{
		const {design} = await traced('plan.pdf', {openDoors: false});
		const doors = design.items.filter((item) => item.item_name === 'Door');
		expect(doors.every((door) => door.spec.openFraction === 0)).toBe(true);
	});

	it('takes the ceiling height it is given', async () =>
	{
		const {design} = await traced('plan.pdf', {ceiling: 108});
		const corners = Object.values(design.floorplan.corners);
		expect(corners.every((corner) => corner.elevation === pyRound(108 * CM, 2))).toBe(true);
	});

	it('reads the same house out of all three formats', async () =>
	{
		const fromPdf = await traced('plan.pdf');
		const fromSvg = await traced('plan.svg');
		// The DXF is in real inches and needs no plot scale, so its page and
		// its region are in different units from the other two.
		const dxf = await sheetFor('plan.dxf');
		const fromDxf = await traceSheet({
			sheet: dxf,
			page: 1,
			clip: [0, 0, dxf.pages[0].width, dxf.pages[0].height],
			scale: dxf.scale,
			newId: counter(),
		});

		for (const result of [fromSvg, fromDxf])
		{
			expect(result.stats.walls).toBe(fromPdf.stats.walls);
			expect(result.stats.corners).toBe(fromPdf.stats.corners);
			expect(result.stats.openings).toEqual(fromPdf.stats.openings);
			expect(result.stats.thicknesses).toEqual(fromPdf.stats.thicknesses);
			// A tenth of a millimetre, which is the round trip through a
			// plotted scale and back. The DXF never leaves real inches.
			expect(result.stats.widthFt).toBeCloseTo(fromPdf.stats.widthFt, 3);
			expect(result.stats.heightFt).toBeCloseTo(fromPdf.stats.heightFt, 3);
		}
	});

	it('produces a design the loader accepts', async () =>
	{
		// The seam that matters: a design this writes by hand has to parse in
		// the app that opens it, or the import is a broken boot.
		const {design} = await traced('plan.pdf');
		const result = DesignDocument.parse(JSON.stringify(design));
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it('places the drawing underneath in centimetres and image pixels', async () =>
	{
		const {design} = await traced('plan.pdf', {
			underlay: {url: 'data:image/png;base64,x', width: 800, height: 620},
		});
		const underlay = design.floorplan.underlay;
		// Plain centimetres, NOT architect3d's carbonSheet fields - two of
		// those are in whatever unit is on screen when the design loads.
		expect(underlay.widthCm).toBeCloseTo(400 * SCALE * CM, 2);
		expect(underlay.heightCm).toBeCloseTo(310 * SCALE * CM, 2);
		// The plan's origin inside the image, in raw image pixels: the fixture
		// is drawn 20pt from the corner and the wall centreline is 3in inside
		// that, at 2 pixels per point.
		expect(underlay.anchorXPx).toBeCloseTo((20 * SCALE + 3) / SCALE * (800 / 400), 1);
		expect(underlay.transparency).toBe(0.5);
	});
});

describe('when it cannot', () =>
{
	it('refuses a scale that is not a length', async () =>
	{
		const sheet = await sheetFor('plan.pdf');
		await expect(traceSheet({sheet, page: 1, clip: CLIP, scale: 0}))
			.rejects.toThrow(/scale/i);
	});

	it('refuses an empty region', async () =>
	{
		const sheet = await sheetFor('plan.pdf');
		await expect(traceSheet({sheet, page: 1, clip: [10, 10, 10, 10], scale: SCALE}))
			.rejects.toThrow(/box around the floor plan/i);
	});

	it('says the region holds no walls rather than writing an empty design', async () =>
	{
		const sheet = await sheetFor('plan.pdf');
		await expect(traceSheet({sheet, page: 1, clip: [0, 0, 15, 15], scale: SCALE}))
			.rejects.toThrow(/structure|no walls/i);
	});

	it('says there is no such page', async () =>
	{
		const sheet = await sheetFor('plan.svg');
		await expect(traceSheet({sheet, page: 4, clip: CLIP, scale: SCALE}))
			.rejects.toThrow(/no page 4/i);
	});
});

describe('regionCanvas', () =>
{
	it('turns a clip in points into pixels at a dpi', () =>
	{
		const region = regionCanvas([0, 0, 72, 36], 150);
		expect(region.width).toBe(150);
		expect(region.height).toBe(75);
		// Element by element: a clip at the origin gives a negative zero
		// offset, which is the same number and not the same value to toEqual.
		expect(region.transform[0]).toBeCloseTo(150 / 72, 12);
		expect(region.transform[3]).toBeCloseTo(150 / 72, 12);
		expect(region.transform[4]).toBe(0);
		expect(region.transform[5]).toBe(0);
	});

	it('shifts the clip corner to the origin', () =>
	{
		const region = regionCanvas([36, 18, 72, 36], 72);
		expect(region.width).toBe(36);
		expect(region.transform[4]).toBe(-36);
		expect(region.transform[5]).toBe(-18);
	});

	it('shrinks a sheet too large for a canvas rather than getting a blank one', () =>
	{
		// A 36x48in sheet at 150dpi is 5400x7200, which some browsers refuse -
		// and a browser that refuses returns a blank canvas rather than
		// throwing.
		const region = regionCanvas([0, 0, 2592, 3456], 150, 4096);
		expect(Math.max(region.width, region.height)).toBeLessThanOrEqual(4096);
		expect(region.width / region.height).toBeCloseTo(2592 / 3456, 3);
	});
});


/*
 * A wide opening is drawn as the sashes it is made of, and both of these are
 * what that costs if the tracer treats them as separate windows.
 *
 * Measured on the real sheet before either was fixed: the kitchen's twin left
 * the north wall in two pieces with an end dangling in mid air at each side of
 * it, no corner loop could close through it, and the kitchen and great room -
 * 421 sqft between them - had no floor at all. The three sashes of the great
 * room's window each carried their own jamb liner and casing and lapped their
 * neighbours by 16.5cm.
 */
describe('a gap is bridged by everything in it, not by one opening', () =>
{
	/** Two collinear boxes with a gap between them, on a 7.33in wall. */
	const pieces = () => [
		{horizontal: true, centre: 302.83, thickness: 7.33, drawn_lo: 1050.6, drawn_hi: 1390.5},
		{horizontal: true, centre: 302.83, thickness: 7.33, drawn_lo: 1454.5, drawn_hi: 1507.4},
	];
	const sash = (lo, hi) => ({horizontal: true, centre: 302.83, lo: lo, hi: hi});

	it('joins a wall across the twin window the drawing draws', () =>
	{
		// 64in of gap, two 31.6in sashes: 49% each and 99% together. Asked one at
		// a time, neither reaches the 60% the rule wants and the wall stays broken.
		const joined = bridgeOpenings(pieces(), [sash(1390.8, 1422.4), sash(1422.4, 1454.0)]);
		expect(joined).toHaveLength(1);
		expect(joined[0].drawn_lo).toBeCloseTo(1050.6, 1);
		expect(joined[0].drawn_hi).toBeCloseTo(1507.4, 1);
	});

	it('still joins it across a single opening of the same size', () =>
	{
		// What `tools/` sees, because it welds the two spans before this runs.
		expect(bridgeOpenings(pieces(), [sash(1390.8, 1454.0)])).toHaveLength(1);
	});

	it('leaves a gap nothing fills alone', () =>
	{
		// The rule still has to say no. A 20in opening in a 64in gap is a wall
		// that stops, not a wall drawn round a hole.
		expect(bridgeOpenings(pieces(), [sash(1400.0, 1420.0)])).toHaveLength(2);
	});

	it('does not bridge across an opening on another wall', () =>
	{
		expect(bridgeOpenings(pieces(), [
			{horizontal: true, centre: 588.01, lo: 1390.8, hi: 1454.0},
		])).toHaveLength(2);
	});
});

describe('sashes side by side are one window made of lights', () =>
{
	// [kind, x, y, width, horizontal, thicknessIn, hinge, swing, exterior]
	const window = (along, width) => ['window', along, 302.83, width, true, 7.33, null, null, true];

	it('collects a twin into one item, spanning both', () =>
	{
		const items = itemsFor([window(1406.6, 31.61), window(1438.2, 31.56)], 1050.6, 302.83);
		expect(items).toHaveLength(1);
		expect(items[0].spec.width).toBeCloseTo((31.61 + 31.56) * 2.54, 1);
		expect(items[0].spec.units.map((u) => u.width))
			.toEqual([expect.closeTo(31.61 * 2.54, 1), expect.closeTo(31.56 * 2.54, 1)]);
		// Centred on the whole opening, not on either sash.
		expect(items[0].xpos).toBeCloseTo((1422.4 - 1050.6) * 2.54, 0);
	});

	it('leaves a lone window with no lights at all', () =>
	{
		// Absent, not `[{...}]` of one: every window in most houses is this, and
		// a field that is always there is a field that changes every file.
		const items = itemsFor([window(1406.6, 35.17)], 1050.6, 302.83);
		expect(items).toHaveLength(1);
		expect(items[0].spec.units).toBeUndefined();
	});

	it('keeps two windows with a pier between them apart', () =>
	{
		// A foot of wall is not a mullion.
		const items = itemsFor([window(1100.0, 35.17), window(1150.0, 35.17)], 1050.6, 302.83);
		expect(items).toHaveLength(2);
		expect(items[0].spec.units).toBeUndefined();
	});

	it('keeps windows on different walls apart', () =>
	{
		const other = ['window', 1406.6, 588.01, 31.56, true, 6.1, null, null, true];
		const items = itemsFor([window(1406.6, 31.61), other], 1050.6, 302.83);
		expect(items).toHaveLength(2);
	});

	it('leaves doors alone, because two doors are two doors', () =>
	{
		// A pair of them is `french` or `bypass`, which the symbol decides.
		const door = (along) => ['door', along, 445.15, 30.83, true, 4.59, 'lo', 'negative', false];
		const items = itemsFor([door(1200.4), door(1240.4)], 1050.6, 302.83);
		expect(items).toHaveLength(2);
	});
});
