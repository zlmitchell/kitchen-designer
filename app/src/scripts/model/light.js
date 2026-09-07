// @ts-check

/**
 * A fixture is data.
 *
 * ROADMAP.md phase 6 opens with the reason this file exists: `three/lights.js`
 * is one hemisphere light, one key and one fill, and that is the entire lighting
 * model. Four things in the catalog - `Chandelier`, `Ceilingfan`, `Lampwall`,
 * `Lampsquareceiling` - already *place* correctly and emit nothing, which the
 * audit records as "placement yes, light no".
 *
 * Nothing here imports three. A fixture is a record and the arithmetic on it is
 * pure, so all of it is assertable without a renderer; `three/fixtures.js` turns
 * a record into emitters and is the only file that knows what a `SpotLight` is.
 *
 * ## Two axes, not one enum
 *
 * `mount` is where it is fixed. `throw` is which way the light leaves it. The
 * real fixtures cut across the two - a pendant and a sconce differ only in
 * mount, an uplight sconce and a downlight sconce only in throw - so one `kind`
 * enum would need an entry per combination and would still miss one.
 *
 * `throw` does more work than it looks like it should. Up washes the ceiling and
 * lifts the whole room; down scallops the wall in a cone; both is a shade open
 * at each end. Same fixture, three completely different rooms.
 *
 * ## Nesting is decided here, on day one
 *
 * ROADMAP.md is explicit that this cannot be retrofitted: "a ceiling fan with a
 * light kit is one placed object carrying a fixture, and so is an in-cabinet
 * puck or a range hood's work light... retrofitting nesting later means touching
 * every reader."
 *
 * So a fixture reaches the scene from one of two places, and the difference is
 * **which frame its position is in**:
 *
 * | source | `position` is in | moved by |
 * |---|---|---|
 * | the document's top-level `lights: []` | world centimetres | its own record |
 * | an item's `fixtures: []` | that item's LOCAL frame | dragging the item |
 *
 * The second is why nesting is nearly free downstream: the emitter is added as a
 * child of the item's `Object3D`, so the host's transform carries it exactly the
 * way a door's leaf is carried by the door. The alternative - a world position
 * kept in step with its host by hand - is the bug this shape is chosen to make
 * impossible.
 *
 * `collectFixtures` is the one reader both paths go through.
 */

import {MAX_KELVIN, MIN_KELVIN} from '../core/color_temperature.js';

/**
 * Where a fixture is fixed.
 *
 * `rod` is separate from `pendant` because the difference is rigid versus hung,
 * and it is what a ceiling fan's downrod is; `surface` is a flush ceiling fitting.
 */
export const MOUNTS = ['recessed', 'surface', 'pendant', 'rod', 'wall',
	'under-cabinet', 'in-cabinet', 'toe-kick'];

/** Which way the light leaves it. */
export const THROWS = ['down', 'up', 'both', 'diffuse'];

/**
 * The scene is in centimetres, and physical lights are not.
 *
 * three's point and spot intensities are **candela**, and its `decay: 2` falloff
 * computes illuminance as `I / d²` with `d` in world units. Our world unit is a
 * centimetre, so a light 2.5m up is at `d = 250`, and feeding it a real candela
 * value makes the room 10,000 times too dark - which reads as "the fixture does
 * not work" rather than as a unit error, because a light that is 10,000x too dim
 * is indistinguishable from one that is off.
 *
 * `intensityFor` multiplies by the square of this for that reason, and it is the
 * single place the conversion happens.
 */
export const SCENE_UNITS_PER_METRE = 100;

/**
 * What each mount is, unless the fixture says otherwise.
 *
 * These are the lamps a kitchen actually has, and the numbers are off the
 * packaging: a 4in can is about 800lm at a 60° beam, an under-cabinet strip
 * about 300lm over 2ft, a puck a fraction of that.
 *
 * `castShadow` is per mount rather than global because most of these should
 * never cast. A strip under a wall cabinet is 40cm from the worktop it lights;
 * a shadow map at that range buys nothing and costs a full render of the scene.
 * The shadow budget is the real constraint - see `shadowCasters`.
 *
 * `normalBias` is per mount for the reason phase 6 gives: a sconce is nearly
 * coplanar with the wall it is fixed to, which is the worst case for a shadow
 * map, and the one global 1.5 the studio profile sets is tuned for a key light
 * three metres away.
 *
 * @type {Record<string, Object>}
 */
