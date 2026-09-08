// @ts-check
import {Box3, Group, Mesh, Vector3} from 'three';
import {mergeMeshes} from '../../core/geometry_merge.js';
import {materialsForSlots} from '../../core/materials.js';
import {boxGeometryFor} from '../../core/geometry_builders.js';
import {KELVIN_OPTIONS} from '../../model/light.js';

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
 * `glazing` is the same idea one step further: the centre panel is the only
 * thing that changes between a shaker door and the glass door beside it in the
 * same run, so it is a property of the CENTRE and not a fourth style. Asking it
 * as its own question is also what stops "glass" fighting "shaker" for one
 * dropdown, and it is why a glazed slab still gets rails - glass needs something
 * to be held in, and a frameless sheet of glass on hinges is not a cabinet door.
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
	/**
	 * What goes in a glazed door, and separate from `front` because it is the one
	 * surface here that is not a solid - the same reason `door.js` gives its own
	 * glass slot. Only spent when `glazing` asks for it; a solid cabinet builds
	 * the material and never draws with it, which is what `door.js` does for a
	 * flush leaf.
	 */
	glass: 'glass-clear',
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
	/**
	 * A drawer box hung under a worktop with open floor beneath it.
	 *
	 * 10in deep front to top, base depth, and no toe kick - the point of one is
	 * that there is nothing under it. What it needs from the rest of the app is
	 * to be a **WallItem (type 2) rather than a WallFloorItem (type 9)**:
	 * `WallItem.boundMove` sets `boundToFloor` on the floor-bound one, so a
	 * floating cabinet dragged as a type 9 has its gap taken back the moment it
	 * moves. ROADMAP phase 3 lists this as blocked on the run holding a cabinet
	 * at a height; it is not, because a wall already does.
	 */
	floating: {height: 25.4, depth: 61.0, toeKick: false},
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
	 * What fills the DOOR panels: nothing, glass, or glass divided by muntins.
	 *
	 * Doors only. A glass drawer front is not a thing you buy, and a bank of them
	 * would be a view of the inside of a drawer box - so `carcassAt` glazes the
	 * door area and leaves the drawers solid, which is also what a run with one
	 * glass cabinet in it actually looks like.
	 *
	 * `none` is the default so that every design saved before this existed opens
	 * exactly as it did.
	 *
	 * Not yet expressible: glass in the STACKED upper only, which is the commonest
	 * way a kitchen is glazed. This reaches every door on the cabinet, stack
	 * included, because that is what a control labelled "Glazing" says it does.
	 */
	glazing: 'none',
	/**
	 * Whether a strip is fixed under this cabinet.
	 *
	 * A property OF the cabinet and not a light somebody put near one, which is
	 * the whole reason it lives here: an under-cabinet strip is the cabinet's
	 * width, it is screwed to its underside, and it moves when the cabinet moves.
	 * Placing it as a separate object would mean keeping two things in step by
	 * hand for the entire life of the design, which is the class of bug the
	 * nesting in `model/light.js` was shaped to make impossible.
	 *
	 * The variant picks the mount, because "under" means two different fittings:
	 * under a WALL cabinet is the strip over a worktop, and under a base or tall
	 * cabinet is the toe kick, which is an accent wash on the floor. Same field,
	 * because it is the same question -- is there a light under this box.
	 */
	underLight: false,
	/** What colour that strip is. 3000K is what a worktop is normally lit at. */
	underLightKelvin: 3000,
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
	/**
	 * Whether this is an inside corner unit, and which shape of one.
	 *
	 * A corner is the one place a run cannot be made of boxes. Two runs meet at
	 * ninety degrees and the square where they cross is reachable from neither
	 * side, so the trade sells two answers to it and this is both:
	 *
	 *   - `l` keeps the square and puts a face on each leg, meeting at an inside
	 *     corner. Every cubic inch of the corner is in the box; what you give up
	 *     is that the far half of it is an arm's length past the opening.
	 *   - `diagonal` cuts the outer corner off with one angled face. Less volume,
	 *     and all of it in front of a door you can stand square to. It is also
	 *     the one that leaves room for a corner sink.
	 *
	 * `none` is a plain box, which is what a BLIND corner is: the square with no
	 * face on it at all, reached past the cabinet beside it.
	 *
	 * @type {('none'|'l'|'diagonal')}
	 */
	corner: 'none',
	/**
	 * Which end of this cabinet the return wall is on.
	 *
	 * Plan-space, like a door's - `lo` is the -x end in the cabinet's own frame.
	 * A corner has a chirality that a width and a depth cannot express, and
	 * getting it wrong puts the doors against the wall.
	 *
	 * @type {('lo'|'hi')}
	 */
	hand: 'lo',
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
 * @property {('base'|'wall'|'tall'|'floating')} [variant]
 * @property {number} [width] @property {number} [depth] @property {number} [height]
 * @property {('face'|'frameless')} [frame]
 * @property {('slab'|'shaker'|'raised')} [front]
 * @property {('none'|'glass'|'mullion')} [glazing]
 * @property {boolean} [underLight]
 * @property {number} [underLightKelvin]
 * @property {number} [doors] @property {Array<number>} [drawers]
 * @property {string} [layout] One of `CABINET_LAYOUTS`, or `custom`.
 * @property {number} [apronCut]
 * @property {('knob'|'pull'|'none')} [hardware]
 * @property {('none'|'l'|'diagonal')} [corner]
 * @property {('lo'|'hi')} [hand]
 * @property {number} [returnWidth] @property {number} [returnDepth]
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
 * @returns {Vector3} How far everything moved, so anything positioned in the
 *          builder's own frame can be brought into the centred one. A carried
 *          fixture is not a mesh, so `centre` cannot move it for us.
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
	return middle;
}

