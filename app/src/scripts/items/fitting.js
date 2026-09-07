// @ts-check
import {openingFor} from './generated/sink.js';

/**
 * What an item owes the thing it sits in.
 *
 * ## Why this exists
 *
 * A sink is three objects pretending to be one: a bowl, a hole in the worktop
 * above it, and a cabinet front below it that a farmhouse apron replaces. Until
 * this file, only the first of those knew anything had changed. Change a sink's
 * mount and it rebuilt itself alone - the counter kept whichever hole
 * `tools/fitout.py` had baked into its spec offline, the cabinet kept its front,
 * and the sink did not even move, because `buildSink` reasons in "y = 0 is the
 * top of the worktop" and then centres on its bounding box, which throws that
 * plane away. Its own comment said so and named the fix: "phase 3's run is what
 * will put it back by reading `mount`".
 *
 * This is the smallest piece of that run. Not the run itself - no style applied
 * across a row, no alignment, no appliance panels - just the one rule the three
 * symptoms needed, in the shape ROADMAP.md asks for: "an item may declare
 * requirements of its host, and the host validates them".
 *
 * ## Why the host is found by geometry rather than named
 *
 * An explicit reference would be unambiguous, and it would still need this: the
 * traced plan and every design saved before today have no such field, so a
 * spatial fallback has to exist anyway. Two mechanisms where one will do is how
 * the second one rots.
 *
 * ## Pure, and separately assertable
 *
 * `fittingFor` computes and returns; `applyFitting` is the only thing that
 * writes. That split is what lets the cutout arithmetic - which has a coordinate
 * flip in it that is invisible on a centred sink and wrong on everything else -
 * be tested without a scene.
 */

/**
 * How far above the counter's top face a sink may sit and still be counted as
 * belonging to it, in centimetres.
 *
 * Generous on purpose. A vessel sink stands wholly on the slab, so its own
 * bounding box is entirely ABOVE the surface it belongs to, and a tight
 * tolerance would decide it belongs to nothing.
 */
const MOUNT_REACH = 60;

/** How far below the counter a base cabinet may be and still be its cabinet. */
const CABINET_REACH = 100;

/** The smallest hole worth cutting: a 35mm tap hole. */
const MIN_CUTOUT = 3.5;

/**
 * How much smaller than the bowl the hole is, per mount, in centimetres.
 *
 * A drop-in rests its flange on the slab, so the hole has to be undersized or
 * there is nothing holding the sink up - `sink.js` says exactly this and then
 * had no way to make it true. An undermount is the opposite: the hole IS the
 * opening, and the slab's cut edge is what you see.
 */
const INSET = {
	'drop-in': 2.5,
	'semi-recessed': 1.5,
	// A POSITIVE REVEAL, and not zero. `sink.js` says "the cutout IS the opening",
	// which is true of what you see and false of what holds the sink up: an
	// undermount is fixed to the underside of the slab, so the stone has to
	// overhang the bowl or there is nothing to fix it to. 6mm is the middle of the
	// range a fabricator would cut.
	//
	// `tools/fitout.py` bakes 2cm a side instead, so a design traced before this
	// existed gains about 1.4cm of opening each way the first time it is refitted.
	// That is the offline guess being replaced by the mount's own rule, not a
	// regression - but it is a visible change to an existing plan, so it is
	// written down here rather than discovered.
	'undermount': 0.6,
	// The apron is the front of the sink, and the slab meets it.
	'farmhouse': 0,
};

/** Is this item a generated thing of the given kind? */
function isKind(item, kind)
{
	var spec = item && item.metadata && item.metadata.spec;
	return Boolean(spec && spec.kind === kind);
}

/** An item's half extent, falling back to its bounds when halfSize is stale. */
function halfOf(item)
{
	if (item.halfSize)
	{
		return item.halfSize;
	}
	var box = item.bounds ? item.bounds() : null;
	return box ? box.max.clone().sub(box.min).multiplyScalar(0.5) : null;
}