export const MOUNT_DEFAULTS = {
	'recessed': {throw: 'down', kelvin: 3000, lumens: 800, beamAngle: 60,
		castShadow: true, normalBias: 1.5},
	'surface': {throw: 'diffuse', kelvin: 3000, lumens: 1200, beamAngle: 150,
		castShadow: true, normalBias: 1.5},
	'pendant': {throw: 'down', kelvin: 2700, lumens: 600, beamAngle: 90,
		castShadow: true, normalBias: 1.5},
	'rod': {throw: 'down', kelvin: 2700, lumens: 900, beamAngle: 120,
		castShadow: true, normalBias: 1.5},
	// A sconce sits at eye level on the wall it lights, so it is both the mount
	// most likely to be in frame and the one most likely to shadow-acne.
	'wall': {throw: 'both', kelvin: 2700, lumens: 400, beamAngle: 90,
		castShadow: false, normalBias: 4.0},
	// Strips. A short row of small emitters rather than one point, because a
	// 60cm strip drawn as a single source puts one hard scallop on the splashback
	// where there should be an even wash.
	'under-cabinet': {throw: 'down', kelvin: 3000, lumens: 300, beamAngle: 110,
		castShadow: false, normalBias: 2.0, strip: true, length: 60, segments: 3},
	'in-cabinet': {throw: 'diffuse', kelvin: 2700, lumens: 120, beamAngle: 150,
		castShadow: false, normalBias: 2.0},
	'toe-kick': {throw: 'down', kelvin: 2700, lumens: 150, beamAngle: 140,
		castShadow: false, normalBias: 2.0, strip: true, length: 60, segments: 3},
};

/**
 * The most emitters one strip may become.
 *
 * Each segment is a real light in the scene, and nothing downstream caps how
 * many a single fixture contributes - `shadowCasters` budgets SHADOWS, which is
 * a different and smaller limit. A run long enough to want more than this wants
 * two fittings, which is also how it would be installed.
 */
export const MAX_STRIP_SEGMENTS = 8;

/** What a fixture is when the record says nothing at all. */
const FIXTURE_DEFAULTS = {
	mount: 'recessed',
	kelvin: 2700,
	lumens: 800,
	beamAngle: 60,
	on: true,
	/** A switch bank. Free text, so a design can name its own circuits. */
	group: null,
	/**
	 * Softness of a spot's edge, 0..1. Not per mount: every fixture in a house
	 * has a soft edge, and a hard one reads as a stage light.
	 */
	penumbra: 0.4,
};

function finite(value, fallback)
{
	var n = Number(value);
	return (typeof value !== 'boolean' && isFinite(n)) ? n : fallback;
}

/**
 * A fixture record with every field filled in.
 *
 * Normalising rather than validating, on purpose. An unknown `mount` is a design
 * saved by a later build, and the useful behaviour is a light in roughly the
 * right place rather than an exception - the same tolerance `materialsForSlots`
 * extends to a finish this build has retired, and for the same reason: a saved
 * design outlives the code.
 *
 * @param {Object} raw
 * @param {string} [id] Used when the record carries none.
 * @returns {Object} A complete fixture.
 */
