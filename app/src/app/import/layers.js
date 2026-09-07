// @ts-check
/**
 * Split a sheet by pen, and rank which pen drew the structure.
 *
 * A port of `tools/layers.py`. The rules and the failures behind them are
 * recorded in AGENTS.md under "Split by pen before you measure anything" and
 * are not repeated here; what follows is only what a reader of THIS file needs.
 *
 * A layer is **(stroke colour, stroke width, fill)** - all three. Neither
 * colour nor width alone separates, proven on two drafters who share no
 * conventions: one sheet is every pen at 0.5pt separated entirely by colour,
 * the other every pen black separated entirely by width. Fill belongs in the
 * key and is not decoration - one drafter poche-fills walls, another fills
 * cabinets and leaves walls hollow.
 *
 * Geometry comes out in REAL INCHES, already sorted into horizontal runs,
 * vertical runs and diagonals, because that is what every consumer wants.
 */

import {containsPoint, hexOf, overlaps} from './readers/model.js';
import {pyRound} from './round.js';

/** A run shorter than this is not measured; it is a tick or a corner. */
const MIN_MEASURE_IN = 1.0;
/** How far off axis a segment may be and still count as axis aligned. */
const AXIS_TOL = 0.3;

/** The gap band `pair_gaps` tallies over. Wide, since it is only evidence. */
const PAIR_MIN_IN = 2.0;
const PAIR_MAX_IN = 14.0;
/** Two runs must lie alongside each other this far to be a pair. */
const PAIR_OVERLAP_IN = 18.0;

/** The band a layer's commonest gap must fall in to look like construction. */
const WALL_GAP_MIN_IN = 2.5;
const WALL_GAP_MAX_IN = 8.5;

/** A layer with fewer segments than this is not judged at all. */
const MIN_SEGMENTS = 20;

/**
 * @typedef {object} Layer
 * @property {?string} colour
 * @property {number} width
 * @property {?string} fill
 * @property {Array<number[]>} horizontal `[coord, lo, hi]`, in inches.
 * @property {Array<number[]>} vertical
 * @property {Array<number[]>} diagonal `[ax, ay, bx, by]`.
 * @property {number} curves
 * @property {number} paths
 * @property {Array<number[]>} rects
 * @property {number} segments
 * @property {number} ink
 * @property {number} axisShare
 * @property {?number[]} extent
 * @property {Record<string, number>} pairs
 */

/**
 * The key a layer is filed under. A string because it is a map key, and
 * because it is exactly what `--layer "#000000,0.5"` types on the command
 * line.
 *
 * @param {?string} colour
 * @param {number} width
 * @param {?string} fill
 */
export function layerKey(colour, width, fill)
{
	return `${colour || 'none'},${width},${fill || 'none'}`;
}

/**
 * Parse a layer key, as `--layer` does: `"#000000,0.5"` or `"none,0,#646464"`.
 *
 * @param {string} text
 */
export function parseKey(text)
{
	const parts = text.split(',').map((part) => part.trim());
	while (parts.length < 3)
	{
		parts.push('none');
	}
	const blank = (part) => ['none', '-', ''].includes(part.toLowerCase());
	return layerKey(
		blank(parts[0]) ? null : parts[0],
		blank(parts[1]) ? 0 : Number(parts[1]),
		blank(parts[2]) ? null : parts[2]);
}

/**
 * Every path in `clip`, grouped by pen.
 *
 * @param {import('./readers/model.js').DrawnPath[]} paths
 * @param {number[]} clip In points.
 * @param {number} scale Real inches per point.
 * @returns {Map<string, Layer>}
 */
