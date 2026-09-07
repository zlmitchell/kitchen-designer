// @ts-check
import {Group, Object3D} from 'three';
import {mergeMeshes} from '../../core/geometry_merge.js';
import {disposeObject} from '../../core/resource_registry.js';
import {materialsForSlots} from '../../core/materials.js';
import {box, buildCasing, buildSash, resolveHanding} from './opening.js';

/**
 * A window, generated from a spec rather than loaded from a file.
 *
 * ROADMAP.md's audit lists four separate "no"s that are all this one object:
 * window types, muntins in the glass, window width and height, and
 * floor-to-ceiling windows. They are one entry because they have one root cause,
 * the same one the door had - `Item.resize()` calls `setScale`, so the only way
 * to ask for a wider window was to stretch a 123cm model, which stretches the
 * frame, the sash and the muntins along with the glass. There is no width you
 * can ask `whitewindow.glb` for that is correct, and all 19 windows on the
 * traced plan are that stretch: `extract.py` writes
 * `scale_x = width_cm / 123.0769` and `scale_z = thickness / 14.75`.
 *
 * ## What is in the item and what is in a child
 *
 * The same split as the door, and load-bearing for the same reason:
 * `Item.bounds()` reads `this.geometry.boundingBox` and nothing else, and three
 * things downstream read those bounds - `three/edge.js` cuts the wall's hole
 * from `halfSize.x`/`.y`, `WallItem.boundMove` clamps travel along the wall by
 * `sizeX / 2`, and `InWallItem.getWallOffset` centres the item across the wall.
 *
 * So the item's own geometry is exactly the **rough opening**: two side jambs, a
 * head and a sill, filling the wall's thickness. A window has the fourth member
 * a door does not, and that is the only difference in the lining.
 *
 * Everything else is a child. The casing laps the wall face and would widen the
 * hole on all four sides. The sashes move - a casement swings clear of the wall,
 * a hung sash slides past the other one - and a moving part inside the bounds
 * would drag the hole around with it.
 *
 * ## The sill height is the spec's, and the drag writes it back
 *
 * A window is the first generated item whose **position** is part of what it is.
 * A door's is not: it stands on the floor, and `WallItem.resized` re-seats it
 * there. A window sits wherever its sill height says, and nothing in the app had
 * anywhere to put that number - `extract.py` bakes `ypos: 157` and the height
 * lives only in the mesh scale.
 *
 * So `sillHeight` is a spec field, `onBound` applies it (binding is the first
 * moment the item is attached to a wall at all), and `onPlaced` writes it back
 * when somebody drags the window up the wall. Both directions, or the panel and
 * the mouse disagree and whichever ran last silently wins.
 *
 * ## `fullHeight` is the item asking its host a question
 *
 * A floor-to-ceiling window cannot state its own height, because the height it
 * wants is the wall's. `onBound` reads it off the wall it just bound to and
 * rebuilds through `setSpec` - which is the "an item declares requirements of
 * its host, and the host validates" mechanism ROADMAP.md phase 3 wants, in the
 * one place phase 5 already needs it.
 *
 * It is also the trap `docs/generated-items.md` rule 4 says to expect at the
 * other end of the wall. `ShapeUtils.triangulateShape` DISCARDS a hole that
 * strays outside its contour, silently and in full, and a full-height window's
 * hole reaches both the floor and the wall top exactly. `edge.js` clamps holes
 * inside the contour by `HOLE_INSET` for the door's sake and the same clamp
 * saves this - `tests/wall-openings.test.js` pins it from the top edge now as
 * well as the bottom.
 */