/**
 * Turn a world point into an item's own frame.
 *
 * Only the Y rotation matters: everything here stands on a floor. Rotating an
 * item by theta sends its local +x to world (cos, 0, -sin), so going the other
 * way is the same rotation with the angle negated - and getting this wrong is
 * the failure `fitout.py` documents at length, "a hole in the worktop with the
 * sink somewhere else". It is invisible on a run whose sink is centred and
 * obvious on every other one.
 *
 * @returns {{x: number, z: number}} Along the item, and across it.
 */
function intoFrame(item, x, z)
{
	var dx = x - item.position.x;
	var dz = z - item.position.z;
	var angle = -(item.rotation ? item.rotation.y : 0);
	var cos = Math.cos(angle);
	var sin = Math.sin(angle);
	return {
		x: dx * cos - dz * sin,
		z: dx * sin + dz * cos,
	};
}

/**
 * The world point an item's own (x, z) names. The inverse of `intoFrame`.
 *
 * @returns {{x: number, z: number}}
 */
function fromFrame(item, x, z)
{
	var angle = item.rotation ? item.rotation.y : 0;
	var cos = Math.cos(angle);
	var sin = Math.sin(angle);
	return {
		x: item.position.x + x * cos - z * sin,
		z: item.position.z + x * sin + z * cos,
	};
}

/** Whether a point is inside an item's footprint, with a little slack. */
function coversPoint(item, x, z, slack)
{
	var half = halfOf(item);
	if (!half)
	{
		return false;
	}
	var local = intoFrame(item, x, z);
	return Math.abs(local.x) <= half.x + slack && Math.abs(local.z) <= half.z + slack;
}

/**
 * The counter a sink is cut into, and the cabinet beneath it.
 *
 * Either may be null, and a sink with neither is not an error: `sink.js`
 * describes a sink "placed by hand", and one standing on its own is exactly
 * that. It keeps whatever position somebody gave it.
 *
 * @param {Object} sink
 * @param {Array<Object>} items Everything in the scene.
 * @returns {{counter: ?Object, cabinet: ?Object}}
 */
export function hostsFor(sink, items)
{
	// Typed, because the literal alone infers `null` and then every read of
	// `found.counter` below is a property access on `never` (RM-004 B3).
	/** @type {{counter: ?Object, cabinet: ?Object}} */
	var found = {counter: null, cabinet: null};
	if (!sink || !sink.position || !items)
	{
		return found;
	}

	var x = sink.position.x;
	var z = sink.position.z;

	items.forEach(function (item)
	{
		if (item === sink || !item.position)
		{
			return;
		}
		if (!coversPoint(item, x, z, 1))
		{
			return;
		}
		var half = halfOf(item);
		if (!half)
		{
			return;
		}
		if (isKind(item, 'counter'))
		{
			var top = item.position.y + half.y;
			// Above the sink's own middle, and within reach. A counter under a
			// different run entirely fails this even if the footprints overlap in
			// plan, which they can on an L.
			if (top > sink.position.y - MOUNT_REACH && top < sink.position.y + MOUNT_REACH)
			{
				if (!found.counter || top < found.counter.position.y)
				{
					found.counter = item;
				}
			}
			return;
		}
		if (isKind(item, 'cabinet'))
		{
			var cabinetTop = item.position.y + half.y;
			if (cabinetTop < sink.position.y + CABINET_REACH)
			{
				found.cabinet = item;
			}
		}
	});

	return found;
}

/**
 * The hole a sink's mount asks its worktop for.
 *
 * A vessel gets a tap hole and nothing else - it stands wholly on the slab, and
 * `sink.js` is explicit that there is "no bowl cutout at all". Everything else
 * gets the bowl opening, inset by whatever the mount needs to rest on.
 *
 * @param {Object} spec A sink's spec.
 * @returns {{width: number, depth: number, open?: string}} `open` names the edge
 *          this cutout breaks through, and only a farmhouse has one.
 */