export function split(paths, clip, scale)
{
	/** @type {Map<string, Layer>} */
	const layers = new Map();

	for (const path of paths)
	{
		if (!overlaps(clip, path.rect))
		{
			continue;
		}
		const colour = hexOf(path.colour);
		const width = pyRound(path.width || 0, 2);
		const fill = hexOf(path.fill);
		const key = layerKey(colour, width, fill);

		let layer = layers.get(key);
		if (!layer)
		{
			layer = {
				colour, width, fill,
				horizontal: [], vertical: [], diagonal: [],
				curves: 0, paths: 0, rects: [],
				segments: 0, ink: 0, axisShare: 0, extent: null, pairs: {},
			};
			layers.set(key, layer);
		}
		layer.paths += 1;
		if (path.fill)
		{
			layer.rects.push([
				path.rect[0] * scale, path.rect[1] * scale,
				path.rect[2] * scale, path.rect[3] * scale,
			]);
		}

		for (const item of path.items)
		{
			if (item[0] === 'c')
			{
				layer.curves += 1;
				continue;
			}
			if (item[0] !== 'l')
			{
				continue;
			}
			const a = item[1];
			const b = item[2];
			if (!containsPoint(clip, a) || !containsPoint(clip, b))
			{
				continue;
			}
			const ax = a.x * scale;
			const ay = a.y * scale;
			const bx = b.x * scale;
			const by = b.y * scale;
			if (Math.abs(ay - by) < AXIS_TOL && Math.abs(ax - bx) >= AXIS_TOL)
			{
				layer.horizontal.push([ay, Math.min(ax, bx), Math.max(ax, bx)]);
			}
			else if (Math.abs(ax - bx) < AXIS_TOL && Math.abs(ay - by) >= AXIS_TOL)
			{
				layer.vertical.push([ax, Math.min(ay, by), Math.max(ay, by)]);
			}
			else if (Math.abs(ax - bx) >= AXIS_TOL || Math.abs(ay - by) >= AXIS_TOL)
			{
				layer.diagonal.push([ax, ay, bx, by]);
			}
		}
	}

	for (const layer of layers.values())
	{
		describe(layer);
	}
	return layers;
}

/**
 * Measure a layer, so it can be judged without being looked at.
 *
 * @param {Layer} layer
 */
export function describe(layer)
{
	const runs = layer.horizontal.concat(layer.vertical);
	let axisInk = 0;
	for (const [, lo, hi] of runs)
	{
		if (hi - lo >= MIN_MEASURE_IN)
		{
			axisInk += hi - lo;
		}
	}
	let diagonalInk = 0;
	for (const [ax, ay, bx, by] of layer.diagonal)
	{
		const length = Math.hypot(bx - ax, by - ay);
		if (length >= MIN_MEASURE_IN)
		{
			diagonalInk += length;
		}
	}

	const xs = layer.vertical.map(([c]) => c)
		.concat(layer.horizontal.flatMap(([, lo, hi]) => [lo, hi]));
	const ys = layer.horizontal.map(([c]) => c)
		.concat(layer.vertical.flatMap(([, lo, hi]) => [lo, hi]));

	layer.segments = runs.length + layer.diagonal.length;
	layer.ink = axisInk + diagonalInk;
	layer.axisShare = (axisInk + diagonalInk) ? axisInk / (axisInk + diagonalInk) : 0;
	layer.extent = (xs.length && ys.length)
		? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
		: null;
	layer.pairs = pairGaps(layer);
	return layer;
}

/**
 * Gaps between parallel runs that lie alongside each other, tallied.
 *
 * A wall layer piles these onto one or two values - the thicknesses that
 * drafter builds in - because a wall is two faces a construction thickness
 * apart, held over the whole sheet. A cabinet layer scatters them across every
 * depth in the kitchen; an annotation layer produces none.
 *
 * @param {Layer} layer
 * @returns {Record<string, number>}
 */
export function pairGaps(layer)
{
	/** @type {Record<string, number>} */
	const tally = {};
	for (const runs of [layer.horizontal, layer.vertical])
	{
		const ordered = sortRuns(runs);
		for (let index = 0; index < ordered.length; index += 1)
		{
			const [c1, lo1, hi1] = ordered[index];
			for (let other = index + 1; other < ordered.length; other += 1)
			{
				const [c2, lo2, hi2] = ordered[other];
				const gap = c2 - c1;
				// Sorted by coordinate, so once the gap is too wide every
				// later run is too.
				if (gap > PAIR_MAX_IN)
				{
					break;
				}
				if (gap < PAIR_MIN_IN)
				{
					continue;
				}
				const overlap = Math.min(hi1, hi2) - Math.max(lo1, lo2);
				if (overlap >= PAIR_OVERLAP_IN)
				{
					const bucket = pyRound(gap * 2) / 2;
					tally[bucket] = (tally[bucket] || 0) + overlap;
				}
			}
		}
	}
	return tally;
}

/**
 * Python sorts tuples element by element, and the pairing above depends on
 * the runs being in coordinate order for its `break` to be sound.
 *
 * @param {Array<number[]>} runs
 */
export function sortRuns(runs)
{
	return runs.slice().sort((one, two) =>
		(one[0] - two[0]) || (one[1] - two[1]) || (one[2] - two[2]));
}

/**
 * How much of a layer's pairing sits on its single commonest gap. High means
 * one repeated thickness, which is construction; low means a scatter of
 * depths, which is cabinetry.
 *
 * Reported but NOT ranked on - see `rank`.
 *
 * @param {Layer} layer
 */
