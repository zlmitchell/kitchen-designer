// @ts-check
import {Box3, CylinderGeometry, Group, Mesh, Vector3} from 'three';
import {boxGeometryFor} from '../../core/geometry_builders.js';
import {mergeMeshes} from '../../core/geometry_merge.js';
import {materialsForSlots} from '../../core/materials.js';
import {frontPanel} from './cabinet.js';

/**
 * An appliance: a range, a fridge, a dishwasher, a microwave or a vent hood.
 *
 * ## Five appliances are one builder
 *
 * The same claim the sink made about its five mounts, and it holds for the same
 * reason. An appliance is **a box, a face, and a handle**. What differs between
 * a dishwasher and a fridge is how the face is divided and what is bolted to the
 * box - not the modelling.
 *
 * So there is one `faceRects` that divides the front into panels, one
 * `facePanel` that builds one, one `barHandle`, and a short `extras` per subkind
 * for the things that genuinely are extra: a cooktop, a chimney, a vent. A
 * French-door fridge is two panels over a drawer; a side-by-side is two full
 * height panels; a dishwasher is one; a microwave drawer is one on its side. The
 * list is the difference.
 *
 * ## `finish` is what the face is made of, and panel-ready is not a colour
 *
 * `stainless` and `black` build the face as a slab of metal with a bar handle.
 * `panel-ready` builds it with `cabinet.js`'s own `frontPanel` - the actual
 * shaker / slab / raised profile the cabinets beside it use. That is what
 * panel-ready MEANS: the appliance disappears into the run because it is wearing
 * the run's door. Approximating it with a white box would have been the one
 * thing this app exists not to do.
 *
 * It is also why the roadmap puts appliances after runs: the panel has to match
 * the run, and until a run exists the match is made by hand in the inspector.
 *
 * ## Size is not taste
 *
 * Every number in `SIZES` is a trade size, because an appliance that is the
 * wrong size is what breaks a run: a 30in range needs a 30in gap, and a
 * dishwasher is 24in in every kitchen ever built. They are defaults rather than
 * constants - a 36in range exists - but the default has to be the real one, or
 * the first thing anybody draws is wrong.
 *
 * ## What is deliberately NOT here
 *
 * The roadmap lists `microwave-integrated` as a fifth hood style. It is not a
 * hood: it is an over-range microwave and the ABSENCE of a hood, which is a
 * decision about what occupies the slot above the range rather than a shape. So
 * the microwave's `over-range` mount grows the vent and the underside lights it
 * needs to do that job, and the hood has four styles. Phase 3's run is what will
 * refuse to put both in one slot.
 *
 * Doors do not open, for the same reason a cabinet's do not - see `cabinet.js`.
 */

/**
 * Everything an appliance is made of.
 *
 * `body` is the carcass you barely see, `face` the doors and drawer fronts,
 * `trim` the control panels, grates and kicks, `glass` the oven and microwave
 * windows. The values here are the stainless answer; `FINISHES` overrides body,
 * face and hardware as a set, because "stainless" is one decision and not three.
 */
const SLOTS = {
	body: 'metal-stainless',
	face: 'metal-stainless',
	glass: 'glass-smoked',
	hardware: 'metal-stainless',
	trim: 'metal-matte-black',
	// A hood light. Its own slot rather than reusing `glass`, because the render
	// from below showed two BLACK rectangles where the lamps are: smoked glass is
	// what you look through, and a lens is what you look at.
	lens: 'lacquer-white',
};

/**
 * What each finish makes the body, the face and the handle.
 *
 * A preset over the slots rather than a fourth material dropdown: `material.face`
 * still overrides it, so choosing panel-ready and then a walnut face is two
 * clicks and neither of them fights the other.
 */
const FINISHES = {
	stainless: {body: 'metal-stainless', face: 'metal-stainless', hardware: 'metal-stainless'},
	black: {body: 'metal-matte-black', face: 'metal-matte-black', hardware: 'metal-matte-black'},
	// The body stays dark because on a panel-ready machine you never see it: the
	// cabinet panel covers the whole face and the sides are buried in the run.
	'panel-ready': {body: 'metal-matte-black', face: 'paint-white', hardware: 'metal-brushed-nickel'},
};

/**
 * Trade sizes in centimetres, keyed by subkind and then by whichever variant
 * changes them.
 *
 * A built-in fridge is 24in deep because that is what "flush with the cabinet
 * face" means, and it is taller because the depth it gives up has to come back
 * somewhere. An over-range microwave is 30in wide because it spans the range
 * below it; a countertop one is 22in because it has to fit under a wall cabinet
 * with 18in of splash under it.
 */
const SIZES = {
	'range': {width: 76.2, depth: 63.5, height: 91.44},
	'fridge': {width: 90.17, depth: 74.93, height: 177.8},
	'fridge/built-in': {width: 91.44, depth: 61.0, height: 213.36},
	// A beverage cooler is a base cabinet's worth of fridge: 24in wide, and as
	// tall as the carcass it goes beside so the worktop runs over it.
	'fridge/undercounter': {width: 59.53, depth: 59.21, height: 87.15},
	'dishwasher': {width: 60.96, depth: 61.0, height: 87.63},
	'microwave': {width: 55.88, depth: 40.64, height: 30.48},
	'microwave/over-range': {width: 76.2, depth: 38.1, height: 43.18},
	'microwave/drawer': {width: 76.2, depth: 58.42, height: 39.37},
	'hood': {width: 76.2, depth: 50.8, height: 15.24},
	'hood/island': {width: 91.44, depth: 61.0, height: 15.24},
	'hood/downdraft': {width: 76.2, depth: 15.24, height: 10.16},
	// A cabinet hood's canopy is deeper AND taller than a metal one's: it is
	// millwork rather than a pressed shell, so it is built out of the same stock
	// as the run and reads as part of it. 10in of canopy under the mantel.
	'hood/cabinet-front': {width: 76.2, depth: 50.8, height: 25.4},
	'hood/cabinet-over': {width: 76.2, depth: 50.8, height: 25.4},
};

/**
 * The variants each subkind actually has.
 *
 * Guarded rather than trusted, because `subkind` is editable: turn a range into
 * a hood in the inspector and `style` still says `freestanding`, which is not a
 * hood. `shell` falls back to the subkind's first entry, so every intermediate
 * state of an edit is a real appliance rather than an empty group.
 */
const STYLES = {
	range: ['freestanding', 'slide-in'],
	fridge: ['freestanding', 'built-in', 'undercounter'],
	dishwasher: ['standard'],
	microwave: ['standard'],
	hood: ['under-cabinet', 'wall-chimney', 'island', 'downdraft',
		'cabinet-front', 'cabinet-over'],
};

const MOUNTS = ['counter', 'in-cabinet', 'over-range', 'drawer'];

