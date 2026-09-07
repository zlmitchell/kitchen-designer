// @ts-check
import {Box3, Group, Mesh, Vector3} from 'three';
import {mergeMeshes} from '../../core/geometry_merge.js';
import {materialsForSlots} from '../../core/materials.js';
import {boxGeometryFor} from '../../core/geometry_builders.js';

/**
 * A cabinet, built from panels.
 *
 * ## Panels, not a box
 *
 * This is the whole of it. A cabinet drawn as a box with a texture is a box; a
 * cabinet drawn as a carcass with fronts standing proud of it, separated by
 * reveals, reads as cabinetry from across the room - and the difference is about
 * fifteen boxes, not a modelling package.
 *
 * The pieces, and why each earns its place:
 *
 *   - **carcass**: two sides, a deck, a back and a top stretcher. Only the sides
 *     and deck are ever seen, but the stretcher is what stops an open cabinet
 *     looking like a shoebox.
 *   - **toe kick**: recessed 3in and 4.5in high. Its absence is the single
 *     clearest tell of a cabinet that was drawn rather than built, because a
 *     carcass sitting flat on the floor reads as a crate.
 *   - **face frame**: 1.5in stiles and rails, or frameless with a reveal. This
 *     is the difference between an American and a European kitchen and it is two
 *     numbers.
 *   - **fronts**, standing 0.75in proud with a **reveal gap between them**. The
 *     gap is doing the work: without it a run of cabinets is one surface, and no
 *     amount of material makes it read otherwise.
 *   - **hardware**: one knob or pull per front. Trivial geometry, and its
 *     absence is exactly what makes a render look like blocking.
 *
 * ## Front styles are profiles, not models
 *
 * `slab` is one box. `shaker` is an outer frame plus a recessed centre - five
 * boxes - and at any distance you will view this from, that IS a shaker door.
 * `raised` adds a proud centre panel to the same frame. No CSG, no bevels, no
 * imported geometry.
 *
 * ## What is not here yet
 *
 * Doors do not open. When they do they will move into `parts` on a pivot, the
 * way `door.js` hangs its leaf - which is also why fronts are built as their own
 * group here rather than inlined, so that move is a change of parent and not a
 * rewrite.
 *
 * Shelves, and the counter that sits on top, are their own kinds - see
 * ROADMAP.md phase 2. A cabinet does not draw its own counter, because a run of
 * six cabinets has ONE counter across all of them.
 */

/** Everything a cabinet is made of, and what it is made of by default. */
const SLOTS = {
	carcass: 'wood-birch-ply',
	frame: 'paint-white',
	front: 'paint-white',
	hardware: 'metal-brushed-nickel',
};

/**
 * Sizes that come from the trade rather than from taste, in centimetres.
 *
 * A base cabinet is 34.5in tall so that a 1.5in counter lands the work surface
 * at 36in. That is not a preference, it is why every kitchen is the height it is.
 */
const VARIANTS = {
	base: {height: 87.63, depth: 61.0, toeKick: true},
	wall: {height: 76.2, depth: 30.48, toeKick: false},
	tall: {height: 213.36, depth: 61.0, toeKick: true},
};

/**
 * The face arrangements you can actually buy, as doors and drawer heights.
 *
 * The builder has taken `doors` and `drawers` since it was written - `drawers`
 * is heights from the top down, and `fitDrawers` scales them into whatever
 * opening the cabinet turns out to have. What was missing was any way to SAY so:
 * the schema offered `doors` and nothing else, so every cabinet in the app was a
 * pair of doors whatever the builder could do.
 *
 * Heights are the trade's, in centimetres from inches, and graduated rather than
 * equal because that is how a bank is built - the shallow one at the top is for
 * cutlery and the deep one at the bottom is for pans. They are proportions in
 * practice: `fitDrawers` scales the set to the opening, so what matters is their
 * ratio and not the absolute numbers.
 */
