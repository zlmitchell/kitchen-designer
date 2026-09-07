// @ts-check
/**
 * Wall boxes to an architect3d design.
 *
 * A port of `tools/build.py` below the tracing: bridge each wall across its
 * own openings, fuse pairs the app would weld anyway, split centrelines into a
 * corner graph, and write the document the loader takes.
 *
 * ## What reaches the app, and why it is shaped this way
 *
 * Walls carry their MEASURED thickness, face to face, so a 2x4 partition and a
 * 10in exterior wall arrive as themselves rather than as architect3d's
 * configured default.
 *
 * Windows and doors are ITEMS, not gaps: `InWallItem` and `InWallFloorItem`
 * belong to a wall and cut into it, so a wall runs continuously past its own
 * openings and is split only where it meets another wall.
 *
 * ## The 20cm weld, which shapes three of the passes below
 *
 * `corner.js` merges any two corners within `cornerTolerance` of each other,
 * and that constant is 20 CENTIMETRES - near enough eight inches, where the
 * walls on a real plan are three to seven and a half thick. So anything this
 * writes that lands inside that distance is silently merged on load, and a
 * wall between a merged pair becomes zero-length: `_thin`, `fuseParallel` and
 * the length filter all exist to keep that from happening.
 */

import {MIN_PAIR_IN} from './walls.js';
import {CELL_IN, paint, regions} from './spaces.js';
import {pyRound} from './round.js';

const CM_PER_INCH = 2.54;
/** `corner.js` welds corners closer than this. 20cm, in inches. */
const WELD_IN = 20.0 / CM_PER_INCH;

const WALL_TEXTURE = {url: 'rooms/textures/wallmap.png', stretch: true, scale: 0};

/**
 * A window is GENERATED, for the same reason a door is and one step worse.
 *
 * `whitewindow.glb` is 123.0769cm wide and there is no other width it has, so
 * every window used to be that model scaled: `scale_x = width / 123.08`
 * stretches the frame, the sash and any muntin along with the glass, and
 * `scale_z = thickness / 14.75` squashes the sash into the wall plane on a
 * thin partition. The reference plan measures 19 windows and no two of them
 * want the same scale.
 *
 * The height and the sill are the STANDARD rather than a measurement: a plan
 * view gives a width and says nothing else, and both are editable in the
 * inspector. They live in the spec rather than baked into `ypos`, which is the
 * point of `sillHeight` - the item applies it when it binds and writes it back
 * when somebody drags the window up the wall, so the panel and the mouse hold
 * one number between them instead of two.
 */
const GENERATED_WINDOW = {
	model: 'generated:window', type: 3, format: 'generated', name: 'Window',
	// 60in tall on a 32in sill.
	height_cm: 152.4, sill_cm: 81.28,
};

/** 3/4in jamb stock; the builder's default. */
const DOOR_JAMB_CM = 1.9;
/** How far an interior door is drawn open. */
const DOOR_OPEN_FRACTION = 0.75;
/**
 * A door is GENERATED rather than a model. `open_door.glb` was never an open
 * door - decoded, it holds the same in-plane leaf as the closed one with the
 * doorknob deleted, and its whole bounding box is 7.6cm deep, so no placement
 * could show a door open.
 */
const GENERATED_DOOR = {
	model: 'generated:door', type: 7, format: 'generated',
	name: 'Door', height_cm: 203.2,
};

/**
 * Say which openings have the outdoors on one side of them.
 *
 * An exterior door is drawn shut and an interior one open. Both are what the
 * drawing means: a swing arc says how a door opens, but the front door
 * standing open in a walkthrough is just wrong, and an interior door standing
 * shut hides that the rooms connect.
 *
 * Not a guess: the flood fill already knows which region is the outside - the
 * one touching the edge of the clip - so each opening is asked directly.
 *
 * @param {Array<object>} boxes
 * @param {import('./openings.js').Opening[]} openings
 * @param {number[]} clip
 * @param {number} scale
 */
export function markExterior(boxes, openings, clip, scale)
{
	const bounds = [clip[0] * scale, clip[1] * scale, clip[2] * scale, clip[3] * scale];
	const {grid, wide, high} = paint(boxes, bounds, openings);
	const {label, found} = regions(grid, wide, high);
	const outside = new Set(found.filter((region) => region.outside).map((region) => region.index));
	const [x0, y0] = bounds;

	const regionAt = (x, y) =>
	{
		const column = Math.trunc((x - x0) / CELL_IN);
		const row = Math.trunc((y - y0) / CELL_IN);
		if (column < 0 || column >= wide || row < 0 || row >= high)
		{
			return null;
		}
		return label[row * wide + column];
	};

	for (const opening of openings)
	{
		const along = (opening.lo + opening.hi) / 2;
		const reach = opening.thickness / 2 + CELL_IN * 3;
		const sides = [];
		for (const direction of [-1, 1])
		{
			const across = opening.centre + direction * reach;
			const point = opening.horizontal ? [along, across] : [across, along];
			sides.push(regionAt(point[0], point[1]));
		}
		opening.exterior = sides.some((side) => (side !== null && outside.has(side)) || side === 0);
	}
	return openings;
}

