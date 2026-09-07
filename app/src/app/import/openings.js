// @ts-check
/**
 * Windows and doors: where the wall stops, and what fills it.
 *
 * A port of `tools/opening_truth.py`, minus its scoring and rendering, which
 * are fixture tooling rather than pipeline.
 *
 * ## Two detectors, because they miss different things
 *
 * An opening is found twice over and the results are UNIONED, not intersected.
 *
 *   symbols   what the drafter drew in the wall: a swing arc off to one side,
 *             two overlapping bypass leaves, glazing running jamb to jamb.
 *             The only thing that finds a plain hinged doorway, whose swing is
 *             drawn out in the room so that nothing marks the wall line at all.
 *   gaps      where the wall's own face lines STOP. Structural rather than
 *             symbolic, so it catches a cased opening with nothing drawn in
 *             it, which no symbol reader can see.
 *
 * Requiring both to agree would find fewer than either alone.
 */

import {cover} from './walls.js';
import {pyRound} from './round.js';
import {
	ARCHITECTURE, SYMBOLS, diagonals, findOpenings, segments, swingBoxes,
} from './symbols.js';

/** Narrower than this is a break in the linework; wider is a room. */
const MIN_OPENING_IN = 12.0;
const MAX_OPENING_IN = 96.0;

/**
 * How close a face line must be to a box's own `near`/`far` to BE it.
 *
 * The one deliberate divergence from `tools/opening_truth.py`, which uses
 * 1e-6, and the reason is a precision bug in the reference rather than a
 * disagreement about the rule.
 *
 * `walls.coalesce` groups face pairs by their coordinates ROUNDED TO THREE
 * DECIMALS and then carries the rounded values forward as the box's `near` and
 * `far`. `find` then looks for the faces the box was built from by comparing
 * those rounded values against the RAW face coordinates - so the lookup only
 * succeeds when a coordinate happens to land within a millionth of an inch of
 * its own thousandth-rounding, which is luck rather than logic.
 *
 * Measured on the sample sheet, on the wall at y=308.117in:
 *
 *     box near, rounded    305.187000000000   both
 *     face coord, MuPDF    305.186859130859   1.4e-4 away - no match
 *     face coord, pdf.js   305.186850000000   1.4e-4 away - no match
 *     box far, rounded     311.047000000000   both
 *     face coord, MuPDF    311.046997070312   2.9e-6 away - no match
 *     face coord, pdf.js   311.047000284831   2.8e-7 away - MATCHES
 *
 * The two readers differ because MuPDF holds path coordinates as float32 and
 * pdf.js keeps the float64 it parsed. Neither is wrong; the comparison is. And
 * when it fails it fails SILENTLY and completely: `find` returns no gaps for
 * that wall, so the structural half of the opening detection - the half that
 * finds a cased opening with nothing drawn in it - is simply dead, and the
 * trace still succeeds.
 *
 * A thousandth of an inch is below anything a drawing distinguishes and above
 * the rounding the pipeline itself applied, so the lookup now means what it
 * says in both implementations. `tools/` still has the 1e-6 and should be
 * brought into line; it is left alone here because changing it changes what
 * the Python tracer finds on the house it is tuned against.
 */
const FACE_MATCH_IN = 1e-3;
/** How far an opening may sit from its counterpart and still be the same one. */
const PLACE_TOL_IN = 6.0;
/**
 * How far off a wall's centreline a swing box may sit and still belong to it.
 * A swing reaches a door's width into the room, so its box centre is about
 * half a door away from the wall.
 */
const SWING_ACROSS_IN = 48.0;

/**
 * @typedef {object} Opening
 * @property {string} kind window | door | cased | unknown
 * @property {boolean} horizontal
 * @property {number} centre The wall's centreline coordinate.
 * @property {number} thickness
 * @property {number} lo Along the wall.
 * @property {number} hi
 * @property {number} width_in
 * @property {string} [from]
 * @property {?string} [hinge]
 * @property {?string} [swing]
 * @property {boolean} [exterior]
 */

/**
 * Every gap in a wall's own face coverage, along the wall it belongs to.
 *
 * ONLY the pair the box was built from is read. Every other line in the band -
 * the window frame above all, which spans exactly the opening - fills the gap
 * that marks it.
 *
 * @param {ReturnType<import('./walls.js').trace>} traced
 * @returns {Opening[]}
 */