export function normaliseFixture(raw, id)
{
	var given = raw || {};
	var mount = (MOUNTS.indexOf(given.mount) !== -1) ? given.mount : FIXTURE_DEFAULTS.mount;
	var perMount = MOUNT_DEFAULTS[mount] || {};
	var base = Object.assign({}, FIXTURE_DEFAULTS, perMount);

	var out = {
		id: String(given.id || id || 'light'),
		mount: mount,
		throw: (THROWS.indexOf(given.throw) !== -1) ? given.throw : base.throw,
		kelvin: Math.max(MIN_KELVIN, Math.min(MAX_KELVIN, finite(given.kelvin, base.kelvin))),
		lumens: Math.max(0, finite(given.lumens, base.lumens)),
		// A cone wider than 180 degrees is a sphere with extra steps, and three's
		// SpotLight cannot represent one.
		beamAngle: Math.max(1, Math.min(179, finite(given.beamAngle, base.beamAngle))),
		penumbra: Math.max(0, Math.min(1, finite(given.penumbra, base.penumbra))),
		on: (given.on === undefined) ? base.on : Boolean(given.on),
		group: (typeof given.group === 'string' && given.group) ? given.group : null,
		castShadow: (given.castShadow === undefined) ? Boolean(base.castShadow) : Boolean(given.castShadow),
		normalBias: finite(given.normalBias, base.normalBias),
		position: {
			x: finite(given.position && given.position.x, 0),
			y: finite(given.position && given.position.y, 0),
			z: finite(given.position && given.position.z, 0),
		},
		/**
		 * Where a directional throw is aimed, in the same frame as `position`.
		 *
		 * Null means "straight down from where it is", which is what nearly every
		 * fixture does and what nobody should have to write. A target is for the
		 * ones that are aimed: a spot washing a splashback, or art lighting.
		 */
		target: given.target ? {
			x: finite(given.target.x, 0),
			y: finite(given.target.y, 0),
			z: finite(given.target.z, 0),
		} : null,
	};

	if (base.strip)
	{
		out.strip = true;
		out.length = Math.max(1, finite(given.length, base.length));
		// Segments follow the LENGTH when the record does not name them, at the
		// density the mount was written with - three over 60cm, one every 20.
		//
		// A fixed count was right while 60cm was the only length there was. Now
		// that a panel can ask for a 3m run, a fixed three would put the same
		// three sources under it and bring back exactly the scalloping the row of
		// emitters exists to prevent - the fault gets worse the longer the strip,
		// which is the opposite of what somebody lengthening one expects.
		//
		// Capped, because each segment is a real light in the scene and nothing
		// downstream limits how many a fixture may add. Eight over three metres is
		// still one every 37cm, which is under the spacing that reads as even.
		var perSegment = base.length / Math.max(1, base.segments);
		var implied = Math.min(MAX_STRIP_SEGMENTS, Math.round(out.length / perSegment));
		out.segments = Math.max(1, Math.min(MAX_STRIP_SEGMENTS,
			Math.round(finite(given.segments, implied))));
	}
	return out;
}

/**
 * The emitters one fixture is made of, in its own frame.
 *
 * A record is not a light. Three things turn one into more than one, and each of
 * them is a fact about lamps rather than an implementation detail:
 *
 *   - **`both` is two emitters**, not a flag - one up, one down. ROADMAP.md says
 *     so, and the reason is that no single three light points two ways.
 *   - **The lumens are SPLIT between them.** A shade open at both ends is not
 *     twice the lamp; it is the same lamp letting light out of two ends. Given
 *     the full output twice, `throw` would silently double as a brightness
 *     control and comparing an uplight against a downlight would be comparing
 *     two different bulbs.
 *   - **A strip is a row of small emitters** sharing the output, because one
 *     point source under a 60cm strip puts a single hard scallop on the
 *     splashback where there should be an even wash.
 *
 * @param {Object} fixture A normalised fixture.
 * @returns {Array<{dx: number, dy: number, dz: number, aim: number, lumens: number}>}
 *          `aim` is -1 for down and +1 for up; 0 means undirected.
 */
