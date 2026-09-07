// @ts-check
import {Group, Mesh} from 'three';
import {boxGeometryFor} from '../../core/geometry_builders.js';

/**
 * The parts every hole in a wall is made of.
 *
 * ROADMAP.md phase 5 asks for "one opening builder, not two", and the reason is
 * the patio slider: it reaches the floor, so it is a door, and it is mostly
 * glass, so it needs sash, glazing and grille work. Written twice, the second
 * copy is the one that rots.
 *
 * What lives here is therefore everything a door and a window share - the box
 * primitive, the plan-space handing, the casing that laps both wall faces, and
 * the glazing - and what stays in `door.js` and `window.js` is only the part
 * that differs: which members make up the lining, and what moves.
 *
 * Nothing here is a builder. These return meshes and groups in the **item's own
 * centred frame**, so a caller can place them without knowing how they were
 * made. See `docs/generated-items.md` for why that frame is centred.
 */

/**
 * A box spanning `[x0,x1] x [y0,y1] x [z0,z1]`.
 *
 * Written as extents rather than as size-and-centre because every dimension in
 * millwork is naturally a pair of faces - a jamb runs from the opening edge to
 * the rough opening edge, a muntin from one side of the bar to the other - and
 * converting each one to a centre by hand is where sign errors live.
 *
 * @param {import('three').Material} mat
 * @returns {Mesh}
 */
export function box(mat, x0, x1, y0, y1, z0, z1)
{
	var mesh = new Mesh(boxGeometryFor(mat, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)), mat);
	mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
	return mesh;
}

/**
 * A plan-space handing, in the item's own axes.
 *
 * Rotating about y by `theta` sends local +x to world `(cos, 0, -sin)` and local
 * +z to world `(sin, 0, cos)`. A wall running along world x therefore has its
 * along-axis component in `cos` for both; a wall running along world z has the
 * along component of local +x in `-sin` and the across component of local +z in
 * `+sin`. Those two disagreeing on vertical walls is exactly the sort of thing
 * that is invisible until half the doors on one elevation are hinged backwards,
 * so both are computed rather than assumed equal.
 *
 * Measured on the traced plan before this existed: `door-7` and `door-9` are
 * both `lo`/`in` and their leaves ended up at world dz +35.9 and -28.9.
 *
 * A casement window is the same question one storey up - which jamb it is hinged
 * on, and which face it opens out of - which is why this is shared rather than
 * copied.
 *
 * @param {{hand?: string, swing?: string}} spec Plan-space `hand` and `swing`.
 * @param {number} rotationY The rotation the item actually bound with.
 * @returns {{hingeSign: number, dirSign: number}} `hingeSign` is which local x
 *          end carries the hinge; `dirSign` is which local z it opens to.
 */
export function resolveHanding(spec, rotationY)
{
	var cos = Math.cos(rotationY || 0);
	var sin = Math.sin(rotationY || 0);
	// Which world axis this wall runs along, read off the item's own rotation.
	var alongX = Math.abs(cos) >= Math.abs(sin);
	var along = alongX ? cos : -sin;      // local +x, along the wall
	var across = alongX ? cos : sin;      // local +z, across the wall
	var hand = (spec.hand === 'hi') ? 1 : -1;
	var swing = (spec.swing === 'positive') ? 1 : -1;
	return {
		hingeSign: hand * (along < 0 ? -1 : 1),
		dirSign: swing * (across < 0 ? -1 : 1),
	};
}

