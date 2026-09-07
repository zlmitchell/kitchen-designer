// @ts-check
import {Object3D, PointLight, SpotLight, Vector3} from 'three';
import {kelvinToColor} from '../core/color_temperature.js';
import {
	circuitOf, circuitsIn, collectFixtures, emittersFor, intensityFor, shadowCasters,
} from '../model/light.js';
import {isStudio, renderProfile} from '../core/render_profile.js';

/**
 * One three light per emitter, from the fixtures a design carries.
 *
 * `model/light.js` holds what a fixture IS and every piece of arithmetic on it;
 * this file is the only one that knows what a `SpotLight` is. The split is the
 * same one `items/generated/` keeps between a builder and the item that hangs
 * off it, and it is what lets the photometry be asserted without a renderer.
 *
 * ## Studio only
 *
 * Classic draws its walls with `MeshBasicMaterial` - they are not lit by
 * anything and cannot be - and its whole look is frozen against the parity grid.
 * A room full of new point lights would change every classic frame while leaving
 * the walls exactly as they were, which is the worst of both. So this builds
 * nothing under classic, the same gate every other phase 6 and phase 8 item
 * carries.
 *
 * ## Nesting costs nothing here, because it was decided in the record
 *
 * A fixture whose `host` is an item is added as a **child of that item**, so the
 * host's transform carries it and dragging a ceiling fan moves its light kit for
 * free. That is `model/light.js`'s day-one decision arriving: the alternative -
 * a world position kept in step by hand - is a class of bug this shape cannot
 * have. A spot's target is a child of the same group for the same reason.
 */

/** Reused, so `updateCasters` does not allocate a vector per fixture per frame. */
const _scratch = new Vector3();

/**
 * What one lux of real illuminance is worth in this renderer.
 *
 * three's output has no absolute calibration: 1.0 is "as bright as the pipeline
 * chooses", not a photometric quantity. `intensityFor` returns honest candela
 * scaled into centimetres, and honest candela in a real room are large - so
 * something has to say what the renderer's 1.0 means before a fixture can be
 * added without whiting out the frame.
 *
 * Derived from one reference rather than dialled in, so the number can be
 * checked. A 4in can - 800lm at a 60 degree beam - in a 250cm ceiling, lighting
 * the floor directly under it:
 *
 *     half angle  30 deg          cos 30      = 0.8660
 *     solid angle 2*pi*(1-cos)    = 0.8418 sr
 *     candela     800 / 0.8418    = 950 cd
 *     scaled      950 * 100^2     = 9.50e6      (centimetres, not metres)
 *     illuminance 9.50e6 / 250^2  = 152
 *     diffuse     152 * 0.8 / pi  = 38.7        (BRDF_Lambert divides by pi)
 *
 * A well-lit white floor under one can should land near the top of the range
 * without clipping, so 38.7 has to become about 0.87: hence 1/45. ACES rolls off
 * whatever goes over.
 *
 * **This constant is what 8c's composer replaces.** ROADMAP.md phase 6 asks for
 * `toneMappingExposure` as a slider "so comparing two fixtures is not confounded
 * by tone mapping", and phase 8c moves tone mapping off the renderer and onto a
 * pass that takes the profile's knob. When that lands, this stops being a
 * constant and becomes the exposure.
 */
export const PHOTOMETRIC_SCALE = 1 / 45;

/** The reference the constant above is derived from, so a test can re-derive it. */
export const PHOTOMETRIC_REFERENCE = {lumens: 800, beamAngle: 60, distance: 250, albedo: 0.8};

/** How many fixtures may cast a shadow at once, before anybody changes it. */
export const DEFAULT_SHADOW_CAP = 4;

/**
 * Which of a host's materials is the shade.
 *
 * A lit fixture whose shade is not emissive reads as a dark blob against a
 * bright wall - and a sconce is the fixture most likely to be at eye level
 * during a walkthrough, so the object is on screen as much as its light is.
 *
 * Picking the brightest material is a heuristic and is written down as one. A
 * lamp is a pale shade on a dark arm or backplate, so luminance separates them
 * on every fixture in this catalog. It is a guess about an asset, though, not a
 * fact about one, so `fixture.shade` overrides it with an explicit index for the
 * first model it gets wrong.
 *
 * @param {*} material One material or an array of them.
 * @param {*} explicit `fixture.shade`, if the record named a slot.
 * @returns {Array<number>} Indices into the material array.
 */
