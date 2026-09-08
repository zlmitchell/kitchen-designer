// @ts-check
import {Group, Mesh} from 'three';
import {CylinderGeometry} from 'three';
import {mergeMeshes} from '../../core/geometry_merge.js';
import {materialsForSlots} from '../../core/materials.js';
import {KELVIN_OPTIONS, MOUNTS, MOUNT_DEFAULTS, THROWS} from '../../model/light.js';

/**
 * A light fitting you can see, click and drag.
 *
 * ## Why this exists, when `lights: []` already worked
 *
 * Because a fixture in the document's top-level `lights: []` block is a
 * POSITION and a temperature, and nothing else. It has no geometry, so there is
 * nothing in the 3D view to click and nothing in the plan to draw - the light
 * worked and was, as far as the interface was concerned, invisible. You could
 * place one from a script and never find it again.
 *
 * The nesting path `model/light.js` was built around is the answer, and this is
 * the object that uses it: **an item that carries a fixture**. Being an item, it
 * is selected, dragged, duplicated, deleted, saved and inspected by machinery
 * that already exists and that nothing here has to know about. Being a `RoofItem`
 * (type 4), it snaps itself to the ceiling plane, which is where a can goes.
 *
 * ## The spec IS the fixture
 *
 * `fixturesOn` reads this builder's spec directly rather than looking for a
 * separate `metadata.fixtures` block. One object, one schema, one panel - and
 * `SpecInspector` therefore edits the colour temperature and the output of a
 * real lamp with no new UI at all, because it renders whatever schema a builder
 * exports.
 *
 * A fan's light kit is the other case and keeps `metadata.fixtures`: there, the
 * fixture belongs to an object that is not itself a light.
 *
 * ## What the geometry is, and what it is not
 *
 * The trim you can see and nothing behind it. A recessed can is a ring and a
 * lens sitting in a hole in the ceiling; the housing above the plasterboard is
 * not in the room and drawing it would put a cylinder through the ceiling in
 * every section view. A surface fitting is a shallow drum, and a pendant is a
 * shade on a cord - the cord is what carries `drop`, which is the one dimension
 * a pendant has that the others do not.
 */

/** Millwork sizes, in centimetres. */
const DEFAULTS = {
	/** Trim diameter. 4in, the common downlight. */
	diameter: 10.16,
	/** How deep the visible trim is. */
	depth: 2.2,
	/** How far a pendant hangs below the ceiling. */
	drop: 45,
	/**
	 * How long a strip is, in centimetres.
	 *
	 * Read from `MOUNT_DEFAULTS` rather than written again, because this is the
	 * ONE number the drawn bar and the emitters under it have to agree on:
	 * `emittersFor` spreads its row of sources over `fixture.length`, and the
	 * record and the spec are the same object for a fitting. A second 60 here
	 * would be a second 60 to keep in step.
	 */
	length: MOUNT_DEFAULTS['under-cabinet'].length,
	mount: 'recessed',
	kind: 'fixture',
};

/**
 * What each slot is made of unless the spec says otherwise.
 *
 * `lens` is separate from `trim` because it is the part that lights up: when the
 * fixture is on, `three/fixtures.js` makes the brightest slot emissive, and a
 * lamp whose whole body glows reads as a bug rather than as a light.
 */
const SLOTS = {
	trim: 'metal-brushed-nickel',
	lens: 'paint-white',
	cord: 'metal-matte-black',
};

/**
 * @typedef {Object} FixtureSpec
 * @property {string} [mount] `recessed | surface | pendant | rod | wall |
 *           under-cabinet | in-cabinet | toe-kick`. Drives both the geometry
 *           here and the emitter in `three/fixtures.js`.
 * @property {string} [throw] `down | up | both | diffuse`.
 * @property {number} [kelvin]
 * @property {number} [lumens]
 * @property {number} [beamAngle]
 * @property {boolean} [on]
 * @property {number} [diameter]
 * @property {number} [drop] Pendant only.
 */

/** A disc, as a very short cylinder. */
function disc(material, radius, height, y)
{
	var mesh = new Mesh(new CylinderGeometry(radius, radius, height, 24), material);
	mesh.position.y = y;
	return mesh;
}

/** A ring, as an open-ended cylinder. */
function ring(material, radius, height, y)
{
	var mesh = new Mesh(new CylinderGeometry(radius, radius, height, 24, 1, true), material);
	mesh.position.y = y;
	return mesh;
}