/**
 * The casing: a picture frame lapping the wall on each face.
 *
 * A child, never merged into the item's geometry, because it laps the wall face
 * and the wall's hole is cut from the item's bounds - casing in the geometry
 * would widen the hole by the casing width on every side and show daylight all
 * round the opening.
 *
 * `bottom` is the difference between a door's casing and a window's: a door
 * stands on the floor and its casing dies into it, where a window has a fourth
 * run of trim under the sill.
 *
 * `top` exists for the floor-to-ceiling case. Casing stands PROUD of the
 * opening by its own face width, so an opening that already fills its wall has
 * nowhere to put a head or a sill run - they land inside the ceiling and under
 * the floor. Rendered from inside the room, a full-height window came out with a
 * band of trim floating above the wall.
 *
 * @param {import('three').Material} mat
 * @param {{name: string, x1: number, y1: number, ox: number, z1: number,
 *          casing: number, proud: number, bottom?: boolean, top?: boolean}} f
 * @returns {Array<Group>} One group per wall face.
 */
export function buildCasing(mat, f)
{
	return [-1, 1].map(function (side)
	{
		var casing = new Group();
		casing.name = f.name;
		var cz0 = side * f.z1;
		var cz1 = side * (f.z1 + f.proud);
		var cx = f.x1 + f.casing;
		var cy = f.y1 + f.casing;
		var top = (f.top === undefined) ? true : f.top;
		var yLo = f.bottom ? -cy : -f.y1;
		var yHi = top ? cy : f.y1;
		casing.add(box(mat, -cx, -f.ox, yLo, yHi, cz0, cz1));
		casing.add(box(mat, f.ox, cx, yLo, yHi, cz0, cz1));
		if (top)
		{
			casing.add(box(mat, -cx, cx, f.y1, cy, cz0, cz1));
		}
		if (f.bottom)
		{
			casing.add(box(mat, -cx, cx, -cy, -f.y1, cz0, cz1));
		}
		return casing;
	});
}

/**
 * Where the muntins go, in the daylight opening's own centred frame.
 *
 * "Muntins / grille in the glass" is one of the things ROADMAP.md's audit says
 * the app cannot express at all, and it is not a grid: three of the four
 * patterns a house actually has are not `rows x cols`.
 *
 * Returned as SEGMENTS rather than as lines, because craftsman needs bars that
 * stop partway - its verticals live only in the top light - and a full-span
 * model cannot say that. A segment is `{vertical, pos, from, to}`: `pos` is the
 * bar's own coordinate on the axis it divides, `from`/`to` its extent along the
 * other one.
 *
 * The size comes first and the pattern last because the pattern is the OPTIONAL
 * one - a sash with no grille still has a daylight opening - and a type that
 * admits `undefined` makes a parameter optional to the checker, which cannot
 * then be followed by a required one.
 *
 * @param {number} dw Daylight opening width.
 * @param {number} dh Daylight opening height.
 * @param {{pattern?: string, rows?: number, cols?: number}} [grille]
 * @returns {Array<{vertical: boolean, pos: number, from: number, to: number}>}
 */
export function grilleBars(dw, dh, grille)
{
	var pattern = (grille && grille.pattern) || 'none';
	var rows = Math.max(1, Math.round((grille && grille.rows) || 2));
	var cols = Math.max(1, Math.round((grille && grille.cols) || 2));
	/** @type {Array<{vertical: boolean, pos: number, from: number, to: number}>} */
	var bars = [];
	var i;

	if (pattern === 'none' || dw <= 0 || dh <= 0)
	{
		return bars;
	}

	if (pattern === 'colonial')
	{
		// The full grid. `rows x cols` LIGHTS, so one fewer bar than lights on
		// each axis - a 2x2 colonial sash has one bar each way, not two.
		for (i = 1; i < cols; i++)
		{
			bars.push({vertical: true, pos: -dw / 2 + i * dw / cols, from: -dh / 2, to: dh / 2});
		}
		for (i = 1; i < rows; i++)
		{
			bars.push({vertical: false, pos: -dh / 2 + i * dh / rows, from: -dw / 2, to: dw / 2});
		}
		return bars;
	}

	if (pattern === 'prairie')
	{
		// A border, not a grid: four bars set in from the four edges, leaving one
		// large centre light with small squares in the corners. The inset is the
		// only number in it, and it is taken off the SHORTER side, so a wide sash
		// does not get a border an inch deep on one axis and a foot on the other.
		var inset = Math.min(dw, dh) / 5;
		bars.push({vertical: true, pos: -dw / 2 + inset, from: -dh / 2, to: dh / 2});
		bars.push({vertical: true, pos: dw / 2 - inset, from: -dh / 2, to: dh / 2});
		bars.push({vertical: false, pos: -dh / 2 + inset, from: -dw / 2, to: dw / 2});
		bars.push({vertical: false, pos: dh / 2 - inset, from: -dw / 2, to: dw / 2});
		return bars;
	}

	if (pattern === 'craftsman')
	{
		// One horizontal a quarter down from the head, and verticals ONLY above
		// it. The bottom three quarters is a single undivided light, which is the
		// whole look - a craftsman sash divided all the way down is a colonial.
		var split = dh / 2 - dh / 4;
		bars.push({vertical: false, pos: split, from: -dw / 2, to: dw / 2});
		for (i = 1; i < cols; i++)
		{
			bars.push({vertical: true, pos: -dw / 2 + i * dw / cols, from: split, to: dh / 2});
		}
		return bars;
	}

	return bars;
}