/** Millwork sizes, in centimetres. Nominal, and all overridable by the spec. */
const DEFAULTS = {
	/** Jamb liner stock, and the sill. 3/4in. */
	jamb: 1.9,
	/** Casing face width. 2 1/2in. */
	casing: 6.35,
	/** How far the casing stands off the wall face. 5/8in. */
	casingProud: 1.6,
	/** Sash stile and rail face width. 1 3/4in. */
	sashFace: 4.5,
	/** Sash thickness. 1 3/8in. */
	sashThickness: 3.5,
	/** Double glazing, as one pane. */
	glassThickness: 1.8,
	/** Muntin bar width. 3/4in. */
	bar: 1.9,
	/** How far a muntin stands off the glass, each face. */
	barProud: 0.5,
	/** Gap between a sash and the jamb it runs in. */
	reveal: 0.3,
	/** How far open `openFraction: 1` means for a casement, in degrees. */
	openAngle: 90,
	/** An awning tips out from the head; it does not swing wide. */
	awningAngle: 30,
	type: 'double-hung',
	/** Floor to the top of the sill. 32in - the sill the traced plan assumes. */
	sillHeight: 81.28,
	fullHeight: false,
	hand: 'lo',
	swing: 'negative',
	openFraction: 0,
	grille: {pattern: 'none', rows: 2, cols: 2},
};

/**
 * @typedef {Object} WindowSpec
 * @property {number} width Clear opening between the jamb liners, in cm.
 * @property {number} height Clear opening height, in cm.
 * @property {number} wallThickness The wall this sits in, face to face. The
 *           lining fills it, so a 2x4 partition and a 2x6 wall both come out
 *           right without anything being scaled.
 * @property {('fixed'|'picture'|'single-hung'|'double-hung'|'casement'|'slider'|'awning')} [type]
 *           Sash count plus divide direction, which is all a window type is.
 * @property {number} [sillHeight] Floor to the top of the sill. Applied on
 *           binding and written back by a drag; see `applyWindowPlacement`.
 * @property {boolean} [fullHeight] Pin the head to the wall top and the sill to
 *           the floor. Overrides `height` and `sillHeight`, because both then
 *           belong to the wall.
 * @property {{pattern?: string, rows?: number, cols?: number}} [grille] Muntins
 *           in the glass. `none|colonial|prairie|craftsman`.
 * @property {('lo'|'hi')} [hand] Which end a casement is hinged on, or which
 *           sash of a slider moves, **along the plan's axis**, not the item's.
 * @property {('positive'|'negative')} [swing] Which face a casement or awning
 *           opens out of, **across the plan's axis**.
 * @property {number} [openFraction] 0 shut, 1 fully open.
 * @property {number} [jamb]
 * @property {number} [casing]
 * @property {number} [casingProud]
 * @property {number} [sashFace]
 * @property {number} [sashThickness]
 * @property {number} [glassThickness]
 * @property {number} [openAngle]
 */

/**
 * What each slot is made of unless the spec says otherwise.
 *
 * Six, and `grille` is separate from `sash` on purpose even though they are the
 * same white by default: a grille between the panes of a sealed unit is
 * routinely a different finish from the sash it sits in, and once they share a
 * slot no spec can say so. `glass` is separate from both because it is the one
 * surface here that is not a solid.
 */
const SLOTS = {
	frame: 'paint-white',
	sash: 'paint-white',
	grille: 'paint-white',
	casing: 'paint-white',
	glass: 'glass-clear',
	hardware: 'metal-brushed-nickel',
};

/** Which types have a sash that actually moves. */
const OPERABLE = ['single-hung', 'double-hung', 'casement', 'slider', 'awning'];

/** The derived sizes every part below is placed against. */
function frameOf(s)
{
	var W = s.width + 2 * s.jamb;
	var H = s.height + 2 * s.jamb;
	return {
		W: W, H: H,
		x1: W / 2, y1: H / 2, z1: s.wallThickness / 2,
		ox: s.width / 2,
		oy: s.height / 2,
	};
}

/**
 * The sashes a type is made of, before anything opens.
 *
 * Every entry is in the item's own centred frame and carries its own size, so
 * `buildSashes` below places them without knowing which type asked.
 *
 * The one shape worth stating: a two-sash window's sashes are **offset across
 * the wall thickness** and **overlap along it**. That is what makes a hung
 * window and a slider work at all, and it is also the signature ROADMAP.md says
 * a bypass gets wrong - one leaf is always in front of the other, so the opening
 * never clears more than about half. The travel below is capped at exactly that.
 *
 * @param {Object} s A normalised spec.
 * @returns {Array<{name: string, x: number, y: number, z: number, width: number,
 *          height: number, moves: ?string, travel: number}>}
 */