const DEFAULTS = {
	subkind: 'range',
	finish: 'stainless',
	/** Panel-ready only: the cabinet front profile the panel is built in. */
	front: 'shaker',
	/** Range: `gas` grates, or `electric` rings printed on a ceramic top. */
	fuel: 'gas',
	/** The subkind's own variant. See STYLES. */
	style: 'freestanding',
	/** Fridge: how the front divides. */
	doors: 'french',
	/** Dishwasher: `front` controls on a visible strip, or `top` and hidden. */
	controls: 'front',
	/** Microwave: see MOUNTS. */
	mount: 'counter',
	/** Hood: recirculating, so the flue is decoration and stops short. */
	ductless: false,
	/** Where the ceiling is. A chimney hood is the only thing that needs it. */
	ceilingHeight: 243.84,
	/** Bottom of a hood above the floor. 66in over a 36in cooktop. */
	mountHeight: 167.64,
	/** Downdraft: how far the vane rises out of its slot. */
	riseHeight: 30.48,
	/**
	 * Cabinet hood: the depth of the wall cabinets it meets, so it can be flush.
	 *
	 * The hood's own `depth` is what captures over a cooktop and is deeper than
	 * an upper; the MANTEL above the canopy has to be the uppers' depth or the
	 * run steps at the hood, which is the one thing a cabinet hood exists to
	 * avoid. Two numbers because they are two different things, and phase 3's run
	 * is what will eventually set this one rather than the spec.
	 */
	upperDepth: 30.48,
	/**
	 * Cabinet hood: how much mantel there is above the canopy before a cupboard.
	 *
	 * 10in, and the number is forced rather than chosen. A hood hung at 66in
	 * under a 96in ceiling has 30in above it; the canopy takes 10 and what is
	 * left is 20, which is two 10in bands and nothing else that works. 12in of
	 * mantel leaves an 8in cupboard, which is a shelf you cannot reach into, and
	 * 18in leaves 2in, which is a filler.
	 *
	 * So this is the height at which BOTH halves are usable on the commonest
	 * ceiling in the country, and a taller ceiling spends its extra on the
	 * cupboard - which is the right way round, because the mantel is decoration
	 * and the cupboard is storage. Only means anything to `cabinet-over`.
	 */
	mantelHeight: 25.4,
	/**
	 * How many burners or elements the cooktop has.
	 *
	 * Four is a grid of two by two and is what a 30in range had for fifty years.
	 * FIVE is what one has now: the same four with a bigger one in the middle,
	 * which is where the oval burner and the griddle go - and it is a different
	 * arrangement rather than one more of the same thing, because the middle of a
	 * four-burner top is where the grates meet.
	 *
	 * Six is a 36in range, and falls out of the same rule with three columns.
	 *
	 * @type {number}
	 */
	burners: 4,
	/**
	 * A cast-iron griddle over the middle burner.
	 *
	 * Only means anything with five burners, because the plate spans the space
	 * the middle one occupies. Drawn rather than implied: it is the single most
	 * visible thing on a modern range top, and a five-burner range without it
	 * looks like a four-burner range with a mistake in the middle.
	 */
	griddle: false,
	/**
	 * What you pull the doors by.
	 *
	 * `bar` is the tube on two standoffs that makes a stainless box read as an
	 * appliance. `recessed` is the flush pocket that the panel-flat ranges of
	 * fridge have instead -- Samsung's Bespoke line is the obvious one -- and it
	 * is not a smaller bar, it is the ABSENCE of one: the door face is unbroken
	 * and the grip is a shadow line along its edge.
	 *
	 * @type {('bar'|'recessed'|'none')}
	 */
	handles: 'bar',
	/**
	 * A door within the upper-left door.
	 *
	 * Samsung calls it a Beverage Center, LG calls it InstaView, GE calls it a
	 * door-in-door; all three are one inset panel on the left-hand French door,
	 * and it is what tells those fridges apart at a glance.
	 */
	doorInDoor: false,
	/**
	 * The gap between two fronts.
	 *
	 * More than twice a cabinet's 1/8in reveal, because an appliance's is: two
	 * gasketed doors need clearance a pair of cabinet doors does not. Started at
	 * the cabinet's number and the render settled it - between two stainless
	 * panels a 5mm gap is one pixel of grazing highlight, and a French-door fridge
	 * came out as one unbroken sheet with handles stuck on it.
	 */
	reveal: 1.1,
	/** How far a face panel stands off the body. */
	faceThickness: 1.9,
	/**
	 * Extra standoff for a panel-ready front, on top of `faceThickness`.
	 *
	 * A cabinet's door stands off its FACE FRAME, not off its carcass, so a panel
	 * hung flat on an appliance body lands a face frame's thickness behind the
	 * doors either side of it. Rendered between two shaker base cabinets that was
	 * a visible step down the run - which is the whole thing panel-ready exists to
	 * avoid. 3/4in is `cabinet.js`'s `panel`, and it is what the mounting brackets
	 * on a real dishwasher are set out by.
	 *
	 * It aligns with a FACE-FRAME cabinet, which is the catalog default. A
	 * frameless run reveals differently, and matching a run properly is the run's
	 * job - phase 3, and the reason the roadmap ordered these the other way round.
	 */
	panelStandoff: 1.9,
};

/**
 * @typedef {Object} ApplianceSpec
 * @property {number} [upperDepth] @property {number} [mantelHeight]
 * @property {('range'|'fridge'|'dishwasher'|'microwave'|'hood')} [subkind]
 * @property {('stainless'|'black'|'panel-ready')} [finish]
 * @property {('slab'|'shaker'|'raised')} [front]
 * @property {number} [width] @property {number} [depth] @property {number} [height]
 * @property {string} [style] @property {string} [mount]
 * @property {number} [burners] @property {boolean} [griddle]
 * @property {('bar'|'recessed'|'none')} [handles] @property {boolean} [doorInDoor]
 * @property {('gas'|'electric')} [fuel]
 * @property {('french'|'side-by-side'|'top-freezer'|'bottom-freezer')} [doors]
 * @property {('front'|'top')} [controls]
 * @property {boolean} [ductless]
 * @property {number} [ceilingHeight] @property {number} [mountHeight]
 * @property {Object} [material]
 */

/**
 * @typedef {Object} FaceRect
 * @property {number} x0 @property {number} x1 @property {number} y0 @property {number} y1
 * @property {string} handle Which edge the bar runs along: top, bottom, left,
 *           right, or none.
 * @property {boolean} [glass] Whether this panel has a window in it.
 * @property {?{x0: number, x1: number, y0: number, y1: number}} [inset] A door
 *           within this door - a beverage panel, an InstaView, a door-in-door.
 */

function box(mat, x0, x1, y0, y1, z0, z1)
{
	var mesh = new Mesh(boxGeometryFor(mat, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)), mat);
	mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
	return mesh;
}