export function emittersFor(fixture)
{
	/** @type {Array<number>} */
	var aims;
	if (fixture.throw === 'both')
	{
		aims = [-1, 1];
	}
	else if (fixture.throw === 'up')
	{
		aims = [1];
	}
	else if (fixture.throw === 'diffuse')
	{
		aims = [0];
	}
	else
	{
		aims = [-1];
	}

	var count = fixture.strip ? Math.max(1, fixture.segments) : 1;
	var share = fixture.lumens / (aims.length * count);
	/** @type {Array<Object>} */
	var out = [];

	aims.forEach(function (aim)
	{
		for (var i = 0; i < count; i++)
		{
			// Spread along the strip's own x, centred. One segment sits at zero,
			// which is what makes a strip and a point the same code path.
			var dx = (count === 1) ? 0
				: (-fixture.length / 2 + fixture.length * (i + 0.5) / count);
			out.push({dx: dx, dy: 0, dz: 0, aim: aim, lumens: share});
		}
	});
	return out;
}

/**
 * Three's intensity for a given output, in this scene's units.
 *
 * Two conversions, and both are places to get it wrong quietly.
 *
 * **Lumens to candela.** Luminous flux spread over a solid angle. A cone of full
 * angle θ subtends `2π(1 − cos(θ/2))` steradians; an undirected source fills
 * `4π`. So a 60° spot and a bare bulb of the same wattage are wildly different
 * intensities, which is the whole reason a beam angle is on the packet.
 *
 * **Candela to world units.** See `SCENE_UNITS_PER_METRE`. three computes
 * `I / d²` with `d` in scene units, and ours are centimetres, so the same
 * physical distance is 100x larger and the illuminance 10,000x smaller. A
 * fixture that looks like it is off is this, every time.
 *
 * @param {number} lumens
 * @param {number} beamAngle Full cone angle in degrees. Ignored when undirected.
 * @param {boolean} [directed] false for a point source filling the sphere.
 * @returns {number} three intensity.
 */
export function intensityFor(lumens, beamAngle, directed)
{
	var steradians;
	if (directed === false)
	{
		steradians = 4 * Math.PI;
	}
	else
	{
		var half = Math.max(1, Math.min(179, beamAngle)) * Math.PI / 360;
		steradians = 2 * Math.PI * (1 - Math.cos(half));
	}
	if (steradians <= 0)
	{
		return 0;
	}
	return (Math.max(0, lumens) / steradians) * SCENE_UNITS_PER_METRE * SCENE_UNITS_PER_METRE;
}

/**
 * Every fixture in a design, from both of the two places one can be.
 *
 * The single reader ROADMAP.md's nesting note is about. A caller gets a flat
 * list and does not have to know which source each came from - only `host` says,
 * and `host` is what the emitter should be added to so the transform is free.
 *
 * @param {Array<Object>} lights The document's top-level `lights: []`.
 * @param {Array<Object>} items Placed items, each possibly carrying `fixtures`.
 * @returns {Array<{fixture: Object, host: ?Object}>} `host` null for a top-level
 *          fixture, whose position is world; otherwise the item whose LOCAL
 *          frame the position is in.
 */
export function collectFixtures(lights, items)
{
	/** @type {Array<{fixture: Object, host: ?Object}>} */
	var out = [];

	(lights || []).forEach(function (raw, index)
	{
		out.push({fixture: normaliseFixture(raw, `light-${index}`), host: null});
	});

	(items || []).forEach(function (item)
	{
		var carried = fixturesOn(item);
		carried.forEach(function (raw, index)
		{
			var id = (item.metadata && item.metadata.itemName) || 'item';
			out.push({fixture: normaliseFixture(raw, `${id}-light-${index}`), host: item});
		});
	});

	return out;
}

/**
 * The fixtures an item carries, or an empty list.
 *
 * Read off `metadata.fixtures`, which is where `getMetaData` round-trips it -
 * the same shape and the same round trip as `material_colors` and `spec`, so the
 * save format gains a field in a place it already has optional per-item blobs
 * rather than a parallel mechanism.
 *
 * @param {Object} item
 * @returns {Array<Object>}
 */
