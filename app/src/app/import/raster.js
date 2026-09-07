// @ts-check
/**
 * Pictures of a drawing: page thumbnails to choose from, and the traced region
 * as a carbon sheet to lay under the plan.
 *
 * Kept apart from everything else in `import/` because it is the only part
 * that needs a canvas. The tracer is pure arithmetic over the reader's paths
 * and runs headlessly, which is what lets the whole pipeline be tested in node
 * against the Python; a `document.createElement` anywhere inside it would end
 * that. The geometry that decides what to draw is `regionCanvas` below, which
 * is pure and tested; the three drawing functions are thin.
 */

import {SYMBOLS, wanted} from './symbols.js';

/** Dots per inch for the carbon sheet, matching `tools/build.py`. */
export const UNDERLAY_DPI = 150;
/** Dots per inch for a page thumbnail in the picker. */
export const THUMBNAIL_DPI = 18;
/** Dots per inch for the page a region is dragged on. */
export const PREVIEW_DPI = 96;
/**
 * Dots per inch for the check render. Higher than the preview, because the
 * whole point of it is to see whether a wall is a few inches out.
 */
export const CHECK_DPI = 130;

/**
 * A canvas big enough for `clip` at `dpi`, and the transform that puts page
 * points into it.
 *
 * Separated out because it is the whole of the arithmetic and none of the
 * platform: a point is 1/72in, so a page coordinate becomes a device pixel by
 * scaling and then shifting the clip's corner to the origin.
 *
 * @param {number[]} clip `[x0, y0, x1, y1]` in points.
 * @param {number} dpi
 * @param {number} [max] Largest edge in pixels. A 36x48in sheet at 150dpi is
 * 5400x7200, which is 155MB of canvas and is refused outright by some browsers
 * - and a browser that refuses returns a blank one rather than throwing.
 */
export function regionCanvas(clip, dpi, max = 4096)
{
	const scale = dpi / 72;
	const width = (clip[2] - clip[0]) * scale;
	const height = (clip[3] - clip[1]) * scale;
	const shrink = Math.min(1, max / Math.max(width, height, 1));
	const applied = scale * shrink;
	return {
		scale: applied,
		width: Math.max(1, Math.round(width * shrink)),
		height: Math.max(1, Math.round(height * shrink)),
		// Page points to device pixels: `[a, b, c, d, e, f]`. Written as a
		// subtraction from zero rather than a negation so that a clip at the
		// origin gives +0 and not -0 - the same number to arithmetic, a
		// different one to any test that compares identities.
		transform: [applied, 0, 0, applied, 0 - clip[0] * applied, 0 - clip[1] * applied],
	};
}

/**
 * @param {number} width
 * @param {number} height
 */
function makeCanvas(width, height)
{
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context)
	{
		throw new Error('This browser would not give the importer a 2D canvas.');
	}
	// White rather than transparent: this becomes a carbon sheet drawn under
	// the plan, and a transparent one shows the grid through the paper.
	context.fillStyle = '#ffffff';
	context.fillRect(0, 0, width, height);
	return {canvas, context};
}

/**
 * Render part of a page to a PNG data URL.
 *
 * @param {import('./readers/index.js').Sheet} sheet
 * @param {number} page
 * @param {object} [options]
 * @param {number[]} [options.clip] Defaults to the whole page.
 * @param {number} [options.dpi]
 * @param {number} [options.max]
 * @returns {Promise<{url: string, width: number, height: number}>}
 */
export async function renderRegion(sheet, page, options = {})
{
	const size = sheet.pages[page - 1];
	const clip = options.clip || [0, 0, size.width, size.height];
	const dpi = options.dpi || PREVIEW_DPI;
	const region = regionCanvas(clip, dpi, options.max);
	const {canvas, context} = makeCanvas(region.width, region.height);

	if (sheet.kind === 'pdf')
	{
		await drawPdf(sheet, page, context, region);
	}
	else if (sheet.kind === 'svg')
	{
		await drawSvg(sheet, context, region, clip);
	}
	else
	{
		drawPaths(await sheet.paths(page), context, region);
	}

	return {url: canvas.toDataURL('image/png'), width: region.width, height: region.height};
}