/**
 * A round bar along one axis, running from `lo` to `hi` on it.
 *
 * `u` and `v` are the other two coordinates, in x, y, z order skipping the axis:
 * for an x bar they are y and z, for a y bar x and z, for a z bar x and y.
 */
function bar(mat, radius, axis, lo, hi, u, v)
{
	var mesh = new Mesh(new CylinderGeometry(radius, radius, Math.abs(hi - lo), 10), mat);
	var mid = (lo + hi) / 2;
	if (axis === 'x')
	{
		mesh.rotation.z = Math.PI / 2;
		mesh.position.set(mid, u, v);
	}
	else if (axis === 'z')
	{
		mesh.rotation.x = Math.PI / 2;
		mesh.position.set(u, v, mid);
	}
	else
	{
		mesh.position.set(u, mid, v);
	}
	return mesh;
}

/** A flat disc lying in the xz plane - a burner cap, an element ring. */
function disc(mat, radius, thickness, cx, cy, cz)
{
	var mesh = new Mesh(new CylinderGeometry(radius, radius, thickness, 16), mat);
	mesh.position.set(cx, cy, cz);
	return mesh;
}

/**
 * The appliance handle: a tube on two standoffs, along one edge of a panel.
 *
 * The single most recognisable thing about any of these, and the reason a
 * stainless box reads as a fridge rather than as a locker. It spans most of the
 * edge rather than being a cabinet's knob, which is also what keeps an appliance
 * looking like an appliance while it is wearing a cabinet door: a panel-ready
 * dishwasher still takes the kitchen's long pull.
 *
 * @param {FaceRect} rect
 * @param {number} z The front face of the panel it hangs on.
 * @returns {Array<Mesh>}
 */
function barHandle(mat, rect, z, projection, style)
{
	if (rect.handle === 'none' || style === 'none')
	{
		return [];
	}
	if (style === 'recessed')
	{
		// A pocket, not a bar. Set INTO the face rather than standing off it, so
		// the front is unbroken and the grip is the shadow line along its edge -
		// which is the whole look, and the reason a flat-panel fridge needs a
		// different shape here rather than a shorter tube.
		var deep = 1.6;
		if (rect.handle === 'top' || rect.handle === 'bottom')
		{
			var edgeY = (rect.handle === 'top') ? rect.y1 - 3.2 : rect.y0 + 0.6;
			return [box(mat, rect.x0 + 4, rect.x1 - 4, edgeY, edgeY + 2.6, z - deep, z)];
		}
		var edgeX = (rect.handle === 'left') ? rect.x0 + 0.6 : rect.x1 - 3.2;
		return [box(mat, edgeX, edgeX + 2.6, rect.y0 + 6, rect.y1 - 6, z - deep, z)];
	}
	var radius = 1.1;
	var inset = 4.6;
	var standoff = 1.5;
	var stand = z + projection - radius;
	/** @type {Array<Mesh>} */
	var out = [];
	if (rect.handle === 'top' || rect.handle === 'bottom')
	{
		var y = (rect.handle === 'top') ? rect.y1 - inset : rect.y0 + inset;
		var mid = (rect.x0 + rect.x1) / 2;
		var half = Math.max(4, (rect.x1 - rect.x0) * 0.42);
		out.push(bar(mat, radius, 'x', mid - half, mid + half, y, stand));
		out.push(box(mat, mid - half, mid - half + standoff, y - radius, y + radius, z, stand));
		out.push(box(mat, mid + half - standoff, mid + half, y - radius, y + radius, z, stand));
	}
	else
	{
		var x = (rect.handle === 'left') ? rect.x0 + inset : rect.x1 - inset;
		var midY = (rect.y0 + rect.y1) / 2;
		var halfY = Math.max(4, (rect.y1 - rect.y0) * 0.38);
		out.push(bar(mat, radius, 'y', midY - halfY, midY + halfY, x, stand));
		out.push(box(mat, x - radius, x + radius, midY - halfY, midY - halfY + standoff, z, stand));
		out.push(box(mat, x - radius, x + radius, midY + halfY - standoff, midY + halfY, z, stand));
	}
	return out;
}

/**
 * One panel of the face, plus its handle.
 *
 * This is the whole of `finish`. A metal finish is a slab with an optional
 * window; a panel-ready one is a real cabinet front in the run's own profile,
 * and gets no window, because the point of it is to not look like an appliance.
 *
 * @param {FaceRect} rect
 */
function facePanel(group, s, mats, rect, z)
{
	var thickness = s.faceThickness;
	var front = z + thickness;
	if (s.finish === 'panel-ready')
	{
		var out = z + s.panelStandoff;
		front = out + thickness;
		frontPanel({front: mats.face}, s.front, rect.x0, rect.x1, rect.y0, rect.y1, out, thickness)
			.forEach(function (mesh) {group.add(mesh);});
	}
	else if (rect.glass)
	{
		// A window is a border of face metal round a pane, not a hole: the pane
		// sits just proud of the slab behind it, which is how an oven door is
		// actually built and what gives the border its shadow line.
		// Off the SHORTER side, and floored: judging it off each side separately
		// gave a flat 7cm on a 75cm oven door, which rendered as a black hole with
		// a pinstripe round it rather than as a door with a window in it.
		var border = Math.max(4.0, Math.min(10.0,
			Math.min(rect.x1 - rect.x0, rect.y1 - rect.y0) * 0.15));
		group.add(box(mats.face, rect.x0, rect.x1, rect.y0, rect.y1, z, front));
		group.add(box(mats.glass, rect.x0 + border, rect.x1 - border,
			rect.y0 + border, rect.y1 - border, front - 0.2, front + 0.4));
	}
	else
	{
		group.add(box(mats.face, rect.x0, rect.x1, rect.y0, rect.y1, z, front));
	}
	barHandle(mats.hardware, rect, front, 6.4, s.handles)
		.forEach(function (mesh) {group.add(mesh);});
	if (rect.inset)
	{
		// The door within the door. Its own face, held a hair proud so the seam
		// round it catches - flush, it is one surface and reads as a sticker.
		var pad = 2.2;
		group.add(box(mats.trim, rect.inset.x0 - pad, rect.inset.x1 + pad,
			rect.inset.y0 - pad, rect.inset.y1 + pad, front - 0.1, front + 0.5));
		group.add(box(mats.face, rect.inset.x0, rect.inset.x1,
			rect.inset.y0, rect.inset.y1, front, front + 1.0));
		barHandle(mats.hardware, {x0: rect.inset.x0, x1: rect.inset.x1,
			y0: rect.inset.y0, y1: rect.inset.y1, handle: 'left'},
		front + 1.0, 4.0, s.handles).forEach(function (mesh) {group.add(mesh);});
	}
}

/**
 * The fridge's four door layouts.
 *
 * Split horizontally, then vertically, and hang each handle at the meeting line:
 * a pair of doors is handled at the middle because that is where a hand goes,
 * and a drawer across the top for the same reason.
 *
 * @returns {Array<FaceRect>}
 */
