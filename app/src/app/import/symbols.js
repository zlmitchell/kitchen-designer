// @ts-check
/**
 * The symbol pen: what the drafter DREW in a wall, as opposed to the wall.
 *
 * A port of the parts of `tools/extract.py` that the box pipeline still uses -
 * `segments`, `diagonals`, `swing_boxes`, `jambs_on`, `spans_linework` and
 * `find_openings`. The lattice tracer around them is not ported; it was
 * superseded and `tools/AGENTS.md` says to retire it.
 *
 * ## Two pens answer two different questions
 *
 * Between consecutive jambs the architecture pen and the symbol pen are near
 * perfect complements. Measured on the north wall of the kitchen plan:
 *
 *     span 107in   architecture 100%   symbol   1%    solid wall
 *     span  18in   architecture   0%   symbol 100%    opening
 *     span  92in   architecture 100%   symbol  24%    solid wall
 *     span  32in   architecture   0%   symbol 100%    opening
 *
 * So the wall's own pen says WHERE it stops, and the symbol pen says WHAT is
 * in the hole. A window's glazing connects the two jambs, one run corner to
 * corner; a door does not, because a swing is an arc off to one side and a
 * bypass slider is two leaves that overlap and stop short.
 *
 * ## A note on tolerances
 *
 * The axis tests here are in POINTS, not inches - `abs(a.y - b.y) < 0.3` is
 * applied to the page coordinates before the scale is multiplied in. That
 * differs from `layers.split`, which scales first and then compares in inches,
 * and the difference is deliberate in the original. Both are ported as they
 * are.
 */

import {containsPoint} from './readers/model.js';

/** The architecture pen: black, exactly. */
export const ARCHITECTURE = [0, 0, 0];

/**
 * The symbol pen: any neutral grey. Every door and window on the reference
 * sheet - jambs, swing arcs, bypass panels - is drawn in one, and nothing else
 * is. Taking swings from every pen instead returned the shaded cabinet runs as
 * one enormous door.
 */
export const SYMBOLS = 'grey';

/** A traced pair of lines is a wall if it is between these two apart. */
const WALL_MIN_IN = 3.0;
const WALL_MAX_IN = 9.0;

/** An opening the symbol reader will admit to. Wider than opening_truth's. */
const MIN_OPENING_IN = 18.0;
const MAX_OPENING_IN = 144.0;

const SWING_MIN_IN = 18.0;
const SWING_MAX_IN = 44.0;
/** A swing is a few long chords; hatching is hundreds. */
const SWING_MAX_SEGMENTS = 14;
const ON_WALL_TOL_IN = 6.0;

/** A jamb must reach this fraction of the wall's own thickness. */
const MIN_JAMB_SPAN = 0.6;
/** A window's glazing runs jamb to jamb. */
const CONNECTED = 0.92;
const GLAZING_TOL_IN = 4.0;

/**
 * Is this path drawn with the pen we asked for?
 *
 * @param {import('./readers/model.js').DrawnPath} path
 * @param {?number[]|string} colour
 */
export function wanted(path, colour)
{
	if (colour === null || colour === undefined)
	{
		return true;
	}
	const stroke = path.colour;
	if (colour === SYMBOLS)
	{
		return (!!stroke
			&& Math.abs(stroke[0] - stroke[1]) < 1e-6
			&& Math.abs(stroke[1] - stroke[2]) < 1e-6
			&& stroke[0] > 0.15 && stroke[0] < 0.85);
	}
	if (!stroke || !Array.isArray(colour))
	{
		return false;
	}
	return stroke[0] === colour[0] && stroke[1] === colour[1] && stroke[2] === colour[2];
}

/**
 * Axis-aligned line segments inside `clip`, in real inches.
 *
 * @param {import('./readers/model.js').DrawnPath[]} paths
 * @param {number[]} clip
 * @param {number} k Real inches per point.
 * @param {?number[]|string} [colour]
 * @returns {{horizontal: Array<number[]>, vertical: Array<number[]>}}
 */
export function segments(paths, clip, k, colour = ARCHITECTURE)
{
	/** @type {Array<number[]>} */
	const horizontal = [];
	/** @type {Array<number[]>} */
	const vertical = [];
	for (const path of paths)
	{
		if (!wanted(path, colour))
		{
			continue;
		}
		for (const item of path.items)
		{
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
			if (Math.abs(a.y - b.y) < 0.3 && Math.abs(a.x - b.x) > 0.5)
			{
				horizontal.push([a.y * k, Math.min(a.x, b.x) * k, Math.max(a.x, b.x) * k]);
			}
			else if (Math.abs(a.x - b.x) < 0.3 && Math.abs(a.y - b.y) > 0.5)
			{
				vertical.push([a.x * k, Math.min(a.y, b.y) * k, Math.max(a.y, b.y) * k]);
			}
		}
	}
	return {horizontal, vertical};
}

/**
 * Segments that are neither horizontal nor vertical: arcs, mostly.
 *
 * @param {import('./readers/model.js').DrawnPath[]} paths
 * @param {number[]} clip
 * @param {number} k
 * @param {?number[]|string} [colour]
 * @returns {Array<number[]>}
 */