/**
 * Join collinear walls across a gap that one of their openings fills.
 *
 * `combine` bridges a wall over an opening only where a jamb stub survives on
 * the wall's own line. Across a 5ft picture window the wall face is simply
 * absent - the frame is drawn on another line - so gaps are left and every one
 * of them produces two loose ends. A loose end matters here in a way it does
 * not elsewhere: architect3d finds a room by walking a closed loop of corners,
 * and a wall that stops in mid-air breaks the loop for the room on both sides.
 *
 * By this point the openings are known, and a gap an opening fills is not a
 * gap in the wall - it is the hole the wall is drawn around.
 *
 * @param {Array<object>} boxes
 * @param {import('./openings.js').Opening[]} openings
 */
export function bridgeOpenings(boxes, openings)
{
	const merged = boxes.map((box) => ({...box}));
	let changed = true;
	while (changed)
	{
		changed = false;
		outer:
		for (const one of merged)
		{
			for (const two of merged)
			{
				if (one === two || one.horizontal !== two.horizontal)
				{
					continue;
				}
				if (Math.abs(one.centre - two.centre)
					> Math.max(one.thickness, two.thickness) / 2)
				{
					continue;
				}
				const lo = Math.min(one.drawn_hi, two.drawn_hi);
				const hi = Math.max(one.drawn_lo, two.drawn_lo);
				if (hi <= lo)
				{
					continue;
				}
				// By how much of the gap the opening COVERS, not by whether it
				// lines up with it. A wall's face stops short of its own jamb,
				// so requiring the two to coincide within a couple of inches
				// never fired: the stretch beyond was left unbridged, the
				// length filter dropped it, and the door was then placed on a
				// wall that no longer existed.
				const spanned = openings.some((opening) =>
					opening.horizontal === one.horizontal
					&& Math.abs(opening.centre - one.centre) <= Math.max(one.thickness, 6.0)
					&& Math.min(opening.hi, hi) - Math.max(opening.lo, lo) >= (hi - lo) * 0.6);
				if (!spanned)
				{
					continue;
				}
				one.drawn_lo = Math.min(one.drawn_lo, two.drawn_lo);
				one.drawn_hi = Math.max(one.drawn_hi, two.drawn_hi);
				merged.splice(merged.indexOf(two), 1);
				changed = true;
				break outer;
			}
		}
	}
	return merged;
}

/**
 * Merge parallel walls too close together for the app to keep apart.
 *
 * Two parallel walls 3.77in apart put corner pairs inside the 20cm weld on
 * every wall they both cross, and the loader merges them blind - the wall
 * between the merged pair becomes zero-length and the 3D view builds a room
 * polygon around a degenerate edge.
 *
 * Welding the corners instead does not help and is worse: two corners at
 * different places cannot both be kept, so the survivor moves, and moving it
 * in x throws the vertical wall through it off its axis. Measured: 3.36in of
 * skew, against a plan whose whole point is that it is exactly square. Merging
 * a whole wall at once keeps every wall axis-aligned by construction.
 *
 * @param {Array<object>} boxes
 */
export function fuseParallel(boxes)
{
	const out = [];
	const ordered = boxes.slice().sort((one, two) =>
		((two.drawn_hi - two.drawn_lo) - (one.drawn_hi - one.drawn_lo)));
	for (const box of ordered)
	{
		let merged = false;
		for (const kept of out)
		{
			if (kept.horizontal !== box.horizontal)
			{
				continue;
			}
			if (Math.abs(kept.centre - box.centre) >= WELD_IN)
			{
				continue;
			}
			if (Math.min(kept.drawn_hi, box.drawn_hi) <= Math.max(kept.drawn_lo, box.drawn_lo))
			{
				continue;
			}
			kept.drawn_lo = Math.min(kept.drawn_lo, box.drawn_lo);
			kept.drawn_hi = Math.max(kept.drawn_hi, box.drawn_hi);
			// The longer of the two keeps its centreline, for the same reason
			// the dominant face pair sets thickness.
			kept.thickness = Math.max(kept.thickness, box.thickness);
			merged = true;
			break;
		}
		if (!merged)
		{
			out.push({...box});
		}
	}
	return out;
}