export function find(traced)
{
	const out = [];
	for (const box of traced.boxes)
	{
		const runs = traced.faces[box.horizontal ? 0 : 1];
		const mine = runs.filter(([coord]) =>
			Math.abs(coord - box.near) < FACE_MATCH_IN
			|| Math.abs(coord - box.far) < FACE_MATCH_IN);
		if (!mine.length)
		{
			continue;
		}
		const clipped = mine
			.map(([, lo, hi]) => [Math.max(lo, box.drawn_lo), Math.min(hi, box.drawn_hi)])
			.filter(([lo, hi]) => hi > lo);
		const covered = cover(clipped);
		for (let index = 1; index < covered.length; index += 1)
		{
			const width = covered[index][0] - covered[index - 1][1];
			if (!(width >= MIN_OPENING_IN && width <= MAX_OPENING_IN))
			{
				continue;
			}
			out.push({
				kind: 'unknown',
				horizontal: box.horizontal,
				centre: pyRound(box.centre, 2),
				thickness: pyRound(box.thickness, 2),
				lo: pyRound(covered[index - 1][1], 2),
				hi: pyRound(covered[index][0], 2),
				width_in: pyRound(width, 2),
			});
		}
	}
	return sortOpenings(out);
}

/**
 * What the drafter DREW in the wall: swing arcs, bypass leaves, glazing.
 *
 * Driven against the BOX walls rather than a lattice, so an opening lands on
 * the wall that will actually be written out instead of a few inches off it.
 *
 * @param {ReturnType<import('./walls.js').trace>} traced
 * @param {import('./readers/model.js').DrawnPath[]} paths
 * @param {number[]} clip
 * @param {number} scale
 * @param {{horizontal: Array<number[]>, vertical: Array<number[]>}} architecture
 * The structure layer's runs - passed in rather than re-derived, since the
 * caller has already chosen the layer and choosing it twice could differ.
 * @returns {Opening[]}
 */
export function findBySymbol(traced, paths, clip, scale, architecture)
{
	// Thickness goes with each wall so jambsOn can tell a jamb, which spans the
	// wall face to face, from a symbol drawn inside it.
	const wallsH = traced.boxes.filter((box) => box.horizontal)
		.map((box) => [box.centre, box.drawn_lo, box.drawn_hi, box.thickness]);
	const wallsV = traced.boxes.filter((box) => !box.horizontal)
		.map((box) => [box.centre, box.drawn_lo, box.drawn_hi, box.thickness]);

	const symbol = segments(paths, clip, scale, SYMBOLS);
	const swings = swingBoxes(diagonals(paths, clip, scale, SYMBOLS));

	const raw = [
		...findOpenings(wallsH, symbol.vertical, symbol.horizontal,
			architecture.horizontal, swings, true),
		...findOpenings(wallsV, symbol.horizontal, symbol.vertical,
			architecture.vertical, swings, false),
	];

	/** @type {Map<string, number>} */
	const thickness = new Map();
	for (const box of traced.boxes)
	{
		thickness.set(`${box.horizontal},${pyRound(box.centre, 1)}`, box.thickness);
	}

	return raw.map(([kind, along, coord, width, horizontal]) => ({
		kind,
		horizontal,
		centre: pyRound(coord, 2),
		thickness: pyRound(
			thickness.get(`${horizontal},${pyRound(coord, 1)}`) ?? 5.0, 2),
		lo: pyRound(along - width / 2, 2),
		hi: pyRound(along + width / 2, 2),
		width_in: pyRound(width, 2),
		from: 'symbol',
	}));
}

/**
 * One opening per place. First detector to claim a spot keeps it.
 *
 * @param {...Opening[]} groups
 * @returns {Opening[]}
 */
export function merge(...groups)
{
	/** @type {Opening[]} */
	const kept = [];
	for (const group of groups)
	{
		for (const opening of group)
		{
			let duplicate = false;
			for (const other of kept)
			{
				if (other.horizontal !== opening.horizontal)
				{
					continue;
				}
				if (Math.abs(other.centre - opening.centre) > PLACE_TOL_IN * 2)
				{
					continue;
				}
				if (Math.min(other.hi, opening.hi) - Math.max(other.lo, opening.lo) > 0)
				{
					duplicate = true;
					// A kind from the symbol pen beats "unknown" from a gap.
					if (other.kind === 'unknown' && opening.kind !== 'unknown')
					{
						other.kind = opening.kind;
					}
					break;
				}
			}
			if (!duplicate)
			{
				kept.push({...opening});
			}
		}
	}
	return sortOpenings(kept);
}

/**
 * Ask the symbol pen what is in each opening. Guesses, never invented.
 *
 * Only the classification is taken from symbols - the opening was already
 * located by the linework, so a symbol that cannot be read costs a label and
 * not a window.
 *
 * @param {Opening[]} openings
 * @param {import('./readers/model.js').DrawnPath[]} paths
 * @param {number[]} clip
 * @param {number} scale
 */