function fridgeRects(s, x0, x1, y0, y1)
{
	var r = s.reveal;
	var mid = (x0 + x1) / 2;
	// The RESOLVED style, not the raw one: `shell` guards it and this is asked
	// before anything downstream would have caught a spec mid-edit.
	s = Object.assign({}, s, {style: (STYLES.fridge.indexOf(s.style) === -1)
		? STYLES.fridge[0] : s.style});
	if (s.style === 'undercounter')
	{
		// One door, floor to worktop, and glass: a beverage cooler is a cabinet
		// that shows what is in it, and a solid one is just a small fridge.
		return [{x0: x0, x1: x1, y0: y0, y1: y1, handle: 'left', glass: true}];
	}
	if (s.doors === 'side-by-side')
	{
		// The freezer is the narrower side, which is what tells the two apart.
		var split = x0 + (x1 - x0) * 0.42;
		return [
			{x0: x0, x1: split - r, y0: y0, y1: y1, handle: 'right'},
			{x0: split + r, x1: x1, y0: y0, y1: y1, handle: 'left'},
		];
	}
	if (s.doors === 'top-freezer')
	{
		var freezer = y1 - (y1 - y0) * 0.3;
		return [
			{x0: x0, x1: x1, y0: freezer + r, y1: y1, handle: 'bottom'},
			{x0: x0, x1: x1, y0: y0, y1: freezer - r, handle: 'top'},
		];
	}
	if (s.doors === 'bottom-freezer')
	{
		var drawer = y0 + (y1 - y0) * 0.35;
		return [
			{x0: x0, x1: x1, y0: y0, y1: drawer - r, handle: 'top'},
			{x0: x0, x1: x1, y0: drawer + r, y1: y1, handle: 'bottom'},
		];
	}
	if (s.doors === 'four-door')
	{
		// French doors over TWO drawers: a convertible middle compartment and the
		// freezer below it. The middle drawer is what makes it a four-door rather
		// than a French door with a big freezer, and it is shallower than the one
		// under it - it holds trays, not a turkey.
		var freezerTop = y0 + (y1 - y0) * 0.245;
		var flexTop = y0 + (y1 - y0) * 0.425;
		return [
			{x0: x0, x1: x1, y0: y0, y1: freezerTop - r, handle: 'top'},
			{x0: x0, x1: x1, y0: freezerTop + r, y1: flexTop - r, handle: 'top'},
			{x0: x0, x1: mid - r, y0: flexTop + r, y1: y1, handle: 'right',
				inset: s.doorInDoor ? insetPanel(x0, mid - r, flexTop + r, y1) : null},
			{x0: mid + r, x1: x1, y0: flexTop + r, y1: y1, handle: 'left'},
		];
	}
	// French: a pair over a freezer drawer, which is why the fridge compartment
	// is the wide one and the two doors are each half of it.
	var drawerTop = y0 + (y1 - y0) * 0.38;
	return [
		{x0: x0, x1: x1, y0: y0, y1: drawerTop - r, handle: 'top'},
		{x0: x0, x1: mid - r, y0: drawerTop + r, y1: y1, handle: 'right',
			inset: s.doorInDoor ? insetPanel(x0, mid - r, drawerTop + r, y1) : null},
		{x0: mid + r, x1: x1, y0: drawerTop + r, y1: y1, handle: 'left'},
	];
}

/**
 * Where the door-in-door panel sits on the door it is set into.
 *
 * The upper two thirds, inset from every edge: it has to clear the hinge side,
 * the handle side and the seal, which is why it is nowhere near the full door.
 */
function insetPanel(x0, x1, y0, y1)
{
	var w = x1 - x0;
	var h = y1 - y0;
	return {
		x0: x0 + w * 0.16, x1: x1 - w * 0.16,
		y0: y0 + h * 0.34, y1: y1 - h * 0.09,
	};
}

/**
 * How the front divides, per subkind. The list IS the difference between these
 * appliances - see the note at the top of the file.
 *
 * @returns {Array<FaceRect>}
 */
function faceRects(s, f)
{
	var r = s.reveal;
	var x0 = -f.width / 2 + r;
	var x1 = f.width / 2 - r;
	if (s.subkind === 'dishwasher')
	{
		// A front-control machine wears its controls on a strip at the top of the
		// face; a top-control one hides them on the door's upper edge and its
		// panel runs the whole way up. That is exactly what makes an integrated
		// dishwasher vanish into a run, and it is one number.
		var strip = (s.controls === 'front') ? 8.9 : 0;
		return [{x0: x0, x1: x1, y0: f.kick + r, y1: f.height - strip - r, handle: 'top'}];
	}
	if (s.subkind === 'range')
	{
		// A storage drawer under the oven, and controls either on the backguard
		// (freestanding) or on a band under the cooktop (slide-in).
		var band = (f.style === 'slide-in') ? 10.16 : 0;
		var drawerTop = f.kick + 20.32;
		return [
			{x0: x0, x1: x1, y0: f.kick + r, y1: drawerTop, handle: 'top'},
			{x0: x0, x1: x1, y0: drawerTop + r, y1: f.height - band - r, handle: 'top', glass: true},
		];
	}
	if (s.subkind === 'fridge')
	{
		return fridgeRects(s, x0, x1, f.kick + r, f.height - r);
	}
	if (s.subkind === 'microwave')
	{
		if (f.mount === 'drawer')
		{
			// A drawer microwave has no swing door and no side panel: the whole
			// face is one front that pulls out, with the controls on its top edge.
			return [{x0: x0, x1: x1, y0: r, y1: f.height - 6.4, handle: 'top'}];
		}
		// Door on the left, control panel on the right - the layout every
		// countertop and over-range microwave has had for forty years.
		return [{x0: x0, x1: x0 + (x1 - x0) * 0.72, y0: r, y1: f.height - r,
			handle: 'right', glass: true}];
	}
	return [];
}

/**
 * The cooktop, which is the whole visible difference between gas and electric.
 *
 * Gas is burner caps under continuous cast-iron grates - bars running front to
 * back, which is what a modern range has and what reads as gas from any angle.
 * Electric is a ceramic slab with the element rings ON it, and that is not a
 * cheat to dodge transparency: a radiant or induction top has its circles
 * printed on the glass.
 */
