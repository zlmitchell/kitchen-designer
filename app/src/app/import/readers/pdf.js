// @ts-check
/**
 * A PDF's linework, read off the operator list.
 *
 * pymupdf hands `get_drawings()` over as finished path records. pdf.js has no
 * such call: what it exposes is the display list the canvas backend replays -
 * `constructPath` with a stream of commands, and the graphics state around it
 * as separate operators. So this module is the part MuPDF does internally,
 * which is a state machine over the operator list.
 *
 * ## What has to be tracked, and why each one matters
 *
 *   the CTM        Path coordinates are in the CURRENT user space, not the
 *                  page's. A plan is routinely drawn inside a form XObject at
 *                  a scale, so untransformed coordinates are off by whatever
 *                  the drafter's export chose - which does not look like an
 *                  error, it looks like a plan at the wrong scale.
 *   save/restore   478 transforms and 483 save/restore pairs on the one-page
 *                  sample sheet. Without the stack the CTM never comes back.
 *   the paint op   pymupdf reports a stroked path with `color` and a filled
 *                  one with `fill`, and `layers.split` keys on all three
 *                  fields. pdf.js carries the paint op INSIDE constructPath's
 *                  first argument, which is where the distinction comes from.
 *   line width     In user space, like the coordinates, so it is scaled by the
 *                  CTM on the way out. `setGState` can also carry it as `LW`.
 *
 * ## Coordinates come out in page space
 *
 * The walk starts from `viewport.transform` at scale 1, which is
 * `[1, 0, 0, -1, 0, height]` for an unrotated page: PDF's y-up user space to
 * y-down page space. That is MuPDF's convention, so a clip rectangle means the
 * same thing here as it does to `tools/build.py --clip`, and a page that
 * declares `/Rotate` is handled by the same matrix rather than by a special
 * case here.
 */

import {IDENTITY, apply, boundsOf, compose, rgbOf, scaleOf} from './model.js';

/**
 * pdf.js's own path command codes, from `DrawOPS` in the build. Pinned as a
 * constant rather than imported because they are not exported, and asserted in
 * `readPaths` - a pdf.js upgrade that renumbers them has to fail loudly rather
 * than quietly trace a page of noise.
 */
const MOVE_TO = 0;
const LINE_TO = 1;
const CURVE_TO = 2;
const QUADRATIC_CURVE_TO = 3;
const CLOSE_PATH = 4;

/** How many numbers follow each command code. */
const ARITY = {
	[MOVE_TO]: 2, [LINE_TO]: 2, [CURVE_TO]: 6, [QUADRATIC_CURVE_TO]: 4,
	[CLOSE_PATH]: 0,
};

/**
 * Load pdf.js.
 *
 * A function rather than a static import so that the ~1MB of parser is fetched
 * when somebody imports a drawing and never on first paint - and so the tests,
 * which run in node where the browser build's worker plumbing does not apply,
 * can hand in the legacy build instead.
 *
 * @returns {Promise<any>}
 */
export async function loadPdfjs()
{
	const pdfjs = await import('pdfjs-dist');
	// Bundled by Vite as a worker asset and addressed by URL, which is the only
	// arrangement that survives both the dev server and a hashed production
	// build. Without it pdf.js falls back to parsing on the main thread and a
	// large sheet freezes the interface while it does.
	if (!pdfjs.GlobalWorkerOptions.workerSrc)
	{
		pdfjs.GlobalWorkerOptions.workerSrc =
			new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
	}
	return pdfjs;
}

/**
 * Open a PDF.
 *
 * @param {Uint8Array} data
 * @param {{pdfjs?: any}} [options] `pdfjs` overrides the module, for tests.
 * @returns {Promise<import('./index.js').Sheet & {document: any}>}
 */
