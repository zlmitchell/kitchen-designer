// @ts-check
import {CylinderGeometry, Group, Mesh} from 'three';
import {mergeMeshes} from '../../core/geometry_merge.js';
import {materialsForSlots} from '../../core/materials.js';
import {boxGeometryFor} from '../../core/geometry_builders.js';

/**
 * A post: the thing at the open end of a pony wall.
 *
 * ## Why this is not a short wall
 *
 * `README.md` reasoned that architect3d has no column primitive but a wall is
 * 10cm thick by default, so 4in of one is a 4x4 and needs no model and no new
 * concept. What prompted this file was that the second half was not true: grid
 * snapping quantised to a 25cm pitch, so the shortest wall you could drag was
 * 9.84in - "the smallest was 10 inches" - and below 20cm a wall's own two ends
 * FUSED, which does not shorten a wall, it deletes it. Silently. An exported
 * design carried a 0.56cm remnant of one.
 *
 * Both of those are fixed now (`Corner.mergeWithIntersected` will not weld a
 * wall to itself, and snapping reads the visible grid), so a 4in wall is
 * possible. This is still not one, for the reasons that were always the better
 * ones and that no bug fix reaches:
 *
 * A post is not a wall in the ways that matter to the rest of the model.
 * Rooms are found by walking closed loops of walls, so a column standing in open
 * floor is a wall run that goes nowhere and has to be argued out again -
 * `extract.py:600 drop_islands` exists partly for that. And a post has no
 * inside and outside, no items in it, and no need of two half edges.
 *
 * ## What it is instead
 *
 * A `FloorItem` built from a spec, which is the machinery phase 0 put in.
 * Nothing here touches corners, so any size works and nothing can collapse.
 *
 * A post is also a plain box with a size, which is a spec; a wall is a pair of
 * corners with a topology.
 *
 * The trade, stated plainly: a post does not follow a wall when the wall is
 * dragged. It is furniture, and it stays where it was put. For a post that caps
 * a pony wall that is usually right - the wall is not moving - but it is a real
 * difference from the wall-as-post trick and it is why this is worth writing
 * down rather than assuming.
 */

/** What the parts are made of unless the spec says otherwise. */
const SLOTS = {
	post: 'paint-white',
	trim: 'paint-white',
};

const DEFAULTS = {
	/** 4in nominal - actually a 3.5in finished 4x4, but a post cap is usually
	 *  wrapped, so the nominal number is the one somebody types. */
	width: 10.16,
	depth: 10.16,
	/** 42in, which is the pony wall this most often stands at the end of. */
	height: 106.68,
	profile: 'square',
	trim: 'none',
	/** How far a base or cap band stands proud of the shaft. */
	trimProud: 1.6,
	/** How tall those bands are. */
	trimHeight: 8.9,
};

/**
 * @typedef {Object} PostSpec
 * @property {number} [width] Across, in cm. The diameter when round.
 * @property {number} [depth] The other way. Ignored when round.
 * @property {number} [height]
 * @property {('square'|'round')} [profile]
 * @property {('none'|'base'|'both')} [trim] A band at the foot, or at both ends.
 * @property {Object} [material] `post` and `trim` slots.
 */

/** A box or a cylinder of the given footprint, centred at `y`. */
function shaft(mat, profile, width, depth, height, y)
{
	var geometry = (profile === 'round')
		// 24 sides: a 4in post is small on screen and this is already more than
		// the silhouette needs. Cylinders are the one place a generated part is
		// not boxes, and the only reason is that a round post read as an octagon
		// at 8.
		? new CylinderGeometry(width / 2, width / 2, height, 24)
		: boxGeometryFor(mat, width, height, depth);
	var mesh = new Mesh(geometry, mat);
	mesh.position.set(0, y, 0);
	return mesh;
}

/**
 * What a panel may ask about a post.
 *
 * `depth` is hidden for a round post rather than ignored quietly, which is what
 * the schema's `when` is for - a field that does nothing is worse than a field
 * that is not there.
 */