function cooktop(group, s, mats, f)
{
	var top = f.height;
	var inset = 3.0;
	// Four and five share a two-by-two grid; six is three columns of two. The
	// FIFTH burner is not part of the grid at all - it is the one in the middle,
	// where on a four-burner top the grates meet.
	//
	// The WIDTH still answers when nothing else does, which is what it did before
	// this field existed: a 36in range has six burners unless somebody says
	// otherwise. Asked and answered are different questions, and conflating them
	// would have made `burners: 4` on a 36in range draw six.
	var asked = (s.burners === undefined) ? ((f.width >= 85) ? 6 : 4) : s.burners;
	var wanted = Math.max(4, Math.min(6, Math.round(asked)));
	var columns = (wanted >= 6) ? 3 : 2;
	var centre = (wanted === 5);
	// Off the EDGE rather than off the centre: spreading burners across most of
	// the half width put a 30in range's outer element ring 1cm past the edge of
	// its own ceramic top, which the top-down render showed and the size did not.
	var spread = Math.max(8, f.width / 2 - 19.0);
	var zs = [-f.depth * 0.18, f.depth * 0.18];
	var at = function (i)
	{
		return (columns === 1) ? 0 : -spread + (2 * spread * i) / (columns - 1);
	};

	if (s.fuel === 'electric')
	{
		group.add(box(mats.glass, -f.width / 2 + inset, f.width / 2 - inset, top, top + 0.6,
			-f.depth / 2 + inset, f.depth / 2 - inset));
		if (centre)
		{
			// An oval, drawn as a wide disc: the middle element on a five-zone top
			// is a bridge or a warming zone, and neither is a circle.
			group.add(disc(mats.hardware, 11.0, 0.2, 0, top + 0.7, 0));
			group.add(disc(mats.glass, 9.6, 0.3, 0, top + 0.75, 0));
		}
		for (var c = 0; c < columns; c++)
		{
			var ex = at(c);
			zs.forEach(function (z)
			{
				// A ring drawn as two discs rather than a torus: the printed circle
				// is a line, and a line is a disc with a smaller disc of the top's
				// own colour sitting inside it. In the HARDWARE material, not the
				// trim - matte black on smoked glass is two shades of the same
				// thing, and the render came out as a plain black slab.
				group.add(disc(mats.hardware, 9.0, 0.2, ex, top + 0.7, z));
				group.add(disc(mats.glass, 7.6, 0.3, ex, top + 0.75, z));
			});
		}
		return;
	}

	// Gas: the burners, then a grate OVER each column of them. Spacing the bars
	// evenly across the whole width instead put them between the burners - five
	// stripes and four dots, which is what the top-down render showed and what a
	// vertex count cannot.
	var grateY = top + 2.4;
	var reach = f.depth * 0.30;
	for (var i = 0; i < columns; i++)
	{
		var bx = at(i);
		zs.forEach(function (z)
		{
			group.add(disc(mats.trim, 4.6, 1.4, bx, top + 0.7, z));
		});
		[-5.5, 0, 5.5].forEach(function (dx)
		{
			group.add(bar(mats.trim, 0.8, 'z', -reach, reach, bx + dx, grateY));
		});
		// End rails, so the bars read as one cast grate rather than as loose rods.
		[-reach, reach].forEach(function (z)
		{
			group.add(bar(mats.trim, 0.8, 'x', bx - 6.3, bx + 6.3, grateY, z));
		});
	}

	if (!centre)
	{
		return;
	}
	// The middle burner, and what goes over it. A griddle is a solid plate;
	// without one the zone still needs a grate, or the pan bridges two others.
	var half = Math.min(12.0, f.width * 0.16);
	group.add(disc(mats.trim, 5.6, 1.4, 0, top + 0.7, 0));
	if (s.griddle)
	{
		group.add(box(mats.trim, -half, half, grateY - 1.0, grateY + 0.8,
			-reach, reach));
	}
	else
	{
		[-4.0, 0, 4.0].forEach(function (dx)
		{
			group.add(bar(mats.trim, 0.8, 'z', -reach, reach, dx, grateY));
		});
	}
}

/**
 * The canopy of a chimney hood, as a four-sided frustum.
 *
 * `CylinderGeometry` with four radial segments IS a square frustum, so the taper
 * that makes a hood a hood costs one call and no custom geometry - the same
 * trade the sink's lathe makes. Two things it needs:
 *
 *   - the rotation goes on the GEOMETRY, not on the mesh. A mesh applies its
 *     scale before its rotation, so rotating the mesh would squash the unrotated
 *     frustum and leave a diamond in plan.
 *   - a four-segment cylinder's flats sit at `r * cos(45)` from the axis, so a
 *     radius of `1 / sqrt(2)` is what makes the unit frustum one unit across.
 */
function canopy(mat, topFraction, width, depth, y0, y1, lean)
{
	var geometry = new CylinderGeometry(Math.SQRT1_2 * topFraction, Math.SQRT1_2, 1, 4, 1);
	geometry.rotateY(Math.PI / 4);
	if (lean)
	{
		// Shear the top ring backwards so the canopy's BACK face stands vertical.
		// A frustum is symmetric by construction and a wall hood is not: with the
		// symmetric one, the flue rising at the wall overhung the canopy's top by
		// a third of the depth and stood on nothing, which the render showed
		// plainly and which no dimension of either part would have.
		var position = geometry.getAttribute('position');
		for (var i = 0; i < position.count; i++)
		{
			if (position.getY(i) > 0)
			{
				position.setZ(i, position.getZ(i) + lean);
			}
		}
		position.needsUpdate = true;
	}
	var mesh = new Mesh(geometry, mat);
	mesh.scale.set(width, Math.max(0.1, y1 - y0), depth);
	mesh.position.set(0, (y0 + y1) / 2, 0);
	return mesh;
}

/**
 * The filter on the underside of a canopy, with baffles across it.
 *
 * From below - the only place a hood is ever seen from close up - this is the
 * whole object, and it has to hang PROUD of the canopy. Set inside it, which is
 * where a real filter sits, it was swallowed whole: a canopy is a solid, so the
 * render from below showed a blank cap while the vertex count showed a filter
 * that was there.
 *
 * Pulled out of `hood` so a cabinet hood gets the same one. That is not a
 * convenience: a wood hood is a wood BOX round a metal liner, and the liner is
 * the only part of it that is an appliance at all. Drawing the box without it
 * would be drawing a cupboard over a cooker.
 */
function hoodFilter(group, mats, f)
{
	var fw = f.width * 0.38;
	var fd = f.depth * 0.34;
	group.add(box(mats.trim, -fw, fw, -1.6, 0.2, -fd, fd));
	for (var i = 0; i < 4; i++)
	{
		var bz = -fd + (2 * fd * (i + 0.5)) / 4;
		group.add(bar(mats.hardware, 0.5, 'x', -fw + 1, fw - 1, -1.6, bz));
	}
}

/** A cupboard shorter than this is a filler panel, not a cupboard. 10in. */
const MIN_CUPBOARD = 25.4;

/** The gap between two stacked fronts, and between a front and the box. 1/8in. */
const HOOD_REVEAL = 0.32;