export async function openPdf(data, options = {})
{
	const pdfjs = options.pdfjs || await loadPdfjs();
	// The LOADING TASK is kept, not just the document it resolves to. In
	// pdf.js 6 the two have different teardown: the task owns `destroy()` and
	// the document proxy has only `cleanup()`, so closing through the document
	// - which is the obvious thing to write, and what this did - throws
	// `document.destroy is not a function` and leaves the worker running.
	// Destroying the task is also the only thing that terminates that worker,
	// which is 2.23 MB and holds the whole parsed file.
	const task = pdfjs.getDocument({
		// `isEvalSupported` off because nothing here needs pdf.js's compiled
		// font paths and a CSP that forbids eval is a reasonable thing for an
		// embedder to have. The data is copied because pdf.js transfers the
		// buffer to its worker and detaches it, and the caller still owns
		// theirs.
		data: data.slice(),
		isEvalSupported: false,
	});
	const document = await task.promise;

	const pages = [];
	for (let number = 1; number <= document.numPages; number += 1)
	{
		const page = await document.getPage(number);
		const viewport = page.getViewport({scale: 1});
		pages.push({
			number,
			width: Math.round(viewport.width * 100) / 100,
			height: Math.round(viewport.height * 100) / 100,
		});
	}

	return {
		kind: /** @type {'pdf'} */ ('pdf'),
		document,
		pages,
		// A PDF of a floor plan is a picture at a plotted scale and records
		// nowhere which one, so only the person holding the drawing knows.
		scale: null,
		/** @param {number} number */
		paths: (number) => readPaths(document, pdfjs, number),
		close: () => task.destroy(),
	};
}

/**
 * Every stroked or filled path on one page, in page points.
 *
 * @param {any} document
 * @param {any} pdfjs
 * @param {number} number 1-indexed.
 * @returns {Promise<import('./model.js').DrawnPath[]>}
 */
export async function readPaths(document, pdfjs, number)
{
	const OPS = pdfjs.OPS;
	const page = await document.getPage(number);
	const viewport = page.getViewport({scale: 1});
	const list = await page.getOperatorList();

	/** @type {import('./model.js').DrawnPath[]} */
	const out = [];
	/** @type {import('./model.js').Matrix} */
	let ctm = viewport.transform.slice();
	/** @type {import('./model.js').Matrix[]} */
	const stack = [];
	let lineWidth = 1;
	/** @type {number[]} */
	const widths = [];
	// Nullable: a pattern or shading fill has no one colour, and saying so is
	// the point - see the note on setFillColorN below.
	/** @type {?number[]} */
	let stroke = [0, 0, 0];
	/** @type {?number[]} */
	let fill = [0, 0, 0];
	/** @type {Array<?number[]>} */
	const strokes = [];
	/** @type {Array<?number[]>} */
	const fills = [];

	for (let index = 0; index < list.fnArray.length; index += 1)
	{
		const op = list.fnArray[index];
		const args = list.argsArray[index];

		if (op === OPS.save)
		{
			stack.push(ctm.slice());
			widths.push(lineWidth);
			strokes.push(stroke);
			fills.push(fill);
		}
		else if (op === OPS.restore)
		{
			// A restore with nothing to restore is a malformed page, not a
			// reason to stop reading one: the rest of the sheet is still
			// perfectly good linework.
			ctm = stack.pop() || viewport.transform.slice();
			lineWidth = widths.pop() ?? lineWidth;
			// `??` and not `||`: a saved null is a real value here - the paint
			// in force was a pattern - and `||` would restore the colour from
			// before it instead.
			stroke = strokes.length ? strokes.pop() ?? null : stroke;
			fill = fills.length ? fills.pop() ?? null : fill;
		}
		else if (op === OPS.transform)
		{
			ctm = compose(ctm, /** @type {import('./model.js').Matrix} */ (args));
		}
		else if (op === OPS.setLineWidth)
		{
			lineWidth = args[0];
		}
		else if (op === OPS.setStrokeRGBColor)
		{
			stroke = rgbOf(args[0]) || stroke;
		}
		else if (op === OPS.setFillRGBColor)
		{
			fill = rgbOf(args[0]) || fill;
		}
		// The other ways a PDF states a colour. Leaving these unhandled does
		// not lose a colour, it keeps the PREVIOUS one - so a grey-filled or
		// pattern-filled path silently joins whichever pen was set last, which
		// on a floor plan can be the wall pen.
		else if (op === OPS.setStrokeGray)
		{
			stroke = greyOf(args[0]) || stroke;
		}
		else if (op === OPS.setFillGray)
		{
			fill = greyOf(args[0]) || fill;
		}
		else if (op === OPS.setStrokeCMYKColor)
		{
			stroke = cmykOf(args) || stroke;
		}
		else if (op === OPS.setFillCMYKColor)
		{
			fill = cmykOf(args) || fill;
		}
		else if (op === OPS.setStrokeColorN || op === OPS.setFillColorN)
		{
			// A pattern or a shading: paint that is not one colour, so there is
			// no honest hex for it. Reported as no colour rather than as the
			// last one, which puts every pattern fill in its own bucket where
			// it can be ignored instead of contaminating a pen.
			const painted = colourOfN(args);
			if (op === OPS.setStrokeColorN)
			{
				stroke = painted;
			}
			else
			{
				fill = painted;
			}
		}
		else if (op === OPS.setGState)
		{
			// An array of [key, value] pairs. Only the line width is read: it
			// is the one piece of graphics state that also arrives this way and
			// that `layers.split` keys on.
			for (const [key, value] of args[0] || [])
			{
				if (key === 'LW')
				{
					lineWidth = value;
				}
			}
		}
		else if (op === OPS.constructPath)
		{
			const drawn = buildPath(args, ctm, OPS, lineWidth, stroke, fill);
			if (drawn)
			{
				out.push(drawn);
			}
		}
	}

	page.cleanup();
	return out;
}