export function sashLayout(s)
{
	var f = frameOf(s);
	var full = {name: 'window-sash', x: 0, y: 0, z: 0,
		width: s.width - 2 * s.reveal, height: s.height - 2 * s.reveal,
		moves: null, travel: 0};

	if (s.type === 'fixed' || s.type === 'picture')
	{
		return [full];
	}

	if (s.type === 'casement' || s.type === 'awning')
	{
		return [Object.assign({}, full, {moves: 'pivot'})];
	}

	// The two sashes pass each other, so each is offset half a sash thickness off
	// the wall centreline plus a hair of clearance. Without the clearance they
	// share a plane down the overlap and z-fight along it.
	var off = s.sashThickness / 2 + 0.2;

	if (s.type === 'slider')
	{
		var sw = (s.width + s.sashFace) / 2 - s.reveal;
		var run = f.ox - s.sashFace;
		return [
			{name: 'window-sash-lo', x: -f.ox + sw / 2 + s.reveal, y: 0, z: off,
				width: sw, height: s.height - 2 * s.reveal, moves: 'slide-x', travel: run},
			// Both carry the travel, because which one moves is the HAND's answer
			// and the hand is not known here. `buildSashes` moves the flag.
			{name: 'window-sash-hi', x: f.ox - sw / 2 - s.reveal, y: 0, z: -off,
				width: sw, height: s.height - 2 * s.reveal, moves: null, travel: run},
		];
	}

	// Hung. The lower sash is the inner one - that is which way round a hung
	// window is built, and it is also why the lower one is the one you can reach.
	//
	// A DOUBLE hung gets HALF the travel each, and that is not a tuning choice.
	// Given both sashes the full travel they simply swap ends - the lower goes to
	// the top, the upper comes to the bottom, and every part of the opening is
	// still covered by one of them. Rendered, `openFraction: 1` was
	// indistinguishable from shut. Half each is also how the thing is actually
	// used: a gap at the head and a gap at the sill, sashes overlapping in the
	// middle.
	var sh = (s.height + s.sashFace) / 2 - s.reveal;
	var travel = f.oy - s.sashFace;
	var double = (s.type === 'double-hung');
	return [
		{name: 'window-sash-lo', x: 0, y: -f.oy + sh / 2 + s.reveal, z: off,
			width: s.width - 2 * s.reveal, height: sh, moves: 'slide-y',
			travel: double ? travel / 2 : travel},
		{name: 'window-sash-hi', x: 0, y: f.oy - sh / 2 - s.reveal, z: -off,
			width: s.width - 2 * s.reveal, height: sh,
			moves: double ? 'slide-y-down' : null, travel: double ? travel / 2 : travel},
	];
}

/**
 * The sashes, glazed, placed, and opened by `openFraction`.
 *
 * Handing-dependent, so it is rebuilt on binding and never merged - the same
 * arrangement the door's leaf has, and for the same reason: the item's own
 * geometry stays symmetric and the wall's hole never moves when a window is
 * re-handed.
 *
 * @returns {Array<Object3D>}
 */