export function cutoutFor(spec)
{
	if (spec.mount === 'vessel')
	{
		return {width: MIN_CUTOUT, depth: MIN_CUTOUT};
	}

	// The BOWL's footprint, not the spec's. A round sink's spec says 76.2 wide
	// and 47 deep and the bowl is a 47cm circle, so cutting to the spec would
	// take 29cm more stone than the sink covers.
	var opening = openingFor(spec);
	var inset = INSET[spec.mount] === undefined ? 0 : INSET[spec.mount];
	return {
		width: Math.max(MIN_CUTOUT, opening.width - inset * 2),
		depth: Math.max(MIN_CUTOUT, opening.depth - inset * 2),
		// A farmhouse breaks through the front edge rather than sitting in a hole:
		// its apron is the front of the run. `counter.js` turns this into a notch
		// in the outline, which is the only way to express it - a hole touching
		// the contour is discarded.
		open: spec.mount === 'farmhouse' ? 'front' : undefined,
	};
}

/** Clearance between a bowl and the carcass either side of it, in centimetres. */
const SIDE_CLEARANCE = 1.5;

/** How much stone is left behind a sink, between the bowl and the backsplash. */
const BACK_MARGIN = 4;

/**
 * How far a farmhouse apron stands in front of the worktop's edge, in cm.
 *
 * Flush is wrong, and it is the detail that makes an apron sink read as one: the
 * face is meant to break the line of the run and catch its own shadow. A little
 * over half an inch, which is the middle of what a fabricator would leave.
 */
const APRON_PROUD = 1.5;

/**
 * The size a sink can actually be, here, in this cabinet.
 *
 * Shrink-only for every mount but one. A sink that is too wide for its base is
 * not a sink, it is a drawing mistake - a 30in bowl does not go into a 24in
 * cabinet however firmly the panel is told it does - and the symptom is a bowl
 * through the carcass sides. A round sink was the loudest case, because its
 * spec says one thing and its geometry another.
 *
 * A FARMHOUSE is the exception and is SET rather than clamped: its apron is the
 * front of the run, so its depth is not a preference, it is the distance from
 * the back margin to the front edge. That is what makes it reach the front of
 * the cabinet instead of floating in the middle of the slab.
 *
 * @param {Object} spec
 * @param {{counter: ?Object, cabinet: ?Object}} hosts
 * @returns {{width: number, frontToBack: number}}
 */
export function fitSpecToHosts(spec, hosts)
{
	var width = spec.width;
	var frontToBack = spec.frontToBack;

	var cabinet = hosts ? hosts.cabinet : null;
	if (cabinet)
	{
		var cabinetSpec = cabinet.metadata && cabinet.metadata.spec ? cabinet.metadata.spec : {};
		// The carcass sides eat 3/4in of ply each. Clearance beyond that, because a
		// bowl touching the panel does not go in either.
		var panel = cabinetSpec.panel === undefined ? 1.9 : cabinetSpec.panel;
		var inside = (cabinetSpec.width || 0) - 2 * panel - 2 * SIDE_CLEARANCE;
		if (inside > 10)
		{
			width = Math.min(width, inside);
		}
	}

	var counter = hosts ? hosts.counter : null;
	var counterHalf = counter ? halfOf(counter) : null;
	if (counterHalf)
	{
		var usable = counterHalf.z * 2 - BACK_MARGIN;
		if (spec.mount === 'farmhouse')
		{
			frontToBack = Math.max(10, usable);
		}
		else
		{
			// A finger of stone in front as well, so the bowl is not flush with the
			// nosing of the worktop.
			frontToBack = Math.min(frontToBack, Math.max(10, usable - BACK_MARGIN));
		}
	}

	return {width: width, frontToBack: frontToBack};
}

/**
 * Everything a sink implies for itself and its hosts, computed and not applied.
 *
 * @param {Object} sink
 * @param {{counter: ?Object, cabinet: ?Object}} hosts
 * @returns {?{y: number, z: ?number, cutout: ?Object, apronHeight: number}} Null when there
 *          is no counter to fit to.
 */