/**
 * One `constructPath` operator to a path record, or null if it paints nothing.
 *
 * @param {any[]} args `[paintOp, pathData, minMax]`.
 * @param {import('./model.js').Matrix} ctm
 * @param {any} OPS
 * @param {number} lineWidth
 * @param {?number[]} stroke
 * @param {?number[]} fill
 * @returns {?import('./model.js').DrawnPath}
 */
function buildPath(args, ctm, OPS, lineWidth, stroke, fill)
{
	const paint = args[0];
	const stroked = (paint === OPS.stroke || paint === OPS.closeStroke
		|| paint === OPS.fillStroke || paint === OPS.eoFillStroke
		|| paint === OPS.closeFillStroke || paint === OPS.closeEOFillStroke);
	const filled = (paint === OPS.fill || paint === OPS.eoFill
		|| paint === OPS.fillStroke || paint === OPS.eoFillStroke
		|| paint === OPS.closeFillStroke || paint === OPS.closeEOFillStroke);
	// A path built only to clip with paints nothing and is not linework. Left
	// out rather than recorded with no colour, which would give `layers.split`
	// a key of (none, 0, none) holding every clip box on the sheet.
	if (!stroked && !filled)
	{
		return null;
	}

	/** @type {import('./model.js').PathItem[]} */
	const items = [];
	/** @type {import('./model.js').Point[]} */
	const points = [];
	// pdf.js hands the commands over as one or more typed arrays. Both shapes
	// are accepted because the packing is an implementation detail of a
	// dependency and the meaning of the stream is not.
	const chunks = Array.isArray(args[1]) ? args[1] : [args[1]];

	for (const chunk of chunks)
	{
		if (!chunk || typeof chunk.length !== 'number')
		{
			continue;
		}
		/** @type {import('./model.js').PathItem[]} */
		let sub = [];
		/** @type {import('./model.js').Point[]} */
		let corners = [];
		/** @type {?import('./model.js').Point} */
		let current = null;
		/** @type {?import('./model.js').Point} */
		let start = null;
		// Where the pen actually was when the subpath closed. Distinct from
		// `current`, which a close rewinds to `start` - reading the closing
		// edge off that gives a zero-length line and no edge at all, which is
		// the l3-against-l4 the signature diff caught on 42 paths.
		/** @type {?import('./model.js').Point} */
		let last = null;
		let closed = false;

		const flush = () =>
		{
			const rectangle = asRectangle(sub, corners, closed);
			if (rectangle)
			{
				items.push(rectangle);
			}
			else
			{
				items.push(...sub);
				// The closing edge IS a segment, and this was measured rather
				// than assumed - see the note on CLOSE_PATH below.
				if (closed && last && start && (last.x !== start.x || last.y !== start.y))
				{
					items.push(['l', last, start]);
				}
			}
			sub = [];
			corners = [];
			closed = false;
			last = null;
		};

		let at = 0;
		while (at < chunk.length)
		{
			const command = chunk[at];
			const arity = ARITY[command];
			if (arity === undefined)
			{
				// An unknown command means the stream cannot be walked past
				// this point - the arities are what make it self-delimiting -
				// so the rest of this path is abandoned rather than guessed at.
				break;
			}
			at += 1;
			if (command === MOVE_TO)
			{
				flush();
				current = apply(ctm, chunk[at], chunk[at + 1]);
				start = current;
				last = current;
				corners.push(current);
				points.push(current);
			}
			else if (command === LINE_TO)
			{
				const next = apply(ctm, chunk[at], chunk[at + 1]);
				if (current)
				{
					sub.push(['l', current, next]);
				}
				corners.push(next);
				points.push(next);
				current = next;
				last = next;
			}
			else if (command === CURVE_TO || command === QUADRATIC_CURVE_TO)
			{
				sub.push(['c']);
				// Enough to stop the subpath being mistaken for a rectangle,
				// whatever the control points happen to be.
				corners.push({x: NaN, y: NaN});
				for (let k = 0; k < arity; k += 2)
				{
					points.push(apply(ctm, chunk[at + k], chunk[at + k + 1]));
				}
				current = apply(ctm, chunk[at + arity - 2], chunk[at + arity - 1]);
				last = current;
			}
			else if (command === CLOSE_PATH)
			{
				// Recorded, and turned into a segment by `flush` unless the
				// subpath is a rectangle. Which of those two MuPDF does was the
				// one thing here that had to be measured rather than reasoned
				// out, and the count that settled it was not the one it looked
				// like: emitting every closing edge put 2549 lines in the
				// filled layer against pymupdf's 2353, and the 196 difference
				// is not the closes at all - it is the 49 RECTANGLES, at four
				// lines each, which MuPDF reports as one `re` item carrying no
				// segments. Suppressing the closes instead fixed that total and
				// broke 42 paths individually, every one of them an `l4` in
				// Python against an `l3` here.
				closed = true;
				current = start;
			}
			at += arity;
		}
		flush();
	}

	if (!items.length)
	{
		return null;
	}
	return {
		colour: stroked ? stroke : null,
		width: stroked ? lineWidth * scaleOf(ctm) : 0,
		fill: filled ? fill : null,
		rect: boundsOf(points),
		items,
	};
}