export function label(openings, paths, clip, scale)
{
	const symbol = segments(paths, clip, scale, SYMBOLS);
	const swings = swingBoxes(diagonals(paths, clip, scale, SYMBOLS));

	for (const opening of openings)
	{
		const along = [opening.lo, opening.hi];
		const centre = opening.centre;
		const near = swings.filter((swing) => within(swing, along, centre, opening.horizontal));
		if (near.length)
		{
			opening.kind = 'door';
			continue;
		}
		const runs = opening.horizontal ? symbol.horizontal : symbol.vertical;
		let glazing = 0;
		for (const [coord, lo, hi] of runs)
		{
			if (Math.abs(coord - centre) <= opening.thickness && hi > along[0] && lo < along[1])
			{
				glazing += Math.min(hi, along[1]) - Math.max(lo, along[0]);
			}
		}
		const span = along[1] - along[0];
		if (span > 0 && glazing / span >= 0.6)
		{
			opening.kind = 'window';
		}
		else if (glazing <= 1.0)
		{
			opening.kind = 'cased';
		}
	}
	return openings;
}

/**
 * @param {number[]} swing
 * @param {number[]} along
 * @param {number} centre
 * @param {boolean} horizontal
 */
function within(swing, along, centre, horizontal)
{
	const [x0, y0, x1, y1] = swing;
	const lo = horizontal ? x0 : y0;
	const hi = horizontal ? x1 : y1;
	const across = horizontal ? (y0 + y1) / 2 : (x0 + x1) / 2;
	return (hi > along[0] - PLACE_TOL_IN && lo < along[1] + PLACE_TOL_IN
		&& Math.abs(across - centre) <= 60.0);
}

/**
 * Which end a door is hinged on, and which way it swings.
 *
 * Both come off the swing arc's bounding box, and between them they are the
 * door's handing. The box is a square whose side is the door's width with one
 * corner at the hinge: the corner nearest a jamb says which END the hinge is
 * on, and which side of the wall the box sits on says which way it opens.
 * Four combinations, which is exactly the four handings a joiner would name.
 *
 * Matched one to one, nearest first. A loose match let a single swing be
 * claimed by three different doors at once.
 *
 * A door with no swing keeps hinge null - not a failure: a bypass slider does
 * not swing, and neither does a cased opening.
 *
 * @param {Opening[]} openings
 * @param {import('./readers/model.js').DrawnPath[]} paths
 * @param {number[]} clip
 * @param {number} scale
 */
export function hand(openings, paths, clip, scale)
{
	const swings = swingBoxes(diagonals(paths, clip, scale, SYMBOLS));
	const doors = openings.filter((opening) => opening.kind === 'door');
	for (const door of doors)
	{
		door.hinge = null;
		door.swing = null;
	}

	const pairs = [];
	for (const door of doors)
	{
		const centre = (door.lo + door.hi) / 2;
		swings.forEach((box, index) =>
		{
			const [x0, y0, x1, y1] = box;
			const along = door.horizontal ? (x0 + x1) / 2 : (y0 + y1) / 2;
			const across = door.horizontal ? (y0 + y1) / 2 : (x0 + x1) / 2;
			if (Math.abs(across - door.centre) > SWING_ACROSS_IN)
			{
				return;
			}
			pairs.push({gap: Math.abs(along - centre), door, index, box});
		});
	}

	const taken = new Set();
	for (const {gap, door, index, box} of pairs.sort((one, two) => one.gap - two.gap))
	{
		if (taken.has(index) || door.hinge !== null)
		{
			continue;
		}
		if (gap > (door.hi - door.lo))
		{
			continue;
		}
		taken.add(index);
		const [x0, y0, x1, y1] = box;
		const lo = door.horizontal ? x0 : y0;
		const hi = door.horizontal ? x1 : y1;
		const across = door.horizontal ? (y0 + y1) / 2 : (x0 + x1) / 2;
		door.hinge = Math.abs(lo - door.lo) < Math.abs(hi - door.hi) ? 'lo' : 'hi';
		door.swing = across > door.centre ? 'positive' : 'negative';
	}
	return openings;
}

/**
 * Python's `sorted(key=lambda o: (not o["horizontal"], o["centre"], o["lo"]))`
 * - horizontal walls first, then by position.
 *
 * @param {Opening[]} openings
 */
function sortOpenings(openings)
{
	return openings.slice().sort((one, two) =>
		(Number(!one.horizontal) - Number(!two.horizontal))
		|| (one.centre - two.centre)
		|| (one.lo - two.lo));
}

export {ARCHITECTURE, MAX_OPENING_IN, MIN_OPENING_IN};
