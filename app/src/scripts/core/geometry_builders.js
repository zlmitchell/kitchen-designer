// @ts-check
import {BoxGeometry, BufferAttribute, BufferGeometry, ShapeUtils, Vector2} from 'three';

/**
 * The hand-built meshes this app makes, as BufferGeometry.
 *
 * Added in sprint S4. `Geometry` and `Face3` were removed from three in r125,
 * and five places in this codebase built meshes the same way with them: push
 * some vertices, then push `Face3(0, i-1, i)` for each one after the second -
 * a triangle fan from the first vertex. Two of those five were quads, which is
 * just a four-point fan.
 *
 * Collecting it here means the fan is written once and the winding order is
 * decided in one place. That order is load-bearing: these meshes are
 * single-sided in places, and reversing a triangle turns a wall filler
 * invisible from the side it is meant to be seen from.
 *
 * The output is indexed, which the legacy path effectively was too - `Geometry`
 * shared its vertex list across faces in exactly the same way.
 */

/**
 * A triangle fan over `points`, wound `(0, i-1, i)`.
 *
 * Reproduces the legacy `Face3(0, i-1, i)` loop exactly, including for the
 * four-point quad case, where it yields `(0,1,2)` and `(0,2,3)` - the same two
 * triangles the old code pushed by hand.
 *
 * @param {import('three').Vector3[]} points Fan vertices, in order. Fewer than three yields an
 *   empty (but valid) geometry rather than throwing, matching the legacy code's
 *   tolerance for degenerate rooms mid-edit.
 * @returns {BufferGeometry} Indexed, with a `position` attribute and nothing else.
 */
export function triangleFanGeometry(points)
{
	var geometry = new BufferGeometry();
	var positions = new Float32Array(points.length * 3);

	points.forEach(function (point, i)
	{
		positions[i * 3] = point.x;
		positions[i * 3 + 1] = point.y;
		positions[i * 3 + 2] = point.z;
	});
	geometry.setAttribute('position', new BufferAttribute(positions, 3));

	var index = [];
	for (var i = 2; i < points.length; i++)
	{
		index.push(0, i - 1, i);
	}
	geometry.setIndex(index);

	return geometry;
}

/**
 * A polygon, triangulated properly, keeping each vertex's own height.
 *
 * triangleFanGeometry() fans from vertex 0, which is correct only for a CONVEX
 * outline. A room in a real floor plan is rarely convex -- the kitchen and
 * great room on the plan this was written against form one 421 sqft space with
 * 14 corners, 8 of them reflex -- and a fan across a reflex corner lays
 * triangles outside the polygon. On screen that is a large flat wedge hanging
 * across the room at ceiling height, which is what "roofs look weird" in
 * floor.js was describing.
 *
 * Earcut, via ShapeUtils, handles a concave outline. It is given the footprint
 * in 2D and returns indices into that same vertex list, so the 3D points keep
 * their individual Y and a ceiling that steps in height still works.
 *
 * @param {Array<{x: number, y: number, z: number}>} points outline, in order
 * @returns {BufferGeometry}
 */
export function polygonGeometry(points)
{
	var geometry = new BufferGeometry();
	var positions = new Float32Array(points.length * 3);

	points.forEach(function (point, i)
	{
		positions[i * 3] = point.x;
		positions[i * 3 + 1] = point.y;
		positions[i * 3 + 2] = point.z;
	});
	geometry.setAttribute('position', new BufferAttribute(positions, 3));

	// Triangulated on the FOOTPRINT: x and z, the two axes a plan is drawn in.
	// Height is the axis being ignored on purpose, so a sloped or stepped
	// ceiling triangulates the same way a flat one does.
	var footprint = points.map(function (point)
	{
		return new Vector2(point.x, point.z);
	});
	var faces = ShapeUtils.triangulateShape(footprint, []);

	var index = [];
	faces.forEach(function (face)
	{
		index.push(face[0], face[1], face[2]);
	});
	// A degenerate outline triangulates to nothing. Falling back to the fan
	// keeps the old behaviour rather than returning an empty mesh.
	geometry.setIndex(index.length ? index : fanIndex(points.length));
	geometry.computeVertexNormals();
	return geometry;
}


function fanIndex(count)
{
	var index = [];
	for (var i = 2; i < count; i++)
	{
		index.push(0, i - 1, i);
	}
	return index;
}


/**
 * The normal of a geometry's first triangle.
 *
 * `Geometry.computeFaceNormals()` stored a normal per face and one caller reads
 * it - `WallItem.placeInRoom` takes the wall plane's first face normal to work
 * out which way the item should face. BufferGeometry has no per-face normals,
 * so the value is computed on demand from the position attribute instead.
 *
 * @param {BufferGeometry} geometry Must be indexed and hold at least one triangle.
 * @returns {import('three').Vector3} Unit normal, or a zero vector for a degenerate triangle.
 */