/**
 * A PDF grey level as r,g,b.
 *
 * @param {number} value
 * @returns {?number[]}
 */
function greyOf(value)
{
	return Number.isFinite(value) ? [value, value, value] : null;
}

/**
 * CMYK as r,g,b, by the naive conversion every viewer uses for device CMYK.
 *
 * Not colour-managed, and it does not need to be: the value is only ever used
 * as part of a layer KEY, so what matters is that two paths drawn with the
 * same ink land on the same hex and two drawn with different ink do not.
 *
 * @param {number[]} args
 * @returns {?number[]}
 */
function cmykOf(args)
{
	if (!args || args.length < 4 || !args.every((v) => Number.isFinite(v)))
	{
		return null;
	}
	const [c, m, y, k] = args;
	return [
		Math.max(0, 1 - Math.min(1, c + k)),
		Math.max(0, 1 - Math.min(1, m + k)),
		Math.max(0, 1 - Math.min(1, y + k)),
	];
}

/**
 * What `setFillColorN` / `setStrokeColorN` paints with.
 *
 * pdf.js hands a pattern over as `['TilingPattern', ...]` or
 * `['RadialAxial', ...]` - a name, then the pattern's own content. There is no
 * single colour in that, so it comes back as none. Where the arguments are
 * numbers instead, they are a colour in the current space and are read by
 * count, the way the operator's own arity defines them.
 *
 * @param {any[]} args
 * @returns {?number[]}
 */
function colourOfN(args)
{
	if (!args || !args.length || typeof args[0] === 'string')
	{
		return null;
	}
	const numbers = args.filter((value) => Number.isFinite(value));
	if (numbers.length === 1)
	{
		return greyOf(numbers[0]);
	}
	if (numbers.length === 3)
	{
		return numbers.map((value) => Math.min(1, Math.max(0, value)));
	}
	if (numbers.length === 4)
	{
		return cmykOf(numbers);
	}
	return null;
}

