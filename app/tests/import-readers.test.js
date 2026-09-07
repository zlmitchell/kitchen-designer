/**
 * The three drawing readers, against the one drawing they all describe.
 *
 * `tests/drawings/plan.{pdf,svg,dxf}` are the same synthetic house written
 * three ways by `tools/fixture_plan.py`: a 20x15ft envelope of 6in walls, two
 * 4in partitions, a 36in window and three 32in doors, with the walls on a
 * black pen and the jambs, glazing and swing arcs on a grey one. The point of
 * a fixture whose answer is known by construction is that a reader can be
 * wrong in a way that still traces.
 *
 * What is pinned here is the reader contract: the same path model MuPDF's
 * `get_drawings()` produces, since every constant in `src/app/import/` was
 * tuned against that and a port that reads its input differently is a port
 * that traces a different drawing.
 */
import {describe, expect, it} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {kindOf, openDrawing} from '../src/app/import/readers/index.js';
import {hexOf, overlaps, containsPoint} from '../src/app/import/readers/model.js';
import {openSvg, parseTransform} from '../src/app/import/readers/svg.js';

const require = createRequire(import.meta.url);
const DRAWINGS = join(import.meta.dirname, 'drawings');

/**
 * pdf.js and dxf-parser are handed in rather than imported by the reader.
 * In the browser the reader loads the worker build by URL, which node has no
 * use for; the legacy build is the one that runs headlessly.
 */
async function parsers()
{
	return {
		pdfjs: await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')),
		DxfParser: (await import('dxf-parser')).default,
	};
}

function bytes(name)
{
	return new Uint8Array(readFileSync(join(DRAWINGS, name)));
}

/** Every line item, flattened, as `[coord, lo, hi]` axis runs in points. */
function runs(paths)
{
	const out = {horizontal: [], vertical: []};
	for (const path of paths)
	{
		for (const item of path.items)
		{
			if (item[0] !== 'l') { continue; }
			const [, a, b] = item;
			if (Math.abs(a.y - b.y) < 0.01) { out.horizontal.push([a.y, Math.min(a.x, b.x), Math.max(a.x, b.x)]); }
			else if (Math.abs(a.x - b.x) < 0.01) { out.vertical.push([a.x, Math.min(a.y, b.y), Math.max(a.y, b.y)]); }
		}
	}
	return out;
}

describe('kindOf', () =>
{
	it('reads the content, not the name', () =>
	{
		expect(kindOf(bytes('plan.pdf'), 'anything.txt')).toBe('pdf');
		expect(kindOf(bytes('plan.svg'), 'anything.txt')).toBe('svg');
		expect(kindOf(bytes('plan.dxf'), 'anything.txt')).toBe('dxf');
	});

	it('refuses a binary DXF by name rather than misreading it', () =>
	{
		const binary = new TextEncoder().encode('AutoCAD Binary DXF\r\n\x1a\x00rest');
		expect(() => kindOf(binary, 'x.dxf')).toThrow(/binary DXF/i);
	});

	it('refuses anything else with a sentence, not a stack trace', () =>
	{
		expect(() => kindOf(new TextEncoder().encode('hello'), 'notes.md'))
			.toThrow(/not a PDF, an SVG or a DXF/);
	});
});

describe('the path model', () =>
{
	it('rounds a colour channel the way layers._hex does', () =>
	{
		expect(hexOf([0, 0, 0])).toBe('#000000');
		expect(hexOf([0.5019607843137255, 0.5019607843137255, 0.5019607843137255])).toBe('#808080');
		expect(hexOf(null)).toBe(null);
	});

	it('treats a zero-area rect as overlapping, which Rect.intersects does not', () =>
	{
		// The bug that cut 10600 stroked paths to 36: a path holding a single
		// horizontal line has zero height, and pymupdf calls that empty.
		expect(overlaps([0, 0, 100, 100], [10, 50, 90, 50])).toBe(true);
		expect(overlaps([0, 0, 100, 100], [10, 500, 90, 500])).toBe(false);
	});

	it('contains a point half-openly, as MuPDF does', () =>
	{
		// Inclusive on the near edges, exclusive on the far ones. A clip drawn
		// exactly on a drawing's extents otherwise loses every wall that
		// reaches them.
		expect(containsPoint([0, 0, 10, 10], {x: 0, y: 0})).toBe(true);
		expect(containsPoint([0, 0, 10, 10], {x: 10, y: 5})).toBe(false);
		expect(containsPoint([0, 0, 10, 10], {x: 5, y: 10})).toBe(false);
	});
});