export const CABINET_LAYOUTS = {
	doors: {doors: null, drawers: []},
	'drawer-over-doors': {doors: null, drawers: [15.24]},
	'two-drawers': {doors: 0, drawers: [22.86, 30.48]},
	'three-drawers': {doors: 0, drawers: [15.24, 22.86, 30.48]},
	'four-drawers': {doors: 0, drawers: [12.7, 17.78, 22.86, 27.94]},
	'five-drawers': {doors: 0, drawers: [10.16, 12.7, 15.24, 17.78, 20.32]},
	// Three shallow over one deep - the pan drawer, and the commonest bank there
	// is in a modern kitchen.
	'deep-bottom': {doors: 0, drawers: [15.24, 15.24, 15.24, 35.56]},
};

const DEFAULTS = {
	variant: 'base',
	/**
	 * Which face arrangement, or `custom` to use `doors` and `drawers` directly.
	 *
	 * `custom` is the default so that every design saved before this existed opens
	 * exactly as it did: those files carry `doors` and `drawers` and no layout, and
	 * this leaves them alone. A named layout overwrites both.
	 */
	layout: 'custom',
	/** 24in. The snap list in the schema is what you can actually buy. */
	width: 60.96,
	/** Carcass stock: 3/4in ply. */
	panel: 1.9,
	/** Face frame stiles and rails: 1.5in. */
	stile: 3.81,
	/** How far a front stands off the frame. */
	frontThickness: 1.9,
	/** The gap between two fronts, and between a front and the frame. 1/8in. */
	reveal: 0.32,
	/** Toe kick: 4.5in high, set back 3in. */
	toeHeight: 11.43,
	toeRecess: 7.62,
	frame: 'face',
	front: 'shaker',
	/**
	 * How much of the front the sink above has taken, in centimetres.
	 *
	 * A farmhouse sink's apron IS the top of this cabinet's face - you buy a sink
	 * base for one and the drawer that would have been there does not exist. Not
	 * in the schema, because it is not a choice anybody makes: `items/fitting.js`
	 * sets it from the sink it finds above, and back to 0 when that sink stops
	 * being a farmhouse.
	 */
	apronCut: 0,
	/** How many doors across the door area. 0 leaves it open. */
	doors: 2,
	/**
	 * Drawer front heights from the top down, in cm. Whatever is left below them
	 * is the door area. `[]` is all doors; a bank is four entries and `doors: 0`.
	 * See `fitDrawers` for what happens when they do not fit.
	 */
	drawers: [],
	hardware: 'knob',
	/**
	 * What happens between the top of a wall cabinet and the ceiling.
	 *
	 * `standard` leaves the gap that most kitchens have and nobody wants -- it
	 * collects dust and it is the reason cabinets look like they were put in
	 * rather than built in. The other three are the ways of not having it:
	 *
	 *   - `to-ceiling` makes ONE taller cabinet. A 42in wall cabinet on an 8ft
	 *     ceiling is exactly this, and it is why 42in is a size you can buy.
	 *   - `soffit` keeps a standard cabinet and fills above it with a closed box.
	 *   - `stacked` puts a second, shorter cabinet on top, usually with glass in
	 *     it. Two doors, not one tall one.
	 *
	 * Wall cabinets only. A base cabinet's top is the counter's business.
	 */
	topTreatment: 'standard',
	/** Bottom of a wall cabinet above the floor. 54in leaves 18in of splash. */
	mountHeight: 137.16,
	/** Where the ceiling is. Needed to reach it, and nothing else knows. */
	ceilingHeight: 243.84,
	/**
	 * Whether this cabinet has a recessed toe kick. Defaults to the variant's
	 * answer - a base cabinet does, a wall cabinet does not - and is overridable
	 * for a base that gets a separate plinth.
	 *
	 * NOT the same as floating. A floating drawer under a counter hangs from the
	 * counter with a gap below it, and a gap is not geometry: it cannot survive
	 * in a bounding box, and `FloorItem` puts the bottom of the bounds on the
	 * floor, so a builder that simply left space would have it taken back. That
	 * needs the run to hold the cabinet at a height, which is phase 3.
	 * @type {?boolean}
	 */
	toeKick: null,
};

