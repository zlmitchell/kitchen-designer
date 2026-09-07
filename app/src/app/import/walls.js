// @ts-check
/**
 * Walls as boxes: a rectangle per run, overlapping freely at the junctions.
 *
 * A port of `tools/walls.py`, constant for constant. The model and the
 * failures that produced it are recorded in AGENTS.md under "A wall is a box,
 * not a line"; the short version is:
 *
 *   A wall is `(centreline, thickness, run)`, built from its own two FACES, so
 *   thickness is measured rather than assumed. Boxes are not trimmed where
 *   they meet - they overlap, and the overlap IS the junction, which is how
 *   the drafter drew it. They are over-extended by one thickness at each end
 *   so that two boxes which should cross certainly do; that overshoot is a
 *   device and never drawn, which is what `drawn_lo`/`drawn_hi` record.
 *
 * Every threshold below is a measurement off real drawings, not a preference.
 * Changing one changes what this reads as a wall.
 */

import {pyRound} from './round.js';
import {sortRuns} from './layers.js';

/** A face pair this far apart could be a wall - only a seed for discovery. */
const THICKNESS_MIN_IN = 2.0;
const THICKNESS_MAX_IN = 12.0;
/** How far a measured gap may sit from a discovered thickness and still be it. */
const THICKNESS_TOL_IN = 0.75;
/**
 * Two faces must run alongside each other at least this far to be a pair.
 * Short, because a return beside a doorway is short.
 */
export const MIN_PAIR_IN = 2.5;
/** Faces within this of each other on the same line are one face. */
const FACE_JOIN_IN = 2.0;
/** How far to overshoot each end of a box, as a multiple of its thickness. */
const OVERSHOOT = 1.0;
/** Slack when asking whether a run sits between two others. */
const GAP_TOUCH_IN = 2.0;
/** A wall may be bridged across an opening no wider than this. */
const MAX_OPENING_IN = 96.0;
/** Longer than this and a stub is a piece of wall face, not a jamb mark. */
const MAX_JAMB_IN = 14.0;
/** How much wall a width needs behind it to be a construction type. */
const MIN_TYPE_LENGTH_IN = 72.0;
/** How much longer than it is thick a wall attached at one end must be. */
const MIN_STUB_RATIO = 3.0;
/** Two stretches are the same wall only if built from the same face lines. */
const SAME_PAIR_IN = 1.0;
/** Centrelines closer than this are one wall however they were paired. */
const SAME_LINE_IN = 1.5;

/**
 * @typedef {object} Box
 * @property {number} centre
 * @property {number} thickness
 * @property {number} near The two lines this box was built from. Kept because
 * a tolerance band around the centreline also contains the window frame, which
 * covers exactly the openings - so reading the band back fills every gap and
 * the openings vanish.
 * @property {number} far
 * @property {number} lo Including the overshoot.
 * @property {number} hi
 * @property {boolean} horizontal
 * @property {number} drawn_lo Where the wall was actually drawn.
 * @property {number} drawn_hi
 * @property {Array<number[]>} [faces]
 * @property {number} [_span]
 */

/**
 * Weld overlapping and nearly-touching runs on the same line.
 *
 * @param {Array<number[]>} runs
 * @param {number} join
 * @returns {Array<number[]>}
 */
export function mergeRuns(runs, join)
{
	/** @type {Array<number[]>} */
	const out = [];
	for (const [coord, lo, hi] of sortRuns(runs))
	{
		let merged = false;
		for (const run of out)
		{
			if (Math.abs(run[0] - coord) < 1e-6 && lo <= run[2] + join && hi >= run[1] - join)
			{
				run[1] = Math.min(run[1], lo);
				run[2] = Math.max(run[2], hi);
				merged = true;
				break;
			}
		}
		if (!merged)
		{
			out.push([coord, lo, hi]);
		}
	}
	return out;
}

/**
 * Axis-aligned runs, snapped onto shared lines and welded.
 *
 * Snapping happens BEFORE welding. Two collinear pieces of one face that
 * differ by a thousandth of an inch are not on the same line by an exact test,
 * so they never weld, and each pairs separately with the opposite face to make
 * two boxes where there is one wall.
 *
 * Single-linkage, not a rounding grid: rounding puts two pieces of one face at
 * 0.24 and 0.26 into different buckets, and one exterior wall comes back as
 * four boxes along the same line.
 *
 * @param {Array<number[]>} segments
 * @param {number} tolIn
 * @returns {Array<number[]>}
 */