export function diagonals(paths, clip, k, colour = ARCHITECTURE)
{
	const out = [];
	for (const path of paths)
	{
		if (!wanted(path, colour))
		{
			continue;
		}
		for (const item of path.items)
		{
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
			if (Math.abs(a.x - b.x) > 0.3 && Math.abs(a.y - b.y) > 0.3)
			{
				out.push([
					Math.min(a.x, b.x) * k, Math.min(a.y, b.y) * k,
					Math.max(a.x, b.x) * k, Math.max(a.y, b.y) * k,
				]);
			}
		}
	}
	return out;
}

/**
 * Cluster arc chords into door swings, and reject the hatching.
 *
 * @param {Array<number[]>} diags
 * @returns {Array<number[]>}
 */
export function swingBoxes(diags)
{
	/** @type {Array<number[]>} */
	const groups = [];
	for (const box of diags)
	{
		let placed = false;
		for (const group of groups)
		{
			if (!(box[0] > group[2] + 3 || box[2] < group[0] - 3
				|| box[1] > group[3] + 3 || box[3] < group[1] - 3))
			{
				group[0] = Math.min(group[0], box[0]);
				group[1] = Math.min(group[1], box[1]);
				group[2] = Math.max(group[2], box[2]);
				group[3] = Math.max(group[3], box[3]);
				group[4] += 1;
				placed = true;
				break;
			}
		}
		if (!placed)
		{
			groups.push([box[0], box[1], box[2], box[3], 1]);
		}
	}

	const swings = [];
	for (const [x0, y0, x1, y1, count] of groups)
	{
		const width = x1 - x0;
		const height = y1 - y0;
		// Square-ish, door-sized, and cheap to draw. A shaded cabinet run is
		// hundreds of chords in a box this size and would otherwise read as an
		// enormous door.
		if (count <= SWING_MAX_SEGMENTS
			&& width >= SWING_MIN_IN && width <= SWING_MAX_IN
			&& height >= SWING_MIN_IN && height <= SWING_MAX_IN
			&& width / height >= 0.6 && width / height <= 1.6)
		{
			swings.push([x0, y0, x1, y1]);
		}
	}
	return swings;
}

/**
 * Where a wall is interrupted, in wall-length coordinates.
 *
 * A jamb is a short line drawn across the wall's thickness at each side of an
 * opening. Nothing else in a floor plan is a stub exactly one wall thick
 * sitting astride a wall's centreline, which makes this the sharp edge of the
 * detection: the glazing says WHAT the opening is, the jambs say exactly where
 * it starts and stops.
 *
 * The span floor is what separates a jamb from a symbol drawn INSIDE the wall.
 * A casement operator is a 3.0in mark on a 6.1in wall, centred, two per sash -
 * read as jambs they chop each sash into 1.7in slivers and a three-section
 * picture window comes back as its middle pane alone.
 *
 * @param {number[]} wall `[coord, lo, hi]`.
 * @param {Array<number[]>} perpendicular
 * @param {?number} [thickness]
 * @returns {number[]}
 */
export function jambsOn(wall, perpendicular, thickness = null)
{
	const [coord, lo, hi] = wall;
	const floor = thickness ? thickness * MIN_JAMB_SPAN : WALL_MIN_IN;
	const marks = [];
	for (const [pc, pa, pb] of perpendicular)
	{
		const length = pb - pa;
		if (!(length >= floor && length <= WALL_MAX_IN + 3))
		{
			continue;
		}
		// Contains the centreline within a tolerance rather than strictly
		// straddling it: clustering the canonical axes moves a wall line by up
		// to the cluster tolerance, so a jamb drawn dead centre can sit wholly
		// to one side of the line that represents it.
		if (pa - 3.0 <= coord && coord <= pb + 3.0 && lo - 2 <= pc && pc <= hi + 2)
		{
			marks.push(pc);
		}
	}

	// The pair an inch apart is one jamb.
	/** @type {number[][]} */
	const groups = [];
	for (const mark of marks.slice().sort((one, two) => one - two))
	{
		const last = groups[groups.length - 1];
		if (last && mark - last[last.length - 1] <= 2.5)
		{
			last.push(mark);
		}
		else
		{
			groups.push([mark]);
		}
	}
	return groups.map((group) => group.reduce((sum, v) => sum + v, 0) / group.length);
}

/**
 * How the drawing fills the opening: `[covered fraction, piece count]`.
 *
 * This is the whole window/door test, and it comes from how the symbols are
 * drawn rather than from their shape. Measured on the reference sheet: the
 * 36in window is 100% covered in one piece; the 49in closet slider is 77% in
 * two, with an 11in gap.
 *
 * @param {Array<number[]>} runs
 * @param {number} coord
 * @param {number} a
 * @param {number} b
 * @param {number} [tol]
 * @returns {[number, number]}
 */