export function firstFaceNormal(geometry, target)
{
	var index = geometry.getIndex();
	var position = geometry.getAttribute('position');
	var a = index ? index.getX(0) : 0;
	var b = index ? index.getX(1) : 1;
	var c = index ? index.getX(2) : 2;

	var ax = position.getX(a), ay = position.getY(a), az = position.getZ(a);
	var ux = position.getX(b) - ax, uy = position.getY(b) - ay, uz = position.getZ(b) - az;
	var vx = position.getX(c) - ax, vy = position.getY(c) - ay, vz = position.getZ(c) - az;

	target.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
	// A zero-length cross product means the triangle is degenerate; normalize()
	// would divide by zero, and three's own Triangle.getNormal returns zero here.
	if (target.lengthSq() > 0)
	{
		target.normalize();
	}
	return target;
}

/**
 * Every triangle of an indexed or non-indexed geometry, as vertex index triples.
 *
 * Replaces iteration over `Geometry.faces`; `RoofItem.roofContainsPoint` walks
 * a roof mesh triangle by triangle to find the ceiling above an item.
 *
 * @param {BufferGeometry} geometry Any triangle-list geometry.
 * @returns {number[][]} One `[a, b, c]` per triangle.
 */
export function faceIndices(geometry)
{
	var index = geometry.getIndex();
	var count = index ? index.count : geometry.getAttribute('position').count;
	var faces = [];

	for (var i = 0; i < count; i += 3)
	{
		faces.push(index
			? [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
			: [i, i + 1, i + 2]);
	}
	return faces;
}


/**
 * How a box's six faces map onto its three dimensions.
 *
 * three builds them in this order, four vertices each, and each face's UVs span
 * 0..1 whatever size the face is - which is exactly the problem: a 12ft counter
 * run and a 24in door both get one repeat, so the same walnut comes out with a
 * grain six times coarser on one than the other.
 *
 * The pair is (what u runs along, what v runs along), read out of three's own
 * `buildPlane` calls in BoxGeometry.
 */
const BOX_FACE_SPANS = [
	['depth', 'height'],  // +X
	['depth', 'height'],  // -X
	['width', 'depth'],   // +Y
	['width', 'depth'],   // -Y
	['width', 'height'],  // +Z
	['width', 'height'],  // -Z
];

/**
 * Rewrite a box's UVs so one repeat covers `tile` centimetres of real surface.
 *
 * ## Why the UVs and not `Texture.repeat`
 *
 * `repeat` lives on the texture, and `mergeMeshes` pools materials by name so a
 * cabinet draws one material per slot - a door and a side panel finished in the
 * same walnut are one material and one draw call. Setting `repeat` per panel
 * would mean a material per panel, which gives that up for something the UVs can
 * express for free. Baking it here also means the scale is fixed at build time,
 * where the panel's real size is known and nothing downstream has to be told.
 *
 * A no-op without a tile size, so an unmapped material - which is most of the
 * library - pays nothing and keeps the 0..1 UVs it had.
 *
 * @param {BufferGeometry} geometry A `BoxGeometry`, unsegmented.
 * @param {number} width
 * @param {number} height
 * @param {number} depth Centimetres, matching the model's units.
 * @param {number} [tile] Centimetres one repeat covers. Zero or absent: no-op.
 * @returns {BufferGeometry} The same geometry, for chaining.
 */
export function scaleBoxUVs(geometry, width, height, depth, tile)
{
	var uv = geometry && geometry.attributes ? geometry.attributes.uv : null;
	// 24 is the unsegmented box - six faces of four. A segmented one has a
	// different layout and this would silently scramble it, so it is left alone.
	if (!tile || tile <= 0 || !uv || uv.count !== 24)
	{
		return geometry;
	}

	var spans = {width: width, height: height, depth: depth};
	for (var face = 0; face < 6; face++)
	{
		var u = Math.abs(spans[BOX_FACE_SPANS[face][0]]) / tile;
		var v = Math.abs(spans[BOX_FACE_SPANS[face][1]]) / tile;
		for (var corner = 0; corner < 4; corner++)
		{
			var i = face * 4 + corner;
			uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
		}
	}
	uv.needsUpdate = true;
	return geometry;
}

/**
 * A box sized in centimetres, with its UVs already scaled to its material.
 *
 * The five generated builders each had their own `box()` helper wrapping
 * `new BoxGeometry(...)`, and every one of them needs the same UV pass now that
 * a material can carry a picture. This is that pass, written once, reading the
 * tile size off the material the panel is about to be given - see
 * `core/materials.js`, which puts it there.
 *
 * @param {?Object} material Anything with `userData.tile`, or null.
 * @param {number} width
 * @param {number} height
 * @param {number} depth
 * @returns {BufferGeometry}
 */
export function boxGeometryFor(material, width, height, depth)
{
	var geometry = new BoxGeometry(width, height, depth);
	var tile = (material && material.userData) ? material.userData.tile : 0;
	return scaleBoxUVs(geometry, width, height, depth, tile);
}