/** @typedef {Object} CabinetSpec
 * @property {('base'|'wall'|'tall')} [variant]
 * @property {number} [width] @property {number} [depth] @property {number} [height]
 * @property {('face'|'frameless')} [frame]
 * @property {('slab'|'shaker'|'raised')} [front]
 * @property {number} [doors] @property {Array<number>} [drawers]
 * @property {string} [layout] One of `CABINET_LAYOUTS`, or `custom`.
 * @property {number} [apronCut]
 * @property {('knob'|'pull'|'none')} [hardware]
 * @property {?boolean} [toeKick]
 * @property {Object} [material]
 */

function box(mat, x0, x1, y0, y1, z0, z1)
{
	var mesh = new Mesh(boxGeometryFor(mat, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)), mat);
	mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
	return mesh;
}

/**
 * Drawer heights that fit the opening they are going into.
 *
 * Stated in centimetres, because "a 6in top drawer" is how a drawer is specified
 * and a proportion is not. But a spec outlives the cabinet it was written for -
 * change the height, or drop the same drawers into a wall cabinet, and the
 * numbers no longer fit. Two ways they can miss, and only one of them was
 * visible: a drawer that overflowed the opening was silently DROPPED, so a four
 * drawer bank came out with three and a gap where the fourth belonged.
 *
 * So they are scaled rather than dropped:
 *
 *   - **overflowing** always scales down. Four drawers asked for is four drawers.
 *   - **underfilling** scales UP only when there are no doors, because then
 *     nothing else can take up the slack and the remainder is just a hole. With
 *     doors below, the leftover IS the door area and the drawer keeps the height
 *     it asked for - which is what "one drawer over two doors" means.
 *
 * @param {Array<number>} drawers Heights from the top down.
 * @param {number} available The opening's height.
 * @param {number} doors How many doors take the remainder.
 * @returns {Array<number>}
 */
function fitDrawers(drawers, available, doors)
{
	var wanted = drawers.reduce(function (sum, height) {return sum + height;}, 0);
	if (wanted <= 0 || available <= 0)
	{
		return [];
	}
	var overflows = wanted > available;
	var mustFill = doors <= 0;
	if (!overflows && !mustFill)
	{
		return drawers.slice();
	}
	var factor = available / wanted;
	return drawers.map(function (height) {return height * factor;});
}

/**
 * Shift a group so its bounding box is centred on the origin.
 *
 * `Item`'s constructor recentres geometry anyway, so this is not about where the
 * cabinet ends up - it is about the offset being KNOWN. A carcass is built
 * symmetrically about its own depth, and then the face frame and the fronts are
 * added in front of it and nothing behind, so the assembly sits a couple of
 * centimetres forward of where its numbers say. Item would silently take that
 * out, and the spec's `depth` would stop relating to the item's bounds in any
 * way a caller could predict.
 *
 * Done here, once, so the invariant every generated part shares holds: what the
 * builder returns is centred, and `Item` moves nothing.
 *
 * Note for when cabinet doors open. The fronts will move into `parts`, and
 * children are NOT recentred - so the centring will then have to be computed
 * from the carcass and frame alone, the way `door.js` centres on its rough
 * opening and lets the leaf hang outside it. Centring on the whole assembly is
 * right only while the whole assembly is the geometry.
 *
 * @param {Group} group
 */
function centre(group)
{
	group.updateMatrixWorld(true);
	var bounds = new Box3().setFromObject(group);
	var middle = bounds.getCenter(new Vector3());
	group.children.forEach(function (child) {child.position.sub(middle);});
	// Again, and this is not belt and braces. `mergeMeshes` calls
	// `updateMatrixWorld(true)` per MESH, which recomputes that mesh from its
	// parent's CURRENT matrixWorld - and the fronts' parent is a group whose
	// position just moved. Without this the carcass shifts and the fronts do not,
	// which came out as a cabinet 71.5cm deep instead of 68 and a centre still
	// 1.75 off.
	group.updateMatrixWorld(true);
}

