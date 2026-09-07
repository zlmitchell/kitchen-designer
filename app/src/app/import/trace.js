// @ts-check
/**
 * Turn a region of a drawing into an architect3d design.
 *
 * The one entry point for the whole importer, and a port of `tools/build.py`'s
 * `main()`. The stage order is the load-bearing part and is the same as the
 * Python's, for the reasons AGENTS.md gives: each stage consumes the one above
 * and nothing else, and almost every difficult bug in this tracer came from
 * asking a later question before an earlier one was settled.
 *
 *     1. LAYERS     split the sheet by (colour, width, fill)   layers.js
 *     2. WALLS      the structure layer -> boxes -> centrelines walls.js
 *     3. OPENINGS   symbols + face gaps -> windows and doors   openings.js
 *     4. ROOMS      the complement of the wall union           spaces.js
 *     5. WRITE      corners, walls, items                      design.js
 */

import {structure} from './layers.js';
import {trace as traceWalls} from './walls.js';
import {find, findBySymbol, hand, label, merge} from './openings.js';
import {
	CM_PER_INCH, WELD_IN, bridgeOpenings, design, fuseParallel, graph, itemsFor,
	markExterior, verify,
} from './design.js';

/** Ceiling height, in inches, when the caller does not say. */
export const DEFAULT_CEILING_IN = 96.0;

/**
 * @typedef {object} TraceOptions
 * @property {import('./readers/index.js').Sheet} sheet
 * @property {number} page 1-indexed.
 * @property {number[]} clip `[x0, y0, x1, y1]` in points.
 * @property {number} scale Real inches per point.
 * @property {number} [ceiling] Inches.
 * @property {?string} [layer] A layer key, overriding the ranking.
 * @property {boolean} [openDoors] Draw interior doors open. The plan drew the
 * swing for a reason, and a shut door hides that the opening leads anywhere.
 * @property {?{url: string, width: number, height: number, transparency?: number}} [underlay]
 * The traced region as an image, to place under the plan as a carbon sheet.
 * @property {() => string} [newId] Corner id source, for deterministic tests.
 * @property {(label: string, value: number) => void} [onProgress] Called at
 * each stage with a fraction 0..1. The stages are the ones worth naming to
 * somebody waiting: on a big sheet the linework read and the wall trace are
 * where the time goes.
 */

/**
 * @param {TraceOptions} options
 */
export async function traceSheet(options)
{
	const {
		sheet, page, clip, scale,
		ceiling = DEFAULT_CEILING_IN,
		layer = null,
		openDoors = true,
		underlay = null,
		newId = undefined,
		onProgress = () => {},
	} = options;

	if (!(scale > 0))
	{
		throw new Error('The drawing scale has to be a positive number of inches per point.');
	}
	if (!(clip[2] - clip[0] > 0) || !(clip[3] - clip[1] > 0))
	{
		throw new Error('Draw a box around the floor plan first.');
	}

	onProgress('Reading the linework…', 0.05);
	const paths = await sheet.paths(page);
	onProgress('Splitting the drawing by pen…', 0.3);
	const found = structure(paths, clip, scale, layer);
	onProgress('Tracing the walls…', 0.45);
	const traced = traceWalls(found.horizontal, found.vertical);
	if (!traced.boxes.length)
	{
		throw new Error(
			'No walls were traced in that region. Check the box covers the floor '
			+ 'plan and that the scale matches the drawing.');
	}

	onProgress('Finding the doors and windows…', 0.65);
	// Both detectors, unioned - see openings.js. The gap reader misses a
	// doorway whose swing is drawn out in the room; the symbol reader misses a
	// cased opening with nothing drawn in it at all.
	const openings = hand(
		merge(
			findBySymbol(traced, paths, clip, scale, found),
			label(find(traced), paths, clip, scale)),
		paths, clip, scale);

	// A box shorter than the weld tolerance cannot become a wall: the app
	// merges its two corners on load and the wall between them vanishes.
	const boxes = bridgeOpenings(traced.boxes, openings)
		.filter((box) => box.drawn_hi - box.drawn_lo >= WELD_IN);
	onProgress('Finding the rooms…', 0.82);
	markExterior(boxes, openings, clip, scale);

	const {corners, walls} = graph(fuseParallel(boxes), ceiling, null, newId);
	if (!corners.size)
	{
		throw new Error('The walls in that region did not join up into a plan.');
	}

	const values = [...corners.values()];
	const ox = Math.min(...values.map(([x]) => x));
	const oy = Math.min(...values.map(([, y]) => y));

	// Thickness goes with each opening so the item can be scaled to span its
	// wall. An in-wall item is placed flush to the near face at its own depth,
	// so a door narrower than the wall is simply buried in it.
	const items = itemsFor(openings.map((opening) => [
		opening.kind,
		opening.horizontal ? (opening.lo + opening.hi) / 2 : opening.centre,
		opening.horizontal ? opening.centre : (opening.lo + opening.hi) / 2,
		opening.width_in,
		opening.horizontal,
		opening.thickness,
		opening.hinge,
		opening.swing,
		opening.exterior,
	]), ox, oy, openDoors);

	onProgress('Writing the plan…', 0.95);
	const document = design(corners, walls, ceiling,
		underlayBlock(underlay, clip, scale, ox, oy), items);

	return {
		design: document,
		stats: statsFor(traced, boxes, corners, walls, openings, found),
		// What was traced, in real inches, so it can be DRAWN over the drawing
		// before anybody commits to it. AGENTS.md's "Look at it": numbers do
		// not show a wall in the wrong place, and a box list that reads
		// perfectly well was three chunks at the windows of a wall that is
		// continuous. `raster.renderCheck` is the consumer.
		check: {clip, scale, boxes, faces: traced.faces, openings},
	};
}