export function fittingFor(sink, hosts)
{
	var spec = sink && sink.metadata ? sink.metadata.spec : null;
	var counter = hosts ? hosts.counter : null;
	if (!spec || !counter)
	{
		return null;
	}

	var counterHalf = halfOf(counter);
	if (!counterHalf)
	{
		return null;
	}

	// The plane every mount is measured against - the WORK SURFACE, which is not
	// the top of the counter's bounding box: a counter with a backsplash is 10cm
	// taller than its worktop, and measuring to the box would hang every sink in
	// the run off the top of the splash.
	var slabTop = counter.specDatum
		? counter.position.y - counter.specDatum.y
		: counter.position.y + counterHalf.y;
	// `specDatum.y` is how far the builder's origin moved when it centred, so the
	// worktop plane sits that far below the item's middle. Put it back.
	var datum = sink.specDatum ? sink.specDatum.y : 0;

	var size = cutoutFor(spec);
	var local = intoFrame(counter, sink.position.x, sink.position.z);

	// A farmhouse is pulled forward until its apron is the front of the run. Every
	// other mount stays where somebody put it: only the depth of a farmhouse is
	// decided by the worktop rather than chosen.
	var placeZ = null;
	if (spec.mount === 'farmhouse')
	{
		var front = counterHalf.z + APRON_PROUD;
		placeZ = front - (spec.frontToBack || 0) / 2;
		local = {x: local.x, z: placeZ};
	}

	return {
		y: slabTop + datum,
		z: placeZ,
		cutout: {
			open: size.open,
			x: Number(local.x.toFixed(4)),
			// The counter's OWN z, not its negative. `counter.js` maps a cutout to
			// shape space as `-cut.z`, and the slab is then tipped by -90 about x,
			// which sends shape y back to world -z - so the two negations cancel
			// and `cut.z` is simply the counter-local z. Negating here as well
			// mirrored every hole front to back: invisible on a sink centred in its
			// run, and for a farmhouse it took the bite out of the BACK edge.
			z: Number(local.z.toFixed(4)),
			width: Number(size.width.toFixed(4)),
			depth: Number(size.depth.toFixed(4)),
			// Whose hole this is. Re-fitting replaces its own and leaves a
			// hand-authored one - a hob, a tap - alone.
			owner: sink.id || 'sink',
		},
		apronHeight: spec.mount === 'farmhouse' ? (spec.apronHeight || 0) : 0,
	};
}

/**
 * Merge a derived cutout into a counter's list, replacing the owner's previous.
 *
 * @param {Array<Object>} cutouts
 * @param {Object} cutout
 * @returns {Array<Object>}
 */
export function mergeCutout(cutouts, cutout)
{
	var kept = (cutouts || []).filter(function (entry)
	{
		return entry.owner !== cutout.owner;
	});
	kept.push(cutout);
	return kept;
}

/**
 * Undo what a sink asked of its hosts, because it is going away.
 *
 * A deleted sink that leaves its hole behind is a worktop with a rectangle
 * missing and nothing in it, and a cabinet with no front for a sink that is not
 * there. The cutout carries the sink's id precisely so this can find it and take
 * nothing else with it - a hob's hole stays.
 *
 * Called from `Scene.removeItem` before the item leaves the list, while it still
 * has a position to find its hosts by.
 *
 * @param {Object} sink
 * @param {Array<Object>} items
 * @returns {boolean} Whether anything was given back.
 */