/**
 * How tall the whole assembly is, and how much of that is cabinet.
 *
 * They are the same number for every treatment but two. A soffit and a stack
 * both reach the ceiling while the CABINET below stays a normal cabinet, so the
 * envelope and the carcass part company and everything downstream has to be
 * told which one it wants.
 */
function heights(s, variant)
{
	var asked = (s.height === undefined) ? variant.height : s.height;
	if (s.variant !== 'wall' || s.topTreatment === 'standard')
	{
		return {envelope: asked, carcass: asked, fill: 0};
	}
	// Everything else reaches the ceiling; what differs is what fills the top.
	var envelope = Math.max(asked, s.ceilingHeight - s.mountHeight);
	if (s.topTreatment === 'to-ceiling')
	{
		// One taller cabinet. A 42in wall cabinet is exactly this.
		return {envelope: envelope, carcass: envelope, fill: 0};
	}
	// soffit and stacked keep a normal cabinet and fill above it.
	return {envelope: envelope, carcass: asked, fill: envelope - asked};
}

/** The resolved sizes every part is placed against. */
function shell(s)
{
	var variant = VARIANTS[s.variant] || VARIANTS.base;
	var tall = heights(s, variant);
	var height = tall.envelope;
	var depth = (s.depth === undefined) ? variant.depth : s.depth;
	var wantsToe = (s.toeKick === null || s.toeKick === undefined) ? variant.toeKick : s.toeKick;
	var toe = wantsToe ? s.toeHeight : 0;
	return {
		width: s.width, height: height, depth: depth,
		carcassHeight: tall.carcass, fill: tall.fill,
		toe: toe,
		// Centred, so Item's recentring is a no-op. See docs/generated-items.md.
		x1: s.width / 2, y1: height / 2, z1: depth / 2,
		floor: -height / 2,
		/** The front face of the carcass, where the frame and fronts sit. */
		face: depth / 2,
	};
}

/**
 * One front panel, in the chosen style.
 *
 * Exported because a panel-ready appliance is not a colour, it is a CABINET
 * FRONT screwed to a dishwasher - so `appliance.js` asks for one of these rather
 * than approximating one, and a panel-ready fridge standing in a shaker run gets
 * shaker doors with the run's reveals without anybody keeping the two in step.
 *
 * @returns {Array<Mesh>} One box for a slab, five for a shaker, six for raised.
 */
export function frontPanel(mats, style, x0, x1, y0, y1, z0, thickness)
{
	var mat = mats.front;
	var z1 = z0 + thickness;
	// The frame: 2.25in rails and stiles, which is what a shaker door uses.
	var rail = 5.7;
	// Fall back on whether a CENTRE PANEL is viable, not on the door's own width.
	// A 6in door is 6in minus two 2.25in rails, so its panel is an inch and a half
	// - nothing is made that way, and drawn that way it is three slivers. Judging
	// the door instead of the panel got this wrong for exactly the sizes it was
	// meant to catch.
	if (style === 'slab' || (x1 - x0) - 2 * rail < 5 || (y1 - y0) - 2 * rail < 5)
	{
		return [box(mat, x0, x1, y0, y1, z0, z1)];
	}

	var out = [
		box(mat, x0, x0 + rail, y0, y1, z0, z1),
		box(mat, x1 - rail, x1, y0, y1, z0, z1),
		box(mat, x0 + rail, x1 - rail, y0, y0 + rail, z0, z1),
		box(mat, x0 + rail, x1 - rail, y1 - rail, y1, z0, z1),
	];
	// The centre. Recessed for a shaker, proud for a raised panel - and that IS
	// the difference between the two styles.
	//
	// This read `Math.abs(inset)` after choosing its sign, which threw the sign
	// away and built both the same: a raised panel that did not stand out. The
	// test measures the front-most z of each and they were equal.
	if (style === 'raised')
	{
		out.push(box(mat, x0 + rail, x1 - rail, y0 + rail, y1 - rail,
			z0 + thickness * 0.3, z1 + thickness * 0.55));
	}
	else
	{
		out.push(box(mat, x0 + rail, x1 - rail, y0 + rail, y1 - rail,
			z0, z1 - thickness * 0.45));
	}
	return out;
}