export function faces(segments, tolIn)
{
	/** @type {Array<Array<number[]>>} */
	const groups = [];
	for (const run of sortRuns(segments))
	{
		const last = groups[groups.length - 1];
		if (last && run[0] - last[last.length - 1][0] <= tolIn)
		{
			last.push(run);
		}
		else
		{
			groups.push([run]);
		}
	}

	/** @type {Array<number[]>} */
	const out = [];
	for (const group of groups)
	{
		const shared = group.reduce((sum, run) => sum + run[0], 0) / group.length;
		out.push(...mergeRuns(group.map(([, lo, hi]) => [shared, lo, hi]), FACE_JOIN_IN));
	}
	return sortRuns(out);
}

/**
 * Every face pair that could be a wall, with where the two run together.
 *
 * No grouping and no seed. Grouping faces into bands first fails for a reason
 * that has nothing to do with the pairing rule: a band is built greedily from
 * whichever line sorts first, and on a real plan that line is the WINDOW
 * FRAME, which projects an inch proud of the wall face. Seeded there the band
 * takes the frame's other side as its opposite face - the two are perfectly
 * co-extensive - and the wall between the windows is never considered, so the
 * trace produces boxes at the windows and nowhere else.
 *
 * So every pair is scored on its own and the strongest wins globally.
 *
 * @param {Array<number[]>} runs Sorted.
 */
export function candidates(runs)
{
	const out = [];
	for (let index = 0; index < runs.length; index += 1)
	{
		const [c1, lo1, hi1] = runs[index];
		for (let other = index + 1; other < runs.length; other += 1)
		{
			const [c2, lo2, hi2] = runs[other];
			const gap = c2 - c1;
			if (gap > THICKNESS_MAX_IN)
			{
				break;
			}
			if (gap < THICKNESS_MIN_IN)
			{
				continue;
			}
			const together = Math.min(hi1, hi2) - Math.max(lo1, lo2);
			if (together >= MIN_PAIR_IN)
			{
				out.push({
					near: c1, far: c2, gap,
					lo: Math.max(lo1, lo2), hi: Math.min(hi1, hi2),
					together,
				});
			}
		}
	}
	return out;
}

/**
 * Sum each face pair's co-extent over every stretch it runs together.
 *
 * A face arrives in pieces - broken at every doorway and every crossing wall -
 * so one wall shows up as several candidates on the same two lines. Judging
 * them piece by piece lets a 3.5ft window frame outscore a 27ft wall drawn in
 * four parts.
 *
 * @param {ReturnType<candidates>} found
 */
export function coalesce(found)
{
	/** @type {Map<string, any[]>} */
	const merged = new Map();
	for (const pair of found)
	{
		const key = `${pyRound(pair.near, 3)},${pyRound(pair.far, 3)}`;
		const group = merged.get(key);
		if (group)
		{
			group.push(pair);
		}
		else
		{
			merged.set(key, [pair]);
		}
	}

	const out = [];
	for (const [key, group] of merged)
	{
		const [near, far] = key.split(',').map(Number);
		out.push({
			near, far, gap: far - near,
			pieces: group.map((pair) => [pair.lo, pair.hi])
				.sort((one, two) => (one[0] - two[0]) || (one[1] - two[1])),
			together: group.reduce((sum, pair) => sum + pair.together, 0),
		});
	}
	// Stable, so pairs that tie keep the order they were first seen in -
	// which is Python's behaviour and matters because `select` takes the
	// first of two equal candidates and shadows the rest.
	return out.sort((one, two) => two.together - one.together);
}