export function concentration(layer)
{
	const values = Object.values(layer.pairs);
	if (!values.length)
	{
		return 0;
	}
	return Math.max(...values) / values.reduce((sum, value) => sum + value, 0);
}

/**
 * Score every layer for how much it looks like the structure of a house.
 *
 * Ink, times how axis-aligned it is, times how much of the plan it reaches -
 * and NOT concentration, which inverts the answer: a run of kitchen cabinets
 * is parallel lines at one repeated depth and scores 1.00, while a real house
 * has several wall thicknesses and scores 0.31.
 *
 * A layer still has to pair up SOMEWHERE at a thickness someone could build,
 * which is what keeps the dimension strings out - they are long, dead straight
 * and reach further than the building, so spread actively rewards them, but
 * they pair at 9in where the walls pair at 3.5.
 *
 * @param {Map<string, Layer>} layers
 * @param {number} pageAreaSqIn
 */
export function rank(layers, pageAreaSqIn)
{
	const scored = [];
	for (const [key, layer] of layers)
	{
		if (layer.segments < MIN_SEGMENTS || !layer.extent)
		{
			continue;
		}
		const [x0, y0, x1, y1] = layer.extent;
		const spread = pageAreaSqIn ? ((x1 - x0) * (y1 - y0)) / pageAreaSqIn : 0;

		let gap = null;
		let best = -Infinity;
		for (const [bucket, weight] of Object.entries(layer.pairs))
		{
			if (weight > best)
			{
				best = weight;
				gap = Number(bucket);
			}
		}
		const buildable = gap !== null && gap >= WALL_GAP_MIN_IN && gap <= WALL_GAP_MAX_IN;
		scored.push({
			key,
			layer,
			spread,
			concentration: concentration(layer),
			structure: buildable ? layer.ink * layer.axisShare * spread : 0,
			modalGap: gap,
		});
	}
	return scored.sort((one, two) => two.structure - one.structure);
}

/**
 * The layer the walls are drawn on, as horizontal and vertical runs.
 *
 * @param {import('./readers/model.js').DrawnPath[]} paths
 * @param {number[]} clip
 * @param {number} scale
 * @param {?string} [override] A layer key, for when the ranking is wrong -
 * which it will be sometimes, and `listLayers` is how a person finds out.
 */
export function structure(paths, clip, scale, override = null)
{
	const found = split(paths, clip, scale);
	if (override)
	{
		const layer = found.get(override);
		if (!layer)
		{
			throw new Error(
				`This drawing has no layer ${override}. Pick one of: `
				+ [...found.keys()].join('  '));
		}
		return {horizontal: layer.horizontal, vertical: layer.vertical, key: override, layers: found};
	}
	const area = (clip[2] - clip[0]) * scale * (clip[3] - clip[1]) * scale;
	const ordered = rank(found, area);
	if (!ordered.length || !ordered[0].structure)
	{
		throw new Error(
			'No layer in this region looks like the structure of a building. '
			+ 'Check the region covers the floor plan, and that the scale is right.');
	}
	return {
		horizontal: ordered[0].layer.horizontal,
		vertical: ordered[0].layer.vertical,
		key: ordered[0].key,
		layers: found,
		ranked: ordered,
	};
}

/**
 * Every layer in the region, best-ranked first, for the layer picker.
 *
 * The ranking is wrong sometimes and is deliberately not tuned to any one
 * drawing, so the interface offers the alternatives rather than hiding them.
 *
 * @param {import('./readers/model.js').DrawnPath[]} paths
 * @param {number[]} clip
 * @param {number} scale
 */
export function listLayers(paths, clip, scale)
{
	const found = split(paths, clip, scale);
	const area = (clip[2] - clip[0]) * scale * (clip[3] - clip[1]) * scale;
	const ranked = rank(found, area);
	const seen = new Set(ranked.map((entry) => entry.key));
	// The ones rank() would not look at are still offered, last and marked,
	// because "too few segments" is a property of the CLIP as much as of the
	// layer - a region drawn tight around one room can put the wall pen below
	// the floor.
	const rest = [...found.entries()]
		.filter(([key]) => !seen.has(key))
		.map(([key, layer]) => ({key, layer, spread: 0, structure: 0, modalGap: null,
			concentration: concentration(layer)}));

	return [...ranked, ...rest].map((entry) => ({
		key: entry.key,
		colour: entry.layer.colour,
		width: entry.layer.width,
		fill: entry.layer.fill,
		segments: entry.layer.segments,
		ink: entry.layer.ink,
		structure: entry.structure,
		modalGap: entry.modalGap,
	}));
}