/** A knob or a pull, on the face of a front. */
function hardwareFor(mats, kind, cx, cy, z, horizontal)
{
	if (kind === 'none')
	{
		return [];
	}
	var mat = mats.hardware;
	if (kind === 'pull')
	{
		var half = 6.4;
		return horizontal
			? [box(mat, cx - half, cx + half, cy - 0.8, cy + 0.8, z, z + 2.9)]
			: [box(mat, cx - 0.8, cx + 0.8, cy - half, cy + half, z, z + 2.9)];
	}
	return [box(mat, cx - 1.6, cx + 1.6, cy - 1.6, cy + 1.6, z, z + 3.2)];
}

/** What a panel may ask about a cabinet. */
export const CABINET_SCHEMA = {
	label: 'Cabinet',
	// The builder's own slot defaults, so the panel can show the finish an
	// unspecified slot will actually be built with. A REFERENCE to `SLOTS`, not a
	// copy: a default written twice is a default that goes stale.
	slots: SLOTS,
	fields: [
		{key: 'variant', label: 'Type', type: 'choice', options: [
			{value: 'base', label: 'Base'},
			{value: 'wall', label: 'Wall'},
			{value: 'tall', label: 'Tall'},
		]},
		// The snap list is in the field's step rather than a dropdown: cabinets
		// come in 3in increments, and typing 63.5 for a 25in filler is legitimate.
		{key: 'width', label: 'Width', type: 'length', min: 22.86, max: 121.92, step: 7.62},
		{key: 'height', label: 'Height', type: 'length', min: 30, max: 250, step: 1},
		{key: 'depth', label: 'Depth', type: 'length', min: 20, max: 80, step: 1},
		{shared: true, key: 'frame', label: 'Construction', type: 'choice', options: [
			{value: 'face', label: 'Face frame'},
			{value: 'frameless', label: 'Frameless'},
		]},
		{shared: true, key: 'front', label: 'Door style', type: 'choice', options: [
			{value: 'slab', label: 'Slab'},
			{value: 'shaker', label: 'Shaker'},
			{value: 'raised', label: 'Raised'},
		]},
		{key: 'layout', label: 'Face', type: 'choice', options: [
			{value: 'doors', label: 'Doors'},
			{value: 'drawer-over-doors', label: 'Drawer over doors'},
			{value: 'two-drawers', label: '2 drawers'},
			{value: 'three-drawers', label: '3 drawers'},
			{value: 'four-drawers', label: '4 drawers'},
			{value: 'five-drawers', label: '5 drawers'},
			{value: 'deep-bottom', label: '3 over a pan drawer'},
			{value: 'custom', label: 'Custom'},
		]},
		{key: 'doors', label: 'Doors', type: 'choice',
			// Only where doors are part of the answer. A drawer bank has none, and
			// offering the control there is offering a number the layout discards.
			when: {layout: ['doors', 'drawer-over-doors', 'custom']}, options: [
			{value: 0, label: 'None'},
			{value: 1, label: 'One'},
			{value: 2, label: 'Pair'},
		]},
		{shared: true, key: 'hardware', label: 'Hardware', type: 'choice', options: [
			{value: 'knob', label: 'Knob'},
			{value: 'pull', label: 'Pull'},
			{value: 'none', label: 'None'},
		]},
		{shared: true, key: 'topTreatment', label: 'Above', type: 'choice', when: {variant: 'wall'}, options: [
			{value: 'standard', label: 'Gap'},
			{value: 'to-ceiling', label: 'To ceiling'},
			{value: 'soffit', label: 'Soffit'},
			{value: 'stacked', label: 'Stacked'},
		]},
		{key: 'ceilingHeight', label: 'Ceiling height', type: 'length', min: 200, max: 400,
			step: 1, when: {variant: 'wall'}},
		{key: 'mountHeight', label: 'Mounted at', type: 'length', min: 90, max: 200,
			step: 1, when: {variant: 'wall'}},
		{key: 'toeKick', label: 'Toe kick', type: 'choice', options: [
			{value: true, label: 'Recessed'},
			{value: false, label: 'None'},
		]},
		{shared: true, key: 'material.front', label: 'Fronts', type: 'material'},
		{shared: true, key: 'material.frame', label: 'Frame', type: 'material', when: {frame: 'face'}},
		{shared: true, key: 'material.carcass', label: 'Carcass', type: 'material'},
		{shared: true, key: 'material.hardware', label: 'Hardware', type: 'material', group: 'metal'},
	],
};