/**
 * A glazed sash: stiles, rails, one pane, and whatever muntins the grille asks
 * for.
 *
 * Built centred on its own origin so the caller can place it - stacked for a
 * double hung, side by side for a slider, hung off a pivot for a casement -
 * without knowing anything about how it was assembled.
 *
 * Two of the traps in `docs/generated-items.md` are load-bearing here:
 *
 *   - **A solid swallows anything put inside it.** A muntin flush with the pane
 *     is a muntin nobody can see - the same fault that made a vent hood's filter
 *     render as nothing while its triangles were present and correct. The bars
 *     stand proud of the glass on both faces, which is also what they do in life.
 *   - **Two coplanar faces z-fight, and it reads as geometry.** The pane is
 *     thinner than the sash and centred in it, so no face of the glass shares a
 *     plane with any face of the frame.
 *
 * @param {{sash: import('three').Material, glass: import('three').Material,
 *          grille: import('three').Material}} mats
 * @param {{width: number, height: number, face: number, thickness: number,
 *          glassThickness: number, bar: number, barProud: number,
 *          grille?: Object, name?: string}} s
 * @returns {Group}
 */
export function buildSash(mats, s)
{
	var group = new Group();
	group.name = s.name || 'sash';

	var x1 = s.width / 2;
	var y1 = s.height / 2;
	var z1 = s.thickness / 2;
	// The daylight opening: what is left of the sash once the stiles and rails
	// have taken their face width off each edge.
	var dx = Math.max(0, x1 - s.face);
	var dy = Math.max(0, y1 - s.face);

	// Stiles full height, rails between them - the joint a sash is actually made
	// with, and it matters here only because it keeps the rail ends from poking
	// out past the stile faces.
	group.add(box(mats.sash, -x1, -dx, -y1, y1, -z1, z1));
	group.add(box(mats.sash, dx, x1, -y1, y1, -z1, z1));
	group.add(box(mats.sash, -dx, dx, dy, y1, -z1, z1));
	group.add(box(mats.sash, -dx, dx, -y1, -dy, -z1, z1));

	if (dx > 0 && dy > 0)
	{
		var gz = s.glassThickness / 2;
		// A shade larger than the daylight opening, so the pane is rebated behind
		// the sash rather than butting it edge to edge - a butt joint there leaves
		// a hairline of whatever is behind the window showing at glancing angles.
		var pane = new Mesh(boxGeometryFor(mats.glass, (dx + 0.2) * 2, (dy + 0.2) * 2, s.glassThickness), mats.glass);
		pane.name = 'sash-glass';
		group.add(pane);

		var bz = gz + s.barProud;
		grilleBars(dx * 2, dy * 2, s.grille).forEach(function (bar)
		{
			var half = s.bar / 2;
			if (bar.vertical)
			{
				group.add(box(mats.grille, bar.pos - half, bar.pos + half, bar.from, bar.to, -bz, bz));
			}
			else
			{
				group.add(box(mats.grille, bar.from, bar.to, bar.pos - half, bar.pos + half, -bz, bz));
			}
		});
	}

	return group;
}