function buildSashes(s, hingeSign, dirSign, mats)
{
	var open = Math.max(0, Math.min(1, s.openFraction));
	var operable = OPERABLE.indexOf(s.type) !== -1;
	/** @type {Array<Object3D>} */
	var parts = [];

	var layout = sashLayout(s);
	if (s.type === 'slider' && hingeSign > 0)
	{
		// The hand names which sash slides, and the layout cannot know it - it is
		// stated in plan axes and only resolved once the item has a wall. Both
		// entries carry the travel, so moving the flag is the whole job.
		layout.forEach(function (place)
		{
			place.moves = (place.moves === 'slide-x') ? null : 'slide-x';
		});
	}

	layout.forEach(function (place)
	{
		var sash = buildSash(mats, {
			width: place.width, height: place.height,
			face: (s.type === 'picture') ? s.sashFace * 0.7 : s.sashFace,
			thickness: s.sashThickness,
			glassThickness: s.glassThickness,
			bar: s.bar, barProud: s.barProud,
			grille: s.grille, name: place.name,
		});

		// One piece of ironmongery, ON WHATEVER MOVES, and that is the point: a
		// handle authored in the frame's coordinates instead is left hanging in
		// the middle of the empty opening the moment the sash swings away from it.
		// Nothing measured says so - the triangles are present and in the position
		// they were given. A render aimed at an open casement says it immediately.
		// A double hung has ONE lock, at the meeting rail, and it belongs to the
		// lower sash. Giving every moving sash a handle put a second one on the
		// upper sash's top rail, up at the head, where no window has one.
		var takesHandle = operable && place.moves
			&& !(s.type === 'double-hung' && place.name !== 'window-sash-lo');
		if (takesHandle)
		{
			var hz = s.sashThickness / 2;
			var inset = s.sashFace / 2;
			var hx = 0;
			var hy = 0;
			if (s.type === 'casement')
			{
				// The stile away from the hinge, at hand height.
				hx = -hingeSign * (place.width / 2 - inset);
			}
			else if (s.type === 'slider')
			{
				// The stile at the trailing end - the one you pull.
				hx = Math.sign(place.x) * (place.width / 2 - inset);
			}
			else if (s.type === 'awning')
			{
				// The bottom rail, which is the edge that comes to you.
				hy = -place.height / 2 + inset;
			}
			else
			{
				// A hung window locks at the meeting rail: the top of the lower sash.
				hy = place.height / 2 - inset;
			}
			sash.add(box(mats.hardware, hx - 1.2, hx + 1.2, hy - 3, hy + 3, hz, hz + 2.2));
		}

		if (place.moves === 'pivot')
		{
			// A casement is hinged on a jamb and swings wide; an awning is hinged at
			// the head and tips out at the bottom. Both hang off an empty pivot at
			// the hinge line, so opening one is a rotation of a single node - which
			// is what makes `openFraction` continuous and animatable for nothing.
			var pivot = new Object3D();
			pivot.name = 'window-sash-pivot';
			var angle = open * (s.type === 'awning' ? s.awningAngle : s.openAngle) * Math.PI / 180;

			if (s.type === 'awning')
			{
				pivot.position.set(0, place.height / 2, 0);
				sash.position.set(0, -place.height / 2, 0);
				// Tipping out of the face `dirSign` names sends the sash's bottom to
				// that side, which is a rotation about x of the OPPOSITE sign: a
				// point at local -y goes to +z under a negative rotation.
				pivot.rotation.x = -dirSign * angle;
			}
			else
			{
				pivot.position.set(hingeSign * place.width / 2, 0, 0);
				sash.position.set(-hingeSign * place.width / 2, 0, 0);
				// Same arithmetic as the door leaf: the sash's centre is at
				// dx = -hingeSign * width/2, and rotating by theta sends it to
				// z = hingeSign * width/2 * sin(theta), so opening toward local +z
				// wants sin(theta) to carry hingeSign's own sign.
				pivot.rotation.y = dirSign * hingeSign * angle;
			}
			pivot.add(sash);
			parts.push(pivot);
			return;
		}

		var dx = 0;
		var dy = 0;
		if (place.moves === 'slide-y')
		{
			dy = open * place.travel;
		}
		else if (place.moves === 'slide-y-down')
		{
			dy = -open * place.travel;
		}
		else if (place.moves === 'slide-x')
		{
			// TOWARD the other sash, which is toward the middle - never away from
			// it. Slid the other way it leaves the opening entirely and hangs in
			// free air beside the window, which is what it did: a slider that clears
			// its whole opening is exactly the mistake ROADMAP.md names, and it is
			// obvious in a render and invisible in a measurement of travel.
			dx = -Math.sign(place.x) * open * place.travel;
		}
		sash.position.set(place.x + dx, place.y + dy, place.z);
		parts.push(sash);
	});

	return parts;
}