/**
 * What wall thicknesses this drawing actually uses.
 *
 * Discovered, not declared. A drafter picks a thickness per wall type and
 * holds it over the whole sheet, so the gaps pile up on a couple of values and
 * everything else is scattered. Each candidate votes with the distance its two
 * faces actually run together, so one long exterior wall outvotes a dozen
 * short coincidences.
 *
 * The floor is an ABSOLUTE quantity of wall, not a fraction of the peak. Two
 * cleverer rules failed first: judging each bucket against the longest wall in
 * the house threw out 25ft of 2x4 partition, and clustering the buckets into
 * modes failed because the distribution is not modal - a remodel has a bucket
 * at nearly every quarter inch, because existing, new and furred-out walls are
 * genuinely different thicknesses.
 *
 * @param {ReturnType<coalesce>} horizontal
 * @param {ReturnType<coalesce>} vertical
 * @returns {number[]}
 */
export function thicknesses(horizontal, vertical)
{
	/** @type {Map<number, number>} */
	const tally = new Map();
	for (const pair of [...horizontal, ...vertical])
	{
		const bucket = pyRound(pair.gap * 4) / 4;
		tally.set(bucket, (tally.get(bucket) || 0) + pair.together);
	}
	return [...tally.entries()]
		.filter(([, weight]) => weight >= MIN_TYPE_LENGTH_IN)
		.map(([width]) => width)
		.sort((one, two) => one - two);
}

/**
 * The intervals one face covers, merged, in order.
 *
 * Bridged across small breaks: a face is interrupted by every doorway and
 * every wall crossing it, and those interruptions are the wall, not gaps in
 * it.
 *
 * @param {Array<number[]>} spans `[lo, hi]` pairs.
 * @returns {Array<number[]>}
 */
export function cover(spans)
{
	const ordered = spans.slice().sort((one, two) => (one[0] - two[0]) || (one[1] - two[1]));
	/** @type {Array<number[]>} */
	const out = [];
	for (const [lo, hi] of ordered)
	{
		if (out.length && lo <= out[out.length - 1][1] + FACE_JOIN_IN)
		{
			out[out.length - 1][1] = Math.max(out[out.length - 1][1], hi);
		}
		else
		{
			out.push([lo, hi]);
		}
	}
	return out;
}

/**
 * True if this run sits in a gap between two accepted stretches of one wall.
 *
 * A window is drawn a little wider than the wall it sits in, so its frame is a
 * parallel pair too - 10in where the wall is 7in - and it lives exactly where
 * the wall's own faces stop. Nothing overlaps it, so the shadow test never
 * sees it, and it is accepted as a wall that neatly plugs every window. The
 * openings then vanish.
 *
 * Judged by the MIDPOINT, not the ends: a frame overlaps the wall face either
 * side of it by an inch or two, so an endpoint test finds nothing "before" it
 * and lets the frame through.
 *
 * @param {number} centre
 * @param {number} lo
 * @param {number} hi
 * @param {Box[]} taken
 */
function plugsAGap(centre, lo, hi, taken)
{
	const same = taken.filter(
		(box) => Math.abs(centre - box.centre) <= Math.max(box.thickness, 1.0));
	if (!same.length)
	{
		return false;
	}
	const middle = (lo + hi) / 2;
	const before = same.filter((box) => box.drawn_hi <= middle);
	const after = same.filter((box) => box.drawn_lo >= middle);
	if (!before.length || !after.length)
	{
		return false;
	}
	// And it has to be a hole in that wall, not a continuation of it.
	const left = Math.max(...before.map((box) => box.drawn_hi));
	const right = Math.min(...after.map((box) => box.drawn_lo));
	return right - left <= MAX_OPENING_IN;
}

/**
 * Take the strongest face pairs first, letting each shadow weaker overlaps.
 *
 * Best-first rather than in drawing order. Two candidates covering the same
 * stretch of the same wall are the same wall described twice - the real face
 * pair, and some inner line paired with an outer one - and the one that runs
 * together longest is the one the drafter drew as the wall.
 *
 * @param {ReturnType<coalesce>} pairs
 * @param {number[]} thicknessSet
 * @param {boolean} horizontal
 * @returns {Box[]}
 */