describe('the SVG reader', () =>
{
	it('reports each primitive as the items MuPDF reports', async () =>
	{
		// Measured against pymupdf on this exact markup: a rect is one `re`
		// and never four lines, a polygon's closing edge IS a segment, and a
		// circle is four curves.
		const sheet = openSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
			<g stroke="#000000" stroke-width="1.5" fill="none">
				<line x1="0" y1="0" x2="100" y2="0"/>
				<rect x="10" y="10" width="80" height="40"/>
				<polygon points="200,10 260,10 260,60"/>
				<path d="M 300 10 L 340 10 L 340 50 Z"/>
				<circle cx="150" cy="200" r="20"/>
			</g></svg>`);
		const kinds = (await sheet.paths(1)).map((path) => path.items.map((item) => item[0]).join(''));
		expect(kinds).toEqual(['l', 're', 'lll', 'lll', 'cccc']);
	});

	it('applies a group transform to the geometry', async () =>
	{
		const sheet = openSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
			+ '<g transform="translate(10,20)" stroke="#000"><line x1="0" y1="0" x2="50" y2="0"/></g></svg>');
		const [path] = await sheet.paths(1);
		expect(path.items[0][1]).toEqual({x: 10, y: 20});
		expect(path.items[0][2]).toEqual({x: 60, y: 20});
	});

	it('reads a viewBox as a scale, not as decoration', async () =>
	{
		// A plan drawn in millimetres inside a sheet declared in inches is
		// routine; ignoring the viewBox puts every coordinate out by that
		// factor, which looks exactly like the wrong plot scale.
		const sheet = openSvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" '
			+ 'viewBox="0 0 100 100"><line x1="0" y1="0" x2="50" y2="0" stroke="#000"/></svg>');
		const [path] = await sheet.paths(1);
		expect(path.items[0][2]).toEqual({x: 100, y: 0});
	});

	it('leaves an unpainted element out, as MuPDF does', async () =>
	{
		const sheet = openSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
			+ '<line x1="0" y1="0" x2="50" y2="0" stroke="none" fill="none"/></svg>');
		expect(await sheet.paths(1)).toHaveLength(0);
	});

	it('does not draw what is inside defs', async () =>
	{
		const sheet = openSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
			+ '<defs><line x1="0" y1="0" x2="50" y2="0" stroke="#000"/></defs>'
			+ '<line x1="0" y1="9" x2="50" y2="9" stroke="#000"/></svg>');
		const paths = await sheet.paths(1);
		expect(paths).toHaveLength(1);
		expect(paths[0].items[0][1].y).toBe(9);
	});

	it('composes a transform list left to right', () =>
	{
		expect(parseTransform('translate(10,0) scale(2)')).toEqual([2, 0, 0, 2, 10, 0]);
	});
});

describe('every reader, on the same house', () =>
{
	it('reads the PDF as two pens and the linework of the plan', async () =>
	{
		const sheet = await openDrawing(bytes('plan.pdf'), 'plan.pdf', await parsers());
		expect(sheet.kind).toBe('pdf');
		// A picture at a plotted scale states no scale of its own.
		expect(sheet.scale).toBe(null);
		expect(sheet.pages).toEqual([{number: 1, width: 400, height: 310}]);

		const paths = await sheet.paths(1);
		const pens = new Set(paths.map((path) => `${hexOf(path.colour)},${path.width}`));
		expect([...pens].sort()).toEqual(['#000000,0.5', '#808080,0.35']);
		// 22 wall faces and 34 symbol marks, as fixture_plan.py draws them.
		expect(paths.filter((path) => hexOf(path.colour) === '#000000')).toHaveLength(22);
		expect(paths.filter((path) => hexOf(path.colour) === '#808080')).toHaveLength(34);
	});

	it('reads the SVG identically to the PDF', async () =>
	{
		const {pdfjs} = await parsers();
		const fromPdf = await openDrawing(bytes('plan.pdf'), 'plan.pdf', {pdfjs});
		const fromSvg = await openDrawing(bytes('plan.svg'), 'plan.svg', {});

		const one = runs(await fromPdf.paths(1));
		const two = runs(await fromSvg.paths(1));
		expect(two.horizontal.length).toBe(one.horizontal.length);
		expect(two.vertical.length).toBe(one.vertical.length);

		const ink = (found) => found.horizontal.concat(found.vertical)
			.reduce((sum, [, lo, hi]) => sum + (hi - lo), 0);
		expect(ink(two)).toBeCloseTo(ink(one), 6);
	});

	it('reads the DXF in real units, and knows its own scale', async () =>
	{
		const sheet = await openDrawing(bytes('plan.dxf'), 'plan.dxf', await parsers());
		expect(sheet.kind).toBe('dxf');
		// $INSUNITS is inches, and one drawing unit is emitted as one point -
		// so a real inch per point, with nobody asked to type it.
		expect(sheet.scale).toBe(1);

		// The page is the drawing plus a margin. It must NOT be the extents:
		// the clip test is half open, so a wall on the boundary is dropped.
		const page = sheet.pages[0];
		expect(page.width).toBeGreaterThan(240);
		expect(page.height).toBeGreaterThan(180);

		const paths = await sheet.paths(1);
		expect(paths.filter((path) => hexOf(path.colour) === '#000000')).toHaveLength(22);
		expect(paths.filter((path) => hexOf(path.colour) === '#808080')).toHaveLength(34);
		// Lineweight is read straight out of the LAYER table, because
		// dxf-parser does not: 0.50mm and 0.35mm, in points.
		const widths = [...new Set(paths.map((path) => path.width))].sort();
		expect(widths).toEqual([0.99, 1.42]);
	});

	it('closes a PDF without throwing, and lets the worker go', async () =>
	{
		// pdf.js 6 puts `destroy()` on the LOADING TASK; the document proxy has
		// only `cleanup()`. Closing through the document threw
		// "document.destroy is not a function", which the dialog hit on every
		// reset - so the state was never cleared and the 2.23MB worker stayed
		// up. Found by sweeping real drawings, not by any unit test, which is
		// why there is now one.
		const sheet = await openDrawing(bytes('plan.pdf'), 'plan.pdf', await parsers());
		expect(() => sheet.close()).not.toThrow();
	});

	it('reads a box as one item however it was drawn, and lines when it is not one', async () =>
	{
		// `tests/drawings/boxes.pdf` holds the same box three ways. MuPDF
		// reports the first as `re`, the second as `qu` - a quad - and only
		// the third as lines; the first two carry no segments either way, which
		// is what matters, because `layers.split` reads only `l` and `c`.
		//
		// Only the `re` spelling was recognised here, so a box drawn the long
		// way arrived as four face lines and went to the wall tracer as walls.
		// Measured on a LayOut sheet: 36 spurious runs forming 9 cabinet-sized
		// boxes, which moved that sheet's structure ranking onto the wrong pen.
		const sheet = await openDrawing(bytes('boxes.pdf'), 'boxes.pdf', await parsers());
		const kinds = (await sheet.paths(1)).map((path) => path.items.map((item) => item[0]).join(''));

		expect(kinds[0]).toBe('re');            // drawn with `re`
		expect(kinds[1]).toBe('re');            // five points, last on the first
		expect(kinds[2]).toBe('lll');           // three sides is not a box
		sheet.close();
	});

	it('flips a DXF so that the top of the drawing is the top of the plan', async () =>
	{
		const sheet = await openDrawing(bytes('plan.dxf'), 'plan.dxf', await parsers());
		const found = runs(await sheet.paths(1));
		// The window is a 36in break in the topmost wall. If y were not
		// flipped it would be in the bottom one.
		const top = Math.min(...found.horizontal.map(([coord]) => coord));
		const broken = found.horizontal.filter(([coord]) => Math.abs(coord - top) < 0.01);
		expect(broken.length).toBe(2);
		expect(broken.reduce((sum, [, lo, hi]) => sum + (hi - lo), 0)).toBeCloseTo(240 - 36, 3);
	});
});
