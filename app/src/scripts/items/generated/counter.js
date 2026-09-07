// @ts-check
import {Box3, BoxGeometry, ExtrudeGeometry, Group, Mesh, Path, Shape, Vector3} from 'three';
import {mergeMeshes} from '../../core/geometry_merge.js';
import {materialsForSlots} from '../../core/materials.js';

/**
 * A countertop: a slab with holes in it.
 *
 * ## Why this is not part of a cabinet
 *
 * Because a run of six cabinets has ONE counter across all of them, and the
 * seam is the whole point - a counter that stopped at every cabinet would read
 * as six counters. So a cabinet does not draw its own top, and this is its own
 * kind.
 *
 * ## Holes, without a CSG library
 *
 * `THREE.Shape` takes `holes`, and `ExtrudeGeometry` triangulates the outline
 * and its holes together and walls both. That is a sink cutout, a hob cutout and
 * a tap hole, natively, with no boolean geometry and no dependency.
 *
 * It also gives the thing an undermount sink needs: the cut edge is a real
 * surface with the slab's thickness, because extruding walls the holes as well
 * as the outline. A cutout made by hiding triangles would show paper.
 *
 * ## The edge profile is the bevel
 *
 * `square`, `eased` and `bullnose` are one parameter - `bevelSize` - rather than
 * three profiles. Which is also why the outline is inset by that size first: a
 * bevel grows the shape outward, so a 96in top asked for with a bullnose would
 * come out 96in plus two bevels wide, and the number you typed would not be the
 * number you got.
 *
 * ## Where it sits
 *
 * Type 0, an "anywhere" item, because `Item._freePosition` is true only there -
 * every floor-bound class pins the bottom of the bounds to the floor, and a
 * counter's bottom belongs at 34.5in. The empty space under it is not geometry
 * and cannot be carried in a bounding box, which is the same wall `floatHeight`
 * ran into on the cabinet. Phase 3's run is what will place this at cabinet
 * height without anybody dragging it.
 */

const SLOTS = {
	counter: 'stone-quartz-white',
	splash: 'stone-quartz-white',
};

const DEFAULTS = {
	/** 8ft, the length a slab comes in. */
	width: 243.84,
	/** 25in: a 24in cabinet plus a 1in overhang at the front. */
	depth: 63.5,
	/** 1.5in, which is what makes a 34.5in cabinet a 36in work surface. */
	thickness: 3.81,
	/** `square`, `eased` or `bullnose`. */
	edge: 'eased',
	/** 4in, the standard. 0 for none. */
	backsplash: 10.16,
	/** Rectangular holes, centre-relative, in cm. See `cutouts` below. */
	cutouts: [],
};

/**
 * @typedef {Object} CounterCutout
 * @property {number} x Centre of the hole along the counter, from its middle.
 * @property {number} [z] Centre front-to-back, from the middle. 0 is centred,
 *           which is where a sink goes; a hob usually sits forward.
 * @property {number} width
 * @property {number} depth Front to back.
 */
/**
 * @typedef {Object} CounterSpec
 * @property {number} [width] @property {number} [depth] @property {number} [thickness]
 * @property {('square'|'eased'|'bullnose')} [edge]
 * @property {number} [backsplash]
 * @property {Array<CounterCutout>} [cutouts]
 * @property {Object} [material]
 */

/** How far the profile eats into the slab's edge, in cm. */
function bevelFor(edge, thickness)
{
	if (edge === 'bullnose')
	{
		// Half the thickness each way is a full round-over, which is what a
		// bullnose is.
		return thickness * 0.45;
	}
	if (edge === 'square')
	{
		return 0;
	}
	// Eased: barely there, and the point of it. A truly square arris looks
	// unfinished and catches every highlight along its length.
	return 0.2;
}

/** The slab outline, inset so the bevel does not grow it. */
function slabShape(width, depth, inset, cutouts)
{
	var halfW = width / 2 - inset;
	var halfD = depth / 2 - inset;
	// No seed points: a Shape's constructor takes Vector2, and the outline is
	// drawn with moveTo/lineTo immediately below anyway.
	var shape = new Shape();
	shape.moveTo(-halfW, -halfD);
	shape.lineTo(halfW, -halfD);
	shape.lineTo(halfW, halfD);
	shape.lineTo(-halfW, halfD);
	shape.closePath();

	(cutouts || []).forEach(function (cut)
	{
		// Not clamped up to a minimum: that turned a 2mm request into a 1cm hole,
		// which is inventing a cutout rather than declining one. Anything under a
		// centimetre is rejected below instead - the smallest real hole in a
		// worktop is a 35mm tap hole.
		var cw = cut.width / 2;
		var cd = cut.depth / 2;
		var cx = cut.x || 0;
		var cz = cut.z || 0;
		// A hole that reaches the outline is not a hole, it is a notch - and
		// `triangulateShape` discards a hole that strays outside its contour
		// rather than clipping it, silently, which is the same trap the wall
		// openings hit. Kept a finger's width inside.
		var margin = 2.0;
		var x0 = Math.max(-halfW + margin, cx - cw);
		var x1 = Math.min(halfW - margin, cx + cw);
		// Negated, because the shape's y becomes the world's -z: rotating by -90
		// about x sends (x, y, z) to (x, z, -y). Without this a cutout asked for
		// toward the front came out toward the back, which is invisible on a sink
		// centred front-to-back and wrong on everything else.
		var z0 = Math.max(-halfD + margin, -cz - cd);
		var z1 = Math.min(halfD - margin, -cz + cd);
		if (x1 - x0 < 1 || z1 - z0 < 1)
		{
			return;
		}
		var hole = new Path();
		hole.moveTo(x0, z0);
		hole.lineTo(x1, z0);
		hole.lineTo(x1, z1);
		hole.lineTo(x0, z1);
		hole.closePath();
		shape.holes.push(hole);
	});
	return shape;
}