/**
 * How far a sconce of this trim size stands off the wall it is on.
 *
 * Exported because a caller has to place the item before the item exists: a wall
 * fixture's back has to land ON the wall face, and the only way to work out
 * where its middle goes is to know how deep it is. `tools/fitout.py` does that
 * arithmetic, the same way it already does a cabinet's.
 *
 * @param {number} diameter
 * @returns {number}
 */
export function sconceProjection(diameter)
{
	return Math.max(6, diameter) + 2;
}

/**
 * A sconce: a backplate on the wall, and a shade standing off it.
 *
 * Built with the WALL at local z = 0 and everything projecting to +z, because
 * that is the direction `WallItem.changeWallEdge` points local +z in - it sets
 * `rotation.y` from the half edge's plane normal, which faces into the room.
 * `Item` recentres what comes back, so the caller places the middle and this
 * only has to be self-consistent.
 *
 * It throws up AND down, which is what `MOUNT_DEFAULTS.wall` already said a
 * sconce does - so the lit surfaces are the two open ends of the shade rather
 * than a lens on one face. Until this existed the `wall` mount fell through to
 * the recessed branch and built a 1cm disc lying flat: a light that worked, in a
 * fitting nobody could see, on the one mount that is always at eye level.
 */
function sconce(group, s, mats)
{
	var radius = Math.max(3, s.diameter / 2);
	var projection = sconceProjection(s.diameter);
	// The shade is as deep as it is wide, and its far face is the projection.
	var middle = projection - radius;

	var plate = new Mesh(new CylinderGeometry(radius * 0.5, radius * 0.5, 1.6, 20), mats.trim);
	plate.rotation.x = Math.PI / 2;
	plate.position.z = 0.8;
	group.add(plate);

	var arm = new Mesh(new CylinderGeometry(1.1, 1.1, Math.max(1, middle), 12), mats.trim);
	arm.rotation.x = Math.PI / 2;
	arm.position.z = middle / 2;
	group.add(arm);

	// Open-ended, and wider at the top: the shape of a shade, and the reason
	// light leaves at both ends of it.
	var shade = new Mesh(
		new CylinderGeometry(radius, radius * 0.72, radius * 1.4, 24, 1, true), mats.trim);
	shade.position.z = middle;
	group.add(shade);

	group.add(lit(mats.lens, radius * 0.92, radius * 0.7, middle));
	group.add(lit(mats.lens, radius * 0.66, -(radius * 0.7), middle));
}

/** A lit disc inside the shade, at a height and standing off the wall. */
function lit(material, radius, y, z)
{
	var mesh = new Mesh(new CylinderGeometry(radius, radius, 0.6, 24), material);
	mesh.position.set(0, y, z);
	return mesh;
}

/**
 * Build a fitting.
 *
 * The origin is the CEILING PLANE, and everything hangs below it. That is what
 * lets `RoofItem` do its job without this knowing anything about ceilings: the
 * item is snapped so its top sits on the plane, and a can whose origin was its
 * own middle would sink half its depth into the plasterboard.
 *
 * The `wall` mount is the one exception, because its mounting surface is not the
 * ceiling: it builds from the WALL at local z = 0 and projects into the room.
 * See `sconce`.
 *
 * @param {FixtureSpec} spec
 * @returns {{geometry: Object, materials: Array, parts: Array}}
 */