/**
 * The strip under the cabinet, as a fixture record in the cabinet's own frame.
 *
 * Returns a record and not geometry. The bar you can see is `fixture.js`'s job
 * when somebody places a fitting by hand; here the strip is a channel tucked up
 * behind the face, which is invisible from every angle a kitchen is looked at --
 * so drawing it would be geometry nobody sees, and what matters is the light.
 *
 * Where it goes is the number worth getting right, and it is the same rule for
 * both mounts: **at the front, not the middle**. A strip over the centre of a
 * 61cm worktop lights the splashback and throws the shadow of the cabinet's own
 * face across the front half of the counter, which is where the work happens. At
 * the front edge it washes the whole depth. Everybody who has fitted one knows
 * this and no render will tell you.
 *
 * @param {Object} s The resolved spec.
 * @param {Object} f The shell.
 * @param {Vector3} middle What `centre` moved everything by.
 * @returns {?Object} A fixture record, or null.
 */
function underLight(s, f, middle)
{
	if (!s.underLight)
	{
		return null;
	}
	var wall = (s.variant === 'wall');
	// Under a wall cabinet: just below the carcass bottom, near the front edge.
	// Under a base or tall one: inside the toe recess, just above the floor and
	// tucked behind the kick board so the fitting itself is never in view.
	var y = wall ? f.floor - 1.2 : f.floor + 2.4;
	var z = wall ? f.face - 8.0 : f.face - s.toeRecess + 1.0;
	// The clear width between the cabinet sides, less an end margin. A strip cut
	// to the full width would light the gap between two cabinets as brightly as
	// the worktop, and the join is the one place a strip must not be visible.
	var length = Math.max(10, s.width - 2 * s.panel - 4);
	return {
		mount: wall ? 'under-cabinet' : 'toe-kick',
		kelvin: s.underLightKelvin,
		length: length,
		// Into the frame `centre` just established. `Item` recentres a generated
		// build on its bounds again, but that is a no-op after `centre` - the
		// invariant every builder here keeps.
		position: {x: -middle.x, y: y - middle.y, z: z - middle.z},
	};
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

/** The corner shapes there are. Anything else is a plain box. */
const CORNERS = ['l', 'diagonal'];

/** The resolved sizes every part is placed against. */
function shell(s)
{
	var variant = VARIANTS[s.variant] || VARIANTS.base;
	var tall = heights(s, variant);
	var height = tall.envelope;
	var depth = (s.depth === undefined) ? variant.depth : s.depth;
	var wantsToe = (s.toeKick === null || s.toeKick === undefined) ? variant.toeKick : s.toeKick;
	var toe = wantsToe ? s.toeHeight : 0;
	// A corner unit is two legs at right angles, so the box it occupies is not
	// its depth: it reaches `returnWidth` back along the wall it turns onto.
	// Resolved here, before anything else, because every other number below is
	// measured off that box - and for a plain cabinet `span` IS the depth, so
	// the two lines that use it give exactly what they always gave.
	var corner = (CORNERS.indexOf(s.corner) === -1) ? 'none' : s.corner;
	var ret = (s.returnWidth === undefined) ? s.width : s.returnWidth;
	// `max`, with no floor added to it. A corner unit whose legs are as long as
	// they are deep has NO face - the square is entirely within reach of neither
	// run, which is what a blind corner is - and padding the box to force a sliver
	// of one made every corner 5cm deeper than the footprint it was given.
	// `faceOn` already declines a face too narrow to hang a door in, so the
	// degenerate case takes care of itself and the honest depth survives.
	var span = (corner === 'none') ? depth : Math.max(depth, ret);
	var retDepth = (s.returnDepth === undefined) ? depth : s.returnDepth;
	return {
		width: s.width, height: height, depth: depth,
		carcassHeight: tall.carcass, fill: tall.fill,
		toe: toe,
		corner: corner,
		/** How deep the return leg is, capped so it cannot swallow the cabinet. */
		retDepth: Math.min(retDepth, Math.max(10, s.width - 5)),
		/** Which side the return wall is on: -1 at the lo end, +1 at the hi end. */
		hx: (s.hand === 'hi') ? 1 : -1,
		// Centred, so Item's recentring is a no-op. See docs/generated-items.md.
		x1: s.width / 2, y1: height / 2, z1: span / 2,
		floor: -height / 2,
		/** The front face of the carcass, where the frame and fronts sit. */
		face: -span / 2 + depth,
	};
}

/** Glazing stock: 4mm, and thin enough to sit clear of both faces of the door. */
const GLASS_THICKNESS = 0.4;

/** Muntin bar width, and how far it stands off the glass on each face. */
const MUNTIN = 1.9;
const MUNTIN_PROUD = 0.3;

/**
 * How big one light wants to be, in centimetres. About 9in, which is what a
 * divided cabinet door is actually made with - a 15in wide door comes out two
 * lights across and a 30in tall one three lights up, and that is the grid
 * anybody picturing a glass cabinet has in mind.
 */
const LIGHT = 22.0;

/** How many lights fit across a span, at least one and never a mesh screen. */
function lights(span)
{
	return Math.max(1, Math.min(4, Math.round(span / LIGHT)));
}

/**
 * The pane that fills a glazed door, and whatever muntins divide it.
 *
 * Two of the traps in `docs/generated-items.md` decide the numbers here, and
 * `opening.js`'s `buildSash` documents both from the window's side:
 *
 *   - **A solid swallows anything put inside it.** A muntin flush with the pane
 *     is a muntin nobody can see. The bars stand proud of the glass on both
 *     faces, which is also what they do in life.
 *   - **Two coplanar faces z-fight, and it reads as geometry.** The pane is
 *     thinner than the door and centred in it, so no face of the glass shares a
 *     plane with the rails, and the bars stay inside the door's own thickness.
 *
 * The bars are `front` and not `glass` on purpose: a muntin is a piece of the
 * door, painted with it, and giving it its own slot would be a control nobody
 * would ever set differently.
 *
 * @param {Object} mats Needs `glass` as well as `front`.
 * @param {number} zc The middle of the door's thickness.
 * @param {boolean} muntins Whether to divide the pane.
 * @returns {Array<Mesh>}
 */
function glazedCentre(mats, x0, x1, y0, y1, zc, muntins)
{
	var gz = GLASS_THICKNESS / 2;
	// A shade larger than the opening, so the pane is rebated behind the rails
	// rather than butting them edge to edge - a butt joint there leaves a hairline
	// of whatever is behind the cabinet showing at glancing angles.
	var out = [box(mats.glass, x0 - 0.2, x1 + 0.2, y0 - 0.2, y1 + 0.2, zc - gz, zc + gz)];
	if (!muntins)
	{
		return out;
	}

	var bz = gz + MUNTIN_PROUD;
	var half = MUNTIN / 2;
	var cols = lights(x1 - x0);
	var rows = lights(y1 - y0);
	var i;
	for (i = 1; i < cols; i++)
	{
		var cx = x0 + (x1 - x0) * i / cols;
		out.push(box(mats.front, cx - half, cx + half, y0, y1, zc - bz, zc + bz));
	}
	for (i = 1; i < rows; i++)
	{
		var cy = y0 + (y1 - y0) * i / rows;
		out.push(box(mats.front, x0, x1, cy - half, cy + half, zc - bz, zc + bz));
	}
	return out;
}

/**
 * One front panel, in the chosen style.
 *
 * Exported because a panel-ready appliance is not a colour, it is a CABINET
 * FRONT screwed to a dishwasher - so `appliance.js` asks for one of these rather
 * than approximating one, and a panel-ready fridge standing in a shaker run gets
 * shaker doors with the run's reveals without anybody keeping the two in step.
 *
 * @param {Object} mats `front` and `hardware`, plus `glass` when glazed.
 *        `appliance.js` passes `front` alone and never glazes, which is why the
 *        glass slot is read only down the glazed branch.
 * @param {string} [glazing] `glass` or `mullion` puts a pane in the centre
 *        instead of a panel. Anything else, `undefined` included, is solid.
 * @returns {Array<Mesh>} One box for a slab, five for a shaker, six for raised,
 *          and one per muntin on top of that for a divided light.
 */
export function frontPanel(mats, style, x0, x1, y0, y1, z0, thickness, glazing)
{
	var mat = mats.front;
	var z1 = z0 + thickness;
	// The frame: 2.25in rails and stiles, which is what a shaker door uses.
	var rail = 5.7;
	var glazed = (glazing === 'glass' || glazing === 'mullion');
	// Fall back on whether a CENTRE PANEL is viable, not on the door's own width.
	// A 6in door is 6in minus two 2.25in rails, so its panel is an inch and a half
	// - nothing is made that way, and drawn that way it is three slivers. Judging
	// the door instead of the panel got this wrong for exactly the sizes it was
	// meant to catch.
	//
	// A glazed SLAB does not fall back, it gains rails: the style names what the
	// centre does, and glass with nothing round it is not a door. A glazed door
	// too small for a centre still does, and comes out solid - a 4in pane in a
	// filler is worse than no glass, and dropping the glazing is the only failure
	// here that leaves something buildable.
	if ((x1 - x0) - 2 * rail < 5 || (y1 - y0) - 2 * rail < 5 || (style === 'slab' && !glazed))
	{
		return [box(mat, x0, x1, y0, y1, z0, z1)];
	}

	var out = [
		box(mat, x0, x0 + rail, y0, y1, z0, z1),
		box(mat, x1 - rail, x1, y0, y1, z0, z1),
		box(mat, x0 + rail, x1 - rail, y0, y0 + rail, z0, z1),
		box(mat, x0 + rail, x1 - rail, y1 - rail, y1, z0, z1),
	];
	// Glass replaces the centre outright, which is why it comes before the two
	// solid cases rather than beside them: a raised panel is by definition solid,
	// so "raised, glazed" is a glazed door in a raised door's frame and not a
	// proud sheet of glass.
	if (glazed)
	{
		return out.concat(glazedCentre(mats, x0 + rail, x1 - rail, y0 + rail, y1 - rail,
			z0 + thickness / 2, glazing === 'mullion'));
	}

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
			{value: 'floating', label: 'Floating drawer'},
		]},
		// The snap list is in the field's step rather than a dropdown: cabinets
		// come in 3in increments, and typing 63.5 for a 25in filler is legitimate.
		{key: 'corner', label: 'Corner', type: 'choice', options: [
			{value: 'none', label: 'Not a corner'},
			{value: 'l', label: 'L-shaped'},
			{value: 'diagonal', label: 'Diagonal'},
		]},
		{key: 'hand', label: 'Turns towards', type: 'choice',
			when: {corner: ['l', 'diagonal']}, options: [
				{value: 'lo', label: 'The left'},
				{value: 'hi', label: 'The right'},
			]},
		{key: 'width', label: 'Width', type: 'length', min: 22.86, max: 121.92, step: 7.62},
		// The other leg. Only asked where there is one, and stepped in stock
		// increments like the width, because it is the same kind of number.
		{key: 'returnWidth', label: 'Return', type: 'length', min: 22.86, max: 121.92,
			step: 7.62, when: {corner: ['l', 'diagonal']}},
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
		// NOT shared, alone among the look controls. A kitchen is glazed in one or
		// two cabinets and not in a run - that is the whole effect of glass, that it
		// breaks a wall of doors - so applying this to everything selected would
		// undo the reason for reaching for it.
		{key: 'glazing', label: 'Glazing', type: 'choice', options: [
			{value: 'none', label: 'Solid'},
			{value: 'glass', label: 'Glass'},
			{value: 'mullion', label: 'Divided'},
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
		// Asked of a floating drawer too, and it is the only number that matters
		// on one: what the height buys is the gap UNDER it. The floor is at 90 for
		// a wall cabinet and lower here, because a drawer under a worktop hangs at
		// about 25in and a wall cabinet never does.
		{key: 'mountHeight', label: 'Mounted at', type: 'length', min: 40, max: 200,
			step: 1, when: {variant: ['wall', 'floating']}},
		{key: 'toeKick', label: 'Toe kick', type: 'choice', options: [
			{value: true, label: 'Recessed'},
			{value: false, label: 'None'},
		]},
		// Shared, unlike glazing: under-cabinet lighting is run along a whole row
		// of uppers and looks wrong done to one of them, which is the opposite of
		// what glass is for.
		{shared: true, key: 'underLight', label: 'Light underneath', type: 'choice', options: [
			{value: false, label: 'None'},
			{value: true, label: 'Strip'},
		]},
		{shared: true, key: 'underLightKelvin', label: 'Strip colour', type: 'choice',
			when: {underLight: true}, options: KELVIN_OPTIONS},
		{shared: true, key: 'material.front', label: 'Fronts', type: 'material'},
		// `when` and not `unless`, deliberately: a spec written before glazing
		// existed has no `glazing` key at all, and `unless: {glazing: 'none'}` would
		// read `undefined !== 'none'` and offer a glass picker on every solid
		// cabinet in every saved design. See the note on `unless` in SpecInspector.
		{shared: true, key: 'material.glass', label: 'Glass', type: 'material', group: 'glass',
			when: {glazing: ['glass', 'mullion']}},
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
 * A face frame and its fronts, lying on any line across the plan.
 *
 * `carcassAt` can only put a face on the front of a box, because it writes
 * axis-aligned extents. A corner cabinet's faces are not: an L has two of them
 * at ninety degrees, and a diagonal has one at forty-five. So the face is built
 * flat, in its own frame, and the group it lives in is rotated onto the segment
 * - which costs nothing, because `mergeMeshes` bakes world matrices and a
 * generated part is one merged geometry either way.
 *
 * **Order the endpoints so the room is on the LEFT of p0 -> p1.** Rotating by
 * theta sends local +x to `(cos, 0, -sin)` and local +z to `(sin, 0, cos)`, so
 * laying +x along the segment puts +z - the direction the doors face - on its
 * left. Reversed, the doors face into the carcass, which is invisible in a
 * vertex count and obvious in one render.
 *
 * @param {{x: number, z: number}} p0 @param {{x: number, z: number}} p1
 */
function faceOn(group, s, mats, p0, p1, yLo, yHi, doors, handleAtStart)
{
	var dx = p1.x - p0.x;
	var dz = p1.z - p0.z;
	var span = Math.sqrt(dx * dx + dz * dz);
	// Narrower than a stile either side plus a door between them is not a face,
	// it is a filler - and asking `frontPanel` for a negative width draws a door
	// inside out.
	if (span < 2 * s.stile + 8)
	{
		return;
	}
	var panel = new Group();
	panel.rotation.y = Math.atan2(-dz, dx);
	panel.position.set((p0.x + p1.x) / 2, 0, (p0.z + p1.z) / 2);

	var x0 = -span / 2;
	var x1 = span / 2;
	var openLo = yLo;
	var openHi = yHi;
	var frontZ = 0;
	if (s.frame === 'face')
	{
		panel.add(box(mats.frame, x0, x0 + s.stile, yLo, yHi, 0, s.panel));
		panel.add(box(mats.frame, x1 - s.stile, x1, yLo, yHi, 0, s.panel));
		panel.add(box(mats.frame, x0 + s.stile, x1 - s.stile, yHi - s.stile, yHi, 0, s.panel));
		panel.add(box(mats.frame, x0 + s.stile, x1 - s.stile, yLo, yLo + s.stile, 0, s.panel));
		openLo = yLo + s.stile;
		openHi = yHi - s.stile;
		x0 += s.stile;
		x1 -= s.stile;
		frontZ = s.panel;
	}

	var r = s.reveal;
	var count = Math.max(1, Math.min(2, doors));
	var each = ((x1 - x0) - r * (count + 1)) / count;
	for (var i = 0; i < count; i++)
	{
		var d0 = x0 + r + i * (each + r);
		frontPanel(mats, s.front, d0, d0 + each, openLo + r, openHi - r, frontZ,
			s.frontThickness, s.glazing).forEach(function (mesh) {panel.add(mesh);});
		// The opening edge, which for a pair is the middle. A single door on a
		// corner is the exception and says which end it opens from: an L's two
		// leaves are hinged at the walls and meet at the inside corner, so both
		// handles are there - and taking the default put one of them 21cm away,
		// against the cabinet next door.
		var opensAtStart = (count === 1) ? Boolean(handleAtStart) : (i !== 0);
		var handX = opensAtStart ? (d0 + 5) : (d0 + each - 5);
		hardwareFor(mats, s.hardware, handX, (openLo + openHi) / 2 + 10,
			frontZ + s.frontThickness, false).forEach(function (mesh) {panel.add(mesh);});
	}
	group.add(panel);
}

/**
 * Where a corner cabinet's faces run, in its own frame.
 *
 * One place, because the toe kick, the carcass and the fronts all need the same
 * two lines and a corner drawn three slightly different ways is three corners.
 *
 * @returns {{bIn: number, faces: Array<Array<{x: number, z: number}>>}} `bIn` is
 *          the inside face of the return leg; `faces` is one segment per face,
 *          each already ordered so the room is on its left.
 */
function cornerLines(s, f)
{
	var bIn = f.hx * (f.x1 - f.retDepth);
	var far = f.hx < 0
		? {a0: {x: bIn, z: f.face}, a1: {x: f.x1, z: f.face},
			b0: {x: bIn, z: f.z1}, b1: {x: bIn, z: f.face}}
		: {a0: {x: -f.x1, z: f.face}, a1: {x: bIn, z: f.face},
			b0: {x: bIn, z: f.face}, b1: {x: bIn, z: f.z1}};
	if (f.corner === 'diagonal')
	{
		// One face across the two free ends. The corner it cuts off is the part of
		// the square you could not reach anyway.
		return {bIn: bIn, faces: [f.hx < 0
			? [far.b0, far.a1]
			: [far.a0, far.b1]]};
	}
	return {bIn: bIn, faces: [[far.a0, far.a1], [far.b0, far.b1]]};
}

/**
 * A corner cabinet: two legs at right angles, and the face across their ends.
 *
 * The same job `carcassAt` does, for the shape it cannot express. Kept separate
 * rather than generalised: `carcassAt` is a box and reads like one, and every
 * cabinet in a kitchen but two is a box.
 */
function cornerAt(group, s, mats, f, yLo, yHi)
{
	var lines = cornerLines(s, f);
	var bIn = lines.bIn;
	var wallB = f.hx * f.x1;
	var bx0 = Math.min(bIn, wallB);
	var bx1 = Math.max(bIn, wallB);
	var back = -f.z1;

	// The two backs, on the two walls.
	group.add(box(mats.carcass, -f.x1, f.x1, yLo, yHi, back, back + s.panel));
	group.add(box(mats.carcass, f.hx < 0 ? bx0 : bx1 - s.panel,
		f.hx < 0 ? bx0 + s.panel : bx1, yLo, yHi, back, f.z1));
	// The deck, as the L it is.
	group.add(box(mats.carcass, -f.x1, f.x1, yLo, yLo + s.panel, back, f.face));
	group.add(box(mats.carcass, bx0, bx1, yLo, yLo + s.panel, back, f.z1));
	// The free end of each leg: a side panel, where a plain cabinet has two.
	group.add(box(mats.carcass, f.hx < 0 ? f.x1 - s.panel : -f.x1,
		f.hx < 0 ? f.x1 : -f.x1 + s.panel, yLo, yHi, back, f.face));
	group.add(box(mats.carcass, bx0, bx1, yLo, yHi, f.z1 - s.panel, f.z1));
	// A wall cabinet is closed on top; a base one gets stretchers, because its
	// top is the counter's business and never seen.
	if (s.variant === 'wall')
	{
		group.add(box(mats.carcass, -f.x1, f.x1, yHi - s.panel, yHi, back, f.face));
		group.add(box(mats.carcass, bx0, bx1, yHi - s.panel, yHi, back, f.z1));
	}
	else
	{
		group.add(box(mats.carcass, -f.x1, f.x1, yHi - s.panel, yHi, back, back + 12));
		group.add(box(mats.carcass, bx0, bx1, yHi - s.panel, yHi, f.z1 - 12, f.z1));
	}

	// One door per face for an L, and whatever was asked for on a diagonal's
	// single face - which is how both are actually hung. `handleAtStart` is which
	// end of the segment the inside corner is on, and `cornerLines` orders each
	// face so that the doors face the room, not so that the corner is first.
	lines.faces.forEach(function (segment, index)
	{
		faceOn(group, s, mats, segment[0], segment[1], yLo, yHi,
			(lines.faces.length === 1) ? s.doors : 1,
			lines.faces.length === 1 ? false : ((f.hx < 0) === (index === 0)));
	});
}

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
		// No glazing argument, and that is the point of glazing being its own
		// field: a drawer front is solid whatever the doors below it are doing.
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
			frontPanel(mats, s.front, x0, x1, openLo + r, cursor - r, frontZ, s.frontThickness,
				s.glazing).forEach((mesh) => fronts.add(mesh));
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

	if (f.corner === 'none')
	{
		carcassAt(group, s, mats, f, lift, cabinetTop, s.doors, s.drawers, s.apronCut);
	}
	else
	{
		// No drawers and no apron cut. A corner unit's opening is a door or two;
		// there is no such thing as a corner drawer, and a farmhouse sink does not
		// go in one.
		cornerAt(group, s, mats, f, lift, cabinetTop);
	}

	// ---- toe kick ---------------------------------------------------------
	if (f.toe > 0)
	{
		group.add(box(mats.carcass, -f.x1, f.x1, f.floor, lift, back, f.face - s.toeRecess));
		if (f.corner !== 'none')
		{
			// The other leg's, recessed from ITS face rather than from the front.
			//
			// `+ hx`, not `- hx`. The return leg reaches OUT from its wall in the
			// -hx direction, so its face normal is -hx and setting the kick back
			// means moving it towards the wall, which is +hx. Backwards, the kick
			// stood 3in PROUD of the door above it and filled the corner the L
			// exists to leave empty.
			var kick = cornerLines(s, f).bIn + f.hx * s.toeRecess;
			group.add(box(mats.carcass, Math.min(kick, f.hx * f.x1),
				Math.max(kick, f.hx * f.x1), f.floor, lift, back, f.z1));
		}
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
			if (f.corner === 'none')
			{
				carcassAt(group, s, mats, f, cabinetTop, f.y1, Math.max(1, s.doors), [], 0);
			}
			else
			{
				cornerAt(group, s, mats, f, cabinetTop, f.y1);
			}
		}
		else
		{
			// A soffit: a closed box, flush with the cabinet face, in the frame
			// material because that is what it is painted to match.
			group.add(box(mats.frame, -f.x1, f.x1, cabinetTop, f.y1, back, f.face + s.panel));
			if (f.corner !== 'none')
			{
				var bIn = cornerLines(s, f).bIn;
				group.add(box(mats.frame, Math.min(bIn, f.hx * f.x1),
					Math.max(bIn, f.hx * f.x1), cabinetTop, f.y1, back, f.z1));
			}
		}
	}

	var middle = centre(group);
	var merged = mergeMeshes(group);
	var built = {geometry: merged.geometry, materials: merged.materials, parts: []};
	var strip = underLight(s, f, middle);
	if (strip)
	{
		built.fixtures = [strip];
	}
	return built;
}