export const POST_SCHEMA = {
	label: 'Post',
	fields: [
		{key: 'profile', label: 'Profile', type: 'choice', options: [
			{value: 'square', label: 'Square'},
			{value: 'round', label: 'Round'},
		]},
		{key: 'width', label: 'Width', type: 'length', min: 2, max: 60, step: 0.5},
		{key: 'depth', label: 'Depth', type: 'length', min: 2, max: 60, step: 0.5,
			when: {profile: 'square'}},
		{key: 'height', label: 'Height', type: 'length', min: 20, max: 400, step: 1},
		{key: 'trim', label: 'Trim', type: 'choice', options: [
			{value: 'none', label: 'Plain'},
			{value: 'base', label: 'Base'},
			{value: 'both', label: 'Base + cap'},
		]},
		{key: 'material.post', label: 'Post', type: 'material'},
		{key: 'material.trim', label: 'Trim', type: 'material', when: {trim: 'base'}},
	],
};

/**
 * Fold a mesh scale into the spec.
 *
 * Only ever needed by a design saved before a generated item's size lived in its
 * spec. The Item panel's width/height/depth fields call `Item.resize`, which
 * SCALES - so a post stretched with them came out drawn at 244cm while its spec
 * still said 106.68, and the two would have multiplied on the next rebuild.
 *
 * Absorbing is exact for a post because its spec fields ARE its bounding box:
 * width is x, height is y, depth is z, with nothing added around them. That is
 * not true of every kind - a door's `width` is the clear opening and its bounds
 * are that plus two jambs - which is why this is declared per builder rather
 * than guessed from the schema.
 *
 * @param {PostSpec} spec
 * @param {{x: number, y: number, z: number}} scale
 * @returns {PostSpec} A new spec; the caller then resets the scale to 1.
 */
buildPost.absorbScale = function (spec, scale)
{
	var s = Object.assign({}, DEFAULTS, spec || {});
	return Object.assign({}, s, {
		width: s.width * scale.x,
		depth: s.depth * scale.z,
		height: s.height * scale.y,
	});
};

/**
 * Build a post.
 *
 * Centred on the origin in all three axes, like every generated part: `Item`'s
 * constructor recentres geometry on its bounding box, so building centred makes
 * that a no-op. `FloorItem` then sets `position.y = halfSize.y`, which stands the
 * base on the floor.
 *
 * Everything is in the item's own geometry rather than in children - a post has
 * no moving parts and nothing that should escape its bounds, which is the exact
 * opposite of a door and worth noticing. `parts` is empty on purpose.
 *
 * @param {PostSpec} spec
 * @returns {{geometry: import('three').BufferGeometry, materials: Array, parts: Array}}
 */
export function buildPost(spec)
{
	var s = Object.assign({}, DEFAULTS, spec || {});
	var mats = materialsForSlots(s.material, SLOTS);
	var width = Math.max(0.5, s.width);
	var depth = (s.profile === 'round') ? width : Math.max(0.5, s.depth);
	var height = Math.max(1, s.height);

	var group = new Group();
	var half = height / 2;

	var hasBase = s.trim === 'base' || s.trim === 'both';
	var hasCap = s.trim === 'both';
	// The shaft runs the full height either way. A band is added around it rather
	// than the shaft being shortened to make room: a post with its trim removed
	// should be the same post, not a shorter one.
	group.add(shaft(mats.post, s.profile, width, depth, height, 0));

	if (hasBase)
	{
		group.add(shaft(mats.trim, s.profile, width + 2 * s.trimProud, depth + 2 * s.trimProud,
			s.trimHeight, -half + s.trimHeight / 2));
	}
	if (hasCap)
	{
		group.add(shaft(mats.trim, s.profile, width + 2 * s.trimProud, depth + 2 * s.trimProud,
			s.trimHeight, half - s.trimHeight / 2));
	}

	var merged = mergeMeshes(group);
	return {geometry: merged.geometry, materials: merged.materials, parts: []};
}