export function buildFixture(spec)
{
	var s = Object.assign({}, DEFAULTS, spec || {});
	var mats = materialsForSlots(s.material, SLOTS);
	var radius = Math.max(2, s.diameter / 2);
	var group = new Group();

	if (s.mount === 'pendant' || s.mount === 'rod') {
		// A cord and a shade. The shade is a cone in life and a tapered cylinder
		// here, which at the size a pendant is looked at is the same thing.
		var drop = Math.max(5, s.drop);
		group.add(ring(mats.cord, 0.5, drop, -drop / 2));
		var shade = new Mesh(
			new CylinderGeometry(radius * 0.45, radius, radius * 1.1, 24, 1, true), mats.trim);
		shade.position.y = -drop - radius * 0.55;
		group.add(shade);
		// The lit surface, set up inside the shade so it is seen from below and
		// not as a disc floating under it.
		group.add(disc(mats.lens, radius * 0.9, 0.6, -drop - radius * 1.0));
	}
	else if (s.mount === 'surface' || s.mount === 'in-cabinet') {
		// A shallow drum against the surface.
		group.add(ring(mats.trim, radius, s.depth * 2, -s.depth));
		group.add(disc(mats.lens, radius * 0.94, 0.6, -s.depth * 2 + 0.3));
	}
	else if (s.mount === 'wall') {
		sconce(group, s, mats);
	}
	else if (s.mount === 'under-cabinet' || s.mount === 'toe-kick') {
		// A strip. Rectangular in life; a long shallow bar is closer than a disc.
		//
		// Off `length`, and this is the field the strip is actually specified by.
		// It was drawn from `diameter * 6`, which is a trim size and means nothing
		// on a strip - and because `emittersFor` spreads its sources over `length`
		// instead, the bar you could see and the light it cast were two different
		// fixtures. They agreed only because 4in of trim happens to be 61cm times
		// six, so the default looked right and every other value did not: a 20cm
		// trim size drew a 120cm bar lighting 60cm of worktop.
		var length = Math.max(10, s.length);
		var bar = new Mesh(new CylinderGeometry(1.6, 1.6, length, 12), mats.trim);
		bar.rotation.z = Math.PI / 2;
		bar.position.y = -1.6;
		group.add(bar);
	}
	else {
		// Recessed, and everything unrecognised.
		//
		// A shallow FLANGE, not a drum. The first pass used the full 2.2cm trim
		// depth and rendered as a cylinder stuck to the underside of the ceiling -
		// which is a surface fitting, the very thing the next branch up already is.
		// What is recessed about a recessed can is that almost nothing of it is in
		// the room: a ring you could cover with a coin, and a lens set back inside
		// it so the fitting reads as a hole with a light in it.
		var flange = Math.min(s.depth, 1.0);
		group.add(ring(mats.trim, radius, flange, -flange / 2));
		group.add(disc(mats.lens, radius * 0.86, 0.5, -flange * 0.35));
	}

	var merged = mergeMeshes(group);
	return {geometry: merged.geometry, materials: merged.materials, parts: []};
}

/**
 * What a panel may ask about a fitting.
 *
 * The light's own fields and the fitting's, in one list, because they are one
 * object - which is the whole point of the spec being the fixture. Changing the
 * colour temperature here goes through `Item.setSpec` like any other spec edit,
 * and `Main.syncFixtures` rebuilds the emitter from it.
 */
export const FIXTURE_ITEM_SCHEMA = {
	label: 'Light',
	slots: SLOTS,
	fields: [
		{key: 'on', label: 'Switched', type: 'choice', shared: true, options: [
			{value: true, label: 'On'},
			{value: false, label: 'Off'},
		]},
		{key: 'mount', label: 'Mount', type: 'choice', options: MOUNTS.map(function (mount)
		{
			return {value: mount, label: mount.replace(/-/g, ' ').replace(/^./, function (c)
			{
				return c.toUpperCase();
			})};
		})},
		{key: 'throw', label: 'Throws', type: 'choice', options: THROWS.map(function (way)
		{
			return {value: way, label: way === 'diffuse' ? 'All round'
				: way.replace(/^./, function (c) {return c.toUpperCase();})};
		})},
		{key: 'kelvin', label: 'Colour', type: 'choice', shared: true, options: KELVIN_OPTIONS},
		{key: 'lumens', label: 'Output', type: 'fraction', shared: true,
			min: 0, max: 3000, step: 50},
		{key: 'beamAngle', label: 'Beam', type: 'fraction', min: 10, max: 179, step: 5,
			when: {throw: ['down', 'up', 'both']}},
		{key: 'castShadow', label: 'Casts shadow', type: 'choice', options: [
			{value: false, label: 'No'},
			{value: true, label: 'Yes'},
		]},
		// A strip has no trim diameter and every other mount has no length, so the
		// two are asked in each other's place. `unless` and not `when` for the
		// diameter, because a spec is allowed to leave `mount` out entirely and
		// `when` cannot tell "not a strip" from "not mentioned" - the trap
		// SpecInspector documents, which cost a window its size fields.
		{key: 'diameter', label: 'Trim size', type: 'length', min: 4, max: 60, step: 0.5,
			unless: {mount: ['under-cabinet', 'toe-kick']}},
		{key: 'length', label: 'Length', type: 'length', min: 10, max: 300, step: 5,
			when: {mount: ['under-cabinet', 'toe-kick']}},
		{key: 'drop', label: 'Drop', type: 'length', min: 5, max: 200, step: 1,
			when: {mount: ['pendant', 'rod']}},
		{key: 'material.trim', label: 'Trim', type: 'material', shared: true, group: 'metal'},
	],
};