/**
 * A closed axis-aligned four-cornered subpath, as the single item MuPDF
 * reports for one - or the subpath unchanged when it is anything else.
 *
 * MuPDF turns a rectangle back into a rectangle: `get_drawings()` gives it as
 * one `('re', Rect)` item, and `layers.split` reads only `l` and `c` items, so
 * in Python a filled box contributes NO horizontal or vertical runs. Emitting
 * its edges as lines instead does not merely differ - it hands the wall tracer
 * four face lines per cabinet fill, on a drawing where telling a wall from a
 * cabinet is the whole problem.
 *
 * Measured on the sample sheet: 24 extra lines and 648pt of extra ink, being
 * the three surviving edges of eight rectangles.
 *
 * ## A rectangle is closed two different ways
 *
 * The `re` operator arrives as `moveTo` + three `lineTo` + `closePath`, which
 * is the case this first handled. A drafter's export also writes them the long
 * way - `moveTo` + FOUR `lineTo`, the last one back to the start, with or
 * without a closePath after it - and MuPDF calls both a rectangle.
 *
 * Requiring the first shape silently let the second through as four lines.
 * Measured on a LayOut sheet: 36 runs the Python did not have, in pairs
 * forming 9 boxes - 9 x 43.25in, 6 x 37in, 9 x 33in - which are cabinets and
 * fixtures being handed to the wall tracer as face lines. It moved that
 * sheet's structure ranking onto the wrong pen.
 *
 * @param {import('./model.js').PathItem[]} sub
 * @param {import('./model.js').Point[]} corners
 * @param {boolean} closed
 * @returns {?import('./model.js').PathItem} The single item, or null when this
 * subpath is not a rectangle and keeps the segments it already has.
 */
function asRectangle(sub, corners, closed)
{
	// A trailing point back on the start is the same closure a `closePath`
	// states, so it is dropped and the shape judged on its four real corners.
	let points = corners;
	let ends = closed;
	if (points.length === 5
		&& near(points[0].x, points[4].x) && near(points[0].y, points[4].y))
	{
		points = points.slice(0, 4);
		ends = true;
	}
	if (!ends || points.length !== 4 || sub.length < 3 || sub.length > 4)
	{
		return null;
	}
	const [a, b, c, d] = points;
	// Relative, not exact. MuPDF decides this on the path BEFORE the transform,
	// where an `re` is a perfect rectangle whatever the matrix then does to it;
	// here the corners arrive already transformed, so a box drawn under a
	// slightly rotated matrix is a hair off axis. Measured on a LayOut sheet:
	// 0.06in out over 29in, about a tenth of a degree, which left twelve box
	// edges leaking into the wall layer. Half a percent is far below the 0.3in
	// the tracer itself calls axis-aligned.
	const size = Math.max(
		Math.abs(a.x - c.x), Math.abs(a.y - c.y),
		Math.abs(b.x - d.x), Math.abs(b.y - d.y));
	const tol = Math.max(1e-6, size * 5e-3);
	const square = (
		(near(a.y, b.y, tol) && near(b.x, c.x, tol) && near(c.y, d.y, tol) && near(d.x, a.x, tol))
		|| (near(a.x, b.x, tol) && near(b.y, c.y, tol) && near(c.x, d.x, tol) && near(d.y, a.y, tol)));
	return square ? ['re'] : null;
}

/**
 * Equal to within a rounding error a transform could have introduced. Not an
 * exact test: the corners have been through a float32 path stream and an
 * affine transform, and a rectangle drawn as one is still a rectangle.
 *
 * @param {number} one
 * @param {number} two
 * @param {number} [tol]
 */
function near(one, two, tol = 1e-6)
{
	return Math.abs(one - two) < tol;
}

/** Exported for the tests that pin the command codes against pdf.js. */
export const PATH_COMMANDS = {MOVE_TO, LINE_TO, CURVE_TO, QUADRATIC_CURVE_TO, CLOSE_PATH, ARITY, IDENTITY};