export function select(pairs, thicknessSet, horizontal)
{
	/** @type {Box[]} */
	const taken = [];
	for (const pair of pairs)
	{
		if (!thicknessSet.some((width) => Math.abs(pair.gap - width) <= THICKNESS_TOL_IN))
		{
			continue;
		}
		const centre = (pair.near + pair.far) / 2;
		for (const [lo, hi] of cover(pair.pieces))
		{
			if (hi - lo < MIN_PAIR_IN)
			{
				continue;
			}
			// Shadowed if an accepted wall already occupies this ground.
			const shadowed = taken.some((box) =>
				Math.abs(centre - box.centre) <= box.thickness / 2
				&& Math.min(hi, box.drawn_hi) - Math.max(lo, box.drawn_lo) > (hi - lo) * 0.5);
			if (shadowed)
			{
				continue;
			}
			if (plugsAGap(centre, lo, hi, taken))
			{
				continue;
			}
			const reach = pair.gap * OVERSHOOT;
			taken.push({
				centre,
				thickness: pair.gap,
				near: pair.near,
				far: pair.far,
				lo: lo - reach,
				hi: hi + reach,
				horizontal,
				drawn_lo: lo,
				drawn_hi: hi,
			});
		}
	}
	return taken;
}

/**
 * Is there a jamb mark on this wall's line, inside the gap lo..hi?
 *
 * A jamb is a short stub lying in the wall's own band. It is what the drafter
 * draws where a wall meets an opening, so finding one is the drawing saying
 * the wall continues past here rather than ending.
 *
 * @param {Box} box
 * @param {number} lo
 * @param {number} hi
 * @param {Array<number[]>} stubs
 */
function jambBetween(box, lo, hi, stubs)
{
	const half = box.thickness / 2 + 1.0;
	for (const [coord, a, b] of stubs)
	{
		if (Math.abs(coord - box.centre) > half)
		{
			continue;
		}
		if (b - a > MAX_JAMB_IN)
		{
			continue;
		}
		if (a >= lo - GAP_TOUCH_IN && b <= hi + GAP_TOUCH_IN)
		{
			return true;
		}
	}
	return false;
}

/**
 * Merge boxes that are the same wall, including across their openings.
 *
 * Two jobs, and the second is the one that matters. Overlapping collinear
 * boxes are the same wall seen twice. The second job is bridging a wall across
 * its own openings: a wall is drawn in the stretches BETWEEN its doors, so a
 * closet wall carrying a bypass slider across almost its whole width survives
 * only as four 2.7in jamb stubs, and a wall that is plainly there goes
 * missing.
 *
 * A gap is bridged only where there is JAMB evidence inside it, which is what
 * keeps this from welding two genuinely separate walls that share a line with
 * a room in between.
 *
 * @param {Box[]} boxesIn
 * @param {Array<number[]>} [jambs]
 * @returns {Box[]}
 */