/** What a panel may ask about a counter. */
export const COUNTER_SCHEMA = {
	label: 'Countertop',
	fields: [
		{key: 'width', label: 'Length', type: 'length', min: 30, max: 400, step: 1},
		{key: 'depth', label: 'Depth', type: 'length', min: 30, max: 120, step: 1},
		{key: 'thickness', label: 'Thickness', type: 'length', min: 1, max: 12, step: 0.1},
		{shared: true, key: 'edge', label: 'Edge', type: 'choice', options: [
			{value: 'square', label: 'Square'},
			{value: 'eased', label: 'Eased'},
			{value: 'bullnose', label: 'Bullnose'},
		]},
		{key: 'backsplash', label: 'Backsplash', type: 'length', min: 0, max: 60, step: 1},
		{shared: true, key: 'material.counter', label: 'Surface', type: 'material'},
		{shared: true, key: 'material.splash', label: 'Backsplash', type: 'material'},
	],
};

/**
 * Build a countertop.
 *
 * @param {CounterSpec} spec
 * @returns {{geometry: import('three').BufferGeometry, materials: Array, parts: Array}}
 */
export function buildCounter(spec)
{
	var s = Object.assign({}, DEFAULTS, spec || {});
	var mats = materialsForSlots(s.material, SLOTS);
	var width = Math.max(5, s.width);
	var depth = Math.max(5, s.depth);
	var thickness = Math.max(0.5, s.thickness);
	var bevel = bevelFor(s.edge, thickness);

	var shape = slabShape(width, depth, bevel, s.cutouts);
	var geometry = new ExtrudeGeometry(shape, {
		depth: Math.max(0.1, thickness - bevel * 2),
		bevelEnabled: bevel > 0,
		bevelThickness: bevel,
		bevelSize: bevel,
		bevelOffset: 0,
		bevelSegments: (s.edge === 'bullnose') ? 4 : 1,
		curveSegments: 8,
	});
	// A Shape is drawn in XY and extruded along Z. A counter lies flat, so the
	// slab is tipped onto its back: rotating by -90 about x sends (x, y, z) to
	// (x, z, -y), so the extrusion becomes the THICKNESS running up in y, and the
	// shape's y becomes the front-to-back run in -z.
	geometry.rotateX(-Math.PI / 2);

	var group = new Group();
	group.add(new Mesh(geometry, mats.counter));

	if (s.backsplash > 0)
	{
		// Against the back edge, standing on the slab. Its own material, because a
		// tiled splash and a stone one are both normal and they are not the same
		// decision as the surface.
		var splashThickness = 1.9;
		var splash = new Mesh(
			new BoxGeometry(width, s.backsplash, splashThickness), mats.splash);
		// ON the slab, not through it. The extrusion runs from y=0 upward, so a
		// splash centred on `backsplash / 2` starts at the slab's underside and
		// passes through it - which measured as a counter 10.36cm tall instead of
		// 13.97 and would have shown as a splash sunk into its own worktop.
		//
		// And at the BACK, which is -z: the cabinet's carcass back is at -z and
		// its face at +z, so this is the edge that meets the wall.
		splash.position.set(0, thickness + s.backsplash / 2,
			-depth / 2 + splashThickness / 2);
		group.add(splash);
	}

	// Centred, like every generated part - and here it also settles where the
	// extrusion put the slab, which is below the shape's plane rather than around
	// it. See docs/generated-items.md rule 2.
	group.updateMatrixWorld(true);
	var middle = new Box3().setFromObject(group).getCenter(new Vector3());
	group.children.forEach(function (child) {child.position.sub(middle);});
	// Again: mergeMeshes recomputes each mesh from its parent's CURRENT world
	// matrix, so a shift after the last update is otherwise ignored.
	group.updateMatrixWorld(true);

	var merged = mergeMeshes(group);
	return {geometry: merged.geometry, materials: merged.materials, parts: []};
}