/**
 * The height a full-height window wants, given the wall it is in.
 *
 * The clear opening, so the lining's head lands on the wall top and its sill on
 * the floor - `H = height + 2 * jamb` by `frameOf`, so this is the wall less
 * both liners.
 *
 * @param {number} wallHeight
 * @param {number} jamb
 * @returns {number}
 */
export function fullHeightFor(wallHeight, jamb)
{
	return Math.max(10, wallHeight - 2 * jamb);
}

/** The wall height an item's edge reports, or null when it is not on one yet. */
function wallHeightOf(item)
{
	var edge = item && item.currentWallEdge;
	if (!edge)
	{
		return null;
	}
	var height = (edge.wall && edge.wall.height) || edge.height;
	return (typeof height === 'number' && height > 0) ? height : null;
}

/**
 * Re-hand a bound window, resize it if it is full height, and sit it on its sill.
 *
 * Called from `WallItem.changeWallEdge` through `Item.onBound`, because that is
 * the moment the item's rotation stops being the tracer's hint and becomes the
 * wall's answer - and it is also the first moment there is a wall to ask how
 * tall it is.
 *
 * The `setSpec` branch recurses exactly once. `setSpec` calls `onBound` again at
 * the end, and by then `spec.height` matches the wall, so the guard is false and
 * the second pass falls through to the placement below.
 *
 * @param {Object} item An Item carrying a `window` spec.
 */
export function applyWindowPlacement(item)
{
	var spec = item.metadata && item.metadata.spec;
	if (!spec || spec.kind !== 'window')
	{
		return;
	}
	var s = Object.assign({}, DEFAULTS, spec);
	var wallHeight = wallHeightOf(item);

	if (s.fullHeight && wallHeight && typeof item.setSpec === 'function' && item._specBuilder)
	{
		var wanted = fullHeightFor(wallHeight, s.jamb);
		if (Math.abs(s.height - wanted) > 0.05)
		{
			var next = item.getSpec();
			next.height = Number(wanted.toFixed(4));
			// The sill is on the floor, so the clear opening starts one liner up.
			next.sillHeight = s.jamb;
			item.setSpec(next);
			return;
		}
	}

	var mats = materialsForSlots(s.material, SLOTS);
	var handing = resolveHanding(s, item.rotation.y);

	var stale = item.generatedParts.filter(function (part)
	{
		// The hardware is a child of whichever sash it belongs to, so it goes with
		// it rather than being listed here.
		return part.name === 'window-sash' || part.name === 'window-sash-lo'
			|| part.name === 'window-sash-hi' || part.name === 'window-sash-pivot';
	});
	stale.forEach(function (part)
	{
		item.remove(part);
		disposeObject(part);
	});

	var fresh = buildSashes(s, handing.hingeSign, handing.dirSign, mats);
	fresh.forEach(function (part) {item.add(part);});
	item.generatedParts = item.generatedParts
		.filter(function (part) {return stale.indexOf(part) === -1;})
		.concat(fresh);

	// And sit it on its sill. The geometry is centred on its own bounding box, so
	// the clear opening's bottom edge is `height / 2` below the item's origin.
	var y = (s.fullHeight && wallHeight) ? wallHeight / 2 : s.sillHeight + s.height / 2;
	if (Math.abs(item.position.y - y) > 1e-4)
	{
		item.position.y = y;
		// The wall's hole is cut from this item's position and bounds, and
		// `changeWallEdge` already redrew before calling this.
		if (typeof item.redrawWall === 'function')
		{
			item.redrawWall();
		}
	}
}

/**
 * Write a dragged window's height back into its spec.
 *
 * Called from `WallItem.moveToPosition` through `Item.onPlaced`. Without it the
 * panel and the mouse hold two different sill heights and the next bind - a
 * document load, a wall edit - throws away whichever one the mouse set.
 *
 * A full-height window is not written back: its sill is the floor by definition,
 * and `boundMove` will happily push it a centimetre up the wall.
 *
 * @param {Object} item An Item carrying a `window` spec.
 */