/**
 * Drop a cut that would leave a piece the app is going to weld anyway.
 *
 * A stub shorter than the weld tolerance cannot survive being loaded: its two
 * corners merge, the wall between them becomes zero-length, and the 3D view
 * builds a room polygon around a degenerate edge. Keeping the outer stops and
 * dropping the cut merges it into the neighbour it was split from, which also
 * closes the loose end the split created.
 *
 * @param {number[]} stops
 */
export function thin(stops)
{
	const kept = [stops[0]];
	for (const stop of stops.slice(1, -1))
	{
		if (stop - kept[kept.length - 1] >= WELD_IN)
		{
			kept.push(stop);
		}
	}
	if (stops.length > 1)
	{
		if (stops[stops.length - 1] - kept[kept.length - 1] < WELD_IN && kept.length > 1)
		{
			kept.pop();
		}
		kept.push(stops[stops.length - 1]);
	}
	return kept;
}

/**
 * Wall boxes to corners and walls, split where centrelines cross.
 *
 * architect3d walks closed loops of corners to find a room, so two walls that
 * merely overlap on screen are not enough: a T-junction has to be a corner
 * they share.
 *
 * Corners are keyed by height as well as position, because architect3d takes a
 * wall's height from its two corners - so one corner cannot be both 42in and
 * 96in, and a pony wall needs its own corner in the same place.
 *
 * @param {Array<object>} boxes
 * @param {number} ceilingIn
 * @param {?Function} [heightOf]
 * @param {() => string} [newId]
 */
export function graph(boxes, ceilingIn, heightOf = null, newId = uuid)
{
	/** @type {Map<number, Set<number>>} */
	const cuts = new Map();
	boxes.forEach((box, index) =>
	{
		for (const other of boxes)
		{
			if (other.horizontal === box.horizontal)
			{
				continue;
			}
			if (box.drawn_lo < other.centre && other.centre < box.drawn_hi
				&& other.drawn_lo <= box.centre && box.centre <= other.drawn_hi)
			{
				const set = cuts.get(index) || new Set();
				set.add(other.centre);
				cuts.set(index, set);
			}
		}
	});

	/** @type {Map<string, number[]>} */
	const corners = new Map();
	const walls = [];
	/** @type {Map<string, string>} */
	const byPoint = new Map();

	const cornerAt = (x, y, height) =>
	{
		const key = `${pyRound(x, 4)},${pyRound(y, 4)},${pyRound(height, 4)}`;
		if (!byPoint.has(key))
		{
			const id = newId();
			byPoint.set(key, id);
			corners.set(id, [pyRound(x, 4), pyRound(y, 4), pyRound(height, 4)]);
		}
		return byPoint.get(key);
	};

	boxes.forEach((box, index) =>
	{
		const stops = thin([...new Set([box.drawn_lo, box.drawn_hi, ...(cuts.get(index) || [])])]
			.sort((one, two) => one - two));
		for (let at = 1; at < stops.length; at += 1)
		{
			const lo = stops[at - 1];
			const hi = stops[at];
			if (hi - lo < MIN_PAIR_IN)
			{
				continue;
			}
			const height = (heightOf ? heightOf(box, lo, hi) : null) || ceilingIn;
			const ends = box.horizontal
				? [[lo, box.centre], [hi, box.centre]]
				: [[box.centre, lo], [box.centre, hi]];
			const pair = [
				cornerAt(ends[0][0], ends[0][1], height),
				cornerAt(ends[1][0], ends[1][1], height),
			];
			if (pair[0] === pair[1])
			{
				continue;
			}
			walls.push({corner1: pair[0], corner2: pair[1], thickness_in: box.thickness});
		}
	});
	return {corners, walls};
}

/** A corner id. `crypto.randomUUID` where there is one, and a fallback for
 * the older browsers and the odd test runner that has no crypto at all. */
function uuid()
{
	if (typeof crypto !== 'undefined' && crypto.randomUUID)
	{
		return crypto.randomUUID();
	}
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) =>
	{
		const random = Math.floor(Math.random() * 16);
		const value = char === 'x' ? random : ((random & 0x3) | 0x8);
		return value.toString(16);
	});
}

/**
 * Assert what the box model is supposed to guarantee, rather than hope.
 *
 * @param {Map<string, number[]>} corners
 * @param {Array<object>} walls
 */