export function combine(boxesIn, jambs)
{
	const stubs = jambs || [];
	/** @type {Box[]} */
	const out = [];
	const ordered = boxesIn.slice().sort((one, two) =>
		(Number(one.horizontal) - Number(two.horizontal))
		|| (one.centre - two.centre)
		|| (one.lo - two.lo));

	for (const box of ordered)
	{
		let merged = false;
		for (const kept of out)
		{
			if (kept.horizontal !== box.horizontal)
			{
				continue;
			}
			if (Math.abs(kept.centre - box.centre)
				> Math.max(kept.thickness, box.thickness) / 2)
			{
				continue;
			}
			const gap = Math.max(box.lo - kept.hi, kept.lo - box.hi);
			// Two stretches that OVERLAP but were built from different face
			// lines are different things sharing a line, and must stay apart:
			// architect3d keeps height and thickness per WALL, so anything the
			// drafter drew differently has to arrive as its own wall or there
			// is nothing to set the property on. A GAP is the opposite case -
			// one wall interrupted by a door - and applying the same-pair test
			// there cost two doors by splitting the walls they sit in.
			const samePair = (Math.abs(kept.near - box.near) <= SAME_PAIR_IN
				&& Math.abs(kept.far - box.far) <= SAME_PAIR_IN);
			// Unless the two centrelines all but coincide, in which case they
			// are one wall that picked up a second pair.
			const onOneLine = Math.abs(kept.centre - box.centre) <= SAME_LINE_IN;
			if (gap <= 0 && !samePair && !onOneLine)
			{
				continue;
			}
			if (gap > 0)
			{
				if (gap > MAX_OPENING_IN)
				{
					continue;
				}
				const lo = Math.min(kept.drawn_hi, box.drawn_hi);
				const hi = Math.max(kept.drawn_lo, box.drawn_lo);
				if (!jambBetween(kept, lo, hi, stubs))
				{
					continue;
				}
			}
			kept.lo = Math.min(kept.lo, box.lo);
			kept.hi = Math.max(kept.hi, box.hi);
			kept.drawn_lo = Math.min(kept.drawn_lo, box.drawn_lo);
			kept.drawn_hi = Math.max(kept.drawn_hi, box.drawn_hi);
			// The DOMINANT contributor sets the thickness - not the first
			// merged and not the widest. Taking the max let a window frame's
			// 10in win over the 7in wall it sat in; keeping the first painted
			// a spurious 10.23in over a whole wall because the merge order is
			// by centreline. Longest wins, for the same reason it wins in
			// select().
			kept.faces = kept.faces || [[kept.near, kept.far]];
			kept.faces.push([box.near, box.far]);
			if ((box.drawn_hi - box.drawn_lo) > (kept._span || 0))
			{
				kept._span = box.drawn_hi - box.drawn_lo;
				kept.thickness = box.thickness;
				kept.centre = box.centre;
				// The pair that won is also the only one entitled to say where
				// this wall's openings are. Reading every merged pair instead
				// lets one that happens to span a doorway fill the gap that
				// marks it, and the opening disappears.
				kept.near = box.near;
				kept.far = box.far;
			}
			merged = true;
			break;
		}
		if (!merged)
		{
			const entry = {...box};
			entry.faces = [[box.near, box.far]];
			entry._span = box.drawn_hi - box.drawn_lo;
			out.push(entry);
		}
	}
	return out;
}

/**
 * Throw out boxes that meet no other wall at either end.
 *
 * A wall runs between other walls, or between a wall and the building
 * envelope. It does not float. What floats is a fixture outline that happens
 * to be drawn on the architecture pen and happens to pair at a wall-like
 * thickness - a 30in counter edge, a 9.7in box under the sink. Those survive
 * every test upstream because they ARE two parallel lines a construction
 * thickness apart. What tells them apart is that they are connected to
 * nothing, and a house is a connected thing.
 *
 * Only boxes joined at NEITHER end go: a pony wall stops in open floor at one
 * end and is still a wall.
 *
 * @param {Box[]} boxesIn
 * @returns {Box[]}
 */
export function dropFloating(boxesIn)
{
	const joins = (box, edge) => boxesIn.some((other) =>
		other !== box
		&& other.horizontal !== box.horizontal
		&& other.lo <= box.centre && box.centre <= other.hi
		&& Math.abs(other.centre - edge) <= Math.max(other.thickness, box.thickness));

	const out = [];
	for (const box of boxesIn)
	{
		const ends = [box.drawn_lo, box.drawn_hi]
			.filter((edge) => joins(box, edge)).length;
		if (!ends)
		{
			continue;
		}
		// A box hanging off ONE end has to be long relative to its thickness.
		// Ratio alone is no good either: a real return beside a doorway is
		// 6.7in on 4.5in, and it is a wall because it is joined at BOTH ends.
		const length = box.drawn_hi - box.drawn_lo;
		if (ends === 1 && length < box.thickness * MIN_STUB_RATIO)
		{
			continue;
		}
		out.push(box);
	}
	return out;
}

/**
 * Run each box's drawn end out to the centreline of the wall it meets.
 *
 * OVERSHOOT exists so two boxes that should cross actually do, but it is a
 * device and not a claim: drawing it makes every wall overhang its corner by a
 * whole thickness, and drawing the un-extended run instead makes the corners
 * look like they failed to close. Walls meet at each other's CENTRELINES,
 * which is the convention the drawing uses and the one architect3d wants.
 *
 * Iterated to a fixed point, because one pass is order-dependent: a box
 * visited early is snapped against neighbours that later grow, and the two
 * corners then sit inside the app's 20cm weld tolerance and are merged on
 * load.
 *
 * @param {Box[]} boxesIn
 * @returns {Box[]}
 */