export function fixturesOn(item)
{
	var metadata = item && item.metadata;
	if (!metadata)
	{
		return [];
	}
	// A light FITTING carries its light in its own spec, because the fitting and
	// the light are one object: `generated:fixture` is a can, and a can's colour
	// temperature is not a separate record hanging off it. That is what lets
	// `SpecInspector` edit a real lamp with no new UI - it renders whatever
	// schema the builder exports, and the schema is the fixture's.
	//
	// `metadata.fixtures` stays for the other case: an object that is not itself
	// a light but carries one, like a ceiling fan's light kit.
	var spec = metadata.spec;
	if (spec && spec.kind === 'fixture')
	{
		// The lamp is not at the item's origin. The origin is the ceiling plane -
		// that is what lets `RoofItem` snap the fitting without either of them
		// knowing about the other - so the emitter has to come down to where the
		// lamp actually is, or a pendant lights the inside of the plasterboard and
		// its own shade is the only thing in shadow.
		return [Object.assign({}, spec, {position: fittingOffset(spec, item)})];
	}
	var carried = metadata.fixtures;
	return Array.isArray(carried) ? carried : [];
}

/**
 * Where the lamp sits inside a fitting, relative to the item's own origin.
 *
 * Measured off the item's own HALF SIZE rather than off the numbers in the spec,
 * and that is not a shortcut - it is the only thing that survives. `Item`'s
 * constructor recentres geometry on its bounding box (`items/item.js:198`), so a
 * builder that carefully puts the ceiling plane at y = 0 has its origin moved to
 * the middle of whatever it built. For a 2cm can that is a rounding error; for a
 * pendant on a 60cm cord it is 30cm, and the lamp ends up level with the middle
 * of the flex with the shade in its own shadow.
 *
 * The bounding box is the one frame that means the same thing before and after
 * that recentring: the bottom of the fitting is `-halfSize.y`, whatever it is.
 *
 * Kept in this file rather than in the builder because `collectFixtures` is the
 * one reader every fixture goes through, and `model/` must not import `items/` -
 * the builder already imports this file, and the other direction would be a cycle.
 *
 * @param {Object} spec A `generated:fixture` spec.
 * @param {Object} [item] The placed item, for its measured extent.
 * @returns {{x: number, y: number, z: number}}
 */
function fittingOffset(spec, item)
{
	var half = (item && item.halfSize && typeof item.halfSize.y === 'number')
		? item.halfSize.y : 1;
	var mount = spec.mount || 'recessed';
	// A pendant's lamp is up inside the shade, not hanging below its rim: the
	// shade is what a pendant is for, and a source below it lights nothing but
	// the floor while leaving the fitting dark.
	var factor = (mount === 'pendant' || mount === 'rod') ? 0.75 : 1;
	return {x: 0, y: -half * factor, z: 0};
}

/**
 * Which fixtures may cast a shadow this frame.
 *
 * A dozen shadow-casting spots will not run: each one is a full render of the
 * scene into a depth target, every frame it changes. ROADMAP.md sets the policy -
 * cap the casters, pick them nearest the camera, and let the rest light without
 * shadowing - and this is that policy as a pure function so the choice can be
 * asserted without a renderer.
 *
 * Distance is measured to the fixture's WORLD position, which the caller
 * supplies, because a nested fixture's own position is in its host's frame and
 * only the scene knows where that ended up.
 *
 * Ties break on id so the set does not flicker between two equidistant lights.
 *
 * @param {Array<{id: string, castShadow: boolean, on: boolean, distance: number}>} candidates
 * @param {number} [cap] Default 4.
 * @returns {Array<string>} The ids that may cast, nearest first.
 */
export function shadowCasters(candidates, cap)
{
	var limit = (cap === undefined) ? 4 : Math.max(0, Math.floor(cap));
	return (candidates || [])
		.filter(function (entry) {return entry.castShadow && entry.on !== false;})
		.slice()
		.sort(function (a, b)
		{
			if (a.distance !== b.distance)
			{
				return a.distance - b.distance;
			}
			return String(a.id).localeCompare(String(b.id));
		})
		.slice(0, limit)
		.map(function (entry) {return entry.id;});
}