export function verify(corners, walls)
{
	let worst = 0;
	for (const wall of walls)
	{
		const one = corners.get(wall.corner1);
		const two = corners.get(wall.corner2);
		// A wall naming a corner that is not there is a bug in `graph`, not a
		// property of a drawing, so it is skipped rather than guessed at.
		if (!one || !two)
		{
			continue;
		}
		worst = Math.max(worst, Math.min(Math.abs(one[0] - two[0]), Math.abs(one[1] - two[1])));
	}
	/** @type {Map<string, number>} */
	const degree = new Map();
	for (const wall of walls)
	{
		degree.set(wall.corner1, (degree.get(wall.corner1) || 0) + 1);
		degree.set(wall.corner2, (degree.get(wall.corner2) || 0) + 1);
	}
	let dangling = 0;
	let junctions = 0;
	for (const id of corners.keys())
	{
		const count = degree.get(id) || 0;
		if (count === 1)
		{
			dangling += 1;
		}
		if (count >= 3)
		{
			junctions += 1;
		}
	}
	return {off_axis_in: worst, dangling, junctions};
}

/**
 * A generated door: a spec, not a model and not a scale factor.
 *
 * Nothing here is scaled. The builder is handed the opening the drawing
 * measured and the wall's own thickness and makes a frame that fits, which is
 * what three scale factors were approximating - badly, since scaling a model
 * stretches its casing and stiles along with its overall size.
 *
 * A door the drawing showed swinging is drawn OPEN, because that is what the
 * drawing says and a closed door hides that the opening leads anywhere. A door
 * with no arc has no handing and stays shut; so does an exterior door however
 * clearly the plan drew its swing.
 */
function doorItem(index, kind, x, y, width, horizontal, thicknessCm,
	hinge, swing, exterior, openDoors, ox, oy)
{
	const heightCm = GENERATED_DOOR.height_cm;
	// The rough opening: the frame stands outside the clear opening by a jamb
	// each side and one over the head. Item's constructor recentres geometry,
	// so the item's origin sits at half the ROUGH height.
	const roughHeight = heightCm + DOOR_JAMB_CM;
	return {
		id: `${kind}-${index}`,
		item_name: GENERATED_DOOR.name,
		item_type: GENERATED_DOOR.type,
		model_url: GENERATED_DOOR.model,
		format: GENERATED_DOOR.format,
		xpos: pyRound((x - ox) * CM_PER_INCH, 2),
		ypos: pyRound(roughHeight / 2, 2),
		zpos: pyRound((y - oy) * CM_PER_INCH, 2),
		// Wall orientation only. The swing side is spec.swing now, so this no
		// longer carries half a handing - and it never could: changeWallEdge
		// overwrites rotation.y from the wall normal as soon as the item binds.
		rotation: horizontal ? 0 : Math.PI / 2,
		scale_x: 1,
		scale_y: 1,
		scale_z: 1,
		fixed: false,
		resizable: true,
		material_colors: [],
		spec: {
			kind: 'door',
			width: pyRound(width * CM_PER_INCH, 2),
			height: heightCm,
			wallThickness: thicknessCm ? pyRound(thicknessCm, 2) : 11.43,
			// PLAN axes, both of them, because that is what the drawing knows.
			// The item resolves them into its own on binding: a wall has two
			// half edges and the one an item lands on sets its rotation, so
			// "swings toward -z" points into opposite rooms on two identical
			// doors.
			hand: (hinge === 'lo' || hinge === 'hi') ? hinge : 'lo',
			swing: (swing === 'positive' || swing === 'negative') ? swing : 'negative',
			// No swing arc means no leaf. A bypass slider or a cased opening
			// drawn as one slab filling the hole is worse than drawing
			// nothing: three 48.7in closet openings came out as solid doors.
			operation: hinge ? 'swing' : 'cased',
			openFraction: (openDoors && hinge && !exterior) ? DOOR_OPEN_FRACTION : 0,
		},
	};
}

/**
 * architect3d items. Wall items snap to the nearest wall edge on load, so an
 * approximate position along the right wall is enough to orient them.
 *
 * @param {Array<any[]>} openings `[kind, x, y, width, horizontal, thicknessIn,
 * hinge, swing, exterior]`.
 * @param {number} ox
 * @param {number} oy
 * @param {boolean} [openDoors]
 */