/**
 * How a leaf is divided, by style name.
 *
 * `rows x cols` LIGHTS, not bars. The names are the ones a schedule uses, which
 * is deliberate: "six-panel" is one thing a joiner recognises, where
 * `{rows: 3, cols: 2}` is two numbers a user has to be taught to combine. The
 * pair is derived here so the spec carries the word.
 */
/** @type {Record<string, {rows: number, cols: number}>} */
const LEAF_PANELS = {
	'two-panel': {rows: 2, cols: 1},
	'six-panel': {rows: 3, cols: 2},
};

/**
 * A door leaf: flush, panelled, or glazed.
 *
 * Shared with the window for one reason - a **glazed leaf is a sash**. A french
 * door and a patio slider are stiles, rails, one pane and whatever grille the
 * spec asks for, at door scale, which is exactly `buildSash`. ROADMAP.md phase 5
 * asks for "one opening builder, not two" and this is where the second copy
 * would otherwise have been written.
 *
 * The panelled case is the same joint with a solid panel instead of glass, and
 * it carries the trap `docs/generated-items.md` names twice:
 *
 *   - **A solid swallows anything put inside it.** A panel flush with the stiles
 *     is a panel nobody can see. It is set back from the leaf faces and stands
 *     as its own box, so the shadow line reads.
 *   - **Two coplanar faces z-fight, and it reads as geometry.** The panel is
 *     thinner than the leaf and centred in it, and it is held a hair inside the
 *     opening it sits in on every axis, so no face of it shares a plane with any
 *     face of the frame around it.
 *
 * Built centred on its own origin, so a caller can hang it off a pivot, slide it
 * along a track or fold it against its neighbour without knowing which style it
 * asked for.
 *
 * @param {{leaf: import('three').Material, glass: import('three').Material,
 *          grille: import('three').Material}} mats
 * @param {{width: number, height: number, thickness: number, style?: string,
 *          stile: number, bottomRail?: number, panelThickness?: number,
 *          glassThickness?: number, bar?: number, barProud?: number,
 *          grille?: Object, name?: string}} s
 * @returns {Group}
 */