/**
 * One clad section of a cabinet hood: a box, wearing the run's own door front.
 *
 * The front comes from `cabinet.js`'s `frontPanel` - the same call a panel-ready
 * dishwasher makes, and the reason that function is exported - so a hood in a
 * shaker kitchen is shaker, in the run's profile, without anybody keeping the
 * two in step. That IS what "follows the cabinets" means: not a colour that
 * matches, a front built by the same code.
 *
 * The panel is inset by a reveal on every edge, so two sections stacked on each
 * other read as two fronts with a gap and not as one tall surface. Same claim
 * `cabinet.js` opens with, and the reason a cupboard over a mantel is visible as
 * a cupboard at all.
 */
function cladSection(group, s, mats, f, y0, y1, z0, z1)
{
	if (y1 - y0 < 2)
	{
		return;
	}
	group.add(box(mats.body, -f.width / 2, f.width / 2, y0, y1, z0, z1));
	var r = HOOD_REVEAL;
	frontPanel({front: mats.face}, s.front,
		-f.width / 2 + r, f.width / 2 - r, y0 + r, y1 - r, z1, s.faceThickness)
		.forEach(function (mesh) {group.add(mesh);});
}

/**
 * A hood built as millwork, flush with the cabinets either side of it.
 *
 * The shape is two boxes and the step between them is the whole of it. The
 * CANOPY keeps the hood's own depth, because that is what captures over a
 * cooktop and a 12in-deep hood does not. The MANTEL above it drops back to the
 * wall cabinets' depth, so its face lands in the same plane as theirs and the
 * run does not step at the hood - which is the one thing this style exists to
 * avoid, and the reason `upperDepth` is a separate number from `depth`.
 *
 * `cabinet-over` stops the mantel short and puts a cupboard on top of it. The
 * cupboard is what is LEFT once the mantel has taken its 18in, rather than a
 * height of its own: the ceiling is where it has to end either way, and two
 * heights that both have to add up to a third is a sum somebody has to keep
 * solving. Where the remainder is too short to be a cupboard the mantel simply
 * runs on to the ceiling, which is `cabinet-front` - the honest answer, and the
 * same fallback `frontPanel` makes for a door too narrow for a centre panel.
 */
function cabinetHood(group, s, mats, f)
{
	var back = -f.depth / 2;
	var top = Math.max(f.height + MIN_CUPBOARD, s.ceilingHeight - s.mountHeight);
	// Clamped into the hood's own depth: an upper deeper than the hood would put
	// the mantel in front of the canopy and hang it over the cooktop.
	var mantelFront = back + Math.max(10, Math.min(s.upperDepth, f.depth));

	// The canopy, at the hood's own depth.
	cladSection(group, s, mats, f, 0, f.height, back, f.depth / 2);

	var mantelTop = top;
	if (f.style === 'cabinet-over' && (top - f.height - s.mantelHeight) >= MIN_CUPBOARD)
	{
		mantelTop = f.height + s.mantelHeight;
	}
	cladSection(group, s, mats, f, f.height, mantelTop, back, mantelFront);
	// The cupboard, when there is room for one worth having.
	cladSection(group, s, mats, f, mantelTop, top, back, mantelFront);

	hoodFilter(group, mats, f);
}

/**
 * A vent hood, in its six shapes.
 *
 * The chimney is the cabinet's `to-ceiling` question again: it runs from the
 * canopy to the ceiling, so it has to be told where the ceiling is and how high
 * the hood is hung. `ductless` is what stops it short - a recirculating hood has
 * a flue cover that is decoration, and drawing that into the ceiling would claim
 * a duct which is not there.
 */
function hood(group, s, mats, f)
{
	if (f.style === 'cabinet-front' || f.style === 'cabinet-over')
	{
		cabinetHood(group, s, mats, f);
		return;
	}
	if (f.style === 'downdraft')
	{
		// Not a canopy at all: a slot behind the cooktop and a vane that rises out
		// of it. The vane is the only part anybody ever sees.
		group.add(box(mats.body, -f.width / 2, f.width / 2, 0, f.height,
			-f.depth / 2, f.depth / 2));
		group.add(box(mats.glass, -f.width / 2 + 2, f.width / 2 - 2, f.height,
			f.height + s.riseHeight, -1.6, 1.6));
		return;
	}

	var flue = 0.34;
	var canopyTop = f.height;
	// A wall hood's flue rises at the wall, so its canopy is sheared to put the
	// top rectangle there; an island hood is seen from every side and stays
	// symmetric, with the flue centred.
	var leaning = (f.style === 'wall-chimney');
	if (f.style === 'under-cabinet')
	{
		group.add(box(mats.body, -f.width / 2, f.width / 2, 0, canopyTop,
			-f.depth / 2, f.depth / 2));
	}
	else
	{
		// The canopy tapers to the chimney's own width, so the two meet without a
		// step. A third of the width is what a 30in hood on a 10in flue looks like.
		group.add(canopy(mats.body, flue, f.width, f.depth, 0, canopyTop,
			leaning ? -(0.5 - flue / 2) : 0));
	}

	hoodFilter(group, mats, f);

	if (f.style === 'under-cabinet')
	{
		return;
	}

	// The chimney: to the ceiling for a ducted hood, a short cover for a
	// recirculating one, because it is not going anywhere.
	var reach = Math.max(canopyTop + 10, s.ceilingHeight - s.mountHeight);
	var top = s.ductless ? Math.min(reach, canopyTop + 45.72) : reach;
	var cw = f.width * flue / 2;
	var cd = f.depth * flue / 2;
	// Over the canopy's top, wherever the shear above put it.
	var zc = leaning ? (-f.depth / 2 + cd) : 0;
	group.add(box(mats.body, -cw, cw, canopyTop, top, zc - cd, zc + cd));
}

/**
 * What each subkind bolts onto the box, beyond its face.
 */