/**
 * Build a cabinet.
 *
 * @param {CabinetSpec} spec
 * @returns {{geometry: import('three').BufferGeometry, materials: Array, parts: Array}}
 */
/**
 * A carcass, its face frame, and the fronts filling the opening.
 *
 * Pulled out of `buildCabinet` so a stacked upper can have one too. A stack is
 * two cabinets, not one tall cabinet with a rail across it - the doors break at
 * the joint, and that break is the whole visual difference between a stack and a
 * 42in cabinet.
 *
 * @param {Object} group Where the meshes go.
 * @param {Object} s The resolved spec.
 * @param {Object} mats Materials by slot.
 * @param {Object} f The shell.
 * @param {number} yLo Bottom of this box, in the centred frame.
 * @param {number} yHi Top of it.
 * @param {number} doors How many doors across its opening.
 * @param {Array<number>} drawers Drawer heights, top down.
 */
function carcassAt(group, s, mats, f, yLo, yHi, doors, drawers, apronCut)
{
	var back = -f.z1;
	var deckAt = yLo;

	group.add(box(mats.carcass, -f.x1, -f.x1 + s.panel, deckAt, yHi, back, f.face));
	group.add(box(mats.carcass, f.x1 - s.panel, f.x1, deckAt, yHi, back, f.face));
	group.add(box(mats.carcass, -f.x1, f.x1, deckAt, deckAt + s.panel, back, f.face));
	group.add(box(mats.carcass, -f.x1, f.x1, deckAt, yHi, back, back + s.panel));
	// Top: a full deck on a wall cabinet, a stretcher on a base one, because that
	// is how each is built and the top of a base cabinet is never seen.
	if (s.variant === 'wall')
	{
		group.add(box(mats.carcass, -f.x1, f.x1, yHi - s.panel, yHi, back, f.face));
	}
	else
	{
		group.add(box(mats.carcass, -f.x1, f.x1, yHi - s.panel, yHi, back, back + 12));
		group.add(box(mats.carcass, -f.x1, f.x1, yHi - s.panel, yHi, f.face - 12, f.face));
	}

	var openLo = deckAt + s.panel;
	var openHi = yHi - s.panel;
	var openX0 = -f.x1;
	var openX1 = f.x1;
	var frontZ = f.face;

	if (s.frame === 'face')
	{
		var fz0 = f.face;
		var fz1 = f.face + s.panel;
		group.add(box(mats.frame, -f.x1, -f.x1 + s.stile, deckAt, yHi, fz0, fz1));
		group.add(box(mats.frame, f.x1 - s.stile, f.x1, deckAt, yHi, fz0, fz1));
		group.add(box(mats.frame, -f.x1 + s.stile, f.x1 - s.stile, yHi - s.stile, yHi, fz0, fz1));
		group.add(box(mats.frame, -f.x1 + s.stile, f.x1 - s.stile, deckAt, deckAt + s.stile, fz0, fz1));
		openLo = deckAt + s.stile;
		openHi = yHi - s.stile;
		openX0 = -f.x1 + s.stile;
		openX1 = f.x1 - s.stile;
		frontZ = fz1;
	}

	// A farmhouse apron replaces the top of the face. The CARCASS is untouched -
	// the box is still a box, and the sink sits in it - so this shortens only the
	// area the fronts are laid out in. Clamped at `openLo` so an apron taller
	// than the cabinet leaves no fronts rather than inverted ones.
	if (apronCut > 0)
	{
		openHi = Math.max(openLo, openHi - apronCut);
	}

	// Built into their own group so that making doors open later is a change of
	// parent rather than a rewrite - see the note at the top of this file.
	var fronts = new Group();
	fronts.name = 'cabinet-fronts';
	var r = s.reveal;
	var cursor = openHi;
	var doorCount = Math.max(0, Math.min(2, doors));
	var fitted = fitDrawers(drawers || [], openHi - openLo, doorCount);

	fitted.forEach((drawerHeight) =>
	{
		var lo = cursor - drawerHeight;
		if (lo < openLo - 0.01)
		{
			return;
		}
		frontPanel(mats, s.front, openX0 + r, openX1 - r, lo + r, cursor - r, frontZ, s.frontThickness)
			.forEach((mesh) => fronts.add(mesh));
		hardwareFor(mats, s.hardware, (openX0 + openX1) / 2, (lo + cursor) / 2,
			frontZ + s.frontThickness, true).forEach((mesh) => fronts.add(mesh));
		cursor = lo;
	});

	if (doorCount > 0 && cursor - openLo > 5)
	{
		var span = (openX1 - openX0);
		var each = (span - r * (doorCount + 1)) / doorCount;
		for (var i = 0; i < doorCount; i++)
		{
			var x0 = openX0 + r + i * (each + r);
			var x1 = x0 + each;
			frontPanel(mats, s.front, x0, x1, openLo + r, cursor - r, frontZ, s.frontThickness)
				.forEach((mesh) => fronts.add(mesh));
			// On the opening edge - the side away from the hinge, which for a pair
			// is the middle. That is where a hand actually goes.
			var handX = (doorCount === 1) ? x1 - 5 : ((i === 0) ? x1 - 5 : x0 + 5);
			hardwareFor(mats, s.hardware, handX, (openLo + cursor) / 2 + 10,
				frontZ + s.frontThickness, false).forEach((mesh) => fronts.add(mesh));
		}
	}

	group.add(fronts);
}