export function releaseFitting(sink, items)
{
	if (!isKind(sink, 'sink'))
	{
		return false;
	}

	var hosts = hostsFor(sink, items);
	var owner = sink.id || 'sink';
	var changed = false;

	if (hosts.counter && hosts.counter.setSpec)
	{
		var counterSpec = hosts.counter.getSpec();
		var kept = (counterSpec && counterSpec.cutouts ? counterSpec.cutouts : [])
			.filter(function (cut) {return cut.owner !== owner;});
		if (counterSpec && kept.length !== (counterSpec.cutouts || []).length)
		{
			counterSpec.cutouts = kept;
			hosts.counter.setSpec(counterSpec);
			changed = true;
		}
	}

	if (hosts.cabinet && hosts.cabinet.setSpec)
	{
		var cabinetSpec = hosts.cabinet.getSpec();
		if (cabinetSpec && cabinetSpec.apronCut)
		{
			// Back to a whole front. A sink base whose sink has gone is an ordinary
			// cabinet again.
			cabinetSpec.apronCut = 0;
			hosts.cabinet.setSpec(cabinetSpec);
			changed = true;
		}
	}

	return changed;
}

/**
 * Fit a sink to the counter it is in and the cabinet under it.
 *
 * Writes three things and no more: the sink's height, the counter's cutout and
 * the cabinet's apron cut. Each host is rebuilt through `setSpec`, which is the
 * only supported way to change what a generated item is.
 *
 * @param {Object} sink
 * @param {Array<Object>} items
 * @returns {boolean} Whether anything changed.
 */
export function applyFitting(sink, items)
{
	if (!isKind(sink, 'sink'))
	{
		return false;
	}

	var hosts = hostsFor(sink, items);
	var spec = sink.metadata.spec;

	// SIZE FIRST, because everything below is measured from the bowl: the hole is
	// cut to it and the height is taken from a build of it. Rebuilding the sink
	// re-enters here through `Item.setSpec` -> `Scene.refit`, and the second pass
	// finds nothing left to change because clamping is idempotent - so this
	// returns and lets that pass do the rest rather than doing it twice.
	var sized = fitSpecToHosts(spec, hosts);
	if (sink.setSpec
		&& (Math.abs((spec.width || 0) - sized.width) > 0.01
			|| Math.abs((spec.frontToBack || 0) - sized.frontToBack) > 0.01))
	{
		var next = sink.getSpec();
		next.width = sized.width;
		next.frontToBack = sized.frontToBack;
		sink.setSpec(next);
		return true;
	}

	var fitting = fittingFor(sink, hosts);
	if (!fitting)
	{
		return false;
	}

	var changed = false;

	// The sink's own height. A tenth of a millimetre of slack, so a refit that
	// changes nothing does not mark the scene dirty for ever.
	if (Math.abs(sink.position.y - fitting.y) > 0.01)
	{
		sink.position.y = fitting.y;
		changed = true;
	}

	// And forward, for a farmhouse, so its apron lands on the front of the run.
	if (fitting.z !== null && fitting.z !== undefined && hosts.counter)
	{
		var placed = fromFrame(hosts.counter, intoFrame(hosts.counter, sink.position.x, sink.position.z).x, fitting.z);
		if (Math.abs(sink.position.x - placed.x) > 0.01 || Math.abs(sink.position.z - placed.z) > 0.01)
		{
			sink.position.x = placed.x;
			sink.position.z = placed.z;
			changed = true;
		}
	}

	if (hosts.counter && hosts.counter.setSpec)
	{
		var counterSpec = hosts.counter.getSpec();
		if (counterSpec)
		{
			var before = JSON.stringify(counterSpec.cutouts || []);
			counterSpec.cutouts = mergeCutout(counterSpec.cutouts, fitting.cutout);
			if (JSON.stringify(counterSpec.cutouts) !== before)
			{
				hosts.counter.setSpec(counterSpec);
				changed = true;
			}
		}
	}

	if (hosts.cabinet && hosts.cabinet.setSpec)
	{
		var cabinetSpec = hosts.cabinet.getSpec();
		if (cabinetSpec && (cabinetSpec.apronCut || 0) !== fitting.apronHeight)
		{
			// Zero is meaningful: it is what puts the front back when somebody
			// switches a farmhouse sink to anything else.
			cabinetSpec.apronCut = fitting.apronHeight;
			hosts.cabinet.setSpec(cabinetSpec);
			changed = true;
		}
	}

	return changed;
}