function extras(group, s, mats, f)
{
	var front = f.depth / 2;
	if (s.subkind === 'range')
	{
		cooktop(group, s, mats, f);
		if (f.style === 'slide-in')
		{
			// Controls on a band under the cooktop, on the face.
			group.add(box(mats.trim, -f.width / 2 + s.reveal, f.width / 2 - s.reveal,
				f.height - 10.16, f.height - s.reveal, front, front + s.faceThickness));
		}
		else
		{
			// A backguard: the panel that stands up behind a freestanding range and
			// carries the knobs. Its absence is what makes a range read as slide-in,
			// so this is the geometry that distinguishes the two styles.
			var guard = 17.78;
			group.add(box(mats.body, -f.width / 2, f.width / 2, f.height, f.height + guard,
				-f.depth / 2, -f.depth / 2 + 7.0));
			group.add(box(mats.trim, -f.width / 2 + 2, f.width / 2 - 2,
				f.height + 4, f.height + guard - 3,
				-f.depth / 2 + 7.0, -f.depth / 2 + 7.6));
		}
		return;
	}
	if (s.subkind === 'dishwasher')
	{
		if (s.controls === 'front')
		{
			group.add(box(mats.trim, -f.width / 2 + s.reveal, f.width / 2 - s.reveal,
				f.height - 8.9, f.height - s.reveal, front, front + s.faceThickness));
		}
		return;
	}
	if (s.subkind !== 'microwave')
	{
		return;
	}
	if (f.mount === 'drawer')
	{
		// A drawer's controls run along the top of the front, where a swing door's
		// run down the side. Without it the whole face is one material and the
		// thing has no scale at all - which is what the merged material list
		// showed before it was here: a drawer microwave in ONE material.
		group.add(box(mats.trim, -f.width / 2 + s.reveal, f.width / 2 - s.reveal,
			f.height - 6.4 + s.reveal, f.height - s.reveal, front, front + s.faceThickness));
	}
	else
	{
		// The control panel beside the door.
		var panelX = -f.width / 2 + s.reveal + (f.width - 2 * s.reveal) * 0.72;
		group.add(box(mats.trim, panelX + s.reveal, f.width / 2 - s.reveal,
			s.reveal, f.height - s.reveal, front, front + s.faceThickness));
	}
	if (f.mount === 'over-range')
	{
		// What makes it a hood as well as a microwave: a vent grille on the
		// underside, and a light either side of it. Without these it is a
		// microwave hanging in the air over a cooktop.
		var vw = f.width * 0.3;
		group.add(box(mats.trim, -vw, vw, -0.6, 0.4, -f.depth * 0.2, f.depth * 0.24));
		for (var i = 0; i < 5; i++)
		{
			var bx = -vw + (2 * vw * (i + 0.5)) / 5;
			// BELOW the body, not inside it. At +0.5 they were buried in the
			// carcass and the underside rendered as a plain dark rectangle.
			group.add(bar(mats.hardware, 0.5, 'z', -f.depth * 0.19, f.depth * 0.23, bx, -0.55));
		}
		group.add(box(mats.lens, -vw - 9, -vw - 2, -0.5, 0.2, -3, 3));
		group.add(box(mats.lens, vw + 2, vw + 9, -0.5, 0.2, -3, 3));
	}
	else if (f.mount === 'counter')
	{
		// Feet, so it stands on a worktop rather than growing out of it.
		[-1, 1].forEach(function (sx)
		{
			[-1, 1].forEach(function (sz)
			{
				group.add(box(mats.trim, sx * (f.width / 2 - 6), sx * (f.width / 2 - 3),
					-1.2, 0, sz * (f.depth / 2 - 6), sz * (f.depth / 2 - 3)));
			});
		});
	}
}

/**
 * The dark liner the reveals show.
 *
 * The gap between two doors is what makes a French-door fridge two doors, and on
 * a stainless machine it vanished: the body behind the fronts was stainless too,
 * so a 5mm reveal between two stainless panels rendered as one unbroken sheet.
 * The panel-ready render is what gave it away - there the body IS dark, and the
 * seam was obvious.
 *
 * So the area the fronts cover gets a thin dark plate under them, which is the
 * gasket line you actually see on the real thing. It reaches only as far as the
 * fronts do, because the face above a range's oven door is cooktop and not a gap.
 *
 * @param {Array<FaceRect>} rects
 */
function liner(group, mats, rects, z)
{
	if (!rects.length)
	{
		return;
	}
	// Held a hair inside the fronts and a hair off the body, on every axis. Flush
	// with them it shares a plane with both, and two coplanar faces z-fight: the
	// first render of this came out with a dashed line stitched along the top edge
	// of the range's oven door, which is depth-buffer noise and not geometry.
	var gap = 0.12;
	var x0 = Math.min.apply(null, rects.map(function (r) {return r.x0;})) + gap;
	var x1 = Math.max.apply(null, rects.map(function (r) {return r.x1;})) - gap;
	var y0 = Math.min.apply(null, rects.map(function (r) {return r.y0;})) + gap;
	var y1 = Math.max.apply(null, rects.map(function (r) {return r.y1;})) - gap;
	group.add(box(mats.trim, x0, x1, y0, y1, z + 0.05, z + 0.6));
}

/**
 * The resolved sizes and variants every part is placed against.
 *
 * `style` and `mount` are put through their guards here rather than at each use,
 * so nothing downstream has to think about an appliance mid-edit.
 */
function shell(s)
{
	var styles = STYLES[s.subkind] || STYLES.range;
	var style = (styles.indexOf(s.style) === -1) ? styles[0] : s.style;
	var mount = (MOUNTS.indexOf(s.mount) === -1) ? MOUNTS[0] : s.mount;
	var key = (s.subkind === 'microwave') ? mount : style;
	var size = SIZES[s.subkind + '/' + key] || SIZES[s.subkind] || SIZES.range;
	return {
		width: Math.max(10, (s.width === undefined) ? size.width : s.width),
		depth: Math.max(10, (s.depth === undefined) ? size.depth : s.depth),
		height: Math.max(10, (s.height === undefined) ? size.height : s.height),
		style: style,
		mount: mount,
		// A fridge and a dishwasher stand on a recessed plinth; a range sits on the
		// floor with a token one; a microwave and a hood have none at all, because
		// neither of them touches the floor.
		kick: (s.subkind === 'fridge' || s.subkind === 'dishwasher') ? 8.9
			: ((s.subkind === 'range') ? 5.08 : 0),
	};
}