export function shadeSlots(material, explicit)
{
	var list = Array.isArray(material) ? material : [material];
	if (typeof explicit === 'number' && explicit >= 0 && explicit < list.length)
	{
		return [explicit];
	}
	var best = -1;
	var bestLuminance = -1;
	list.forEach(function (entry, index)
	{
		if (!entry || !entry.color || !entry.emissive)
		{
			return;
		}
		// Rec. 709 luminance, which is what "brightest" has to mean when the
		// candidates are a cream shade and a bronze arm.
		var luminance = 0.2126 * entry.color.r + 0.7152 * entry.color.g + 0.0722 * entry.color.b;
		if (luminance > bestLuminance)
		{
			bestLuminance = luminance;
			best = index;
		}
	});
	return (best === -1) ? [] : [best];
}

/**
 * The fixtures in a design, as three lights.
 */
export class Fixtures
{
	/**
	 * @param {Object} scene The three scene top-level fixtures are added to.
	 * @param {Object} [profile] The render profile; falls back to the shared one.
	 */
	constructor(scene, profile)
	{
		this.scene = scene;
		this.renderProfile = profile || renderProfile;
		/** @type {Array<Object>} One group per fixture, keyed by id in `_byId`. */
		this.groups = [];
		/** @type {Map<string, Object>} */
		this._byId = new Map();
		/**
		 * Emissive values as they were before a shade was lit, so `dispose` can
		 * hand the item's materials back the way it found them. A viewer that is
		 * remounted must not leave a permanently glowing lamp behind.
		 * @type {Array<{material: Object, emissive: number, intensity: number}>}
		 */
		this._shades = [];
		this.shadowCap = DEFAULT_SHADOW_CAP;
		/**
		 * Circuits the viewer has switched off, by id.
		 *
		 * VIEW state and not design state, which is the same call `useLighting`
		 * makes about the ambient fill and the time of day: walking through a
		 * house with the overheads off is a way of LOOKING at the design, not a
		 * change to it. Two people opening the same file should get the same
		 * kitchen, and a lamp that is off in the record still says so in `on`.
		 *
		 * So an emitter is built when the fixture is on AND its circuit is not
		 * switched off, and nothing here is ever written back.
		 * @type {Set<string>}
		 */
		this.switchedOff = new Set();
		/** @type {Array<{id: string, label: string, count: number}>} */
		this.circuits = [];
		this._disposed = false;
	}

	/**
	 * Rebuild every emitter from the model.
	 *
	 * Wholesale rather than reconciled, because a fixture is a handful of lights
	 * and a design has tens of them at most - the reconciliation `Scene` needs for
	 * items, which are meshes with downloads behind them, would be cost with no
	 * benefit here. If a design ever carries hundreds, this is the place to be
	 * cleverer.
	 *
	 * @param {Object} model The `Model`, for its scene items and its `lights`.
	 */
	sync(model)
	{
		this.clear();
		if (this._disposed || !isStudio(this.renderProfile))
		{
			return;
		}

		var scope = this;
		var items = (model && model.scene && model.scene.getItems) ? model.scene.getItems() : [];
		var lights = (model && model.lights) || [];

		var entries = collectFixtures(lights, items);
		// Every circuit the design has, including the ones currently switched off -
		// a switch that vanished when you used it would be a switch you could not
		// turn back on.
		this.circuits = circuitsIn(entries);

		entries.forEach(function (entry)
		{
			if (scope.switchedOff.has(circuitOf(entry.fixture)))
			{
				return;
			}
			var group = scope.build(entry.fixture, entry.host);
			if (!group)
			{
				return;
			}
			scope.groups.push(group);
			scope._byId.set(entry.fixture.id, group);
			// A nested fixture goes on its host so the host's transform carries it;
			// a top-level one is in world centimetres and goes on the scene.
			(entry.host || scope.scene).add(group);
		});
	}