export function closeCorners(boxesIn)
{
	for (let pass = 0; pass < 8; pass += 1)
	{
		let moved = false;
		for (const box of boxesIn)
		{
			const reach = box.thickness * OVERSHOOT + FACE_JOIN_IN;
			for (const other of boxesIn)
			{
				if (other.horizontal === box.horizontal)
				{
					continue;
				}
				// It has to actually cross, not merely point at us.
				if (!(other.lo <= box.centre && box.centre <= other.hi))
				{
					continue;
				}
				for (const end of ['drawn_lo', 'drawn_hi'])
				{
					const distance = Math.abs(other.centre - box[end]);
					if (distance > 0 && distance <= reach)
					{
						box[end] = other.centre;
						moved = true;
					}
				}
			}
		}
		if (!moved)
		{
			break;
		}
	}
	for (const box of boxesIn)
	{
		// Both read from the ORIGINAL pair. Assigning drawn_lo first and then
		// reading it back to compute drawn_hi collapses the box to a point
		// whenever snapping crossed the two over.
		const low = box.drawn_lo;
		const high = box.drawn_hi;
		box.drawn_lo = Math.min(low, high);
		box.drawn_hi = Math.max(low, high);
	}
	return boxesIn;
}

/**
 * Where each box's centreline is cut by another's.
 *
 * architect3d walks closed loops of corners to find a room, so two walls that
 * merely overlap on screen are not enough: a junction has to be a corner they
 * share, or the room around it is never found.
 *
 * @param {Box[]} boxesIn
 * @returns {Map<number, Set<number>>}
 */
export function crossings(boxesIn)
{
	/** @type {Map<number, Set<number>>} */
	const cuts = new Map();
	const add = (index, value) =>
	{
		const set = cuts.get(index) || new Set();
		set.add(value);
		cuts.set(index, set);
	};

	boxesIn.forEach((box, index) =>
	{
		for (const other of boxesIn)
		{
			if (other.horizontal === box.horizontal)
			{
				continue;
			}
			if (box.lo <= other.centre && other.centre <= box.hi
				&& other.lo <= box.centre && box.centre <= other.hi)
			{
				add(index, other.centre);
			}
		}
	});
	return cuts;
}

/**
 * Split every box's centreline at its crossings. Ready for a wall graph.
 *
 * @param {Box[]} boxesIn
 */
export function segmentsFrom(boxesIn)
{
	const cuts = crossings(boxesIn);
	const out = [];
	boxesIn.forEach((box, index) =>
	{
		const stops = [...new Set([box.lo, box.hi, ...(cuts.get(index) || [])])]
			.sort((one, two) => one - two);
		for (let at = 1; at < stops.length; at += 1)
		{
			if (stops[at] - stops[at - 1] < 1e-6)
			{
				continue;
			}
			out.push({
				centre: box.centre,
				thickness: box.thickness,
				lo: stops[at - 1],
				hi: stops[at],
				horizontal: box.horizontal,
			});
		}
	});
	return out;
}

/**
 * Segments in real inches to wall boxes, and the pieces they split into.
 *
 * @param {Array<number[]>} horizontalSegments
 * @param {Array<number[]>} verticalSegments
 * @param {number} [tolIn]
 */
export function trace(horizontalSegments, verticalSegments, tolIn = 0.5)
{
	const h = faces(horizontalSegments, tolIn);
	const v = faces(verticalSegments, tolIn);
	const pairsH = coalesce(candidates(h));
	const pairsV = coalesce(candidates(v));
	const found = thicknesses(pairsH, pairsV);
	if (!found.length)
	{
		return {thicknesses: [], boxes: [], segments: [], faces: [h, v], pairs: [pairsH, pairsV]};
	}

	let built = combine(select(pairsH, found, true), h)
		.concat(combine(select(pairsV, found, false), v));
	// Zero-length and sliver boxes are dropped AFTER the corner pass, since
	// that is what sets a box's final extent.
	built = dropFloating(closeCorners(built)
		.filter((box) => box.drawn_hi - box.drawn_lo > MIN_PAIR_IN));

	return {
		thicknesses: found,
		boxes: built,
		segments: segmentsFrom(built),
		faces: [h, v],
		pairs: [pairsH, pairsV],
	};
}