export function spansLinework(runs, coord, a, b, tol = GLAZING_TOL_IN)
{
	const width = b - a;
	if (width <= 0)
	{
		return [0, 0];
	}
	const pieces = [];
	for (const [c, runLo, runHi] of runs)
	{
		if (Math.abs(c - coord) > tol)
		{
			continue;
		}
		const lo = Math.max(runLo, a);
		const hi = Math.min(runHi, b);
		if (hi > lo)
		{
			pieces.push([lo, hi]);
		}
	}
	pieces.sort((one, two) => (one[0] - two[0]) || (one[1] - two[1]));

	/** @type {Array<number[]>} */
	const merged = [];
	for (const [lo, hi] of pieces)
	{
		if (merged.length && lo <= merged[merged.length - 1][1] + 0.6)
		{
			merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], hi);
		}
		else
		{
			merged.push([lo, hi]);
		}
	}
	const covered = merged.reduce((sum, [lo, hi]) => sum + (hi - lo), 0) / width;
	return [covered, merged.length];
}

/**
 * Where the wall stops, and what the drawing put there instead.
 *
 * Adjacent windows are merged afterwards: a mullion between two sashes is
 * drawn as a jamb too, so a 36in double window arrives as two 18in spans.
 *
 * @param {Array<number[]>} walls `[coord, lo, hi, thickness?]`.
 * @param {Array<number[]>} perpendicular Symbol runs across the wall.
 * @param {Array<number[]>} symbol Symbol runs along it.
 * @param {Array<number[]>} architecture Wall-pen runs along it.
 * @param {Array<number[]>} swings
 * @param {boolean} horizontal
 * @returns {Array<[string, number, number, number, boolean]>}
 */
export function findOpenings(walls, perpendicular, symbol, architecture, swings, horizontal)
{
	/** @type {Map<number, [number, number, ?number]>} */
	const lines = new Map();
	for (const wall of walls)
	{
		const [coord, lo, hi] = wall;
		const thickness = wall.length > 3 ? wall[3] : null;
		const span = lines.get(coord);
		if (span)
		{
			lines.set(coord, [Math.min(span[0], lo), Math.max(span[1], hi),
				thickness === null ? span[2] : thickness]);
		}
		else
		{
			lines.set(coord, [lo, hi, thickness]);
		}
	}

	const out = [];
	const ordered = [...lines.entries()].sort((one, two) => one[0] - two[0]);
	for (const [coord, [lo, hi, thickness]] of ordered)
	{
		const marks = jambsOn([coord, lo, hi], perpendicular, thickness);
		/** @type {Array<[string, number, number]>} */
		const found = [];
		for (let index = 1; index < marks.length; index += 1)
		{
			const a = marks[index - 1];
			const b = marks[index];
			const width = b - a;
			if (!(width >= 12.0 && width <= MAX_OPENING_IN))
			{
				continue;
			}
			const [solid] = spansLinework(architecture, coord, a, b);
			if (solid >= 0.5)
			{
				continue;                       // the wall runs straight through
			}
			const [covered, pieces] = spansLinework(symbol, coord, a, b);
			const swung = swings.some(([x0, y0, x1, y1]) =>
				Math.min(Math.abs((horizontal ? y0 : x0) - coord),
					Math.abs((horizontal ? y1 : x1) - coord)) <= ON_WALL_TOL_IN
				&& (horizontal ? x0 : y0) >= a - 8
				&& (horizontal ? x1 : y1) <= b + 8);
			// The swing is checked BEFORE giving up on an empty span, not
			// after. A swing arc is drawn out into the room, not along the
			// wall, so a plain hinged door leaves the wall line itself blank -
			// two bedroom doorways measured 1.6% architecture and 2.7% symbol
			// and were being discarded as gaps with nothing in them.
			if (!swung && covered < 0.25)
			{
				continue;
			}
			const connected = covered >= CONNECTED && pieces === 1;
			found.push([(connected && !swung) ? 'window' : 'door', a, b]);
		}

		// Adjacent sashes are NOT merged, and this is the one behavioural
		// difference from `extract.find_openings` that is a decision rather
		// than a bug fix.
		//
		// The Python welds neighbouring window spans into one opening, on the
		// grounds that a mullion between two sashes is drawn as a jamb too, so
		// "a 36in double window arrives as two 18in spans". That is true, and
		// throwing the mullion away is still the wrong answer, because the
		// spans it discards are the units the window is actually built from.
		// Measured on the reference sheet:
		//
		//     y=302.83   63.17in "window"  =  31.61 + 31.56        a twin
		//     y=588.01   91.17in "window"  =  20.11 + 51.00 + 20.06  a triple
		//
		// The second is a picture window between two flankers, and merging
		// reported it as a single 91in pane - one stretched sash where the
		// drawing has three units and two mullions. Keeping the sashes apart
		// gives each one its own frame, so the mullions appear where they were
		// drawn.
		//
		// What this gives up is knowing that the three belong to one assembly.
		// Nothing consumes that yet; when a window is generated from a spec
		// rather than scaled from a model (ROADMAP phase 5), that is where a
		// mulled unit should be expressed.
		for (const [kind, a, b] of found)
		{
			if (b - a >= MIN_OPENING_IN && b - a <= MAX_OPENING_IN)
			{
				out.push([kind, (a + b) / 2, coord, b - a, horizontal]);
			}
		}
	}
	return /** @type {any} */ (out);
}