	/**
	 * One fixture's emitters, as a group in the fixture's own frame.
	 *
	 * @param {Object} fixture A normalised fixture.
	 * @param {?Object} host
	 * @returns {?Object}
	 */
	build(fixture, host)
	{
		if (!fixture.on || fixture.lumens <= 0)
		{
			// Nothing in the graph at all, rather than a light at zero intensity.
			// An off lamp still costs a uniform slot and a shadow-map decision every
			// frame, and there is nothing to see either way.
			return null;
		}

		var group = new Object3D();
		group.name = `fixture-${fixture.id}`;
		group.position.set(fixture.position.x, fixture.position.y, fixture.position.z);
		group.userData.fixtureId = fixture.id;
		group.userData.castShadow = fixture.castShadow;

		var colour = kelvinToColor(fixture.kelvin);
		var profile = this.renderProfile;
		var scope = this;

		emittersFor(fixture).forEach(function (emitter, index)
		{
			/** @type {Object} */
			var light;
			if (emitter.aim === 0)
			{
				light = new PointLight(colour.clone(),
					intensityFor(emitter.lumens, fixture.beamAngle, false) * PHOTOMETRIC_SCALE);
			}
			else
			{
				light = new SpotLight(colour.clone(),
					intensityFor(emitter.lumens, fixture.beamAngle, true) * PHOTOMETRIC_SCALE);
				// three's `angle` is the HALF angle from the axis, in radians; a lamp
				// is sold by its full cone in degrees. Feeding the catalogue number
				// straight in gives a beam twice as wide as the one on the box.
				light.angle = fixture.beamAngle * Math.PI / 360;
				light.penumbra = fixture.penumbra;

				var target = new Object3D();
				if (fixture.target)
				{
					target.position.set(fixture.target.x, fixture.target.y, fixture.target.z);
				}
				else
				{
					// Straight up or straight down from where it is, which is what
					// nearly every fixture does and what nobody should have to write.
					target.position.set(emitter.dx, emitter.dy + emitter.aim * 100, emitter.dz);
				}
				// A child of the same group, so the host's transform reaches the aim
				// as well as the source. A target left on the scene stays behind when
				// the fan it belongs to is dragged, and the beam swings across the
				// room after it.
				group.add(target);
				light.target = target;
			}

			light.name = `${group.name}-${index}`;
			light.position.set(emitter.dx, emitter.dy, emitter.dz);
			// Physical falloff. `distance: 0` means it never cuts off, which is
			// right: a hard cutoff sphere is visible as a ring on a floor.
			light.decay = 2;
			light.distance = 0;
			light.castShadow = false;
			light.shadow.mapSize.width = profile.shadowMapSize;
			light.shadow.mapSize.height = profile.shadowMapSize;
			light.shadow.bias = -0.0001;
			// Per mount, because a sconce is nearly coplanar with the wall it is
			// fixed to and the global 1.5 is tuned for a key light three metres out.
			light.shadow.normalBias = fixture.normalBias;
			group.add(light);
		});

		if (host)
		{
			scope.lightShade(host, colour, fixture);
		}
		return group;
	}

	/**
	 * Make the host's shade glow, and remember what it was.
	 *
	 * Only for a nested fixture: a top-level one is a bare position with no object
	 * at it, and there is nothing to light up.
	 */
	lightShade(host, colour, fixture)
	{
		var scope = this;
		var list = Array.isArray(host.material) ? host.material : [host.material];
		shadeSlots(host.material, fixture.shade).forEach(function (index)
		{
			var material = list[index];
			if (!material || !material.emissive)
			{
				return;
			}
			scope._shades.push({
				material: material,
				emissive: material.emissive.getHex(),
				intensity: material.emissiveIntensity,
			});
			material.emissive.copy(colour);
			// Bright enough to read as lit against a wall the same lamp is washing,
			// and short of white so the shade keeps its form. A shade at 1.0 is a
			// white silhouette with no shape in it.
			material.emissiveIntensity = 0.75;
			material.needsUpdate = true;
		});
	}

	/**
	 * Choose which fixtures cast a shadow, nearest the camera first.
	 *
	 * A dozen shadow-casting spots will not run - each is a full render of the
	 * scene into a depth target. The policy is `model/light.js`'s `shadowCasters`;
	 * this is the part that needs the scene graph, because a nested fixture's own
	 * position is in its host's frame and only the world matrix knows where that
	 * ended up.
	 *
	 * @param {Object} eye The camera position, in world centimetres.
	 */
	updateCasters(eye)
	{
		if (!eye || !this.groups.length)
		{
			return;
		}
		var candidates = this.groups.map(function (group)
		{
			group.updateWorldMatrix(true, false);
			var at = group.getWorldPosition(_scratch);
			return {
				id: group.userData.fixtureId,
				castShadow: Boolean(group.userData.castShadow),
				on: true,
				distance: at.distanceTo(eye),
			};
		});

		var chosen = new Set(shadowCasters(candidates, this.shadowCap));
		this.groups.forEach(function (group)
		{
			var casts = chosen.has(group.userData.fixtureId);
			group.children.forEach(function (child)
			{
				if (child.isLight)
				{
					child.castShadow = casts;
				}
			});
		});
	}

	/** Take every emitter back out and hand the shades back their materials. */
	clear()
	{
		this.groups.forEach(function (group)
		{
			if (group.parent)
			{
				group.parent.remove(group);
			}
			group.children.forEach(function (child)
			{
				if (child.isLight && typeof child.dispose === 'function')
				{
					child.dispose();
				}
			});
		});
		this.groups = [];
		this._byId.clear();

		this._shades.forEach(function (record)
		{
			record.material.emissive.setHex(record.emissive);
			record.material.emissiveIntensity = record.intensity;
			record.material.needsUpdate = true;
		});
		this._shades = [];
	}

	/** Safe to call more than once. */
	dispose()
	{
		if (this._disposed)
		{
			return;
		}
		this.clear();
		this._disposed = true;
	}
}