/**
 * @param {any} sheet
 * @param {number} number
 * @param {CanvasRenderingContext2D} context
 * @param {ReturnType<regionCanvas>} region
 */
async function drawPdf(sheet, number, context, region)
{
	const page = await sheet.document.getPage(number);
	// The viewport carries the page's own flip and rotation; `transform` then
	// applies the region's scale and offset on top, which is how pdf.js is
	// meant to be asked for part of a page.
	const viewport = page.getViewport({scale: 1});
	await page.render({
		canvasContext: context,
		viewport,
		transform: region.transform,
	}).promise;
	page.cleanup();
}

/**
 * @param {any} sheet
 * @param {CanvasRenderingContext2D} context
 * @param {ReturnType<regionCanvas>} region
 * @param {number[]} clip
 */
async function drawSvg(sheet, context, region, clip)
{
	// The browser renders SVG better than this module ever will - gradients,
	// dashes, text and all - so the file is handed to an <img> rather than
	// redrawn from the parsed paths.
	const blob = new Blob([sheet.text], {type: 'image/svg+xml'});
	const url = URL.createObjectURL(blob);
	try
	{
		const image = await new Promise((resolve, reject) =>
		{
			const element = new Image();
			element.onload = () => resolve(element);
			element.onerror = () => reject(new Error('That SVG could not be drawn.'));
			element.src = url;
		});
		const page = sheet.pages[0];
		context.drawImage(
			/** @type {HTMLImageElement} */ (image),
			-clip[0] * region.scale, -clip[1] * region.scale,
			page.width * region.scale, page.height * region.scale);
	}
	finally
	{
		URL.revokeObjectURL(url);
	}
}

/**
 * Draw the reader's own paths. The DXF case, where there is no page to render
 * and the linework IS the drawing.
 *
 * @param {import('./readers/model.js').DrawnPath[]} paths
 * @param {CanvasRenderingContext2D} context
 * @param {ReturnType<regionCanvas>} region
 */
export function drawPaths(paths, context, region)
{
	context.save();
	context.transform(...(/** @type {[number, number, number, number, number, number]} */
		(region.transform)));
	context.lineCap = 'butt';
	for (const path of paths)
	{
		if (!path.colour)
		{
			continue;
		}
		context.strokeStyle = cssOf(path.colour);
		// Hairlines rather than nothing: a DXF layer with no lineweight set is
		// the normal case, and a zero-width stroke draws nothing at all.
		context.lineWidth = Math.max(path.width || 0, 0.5) / region.scale;
		context.beginPath();
		for (const item of path.items)
		{
			if (item[0] !== 'l')
			{
				continue;
			}
			context.moveTo(item[1].x, item[1].y);
			context.lineTo(item[2].x, item[2].y);
		}
		context.stroke();
	}
	context.restore();
}

/**
 * @param {number[]} colour
 */
function cssOf(colour)
{
	const byte = (value) => Math.max(0, Math.min(255, Math.round(value * 255)));
	return `rgb(${byte(colour[0])}, ${byte(colour[1])}, ${byte(colour[2])})`;
}

/**
 * What each kind of opening is drawn in, matching `opening_truth.COLOUR`
 * exactly so a check made here and one made on the command line look the same.
 */
export const OPENING_COLOURS = {
	window: 'rgb(26, 89, 242)',
	door: 'rgb(217, 26, 179)',
	cased: 'rgb(242, 153, 13)',
	unknown: 'rgb(115, 115, 115)',
};

/** The traced walls, in the red `box_check.py` draws them in. */
export const WALL_COLOUR = 'rgb(255, 0, 0)';
/** The face lines the walls were built from, in `box_check.py`'s blue. */
export const FACE_COLOUR = 'rgb(0, 0, 255)';