export function buildLeaf(mats, s)
{
	var style = s.style || 'flush';
	var x1 = s.width / 2;
	var y1 = s.height / 2;
	var z1 = s.thickness / 2;

	if (style === 'glazed')
	{
		return buildSash({sash: mats.leaf, glass: mats.glass, grille: mats.grille}, {
			width: s.width, height: s.height, face: s.stile, thickness: s.thickness,
			glassThickness: s.glassThickness || 1.8, bar: s.bar || 1.9,
			barProud: s.barProud || 0.5, grille: s.grille, name: s.name,
		});
	}

	var group = new Group();
	group.name = s.name || 'leaf';

	var divide = LEAF_PANELS[style];
	if (!divide)
	{
		// Flush: one slab, which is what a hollow-core door is.
		group.add(box(mats.leaf, -x1, x1, -y1, y1, -z1, z1));
		return group;
	}

	// A door's bottom rail is deeper than its top rail - about 8in against 5in -
	// and getting that wrong is the difference between a door and a cupboard
	// front. So the lights are laid out between the rails rather than by dividing
	// the leaf evenly, and the bottom light is the one that loses the extra.
	var bottomRail = s.bottomRail || s.stile * 1.6;
	var panelThickness = s.panelThickness || s.thickness * 0.45;
	var pz = panelThickness / 2;
	var inner = {x0: -x1 + s.stile, x1: x1 - s.stile, y0: -y1 + bottomRail, y1: y1 - s.stile};
	// A hair inside the opening on every axis, so no panel face is coplanar with
	// the stile, rail or leaf face it meets.
	var nudge = 0.1;

	// Stiles full height, rails between them: the joint a door is actually made
	// with, and it keeps the rail ends from poking past the stile faces.
	group.add(box(mats.leaf, -x1, inner.x0, -y1, y1, -z1, z1));
	group.add(box(mats.leaf, inner.x1, x1, -y1, y1, -z1, z1));
	group.add(box(mats.leaf, inner.x0, inner.x1, inner.y1, y1, -z1, z1));
	group.add(box(mats.leaf, inner.x0, inner.x1, -y1, inner.y0, -z1, z1));

	var stepY = (inner.y1 - inner.y0) / divide.rows;
	var stepX = (inner.x1 - inner.x0) / divide.cols;
	var r, c;
	// The muntin bars between the lights, in the leaf's own thickness.
	for (r = 1; r < divide.rows; r++)
	{
		group.add(box(mats.leaf, inner.x0, inner.x1,
			inner.y0 + r * stepY - s.stile / 2, inner.y0 + r * stepY + s.stile / 2, -z1, z1));
	}
	for (c = 1; c < divide.cols; c++)
	{
		group.add(box(mats.leaf, inner.x0 + c * stepX - s.stile / 2, inner.x0 + c * stepX + s.stile / 2,
			inner.y0, inner.y1, -z1, z1));
	}

	for (r = 0; r < divide.rows; r++)
	{
		for (c = 0; c < divide.cols; c++)
		{
			var px0 = inner.x0 + c * stepX + (c === 0 ? 0 : s.stile / 2) + nudge;
			var px1 = inner.x0 + (c + 1) * stepX - (c === divide.cols - 1 ? 0 : s.stile / 2) - nudge;
			var py0 = inner.y0 + r * stepY + (r === 0 ? 0 : s.stile / 2) + nudge;
			var py1 = inner.y0 + (r + 1) * stepY - (r === divide.rows - 1 ? 0 : s.stile / 2) - nudge;
			if (px1 > px0 && py1 > py0)
			{
				group.add(box(mats.leaf, px0, px1, py0, py1, -pz, pz));
			}
		}
	}

	return group;
}

/**
 * Put a build's origin back at the centre of its own geometry.
 *
 * `Item`'s constructor recentres geometry on its bounding box in all three axes
 * and does **not** recentre children (`items/item.js:198`), so a builder whose
 * geometry is not already centred has its frame moved out from under its leaf by
 * half the item. `docs/generated-items.md` rule 2 says "build centred", and for
 * a symmetric lining that is free.
 *
 * A barn door is the case where it is not. Its track runs a full leaf width past
 * one jamb and stops at the other, because that is the wall a barn door needs -
 * so the honest geometry is asymmetric and the origin has to be moved to it
 * rather than the geometry moved to the origin.
 *
 * Applied to the geometry AND every child together, which is the whole point:
 * doing it to one of them is the bug.
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {Array<import('three').Object3D>} parts
 */
export function recentre(geometry, parts)
{
	geometry.computeBoundingBox();
	var boxOf = geometry.boundingBox;
	if (!boxOf)
	{
		return;
	}
	var cx = (boxOf.min.x + boxOf.max.x) / 2;
	var cy = (boxOf.min.y + boxOf.max.y) / 2;
	var cz = (boxOf.min.z + boxOf.max.z) / 2;
	// Float32 positions cannot resolve an exact zero on a 200cm extent, so a
	// symmetric build lands a few microns off and moving it is noise.
	if (Math.abs(cx) < 1e-4 && Math.abs(cy) < 1e-4 && Math.abs(cz) < 1e-4)
	{
		return;
	}
	geometry.translate(-cx, -cy, -cz);
	parts.forEach(function (part)
	{
		part.position.set(part.position.x - cx, part.position.y - cy, part.position.z - cz);
	});
}