export function syncSillHeight(item)
{
	var spec = item.metadata && item.metadata.spec;
	if (!spec || spec.kind !== 'window' || spec.fullHeight)
	{
		return;
	}
	var height = (typeof spec.height === 'number') ? spec.height : DEFAULTS.jamb;
	var sill = item.position.y - height / 2;
	spec.sillHeight = Number(Math.max(0, sill).toFixed(2));
}

/**
 * What a panel may ask about a window, and how to ask it.
 *
 * `SpecInspector.vue` renders whatever this describes, so a new pattern in the
 * glass is a line in `opening.js` and a line here, and no UI work at all.
 */
export const WINDOW_SCHEMA = {
	label: 'Window',
	// The builder's own slot defaults, so the panel can show the finish an
	// unspecified slot will actually be built with. A REFERENCE to `SLOTS`, not a
	// copy: a default written twice is a default that goes stale.
	slots: SLOTS,
	fields: [
		{key: 'type', label: 'Type', type: 'choice', options: [
			{value: 'fixed', label: 'Fixed'},
			{value: 'picture', label: 'Picture'},
			{value: 'single-hung', label: 'Single hung'},
			{value: 'double-hung', label: 'Double hung'},
			{value: 'casement', label: 'Casement'},
			{value: 'slider', label: 'Slider'},
			{value: 'awning', label: 'Awning'},
		]},
		{key: 'width', label: 'Opening width', type: 'length', min: 30, max: 400, step: 1},
		// Both are the wall's when the window runs floor to ceiling, so neither is
		// a choice then.
		// `unless`, not `when: {fullHeight: false}`. A spec is allowed to leave the
		// flag out - every catalog window does - and `when` cannot tell "false"
		// from "not mentioned", so both of these silently vanished from the panel.
		{key: 'height', label: 'Opening height', type: 'length', min: 30, max: 300, step: 1,
			unless: {fullHeight: true}},
		{key: 'sillHeight', label: 'Sill height', type: 'length', min: 0, max: 250, step: 1,
			unless: {fullHeight: true}},
		{key: 'fullHeight', label: 'Floor to ceiling', type: 'choice', options: [
			{value: false, label: 'No'},
			{value: true, label: 'Yes'},
		]},
		// Not editable: it is the wall's, and a window that disagrees with its wall
		// is a bug rather than a choice. Shown so the number is visible.
		{key: 'wallThickness', label: 'Wall thickness', type: 'length', readOnly: true},
		// `shared`, like a cabinet's door style and a door's leaf. The grille IS a
		// window's style - it is the thing you would change across a whole
		// elevation and never on one window alone - and without the flag the panel
		// showed no scope control at all, because it only appears when a schema has
		// at least one shared field. A house with colonial glazing bars in one
		// window and none in the next is a mistake, not a design.
		{key: 'grille.pattern', label: 'Grille', type: 'choice', shared: true, options: [
			{value: 'none', label: 'None'},
			{value: 'colonial', label: 'Colonial'},
			{value: 'prairie', label: 'Prairie'},
			{value: 'craftsman', label: 'Craftsman'},
		]},
		// Prairie is a border and craftsman divides only its top light, so neither
		// has a row or column count to set.
		{key: 'grille.rows', label: 'Lights high', type: 'fraction', shared: true,
			min: 1, max: 6, step: 1, when: {'grille.pattern': 'colonial'}},
		{key: 'grille.cols', label: 'Lights wide', type: 'fraction', shared: true,
			min: 1, max: 6, step: 1, when: {'grille.pattern': 'colonial'}},
		{key: 'hand', label: 'Hinged at', type: 'choice', when: {type: 'casement'}, options: [
			{value: 'lo', label: 'Start of wall'},
			{value: 'hi', label: 'End of wall'},
		]},
		{key: 'swing', label: 'Opens toward', type: 'choice', options: [
			{value: 'negative', label: 'One side'},
			{value: 'positive', label: 'The other'},
		]},
		{key: 'openFraction', label: 'How far open', type: 'fraction', min: 0, max: 1, step: 0.05},
		// Finishes travel too, for the same reason they do on a door.
		{key: 'material.glass', label: 'Glazing', type: 'material', shared: true, group: 'glass'},
		{key: 'material.sash', label: 'Sash', type: 'material', shared: true},
		{key: 'material.frame', label: 'Frame', type: 'material', shared: true},
		{key: 'material.casing', label: 'Casing', type: 'material', shared: true},
		{key: 'material.hardware', label: 'Hardware', type: 'material', shared: true, group: 'metal'},
	],
};