/**
 * The carbon-sheet block, in the units `useDesignIO.applyUnderlay` expects.
 *
 * Plain centimetres and raw image pixels, deliberately - NOT architect3d's own
 * `carbonSheet` fields, two of which do not mean what a saved file makes them
 * look like. `width`/`height` are pushed through `Dimensioning.cmFromMeasureRaw`
 * so they are in whatever unit is on screen, and `anchorX`/`anchorY` are
 * multiplied by a screen-pixels-per-image-pixel factor. Writing those here
 * would bake in the display unit at import time.
 *
 * @param {?{url: string, width: number, height: number, transparency?: number}} image
 * @param {number[]} clip
 * @param {number} scale
 * @param {number} ox Plan origin, in inches.
 * @param {number} oy
 */
function underlayBlock(image, clip, scale, ox, oy)
{
	if (!image || !image.url)
	{
		return null;
	}
	const widthIn = (clip[2] - clip[0]) * scale;
	const heightIn = (clip[3] - clip[1]) * scale;
	const perInch = image.width / widthIn;
	return {
		url: image.url,
		transparency: image.transparency ?? 0.5,
		widthCm: round(widthIn * CM_PER_INCH, 3),
		heightCm: round(heightIn * CM_PER_INCH, 3),
		// Where the plan's origin sits inside the image, in image pixels. The
		// traced walls are written relative to that origin, so this is what
		// lines the picture up with them.
		anchorXPx: round((ox - clip[0] * scale) * perInch, 2),
		anchorYPx: round((oy - clip[1] * scale) * perInch, 2),
	};
}

function round(value, places)
{
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}

/**
 * What the trace found, for the report the dialog shows before committing.
 *
 * The same numbers `build.py` prints, because they are the ones that tell you
 * whether a trace is right at a glance - total extent above all, which catches
 * a wrong scale instantly.
 */
function statsFor(traced, boxes, corners, walls, openings, found)
{
	const checks = verify(corners, walls);
	const values = [...corners.values()];
	const xs = values.map(([x]) => x);
	const ys = values.map(([, y]) => y);
	/** @type {Record<string, number>} */
	const kinds = {};
	for (const opening of openings)
	{
		kinds[opening.kind] = (kinds[opening.kind] || 0) + 1;
	}

	return {
		layer: found.key,
		layers: found.ranked
			? found.ranked.map((entry) => ({key: entry.key, structure: entry.structure}))
			: [],
		tracedBoxes: traced.boxes.length,
		bridgedBoxes: boxes.length,
		corners: corners.size,
		walls: walls.length,
		thicknesses: traced.thicknesses,
		widthFt: (Math.max(...xs) - Math.min(...xs)) / 12,
		heightFt: (Math.max(...ys) - Math.min(...ys)) / 12,
		offAxisIn: checks.off_axis_in,
		junctions: checks.junctions,
		dangling: checks.dangling,
		openings: kinds,
		openingCount: openings.length,
	};
}