/**
 * Build a cabinet.
 *
 * @param {CabinetSpec} spec
 * @returns {{geometry: import('three').BufferGeometry, materials: Array, parts: Array}}
 */
export function buildCabinet(spec)
{
	var s = Object.assign({}, DEFAULTS, spec || {});
	var mats = materialsForSlots(s.material, SLOTS);
	// A named layout decides the face; `custom` leaves whatever the spec carries,
	// which is what keeps older files and the traced plan building as they did.
	var chosen = CABINET_LAYOUTS[s.layout];
	if (chosen)
	{
		s.drawers = chosen.drawers.slice();
		if (chosen.doors !== null)
		{
			s.doors = chosen.doors;
		}
	}
	var f = shell(s);
	var group = new Group();

	var lift = f.floor + f.toe;
	var back = -f.z1;
	// Where the cabinet proper stops. The same as the envelope top for everything
	// except a soffit or a stack, which reach the ceiling with something else.
	var cabinetTop = f.floor + f.carcassHeight;

	carcassAt(group, s, mats, f, lift, cabinetTop, s.doors, s.drawers, s.apronCut);

	// ---- toe kick ---------------------------------------------------------
	if (f.toe > 0)
	{
		group.add(box(mats.carcass, -f.x1, f.x1, f.floor, lift, back, f.face - s.toeRecess));
	}

	// ---- what fills the gap to the ceiling ---------------------------------
	if (f.fill > 0.5)
	{
		if (s.topTreatment === 'stacked')
		{
			// A second cabinet, not a taller one. The doors break at the joint, and
			// that break is the whole visual difference between a stack and a 42in
			// cabinet - which is why this goes through carcassAt again rather than
			// stretching the one below.
			carcassAt(group, s, mats, f, cabinetTop, f.y1, Math.max(1, s.doors), [], 0);
		}
		else
		{
			// A soffit: a closed box, flush with the cabinet face, in the frame
			// material because that is what it is painted to match.
			group.add(box(mats.frame, -f.x1, f.x1, cabinetTop, f.y1, back, f.face + s.panel));
		}
	}

	centre(group);
	var merged = mergeMeshes(group);
	return {geometry: merged.geometry, materials: merged.materials, parts: []};
}