/**
 * Build a window.
 *
 * The handing here is the spec's own, read against a rotation of zero. That is a
 * placeholder: the item is re-handed by `applyWindowPlacement` the moment it
 * binds to a wall, which is the only point at which its axes are known. Building
 * it anyway means a window that is never bound - in a test, or in a design with
 * no walls - still looks like a window.
 *
 * @param {WindowSpec} spec
 * @returns {{geometry: import('three').BufferGeometry, materials: Array,
 *           parts: Array<Object3D>, onBound: function(Object): void,
 *           onPlaced: function(Object): void}}
 */
export function buildWindow(spec)
{
	var s = Object.assign({}, DEFAULTS, spec || {});
	s.grille = Object.assign({}, DEFAULTS.grille, (spec && spec.grille) || {});
	var f = frameOf(s);
	var mats = materialsForSlots(s.material, SLOTS);

	// The item's own geometry: jambs, head and sill, filling the wall. Symmetric,
	// and deliberately free of anything the handing or the opening decides.
	var frame = new Group();
	frame.add(box(mats.frame, -f.x1, -f.ox, -f.y1, f.y1, -f.z1, f.z1));
	frame.add(box(mats.frame, f.ox, f.x1, -f.y1, f.y1, -f.z1, f.z1));
	frame.add(box(mats.frame, -f.ox, f.ox, f.oy, f.y1, -f.z1, f.z1));
	frame.add(box(mats.frame, -f.ox, f.ox, -f.y1, -f.oy, -f.z1, f.z1));
	var merged = mergeMeshes(frame);

	var handing = resolveHanding(s, 0);
	/** @type {Array<Object3D>} */
	var parts = [];
	buildCasing(mats.casing, {
		name: 'window-casing',
		x1: f.x1, y1: f.y1, ox: f.ox, z1: f.z1,
		casing: s.casing, proud: s.casingProud,
		// A floor-to-ceiling window has no room for a head or a sill run: the
		// casing stands proud of the opening, and the opening already fills the
		// wall. Both would land inside the ceiling and under the floor.
		bottom: !s.fullHeight, top: !s.fullHeight,
	}).forEach(function (part) {parts.push(part);});
	buildSashes(s, handing.hingeSign, handing.dirSign, mats).forEach(function (part) {parts.push(part);});

	return {
		geometry: merged.geometry,
		materials: merged.materials,
		parts: parts,
		onBound: applyWindowPlacement,
		onPlaced: syncSillHeight,
	};
}

/**
 * Fold a saved mesh scale into the spec.
 *
 * Every window on the traced plan is a scaled `whitewindow.glb`, and a design
 * saved before this builder existed carries that scale on the item. Left alone
 * it would multiply against the size the spec now asks for, which is the defect
 * `Scene.addItem` folds away for the post and the door.
 *
 * The mapping is not the door's. A window's `width` and `height` are the CLEAR
 * opening and its bounds are that plus a liner on all four sides, so the scale
 * has to come off the bounds and the liners be taken back out.
 *
 * @param {Object} spec
 * @param {{x: number, y: number, z: number}} scale
 * @returns {Object}
 */
buildWindow.absorbScale = function (spec, scale)
{
	var s = Object.assign({}, DEFAULTS, spec || {});
	var next = Object.assign({}, spec);
	next.width = Math.max(10, (s.width + 2 * s.jamb) * scale.x - 2 * s.jamb);
	next.height = Math.max(10, (s.height + 2 * s.jamb) * scale.y - 2 * s.jamb);
	return next;
};