/** What a panel may ask about an appliance. */
export const APPLIANCE_SCHEMA = {
	label: 'Appliance',
	// The builder's own slot defaults, so the panel can show the finish an
	// unspecified slot will actually be built with. A REFERENCE to `SLOTS`, not a
	// copy: a default written twice is a default that goes stale.
	slots: SLOTS,
	fields: [
		{key: 'subkind', label: 'Appliance', type: 'choice', options: [
			{value: 'range', label: 'Range'},
			{value: 'fridge', label: 'Fridge'},
			{value: 'dishwasher', label: 'Dishwasher'},
			{value: 'microwave', label: 'Microwave'},
			{value: 'hood', label: 'Hood'},
		]},
		// One `style` key, three option lists. Only one is ever visible, because
		// `when` decides that from the subkind - and a spec carrying the wrong one
		// for its subkind still builds, because `shell` guards it.
		{key: 'style', label: 'Style', type: 'choice', when: {subkind: 'range'}, options: [
			{value: 'freestanding', label: 'Freestanding'},
			{value: 'slide-in', label: 'Slide-in'},
		]},
		{key: 'style', label: 'Style', type: 'choice', when: {subkind: 'fridge'}, options: [
			{value: 'freestanding', label: 'Freestanding'},
			{value: 'built-in', label: 'Built-in'},
			{value: 'undercounter', label: 'Undercounter'},
		]},
		{key: 'style', label: 'Style', type: 'choice', when: {subkind: 'hood'}, options: [
			{value: 'cabinet-front', label: 'Cabinet front'},
			{value: 'cabinet-over', label: 'Cabinet front, cupboard above'},
			{value: 'under-cabinet', label: 'Under cabinet'},
			{value: 'wall-chimney', label: 'Chimney'},
			{value: 'island', label: 'Island'},
			{value: 'downdraft', label: 'Downdraft'},
		]},
		{key: 'burners', label: 'Burners', type: 'choice', when: {subkind: 'range'}, options: [
			{value: 4, label: 'Four'},
			{value: 5, label: 'Five, with a middle zone'},
			{value: 6, label: 'Six'},
		]},
		{key: 'griddle', label: 'Griddle', type: 'choice', when: {subkind: 'range'}, options: [
			{value: false, label: 'None'},
			{value: true, label: 'Over the middle burner'},
		]},
		{key: 'fuel', label: 'Fuel', type: 'choice', when: {subkind: 'range'}, options: [
			{value: 'gas', label: 'Gas'},
			{value: 'electric', label: 'Electric'},
		]},
		{key: 'doors', label: 'Doors', type: 'choice', when: {subkind: 'fridge'}, options: [
			{value: 'french', label: 'French'},
			{value: 'four-door', label: 'French over two drawers'},
			{value: 'side-by-side', label: 'Side by side'},
			{value: 'top-freezer', label: 'Top freezer'},
			{value: 'bottom-freezer', label: 'Bottom freezer'},
		]},
		{key: 'doorInDoor', label: 'Door in door', type: 'choice',
			when: {doors: ['french', 'four-door']}, options: [
				{value: false, label: 'None'},
				{value: true, label: 'Beverage panel'},
			]},
		{key: 'controls', label: 'Controls', type: 'choice', when: {subkind: 'dishwasher'}, options: [
			{value: 'front', label: 'On the front'},
			{value: 'top', label: 'Hidden'},
		]},
		{key: 'mount', label: 'Mount', type: 'choice', when: {subkind: 'microwave'}, options: [
			{value: 'counter', label: 'Counter'},
			{value: 'in-cabinet', label: 'In cabinet'},
			{value: 'over-range', label: 'Over range'},
			{value: 'drawer', label: 'Drawer'},
		]},
		{key: 'width', label: 'Width', type: 'length', min: 25, max: 130, step: 1},
		{key: 'height', label: 'Height', type: 'length', min: 10, max: 230, step: 1},
		{key: 'depth', label: 'Depth', type: 'length', min: 10, max: 90, step: 1},
		{shared: true, key: 'finish', label: 'Finish', type: 'choice', options: [
			{value: 'stainless', label: 'Stainless'},
			{value: 'black', label: 'Black'},
			{value: 'panel-ready', label: 'Panel-ready'},
		]},
		{shared: true, key: 'front', label: 'Panel style', type: 'choice',
			when: {finish: 'panel-ready'}, options: [
				{value: 'slab', label: 'Slab'},
				{value: 'shaker', label: 'Shaker'},
				{value: 'raised', label: 'Raised'},
			]},
		{key: 'upperDepth', label: 'Upper depth', type: 'length', min: 20, max: 70, step: 0.5,
			when: {style: ['cabinet-front', 'cabinet-over']}},
		{key: 'mantelHeight', label: 'Mantel height', type: 'length', min: 20, max: 120,
			step: 1, when: {style: 'cabinet-over'}},
		{key: 'ductless', label: 'Venting', type: 'choice', when: {subkind: 'hood'}, options: [
			{value: false, label: 'Ducted'},
			{value: true, label: 'Recirculating'},
		]},
		{key: 'ceilingHeight', label: 'Ceiling height', type: 'length', min: 200, max: 400,
			step: 1, when: {subkind: 'hood'}},
		{key: 'mountHeight', label: 'Mounted at', type: 'length', min: 100, max: 250,
			step: 1, when: {subkind: 'hood'}},
		{shared: true, key: 'material.face', label: 'Front', type: 'material'},
		{shared: true, key: 'material.body', label: 'Body', type: 'material'},
		{shared: true, key: 'handles', label: 'Handles', type: 'choice', options: [
			{value: 'bar', label: 'Bar'},
			{value: 'recessed', label: 'Recessed'},
			{value: 'none', label: 'None'},
		]},
		{shared: true, key: 'material.hardware', label: 'Handles', type: 'material', group: 'metal'},
	],
};

/**
 * Build an appliance.
 *
 * @param {ApplianceSpec} spec
 * @returns {{geometry: import('three').BufferGeometry, materials: Array, parts: Array}}
 */
export function buildAppliance(spec)
{
	var s = Object.assign({}, DEFAULTS, spec || {});
	// A cabinet hood IS panel-ready: its face is a cabinet front, built by the
	// run's own `frontPanel`, and there is no such thing as a stainless one with
	// a shaker profile on it. Settled here rather than left to the spec so the
	// finish and the style cannot disagree - and so the panel-style control,
	// which the schema shows for a panel-ready appliance, appears for these
	// without a second copy of the field under a second `when`.
	if (s.subkind === 'hood' && (s.style === 'cabinet-front' || s.style === 'cabinet-over'))
	{
		s.finish = 'panel-ready';
	}
	var finish = FINISHES[s.finish] || FINISHES.stainless;
	var mats = materialsForSlots(s.material, Object.assign({}, SLOTS, finish));
	var f = shell(s);
	var group = new Group();

	if (s.subkind === 'hood')
	{
		// A hood has no face and no plinth - it is a canopy and a flue.
		hood(group, s, mats, f);
	}
	else
	{
		var front = f.depth / 2;
		group.add(box(mats.body, -f.width / 2, f.width / 2, f.kick, f.height,
			-f.depth / 2, front));
		if (f.kick > 0)
		{
			// Recessed, exactly as on a cabinet, so an appliance in a run stands on
			// the same shadow line as the cabinets either side of it.
			group.add(box(mats.trim, -f.width / 2, f.width / 2, 0, f.kick,
				-f.depth / 2, front - 5.08));
		}
		var rects = faceRects(s, f);
		liner(group, mats, rects, front);
		rects.forEach(function (rect) {facePanel(group, s, mats, rect, front);});
		extras(group, s, mats, f);
	}

	// Centred, like every generated part - `Item` recentres geometry and does NOT
	// recentre children, so a builder that returns anything else moves its own
	// pieces apart. See docs/generated-items.md rule 2.
	group.updateMatrixWorld(true);
	var middle = new Box3().setFromObject(group).getCenter(new Vector3());
	group.children.forEach(function (child) {child.position.sub(middle);});
	// Again, and not belt and braces: `mergeMeshes` recomputes each mesh from its
	// parent's CURRENT world matrix, so a shift after the last update is ignored
	// for everything that has one.
	group.updateMatrixWorld(true);

	var merged = mergeMeshes(group);
	return {geometry: merged.geometry, materials: merged.materials, parts: []};
}