/**
 * The traced region with what was found drawn over it.
 *
 * This is `box_check.py` and `opening_truth.py` in the dialog, and it exists
 * for the reason AGENTS.md gives for both of them: **numbers do not show a
 * wall in the wrong place.** A box list that reads perfectly well was three
 * chunks at the windows of a wall that is continuous, and one render showed it
 * instantly. A wall count and an overall size cannot catch that; a picture can,
 * and this one is shown before anything replaces the current design.
 *
 * The same colours as the Python, deliberately: red walls at 35% over the
 * drawing, blue face lines, and each opening in its own colour.
 *
 * @param {import('./readers/index.js').Sheet} sheet
 * @param {number} page
 * @param {object} check From `traceSheet`: `clip`, `scale`, `boxes`, `faces`,
 * `openings`.
 * @param {number} [dpi]
 * @returns {Promise<{url: string, width: number, height: number}>}
 */
export async function renderCheck(sheet, page, check, dpi = CHECK_DPI)
{
	const {clip, scale, boxes, faces, openings} = check;
	const region = regionCanvas(clip, dpi, 2200);
	const {canvas, context} = makeCanvas(region.width, region.height);

	if (sheet.kind === 'pdf')
	{
		await drawPdf(sheet, page, context, region);
	}
	else if (sheet.kind === 'svg')
	{
		await drawSvg(sheet, context, region, clip);
	}
	else
	{
		drawPaths(await sheet.paths(page), context, region);
	}

	// Inches to device pixels. The tracer measures in real inches; the canvas
	// is the clip at `dpi`, so a length divided by the scale is a point, and a
	// point times the region's scale is a pixel.
	const px = (inches) => (inches / scale - clip[0]) * region.scale;
	const py = (inches) => (inches / scale - clip[1]) * region.scale;

	context.lineWidth = 1;
	context.strokeStyle = FACE_COLOUR;
	context.beginPath();
	for (const [coord, lo, hi] of (faces && faces[0]) || [])
	{
		context.moveTo(px(lo), py(coord));
		context.lineTo(px(hi), py(coord));
	}
	for (const [coord, lo, hi] of (faces && faces[1]) || [])
	{
		context.moveTo(px(coord), py(lo));
		context.lineTo(px(coord), py(hi));
	}
	context.stroke();

	for (const box of boxes || [])
	{
		const half = box.thickness / 2;
		// The DRAWN run, which closeCorners has already carried out to the
		// centreline of whatever each end meets - not `lo`..`hi`, which
		// includes the overshoot. The overshoot exists to make crossings
		// detectable and is a device rather than wall; drawing it hangs every
		// wall a full thickness past its corner.
		const rect = box.horizontal
			? [px(box.drawn_lo), py(box.centre - half), px(box.drawn_hi), py(box.centre + half)]
			: [px(box.centre - half), py(box.drawn_lo), px(box.centre + half), py(box.drawn_hi)];
		context.fillStyle = 'rgba(255, 0, 0, 0.35)';
		context.strokeStyle = WALL_COLOUR;
		context.lineWidth = 1;
		context.fillRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
		context.strokeRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
	}

	for (const opening of openings || [])
	{
		// A little proud of the wall on both faces, so an opening on a thin
		// partition is still visible against the wall it sits in.
		const half = Math.max(opening.thickness, 5) / 2 + 1.5;
		const colour = OPENING_COLOURS[opening.kind] || OPENING_COLOURS.unknown;
		const rect = opening.horizontal
			? [px(opening.lo), py(opening.centre - half), px(opening.hi), py(opening.centre + half)]
			: [px(opening.centre - half), py(opening.lo), px(opening.centre + half), py(opening.hi)];
		context.fillStyle = colour.replace('rgb(', 'rgba(').replace(')', ', 0.55)');
		context.strokeStyle = colour;
		context.lineWidth = 1.2;
		context.fillRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
		context.strokeRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
	}

	return {url: canvas.toDataURL('image/png'), width: region.width, height: region.height};
}

/**
 * Which pen each layer is, as a colour a swatch can show.
 *
 * @param {{colour: ?string, width: number, fill: ?string}} layer
 */
export function swatchOf(layer)
{
	return layer.colour || layer.fill || '#888888';
}

export {SYMBOLS, wanted};