export function itemsFor(openings, ox, oy, openDoors = false)
{
	return openings.map((opening, index) =>
	{
		const [kind, x, y, width, horizontal] = opening;
		const thicknessCm = opening.length > 5 && opening[5] ? opening[5] * CM_PER_INCH : null;
		const hinge = opening.length > 6 ? opening[6] : null;
		const swing = opening.length > 7 ? opening[7] : null;
		const exterior = opening.length > 8 ? opening[8] : false;

		if (kind !== 'window')
		{
			return doorItem(index, kind, x, y, width, horizontal, thicknessCm,
				hinge, swing, exterior, openDoors, ox, oy);
		}
		return windowItem(index, kind, x, y, width, horizontal, thicknessCm, ox, oy);
	});
}

/**
 * A generated window: a spec, not a model and not three scale factors.
 *
 * Same argument as `doorItem`. Nothing is scaled - the builder is handed the
 * opening the drawing measured and the wall's own thickness, and makes a
 * lining that fits. The three scale factors this replaces were approximating
 * exactly that, and badly: `scale_x` stretched the stiles with the glass, and
 * `scale_z` was trying to make a 14.75cm model span a 7.7cm wall.
 *
 * The type is `double-hung`, because that is what a plan drawing of a window
 * with no further symbol means in a house like this one. The tracer has no
 * evidence for casement or slider and does not guess: `openings.js` reads
 * glazing that connects the two jambs and nothing about how it opens.
 */
function windowItem(index, kind, x, y, width, horizontal, thicknessCm, ox, oy)
{
	const heightCm = GENERATED_WINDOW.height_cm;
	const sillCm = GENERATED_WINDOW.sill_cm;
	return {
		id: `${kind}-${index}`,
		item_name: GENERATED_WINDOW.name,
		item_type: GENERATED_WINDOW.type,
		model_url: GENERATED_WINDOW.model,
		format: GENERATED_WINDOW.format,
		xpos: pyRound((x - ox) * CM_PER_INCH, 2),
		// The item's origin is the middle of its own geometry, and that
		// geometry is the ROUGH opening - the clear opening plus a liner top
		// and bottom, unlike a door, which has none under it.
		// `applyWindowPlacement` sets this from the spec the moment the window
		// binds; writing it here is what makes the file agree with itself
		// before anything is loaded.
		ypos: pyRound(sillCm + heightCm / 2, 2),
		zpos: pyRound((y - oy) * CM_PER_INCH, 2),
		// Wall orientation only.
		rotation: horizontal ? 0 : Math.PI / 2,
		scale_x: 1,
		scale_y: 1,
		scale_z: 1,
		fixed: false,
		resizable: true,
		material_colors: [],
		spec: {
			kind: 'window',
			type: 'double-hung',
			width: pyRound(width * CM_PER_INCH, 2),
			height: heightCm,
			sillHeight: sillCm,
			wallThickness: thicknessCm ? pyRound(thicknessCm, 2) : 11.43,
			grille: {pattern: 'none', rows: 2, cols: 2},
			openFraction: 0,
		},
	};
}

/**
 * The design document, in the shape `DesignDocument.parse` takes.
 *
 * @param {Map<string, number[]>} corners
 * @param {Array<object>} walls
 * @param {number} ceilingIn
 * @param {?object} underlay
 * @param {Array<object>} items
 */
export function design(corners, walls, ceilingIn, underlay, items)
{
	const values = [...corners.values()];
	const ox = Math.min(...values.map(([x]) => x));
	const oy = Math.min(...values.map(([, y]) => y));

	/** @type {Record<string, object>} */
	const out = {};
	for (const [id, [x, y, height]] of corners)
	{
		out[id] = {
			x: pyRound((x - ox) * CM_PER_INCH, 4),
			y: pyRound((y - oy) * CM_PER_INCH, 4),
			elevation: pyRound((height || ceilingIn) * CM_PER_INCH, 2),
		};
	}

	return {
		floorplan: {
			units: 'cm',
			corners: out,
			walls: walls.map((wall) => ({
				corner1: wall.corner1,
				corner2: wall.corner2,
				// Measured face to face, in centimetres like the rest of the
				// file. floorplan.js reads it if present and keeps its
				// configured default if not.
				thickness: pyRound(wall.thickness_in * CM_PER_INCH, 2),
				frontTexture: {...WALL_TEXTURE},
				backTexture: {...WALL_TEXTURE},
			})),
			rooms: {},
			wallTextures: [],
			floorTextures: {},
			newFloorTextures: {},
			carbonSheet: {
				url: '', transparency: 1, x: 0, y: 0,
				anchorX: 0, anchorY: 0, width: 0.01, height: 0.01,
			},
			...(underlay ? {underlay} : {}),
		},
		items,
	};
}

export {CM_PER_INCH, WELD_IN};
