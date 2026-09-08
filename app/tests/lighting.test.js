// @vitest-environment jsdom
/**
 * Phase 6, part one: a fixture is data, and the emitters it becomes.
 *
 * The arithmetic is in `model/light.js` and imports no three, so nearly all of
 * this runs without a renderer. What needs one - that a nested fixture is a
 * CHILD of its host, that a spot's cone is the one on the packet - is asserted
 * against real three objects in a scene graph rather than against a mock, for
 * the same reason the generated items are: a mock of `SpotLight.angle` would
 * agree with whatever the code did.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {Group, Mesh, MeshStandardMaterial, BoxGeometry, Scene, Vector3} from 'three';
import {
	MAX_STRIP_SEGMENTS, MOUNTS, MOUNT_DEFAULTS, SCENE_UNITS_PER_METRE, circuitOf,
	circuitsIn, collectFixtures, emittersFor, intensityFor, normaliseFixture,
	shadowCasters,
} from '../src/scripts/model/light.js';
import {
	Fixtures, PHOTOMETRIC_REFERENCE, PHOTOMETRIC_SCALE, shadeSlots,
} from '../src/scripts/three/fixtures.js';
import {
	RENDER_CLASSIC, RENDER_STUDIO, createRenderProfile,
} from '../src/scripts/core/render_profile.js';
import {NIGHT_SKY, clockOf, sunAt} from '../src/scripts/core/daylight.js';
import {Lights} from '../src/scripts/three/lights.js';
import {Floorplan3D} from '../src/scripts/three/floorPlan.js';
import {Model} from '../src/scripts/model/model.js';
import {resetAll} from './helpers/harness.js';
import {installCanvas2D} from './helpers/dom.js';
import {buildFixture} from '../src/scripts/items/generated/fixture.js';
import {fixturesOn} from '../src/scripts/model/light.js';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const CATALOG = JSON.parse(readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '../src/catalog/catalog.json'), 'utf8'));

// `STUDIO_PROFILE` is a snapshot of the VALUES and carries no `mode`, so
// `isStudio` says no to it - the gate reads the mode. `createRenderProfile` is
// what builds a profile that knows which one it is.
const STUDIO = createRenderProfile(RENDER_STUDIO);
const CLASSIC = createRenderProfile(RENDER_CLASSIC);

describe('a fixture is a record, and the record fills itself in', () =>
{
	it('takes what it does not say from its mount', () =>
	{
		// The mount is the one field somebody actually sets. An under-cabinet strip
		// is 300lm at 3000K whether or not the record says so, because that is what
		// an under-cabinet strip is.
		const strip = normaliseFixture({mount: 'under-cabinet'});
		expect(strip.lumens).toBe(MOUNT_DEFAULTS['under-cabinet'].lumens);
		expect(strip.kelvin).toBe(3000);
		expect(strip.throw).toBe('down');
		expect(strip.strip).toBe(true);

		// And a sconce is a different object entirely from the same two fields.
		const sconce = normaliseFixture({mount: 'wall'});
		expect(sconce.throw).toBe('both');
		// Nearly coplanar with the wall it lights, which is the worst case for a
		// shadow map - so its bias is its own, not the global one.
		expect(sconce.normalBias).toBeGreaterThan(MOUNT_DEFAULTS.recessed.normalBias);
	});

	it('lets the record win over its mount', () =>
	{
		const dim = normaliseFixture({mount: 'recessed', lumens: 250, kelvin: 2200});
		expect(dim.lumens).toBe(250);
		expect(dim.kelvin).toBe(2200);
	});

	it('falls back rather than throwing on a mount this build does not have', () =>
	{
		// A design outlives the code that wrote it. A light in roughly the right
		// place beats an unopenable document - the tolerance `materialsForSlots`
		// extends to a retired finish.
		const later = normaliseFixture({mount: 'cove-uplight', lumens: 500});
		expect(later.mount).toBe('recessed');
		expect(later.lumens).toBe(500);
	});

	it('clamps a beam angle to something a cone can be', () =>
	{
		expect(normaliseFixture({beamAngle: 400}).beamAngle).toBe(179);
		expect(normaliseFixture({beamAngle: -3}).beamAngle).toBe(1);
		expect(normaliseFixture({lumens: -50}).lumens).toBe(0);
	});
});

describe('what a fixture is made of', () =>
{
	it('makes `both` two emitters and SPLITS the output between them', () =>
	{
		// The load-bearing one. Given the full output twice, `throw` would silently
		// double as a brightness control and an uplight could not be compared with
		// a downlight - they would be two different bulbs.
		const one = normaliseFixture({mount: 'pendant', throw: 'down', lumens: 600});
		const both = normaliseFixture({mount: 'pendant', throw: 'both', lumens: 600});

		expect(emittersFor(one)).toHaveLength(1);
		const pair = emittersFor(both);
		expect(pair).toHaveLength(2);
		expect(pair.map((e) => e.aim).sort()).toEqual([-1, 1]);
		expect(pair.reduce((sum, e) => sum + e.lumens, 0)).toBeCloseTo(600, 6);
		expect(emittersFor(one)[0].lumens).toBeCloseTo(600, 6);
	});

	it('spreads a strip along its length, sharing the output', () =>
	{
		// One point source under a 60cm strip puts a single hard scallop on the
		// splashback where there should be an even wash.
		const strip = normaliseFixture({mount: 'under-cabinet', lumens: 300, length: 90, segments: 3});
		const emitters = emittersFor(strip);
		expect(emitters).toHaveLength(3);
		expect(emitters.reduce((sum, e) => sum + e.lumens, 0)).toBeCloseTo(300, 6);
		// Centred on the fixture's own origin, so a strip and a point are the same
		// code path downstream.
		const xs = emitters.map((e) => e.dx).sort((a, b) => a - b);
		expect(xs[0]).toBeCloseTo(-30, 6);
		expect(xs[2]).toBeCloseTo(30, 6);
		expect(xs[0] + xs[2]).toBeCloseTo(0, 6);
	});

	it('gives an undirected fixture one emitter with no aim', () =>
	{
		const puck = normaliseFixture({mount: 'in-cabinet'});
		const emitters = emittersFor(puck);
		expect(emitters).toHaveLength(1);
		expect(emitters[0].aim).toBe(0);
	});
});

describe('photometry, in a scene measured in centimetres', () =>
{
	it('concentrates the same output into a narrower beam', () =>
	{
		// The reason a beam angle is on the packet: the same bulb in a 25 degree
		// spot and a 120 degree flood are wildly different intensities.
		const narrow = intensityFor(800, 25, true);
		const wide = intensityFor(800, 120, true);
		expect(narrow).toBeGreaterThan(wide * 5);
		// And an undirected source spreads it over the whole sphere, so it is
		// dimmer still than any cone.
		expect(intensityFor(800, 120, false)).toBeLessThan(wide);
	});

	it('converts into centimetres, which is the difference between lit and off', () =>
	{
		// three computes `I / d²` with `d` in world units, and ours are
		// centimetres - so a real candela value is 10,000x too dark here, which
		// reads as a broken fixture rather than as a unit error.
		const candela = 800 / (2 * Math.PI * (1 - Math.cos(30 * Math.PI / 180)));
		expect(intensityFor(800, 60, true))
			.toBeCloseTo(candela * SCENE_UNITS_PER_METRE * SCENE_UNITS_PER_METRE, 0);
	});

	it('lands the reference fixture just under clipping', () =>
	{
		// This is what `PHOTOMETRIC_SCALE` is FOR, and it is the assertion that
		// stops it being a dialled-in number. A 4in can - 800lm, 60 degrees - in a
		// 250cm ceiling, on a white floor directly below it, should come out near
		// the top of the range and not far over: bright, with ACES rolling off
		// whatever is left.
		const {lumens, beamAngle, distance, albedo} = PHOTOMETRIC_REFERENCE;
		const intensity = intensityFor(lumens, beamAngle, true) * PHOTOMETRIC_SCALE;
		const illuminance = intensity / (distance * distance);
		// BRDF_Lambert divides the diffuse response by pi.
		const response = illuminance * albedo / Math.PI;
		expect(response).toBeGreaterThan(0.5);
		expect(response).toBeLessThan(1.5);
	});
});

describe('the shadow budget', () =>
{
	const at = (id, distance, castShadow) => ({id, distance, castShadow, on: true});

	it('keeps only the nearest few', () =>
	{
		// A dozen shadow-casting spots will not run: each is a full render of the
		// scene into a depth target.
		const chosen = shadowCasters([
			at('far', 900, true), at('near', 100, true), at('mid', 400, true),
			at('nearer', 50, true), at('furthest', 1200, true),
		], 3);
		expect(chosen).toEqual(['nearer', 'near', 'mid']);
	});

	it('never picks one that should not cast, however near it is', () =>
	{
		// Most mounts should never cast. A strip 40cm from the worktop it lights
		// buys nothing from a shadow map and costs a whole render.
		const chosen = shadowCasters([at('strip', 1, false), at('can', 300, true)], 4);
		expect(chosen).toEqual(['can']);
	});

	it('breaks a tie on id, so the set does not flicker', () =>
	{
		const chosen = shadowCasters([at('b', 200, true), at('a', 200, true)], 1);
		expect(chosen).toEqual(['a']);
	});
});

describe('a fixture reaches the scene from one of two places', () =>
{
	it('reports the host, which is what says whose frame the position is in', () =>
	{
		// ROADMAP.md's day-one decision. A top-level fixture is world centimetres;
		// one carried by an item is in that item's own frame, and the emitter goes
		// on the item so the transform is free.
		const item = {metadata: {itemName: 'Ceilingfan', fixtures: [{mount: 'rod'}]}};
		const found = collectFixtures([{mount: 'recessed'}], [item]);

		expect(found).toHaveLength(2);
		expect(found[0].host).toBeNull();
		expect(found[1].host).toBe(item);
		// Ids are generated where the file gave none, because the shadow cap has to
		// name them.
		expect(new Set(found.map((entry) => entry.fixture.id)).size).toBe(2);
	});

	it('is empty for a design that carries none', () =>
	{
		expect(collectFixtures([], [{metadata: {itemName: 'Chair'}}])).toEqual([]);
		expect(collectFixtures(null, null)).toEqual([]);
	});
});

/** A host that is enough of an Object3D to hang a fixture off. */
function hostObject()
{
	const host = new Group();
	host.material = [
		new MeshStandardMaterial({color: 0x2a2a2a}),
		new MeshStandardMaterial({color: 0xf2ead8}),
	];
	host.add(new Mesh(new BoxGeometry(10, 10, 10), host.material[0]));
	return host;
}

function modelWith(lights, items)
{
	return {lights: lights || [], scene: {getItems: () => items || []}};
}

describe('the emitters', () =>
{
	let scene;
	let fixtures;

	beforeEach(() =>
	{
		scene = new Scene();
		fixtures = new Fixtures(scene, STUDIO);
	});

	it('builds nothing at all under the classic profile', () =>
	{
		// Classic's walls are MeshBasicMaterial and cannot be lit, and its look is
		// frozen against the parity grid. New point lights would change every
		// classic frame and leave the walls exactly as they were.
		const classic = new Fixtures(scene, CLASSIC);
		classic.sync(modelWith([{mount: 'recessed', position: {x: 0, y: 240, z: 0}}]));
		expect(classic.groups).toHaveLength(0);
	});

	it('aims a spot with the cone that is on the packet, not twice it', () =>
	{
		// three's `angle` is the HALF angle from the axis, in radians; a lamp is
		// sold by its full cone in degrees. Feeding the catalogue number straight in
		// gives a beam twice as wide as the one it was bought for.
		fixtures.sync(modelWith([{id: 'can', mount: 'recessed', beamAngle: 60,
			position: {x: 0, y: 240, z: 0}}]));
		const spot = fixtures.groups[0].children.find((child) => child.isSpotLight);
		expect(spot.angle).toBeCloseTo(30 * Math.PI / 180, 9);
	});

	it('makes `both` two emitters, one aimed up and one down', () =>
	{
		// "An up or both throw is a second emitter aimed at the ceiling, not a
		// flag" - no single three light points two ways.
		fixtures.sync(modelWith([{id: 'sconce', mount: 'wall', throw: 'both',
			position: {x: 0, y: 150, z: 0}}]));
		const group = fixtures.groups[0];
		const lights = group.children.filter((child) => child.isLight);
		expect(lights).toHaveLength(2);

		const aims = lights.map((light) =>
		{
			group.updateMatrixWorld(true);
			return Math.sign(light.target.position.y - light.position.y);
		}).sort();
		expect(aims).toEqual([-1, 1]);
	});

	it('hangs a nested fixture off its host, so moving the host moves the light', () =>
	{
		// The whole point of deciding nesting in the record. The alternative - a
		// world position kept in step with its host by hand - is the class of bug
		// this shape cannot have.
		const host = hostObject();
		fixtures.sync(modelWith([], [Object.assign(host, {
			metadata: {itemName: 'Ceilingfan', fixtures: [{mount: 'rod', position: {x: 0, y: -20, z: 0}}]},
		})]));

		const group = fixtures.groups[0];
		expect(group.parent).toBe(host);

		host.position.set(300, 240, 120);
		host.updateMatrixWorld(true);
		const where = group.getWorldPosition(new Vector3());
		expect(where.x).toBeCloseTo(300, 6);
		expect(where.y).toBeCloseTo(220, 6);
	});

	it('keeps a spot aimed after its host moves', () =>
	{
		// The target is a child of the same group. Left on the scene it stays
		// behind when the fan it belongs to is dragged, and the beam swings across
		// the room after it - which nothing measures, because the light is in the
		// right place and only its aim is wrong.
		const host = hostObject();
		fixtures.sync(modelWith([], [Object.assign(host, {
			metadata: {itemName: 'Ceilingfan', fixtures: [{mount: 'rod', throw: 'down'}]},
		})]));
		const spot = fixtures.groups[0].children.find((child) => child.isSpotLight);
		expect(spot.target.parent).toBe(fixtures.groups[0]);

		host.position.set(500, 0, 0);
		host.updateMatrixWorld(true);
		const source = spot.getWorldPosition(new Vector3());
		const target = spot.target.getWorldPosition(new Vector3());
		// Still pointing straight down, from the new place.
		expect(target.x).toBeCloseTo(source.x, 6);
		expect(target.y).toBeLessThan(source.y);
	});

	it('puts nothing in the graph for a fixture that is switched off', () =>
	{
		fixtures.sync(modelWith([{id: 'off', mount: 'recessed', on: false}]));
		expect(fixtures.groups).toHaveLength(0);
	});

	it('lights the shade, and hands the material back on dispose', () =>
	{
		// A lit fixture whose shade is not emissive reads as a dark blob against a
		// bright wall - and a sconce is the fixture most likely to be at eye level
		// during a walkthrough.
		const host = hostObject();
		const shade = host.material[1];
		expect(shade.emissive.getHex()).toBe(0x000000);

		fixtures.sync(modelWith([], [Object.assign(host, {
			metadata: {itemName: 'Lampwall', fixtures: [{mount: 'wall', kelvin: 2700}]},
		})]));
		// The pale material, not the dark arm.
		expect(shade.emissive.getHex()).not.toBe(0x000000);
		expect(host.material[0].emissive.getHex()).toBe(0x000000);

		fixtures.dispose();
		expect(shade.emissive.getHex()).toBe(0x000000);
		expect(shade.emissiveIntensity).toBe(1);
	});

	it('picks the shade by luminance, and takes an explicit slot over the guess', () =>
	{
		const dark = new MeshStandardMaterial({color: 0x101010});
		const pale = new MeshStandardMaterial({color: 0xfff4e0});
		expect(shadeSlots([dark, pale])).toEqual([1]);
		expect(shadeSlots([dark, pale], 0)).toEqual([0]);
		// Out of range is the guess again, not a crash.
		expect(shadeSlots([dark, pale], 9)).toEqual([1]);
	});

	it('lets only the nearest few cast, and re-picks as the camera moves', () =>
	{
		const near = {id: 'near', mount: 'recessed', position: {x: 0, y: 240, z: 0}};
		const far = {id: 'far', mount: 'recessed', position: {x: 900, y: 240, z: 0}};
		fixtures.sync(modelWith([near, far]));
		fixtures.shadowCap = 1;

		const castersFrom = (x) =>
		{
			fixtures.updateCasters(new Vector3(x, 150, 0));
			return fixtures.groups
				.filter((group) => group.children.some((child) => child.isLight && child.castShadow))
				.map((group) => group.userData.fixtureId);
		};
		expect(castersFrom(0)).toEqual(['near']);
		expect(castersFrom(900)).toEqual(['far']);
	});

	it('takes every emitter back out when it is cleared', () =>
	{
		fixtures.sync(modelWith([{id: 'a', mount: 'recessed'}, {id: 'b', mount: 'pendant'}]));
		expect(scene.children.filter((child) => child.name.startsWith('fixture-'))).toHaveLength(2);
		fixtures.dispose();
		expect(scene.children.filter((child) => child.name.startsWith('fixture-'))).toHaveLength(0);
	});
});

describe('a design carries its fixtures through a save', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
	});

	const PLAN = {
		version: '2.0.0', units: 'cm',
		corners: {
			a: {x: 0, y: 0, elevation: 250}, b: {x: 400, y: 0, elevation: 250},
			c: {x: 400, y: 300, elevation: 250}, d: {x: 0, y: 300, elevation: 250},
		},
		walls: [
			{corner1: 'a', corner2: 'b'}, {corner1: 'b', corner2: 'c'},
			{corner1: 'c', corner2: 'd'}, {corner1: 'd', corner2: 'a'},
		],
		rooms: {}, wallTextures: [], floorTextures: {}, newFloorTextures: {},
	};

	it('round-trips a top-level lights block', () =>
	{
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: PLAN, items: [],
			lights: [{id: 'can-1', mount: 'recessed', position: {x: 200, y: 240, z: 150}, kelvin: 3000}],
		}));
		expect(model.lights).toHaveLength(1);

		const saved = JSON.parse(model.exportSerialized());
		expect(saved.lights).toHaveLength(1);
		expect(saved.lights[0].id).toBe('can-1');
	});

	it('writes no lights key at all for a design that has none', () =>
	{
		// `useHistory` decides whether anything changed by comparing this string to
		// the last one, so a design with no fixtures has to serialise exactly as it
		// did before phase 6 or every open becomes an edit.
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({floorplan: PLAN, items: []}));
		expect(Object.prototype.hasOwnProperty.call(
			JSON.parse(model.exportSerialized()), 'lights')).toBe(false);
	});

	it('refuses a lights block that is not a list, and says which field', () =>
	{
		const model = new Model('/textures/');
		const result = model.loadDocument(JSON.stringify({
			floorplan: PLAN, items: [], lights: {mount: 'recessed'},
		}));
		expect(result.ok).toBe(false);
		expect(result.errors[0].path).toBe('lights');
	});

	it('carries a fixture on the item that holds it', () =>
	{
		// The nested half. It rides in the item record beside `spec` and
		// `material_colors`, so the save format gains a field where it already has
		// optional per-item blobs rather than growing a parallel mechanism.
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: PLAN,
			items: [{
				id: 'post-1', item_name: 'Post', item_type: 1, format: 'generated',
				model_url: 'generated:post', xpos: 100, ypos: 0, zpos: 100, rotation: 0,
				scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
				spec: {kind: 'post', width: 10, depth: 10, height: 240},
				fixtures: [{mount: 'rod', lumens: 900, position: {x: 0, y: -10, z: 0}}],
			}],
		}));

		const saved = JSON.parse(model.exportSerialized());
		expect(saved.items[0].fixtures).toHaveLength(1);
		expect(saved.items[0].fixtures[0].mount).toBe('rod');
		// And it is NOT promoted to the top-level block, which would be two
		// positions in two frames for one lamp.
		expect(Object.prototype.hasOwnProperty.call(saved, 'lights')).toBe(false);
	});
});

describe('the lamps in the catalog emit something', () =>
{
	// The audit's "placement yes, light no" rows. `Lampwall` has been type 2 and
	// bound to a wall edge for the life of this app, and has never emitted a
	// lumen, because there was nowhere for one to live.
	const LAMPS = ['Lampwall', 'Chandelier', 'Ceilingfan', 'Lampsquareceiling'];

	it('gives each of the four a fixture the builder recognises', () =>
	{
		for (const name of LAMPS)
		{
			const entry = CATALOG.items.find((item) => item.name === name);
			expect(entry, `${name} is in the catalog`).toBeTruthy();
			expect(entry.fixtures, `${name} carries a fixture`).toHaveLength(1);

			// Normalising a record that names an unknown mount silently falls back,
			// so a typo in the catalog would be a lamp that quietly became a
			// downlight. Check the mount against the list rather than the result.
			const raw = entry.fixtures[0];
			expect(MOUNTS, `${name} names a real mount`).toContain(raw.mount);
			expect(normaliseFixture(raw).lumens).toBeGreaterThan(0);
		}
	});

	it('hangs them inside the lamp, not above it', () =>
	{
		// A nested fixture's position is in its HOST's frame, and the host is
		// centred on its own bounding box - so a light kit is a small negative y
		// from the middle of the fitting, never a room coordinate.
		for (const name of LAMPS)
		{
			const raw = CATALOG.items.find((item) => item.name === name).fixtures[0];
			const at = normaliseFixture(raw).position;
			expect(Math.abs(at.x), name).toBeLessThan(30);
			expect(Math.abs(at.y), name).toBeLessThan(30);
			expect(Math.abs(at.z), name).toBeLessThan(30);
		}
	});
});

describe('the sun', () =>
{
	it('rises, peaks at noon and sets', () =>
	{
		expect(sunAt(6).altitude).toBeCloseTo(0, 6);
		expect(sunAt(18).altitude).toBeCloseTo(0, 6);
		expect(sunAt(12).altitude).toBeGreaterThan(sunAt(9).altitude);
		expect(sunAt(9).altitude).toBeGreaterThan(sunAt(7).altitude);
		// And is below the horizon at night, which is the fact everything else
		// reads: a directional light at a negative altitude comes up through the
		// floor and lights every ceiling in the house.
		expect(sunAt(23).altitude).toBeLessThan(0);
		expect(sunAt(23).up).toBe(false);
		expect(sunAt(23).intensity).toBe(0);
	});

	it('comes from the east in the morning and the west in the evening', () =>
	{
		// The whole point of the feature: which side of the house the light comes
		// in. +x is east and +z is south, which is what the plan's own axes are.
		expect(sunAt(8).direction.x).toBeGreaterThan(0.3);
		expect(sunAt(16).direction.x).toBeLessThan(-0.3);
		// And is due south at noon, so a north-facing window never gets it.
		expect(sunAt(12).direction.z).toBeGreaterThan(0);
		expect(Math.abs(sunAt(12).direction.x)).toBeLessThan(1e-9);
	});

	it('turns with the building', () =>
	{
		// `heading` is how a user asks "what if the house faced the other way",
		// which is the only way to get the morning sun through a different wall
		// without moving the walls.
		const noon = sunAt(12);
		const turned = sunAt(12, 90);
		expect(turned.direction.x).not.toBeCloseTo(noon.direction.x, 3);
		// Half a turn puts it on the opposite side, at the same height.
		const half = sunAt(12, 180);
		expect(half.altitude).toBeCloseTo(noon.altitude, 9);
		expect(half.direction.z).toBeCloseTo(-noon.direction.z, 6);
	});

	it('is warm at the horizon and neutral overhead', () =>
	{
		// A low sun has crossed more atmosphere, and the same scattering that makes
		// the sky blue takes the blue out of the beam.
		expect(sunAt(17.5).kelvin).toBeLessThan(sunAt(12).kelvin);
		expect(sunAt(6.2).kelvin).toBeLessThan(2600);
		expect(sunAt(12).kelvin).toBeGreaterThan(5000);
	});

	it('leaves the night dim rather than black', () =>
	{
		// A modelling tool whose night view is an unusable black rectangle has told
		// the user nothing.
		expect(sunAt(2).sky).toBeGreaterThanOrEqual(NIGHT_SKY);
		expect(sunAt(2).sky).toBeLessThan(sunAt(12).sky);
		// And twilight fades rather than switching off on the hour.
		expect(sunAt(18.5).sky).toBeGreaterThan(sunAt(21).sky);
	});

	it('reads back as a clock', () =>
	{
		expect(clockOf(17.5)).toBe('17:30');
		expect(clockOf(9)).toBe('09:00');
		expect(clockOf(25)).toBe('01:00');
	});
});

/** Enough of a Floorplan for `Lights` to size a shadow camera against. */
function floorplanStub()
{
	return {
		getSize: () => ({x: 500, y: 250, z: 400}),
		getCenter: () => new Vector3(250, 0, 200),
		addEventListener() {},
		removeEventListener() {},
	};
}

describe('the scene lighting controls', () =>
{
	function lightsIn()
	{
		return new Lights(new Scene(), floorplanStub(), STUDIO);
	}

	it('changes nothing at its defaults', () =>
	{
		// The parity guarantee. A golden capture and a profile switch must not
		// depend on where somebody left a slider, so `ambient: 1` and no daylight
		// have to be exactly the scene every earlier build drew.
		const lights = lightsIn();
		const hemisphere = lights.hemiLight.intensity;
		const key = lights.dirLight.intensity;

		lights.setAmbient(1);
		lights.setDaylight(null);
		expect(lights.hemiLight.intensity).toBeCloseTo(hemisphere, 9);
		expect(lights.dirLight.intensity).toBeCloseTo(key, 9);
	});

	it('takes the fill away and leaves the key, because no ambient is not no sun', () =>
	{
		const lights = lightsIn();
		const key = lights.dirLight.intensity;
		lights.setAmbient(0);
		expect(lights.hemiLight.intensity).toBe(0);
		expect(lights.fillLight.intensity).toBe(0);
		expect(lights.dirLight.intensity).toBeCloseTo(key, 9);
	});

	it('moves the key to where the sun is', () =>
	{
		// The change that makes a window mean something: the wall meshes already
		// cast and receive shadows under studio and a window's opening is a real
		// hole in that geometry, so what was missing was a light from a direction.
		const lights = lightsIn();
		lights.setDaylight({hour: 8, heading: 0});
		const morning = lights.dirLight.position.clone();
		lights.setDaylight({hour: 16, heading: 0});
		const afternoon = lights.dirLight.position.clone();

		const centre = new Vector3(250, 0, 200);
		// East in the morning, west in the afternoon, both above the room.
		expect(morning.x).toBeGreaterThan(centre.x);
		expect(afternoon.x).toBeLessThan(centre.x);
		expect(morning.y).toBeGreaterThan(0);
		expect(afternoon.y).toBeGreaterThan(0);
	});

	it('warms and dims the key as the sun goes down', () =>
	{
		const lights = lightsIn();
		lights.setDaylight({hour: 12});
		const noon = {intensity: lights.dirLight.intensity, blue: lights.dirLight.color.b};
		lights.setDaylight({hour: 17.5});
		expect(lights.dirLight.intensity).toBeLessThan(noon.intensity);
		// Dusk is dim AND orange, from one number rather than two kept in step.
		expect(lights.dirLight.color.b).toBeLessThan(noon.blue);
	});

	it('switches the sun off below the horizon', () =>
	{
		const lights = lightsIn();
		lights.setDaylight({hour: 23});
		expect(lights.dirLight.intensity).toBe(0);
		expect(lights.dirLight.visible).toBe(false);
		// The sky keeps a floor under it, so the room is dim rather than black.
		expect(lights.hemiLight.intensity).toBeGreaterThan(0);
	});
});

describe('the ceiling is opaque exactly when the light comes from outside', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
	});

	function planWithRoom()
	{
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: {
				version: '2.0.0', units: 'cm',
				corners: {
					a: {x: 0, y: 0, elevation: 250}, b: {x: 400, y: 0, elevation: 250},
					c: {x: 400, y: 300, elevation: 250}, d: {x: 0, y: 300, elevation: 250},
				},
				walls: [
					{corner1: 'a', corner2: 'b'}, {corner1: 'b', corner2: 'c'},
					{corner1: 'c', corner2: 'd'}, {corner1: 'd', corner2: 'a'},
				],
				rooms: {}, wallTextures: [], floorTextures: {}, newFloorTextures: {},
			},
			items: [],
		}));
		const scene = new Scene();
		const controls = {object: {position: new Vector3(200, 160, 500)},
			addEventListener() {}, removeEventListener() {}};
		const plan = new Floorplan3D(scene, model.floorplan, controls, STUDIO);
		plan.redraw();
		return plan;
	}

	const roofsCast = (plan) => plan.floors.map((floor) => Boolean(floor.roofPlane
		&& floor.roofPlane.castShadow));

	it('lets light through by default, because the studio key is above the room', () =>
	{
		// `Lights.updateShadowCamera` parks the key ABOVE the plan on purpose - an
		// overhead light is the cheapest way to make every room legible. A ceiling
		// that blocked it would black out the whole house and change every studio
		// frame the parity grid captures.
		const plan = planWithRoom();
		expect(plan.floors.length).toBeGreaterThan(0);
		expect(roofsCast(plan).every((casts) => casts === false)).toBe(true);
	});

	it('closes them for daylight, or the sun rains straight into every room', () =>
	{
		// Measured on the traced plan before this existed: with the roof open, 498
		// of 875 floor samples saw the sun THROUGH the ceiling, and a window
		// opening made no difference to any of them. Closed, 81 did - a patch. That
		// reads as "daylight does nothing" rather than as "the ceiling is missing",
		// which is why a raycast found it and a render would not have.
		const plan = planWithRoom();
		plan.setSkyOpen(false);
		expect(roofsCast(plan).every((casts) => casts === true)).toBe(true);
		plan.setSkyOpen(true);
		expect(roofsCast(plan).every((casts) => casts === false)).toBe(true);
	});

	it('keeps the mode across a redraw, which builds new roof planes', () =>
	{
		const plan = planWithRoom();
		plan.setSkyOpen(false);
		plan.redraw();
		expect(roofsCast(plan).every((casts) => casts === true)).toBe(true);
	});
});

describe('a light fitting is an item that carries its own light', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
	});

	const PLAN = {
		version: '2.0.0', units: 'cm',
		corners: {
			a: {x: 0, y: 0, elevation: 250}, b: {x: 400, y: 0, elevation: 250},
			c: {x: 400, y: 300, elevation: 250}, d: {x: 0, y: 300, elevation: 250},
		},
		walls: [
			{corner1: 'a', corner2: 'b'}, {corner1: 'b', corner2: 'c'},
			{corner1: 'c', corner2: 'd'}, {corner1: 'd', corner2: 'a'},
		],
		rooms: {}, wallTextures: [], floorTextures: {}, newFloorTextures: {},
	};

	function planWithCan(spec)
	{
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: PLAN,
			items: [{
				id: 'can-1', item_name: 'Recessed Can', item_type: 4, format: 'generated',
				model_url: 'generated:fixture', xpos: 200, ypos: 244, zpos: 150, rotation: 0,
				scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
				spec: Object.assign({kind: 'fixture', mount: 'recessed', throw: 'down',
					kelvin: 3000, lumens: 800, beamAngle: 60, on: true}, spec),
			}],
		}));
		return model;
	}

	it('is a real, selectable object rather than a bare position', () =>
	{
		// The whole reason this exists. A `lights: []` entry has no geometry, so
		// there is nothing in the 3D view to click and nothing in the plan to draw.
		const model = planWithCan();
		const items = model.scene.getItems();
		expect(items).toHaveLength(1);
		expect(items[0].geometry, 'it has geometry to click').toBeTruthy();
		items[0].geometry.computeBoundingBox();
		const size = items[0].geometry.boundingBox.getSize(new Vector3());
		// A trim ring: as wide as its diameter and almost nothing deep.
		expect(size.x).toBeCloseTo(10.16, 1);
		expect(size.y).toBeLessThan(2);
	});

	it('emits, because its SPEC is the fixture', () =>
	{
		// One object, one schema, one panel: `fixturesOn` reads the spec directly
		// rather than a separate `metadata.fixtures` block, which is what lets
		// `SpecInspector` edit a real lamp with no new UI.
		const model = planWithCan();
		const item = model.scene.getItems()[0];
		const carried = fixturesOn(item);
		expect(carried).toHaveLength(1);
		expect(carried[0].lumens).toBe(800);

		const scene = new Scene();
		const fixtures = new Fixtures(scene, STUDIO);
		fixtures.sync(model);
		expect(fixtures.groups, 'one emitter, on the item').toHaveLength(1);
		expect(fixtures.groups[0].parent).toBe(item);
	});

	it('takes the edit when the panel changes the spec', () =>
	{
		// `setSpec` rebuilds the geometry; the emitter has to follow, or the panel
		// changes what the fitting looks like and not what it does.
		const model = planWithCan();
		const item = model.scene.getItems()[0];
		const next = item.getSpec();
		next.kelvin = 2200;
		next.lumens = 200;
		item.setSpec(next);
		expect(fixturesOn(item)[0].kelvin).toBe(2200);

		const scene = new Scene();
		const fixtures = new Fixtures(scene, STUDIO);
		fixtures.sync(model);
		const light = fixtures.groups[0].children.find((child) => child.isLight);
		// Warmer means less blue, and dimmer means less of it.
		expect(light.color.b).toBeLessThan(0.75);
	});

	it('builds nothing in the graph when it is switched off', () =>
	{
		const model = planWithCan({on: false});
		const scene = new Scene();
		const fixtures = new Fixtures(scene, STUDIO);
		fixtures.sync(model);
		expect(fixtures.groups).toHaveLength(0);
	});

	/** The fitting's own box, which is the frame its fixtures are positioned in. */
	function boxOf(item)
	{
		item.geometry.computeBoundingBox();
		return item.geometry.boundingBox;
	}

	it('puts a pendant lamp in its shade, not level with its flex', () =>
	{
		// The intent this test always had, measured against the right thing.
		//
		// It used to compare the offset with the item's HALF SIZE, which is a size
		// and not a position - and `RoofItem` re-centres a second time on
		// `(max - min)` rather than `(max + min)`, deliberately, so its origin
		// lands on the TOP of the geometry and the fitting hangs from the ceiling
		// instead of being buried half in the slab. So "half the height down from
		// the origin" was the MIDDLE of the fitting, and the lamp sat 30cm up a
		// 60cm flex with the shade nowhere near it. The old assertion passed,
		// because it was written in the same wrong frame.
		const model = planWithCan({mount: 'pendant', drop: 60, diameter: 22});
		const item = model.scene.getItems()[0];
		const box = boxOf(item);
		const at = fixturesOn(item)[0].position;

		expect(at.y).toBeLessThan(0);
		// In the shade, which is the bottom of the fitting and not the middle.
		expect(at.y).toBeLessThan(box.min.y + 2);
		expect(at.y).toBeGreaterThan(box.min.y - 2);
	});

	it('puts a flush fitting lamp at its aperture, clear of its own body', () =>
	{
		// The reported bug: an all-round ceiling fitting lit nothing. Its lamp was
		// 2.2cm down inside a 4.4cm drum, so the fitting emitted into the inside of
		// itself. A spot aimed down mostly escaped and looked fine, which is why
		// this survived until somebody asked for `diffuse`.
		for (const mount of ['recessed', 'surface'])
		{
			const item = planWithCan({mount, throw: 'diffuse'}).scene.getItems()[0];
			const box = boxOf(item);
			const at = fixturesOn(item)[0].position;

			expect(at.y, `${mount} lamp is inside its own body`).toBeLessThan(box.min.y);
			// And only just: a lamp hanging a hand's width under a recessed can is
			// a pendant, not a can.
			expect(at.y).toBeGreaterThan(box.min.y - 2);
		}
	});

	it('does not let a fitting shadow its own lamp', () =>
	{
		// Even at the aperture, a fitting that casts would occlude a light sitting
		// against it. Same argument `InWallItem` makes about a window sealing its
		// own opening, and the same fix - what is lost is the shadow of a light
		// fitting, which nobody has ever looked for in a kitchen.
		const item = planWithCan({mount: 'surface', throw: 'diffuse'}).scene.getItems()[0];
		expect(item.castShadow).toBe(false);
	});

	it('still casts for everything that is not a light', () =>
	{
		// The opt-out is per kind, not a relaxed default: a cabinet that stopped
		// shadowing would take the daylight work with it.
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: PLAN,
			items: [{
				id: 'c1', item_name: 'Base Cabinet', item_type: 9, format: 'generated',
				model_url: 'generated:cabinet', xpos: 200, ypos: 44, zpos: 150, rotation: 0,
				scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
				spec: {kind: 'cabinet', variant: 'base', width: 60.96},
			}],
		}));
		expect(model.scene.getItems()[0].castShadow).toBe(true);
	});

	it('draws a different fitting for each mount', () =>
	{
		const extent = (mount) =>
		{
			const built = buildFixture({mount, diameter: 20, drop: 50});
			built.geometry.computeBoundingBox();
			return built.geometry.boundingBox.getSize(new Vector3());
		};
		// A pendant hangs; a can does not.
		expect(extent('pendant').y).toBeGreaterThan(40);
		expect(extent('recessed').y).toBeLessThan(2);
		// A strip is long and thin rather than round.
		expect(extent('under-cabinet').x).toBeGreaterThan(extent('under-cabinet').z * 3);
	});
});

describe('a strip is one length, not two', () =>
{
	const spanOf = (spec) =>
	{
		const built = buildFixture(spec);
		built.geometry.computeBoundingBox();
		return built.geometry.boundingBox.getSize(new Vector3()).x;
	};

	it('draws the bar the length the fixture says it is', () =>
	{
		// The bar was drawn from `diameter * 6` while `emittersFor` spread its
		// sources over `length`, so the strip you could see and the light it cast
		// were two different fixtures. They agreed only by coincidence: 4in of
		// trim times six is 61cm, which is the 60cm default to within a rounding
		// error, so the default looked right and nothing else did.
		expect(spanOf({mount: 'under-cabinet', length: 120})).toBeCloseTo(120, 0);
		expect(spanOf({mount: 'toe-kick', length: 45})).toBeCloseTo(45, 0);
	});

	it('does not resize a strip when the trim size changes', () =>
	{
		// A trim diameter is what a round fitting is bought by and means nothing
		// on a strip, which is why the panel now asks each mount for the dimension
		// it actually has. Before this, "Trim size 20" drew a 120cm bar lighting
		// 60cm of worktop.
		const plain = spanOf({mount: 'under-cabinet', length: 90});
		expect(spanOf({mount: 'under-cabinet', length: 90, diameter: 40})).toBeCloseTo(plain, 3);
		expect(spanOf({mount: 'under-cabinet', length: 90, diameter: 4})).toBeCloseTo(plain, 3);
	});

	it('keeps every emitter under the bar you can see', () =>
	{
		// The invariant the two halves have to share: a source outside the fitting
		// is a light with nothing emitting it, which reads as a glow off the end
		// of the strip.
		const length = 150;
		const fixture = normaliseFixture({mount: 'under-cabinet', length});
		const half = spanOf({mount: 'under-cabinet', length}) / 2;
		const spread = emittersFor(fixture).map((e) => e.dx);
		for (const dx of spread)
		{
			expect(Math.abs(dx)).toBeLessThan(half);
		}
		// And spanning it, rather than huddled in the middle.
		expect(Math.max(...spread)).toBeGreaterThan(half * 0.5);
	});

	it('adds segments as the strip gets longer, up to a budget', () =>
	{
		// A fixed count was right while 60cm was the only length there was. Now
		// that a panel can ask for a 3m run, three sources under it would bring
		// back the scalloping the row exists to prevent - and the fault would get
		// worse the longer the strip, which is the opposite of what somebody
		// lengthening one expects.
		const segments = (length) => normaliseFixture({mount: 'under-cabinet', length}).segments;
		// The density the mount was written with: three over 60cm, one every 20.
		expect(segments(60)).toBe(MOUNT_DEFAULTS['under-cabinet'].segments);
		expect(segments(120)).toBeGreaterThan(segments(60));
		// Each segment is a real light and nothing downstream caps how many one
		// fixture may add, so the fixture caps itself.
		expect(segments(300)).toBe(MAX_STRIP_SEGMENTS);
		expect(normaliseFixture({mount: 'under-cabinet', length: 300, segments: 40}).segments)
			.toBe(MAX_STRIP_SEGMENTS);
		// And a count the record states is still its own answer.
		expect(normaliseFixture({mount: 'under-cabinet', length: 300, segments: 2}).segments).toBe(2);
	});

	it('shares one output however many segments it is cut into', () =>
	{
		// Lengthening a strip must not brighten the room: a longer fitting spreads
		// the same lamp further, and a count that multiplied the output would make
		// `length` a second brightness control.
		const total = (length) => emittersFor(normaliseFixture({mount: 'under-cabinet',
			length, lumens: 300})).reduce((sum, e) => sum + e.lumens, 0);
		expect(total(60)).toBeCloseTo(300, 6);
		expect(total(300)).toBeCloseTo(300, 6);
	});
});

describe('lights are switched in banks, the way a house is wired', () =>
{
	it('puts a fixture on the bank its mount implies', () =>
	{
		// Nobody wires a kitchen one lamp at a time. The cans go on one switch, the
		// sconces on another, the worktop strips on a third by the door - so the
		// mount is the default answer to "which switch".
		expect(circuitOf(normaliseFixture({mount: 'recessed'}))).toBe('ceiling');
		expect(circuitOf(normaliseFixture({mount: 'pendant'}))).toBe('ceiling');
		expect(circuitOf(normaliseFixture({mount: 'wall'}))).toBe('wall');
		expect(circuitOf(normaliseFixture({mount: 'under-cabinet'}))).toBe('task');
		expect(circuitOf(normaliseFixture({mount: 'toe-kick'}))).toBe('accent');
	});

	it('lets a design name its own circuits instead', () =>
	{
		// `group` has been on the record since it was written - "a switch bank, so
		// a design can name its own circuits" - and nothing read it until now.
		expect(circuitOf(normaliseFixture({mount: 'recessed', group: 'island'})))
			.toBe('island');
	});

	it('offers a switch only for the banks the design has', () =>
	{
		// Four dead toggles in a design with one lamp is worse than no panel. The
		// list is derived from what is placed, so a switch appears with the first
		// fixture on it.
		expect(circuitsIn([])).toEqual([]);

		const found = circuitsIn([
			{fixture: normaliseFixture({mount: 'recessed'})},
			{fixture: normaliseFixture({mount: 'recessed'})},
			{fixture: normaliseFixture({mount: 'under-cabinet'})},
		]);
		expect(found.map((one) => one.id)).toEqual(['ceiling', 'task']);
		expect(found[0].count).toBe(2);
		expect(found[0].label).toBe('Overheads');
	});

	it('keeps the order stable, so a switch does not move under a finger', () =>
	{
		// Added in one order, listed in another: the known banks in their own
		// order, then anything a design named, alphabetically.
		const found = circuitsIn([
			{fixture: normaliseFixture({mount: 'recessed', group: 'zone-b'})},
			{fixture: normaliseFixture({mount: 'toe-kick'})},
			{fixture: normaliseFixture({mount: 'recessed'})},
			{fixture: normaliseFixture({mount: 'recessed', group: 'island'})},
			{fixture: normaliseFixture({mount: 'wall'})},
		]);
		expect(found.map((one) => one.id)).toEqual(
			['ceiling', 'wall', 'accent', 'island', 'zone-b']);
	});
});

describe('a switched-off bank is not in the scene at all', () =>
{
	let scene;
	let fixtures;

	beforeEach(() =>
	{
		scene = new Scene();
		fixtures = new Fixtures(scene, STUDIO);
	});

	const TWO_BANKS = [
		{id: 'can', mount: 'recessed', position: {x: 0, y: 240, z: 0}},
		{id: 'strip', mount: 'under-cabinet', position: {x: 0, y: 140, z: 0}},
	];

	it('drops the emitters of a bank that is off and keeps the rest', () =>
	{
		fixtures.sync(modelWith(TWO_BANKS));
		expect(fixtures.groups).toHaveLength(2);

		fixtures.switchedOff = new Set(['ceiling']);
		fixtures.sync(modelWith(TWO_BANKS));
		expect(fixtures.groups).toHaveLength(1);
		expect(fixtures._byId.has('strip')).toBe(true);
		expect(fixtures._byId.has('can')).toBe(false);
	});

	it('still lists a bank it has switched off', () =>
	{
		// A switch that vanished when you used it would be a switch you could not
		// turn back on.
		fixtures.switchedOff = new Set(['ceiling', 'task']);
		fixtures.sync(modelWith(TWO_BANKS));
		expect(fixtures.groups).toHaveLength(0);
		expect(fixtures.circuits.map((one) => one.id)).toEqual(['ceiling', 'task']);
	});

	it('comes back exactly as it was when the bank is switched on again', () =>
	{
		// The switch is a way of LOOKING at the design and not a change to it, so
		// there is nothing to restore and nothing that can be lost.
		fixtures.sync(modelWith(TWO_BANKS));
		const before = fixtures.groups.length;

		fixtures.switchedOff = new Set(['ceiling']);
		fixtures.sync(modelWith(TWO_BANKS));
		fixtures.switchedOff = new Set();
		fixtures.sync(modelWith(TWO_BANKS));

		expect(fixtures.groups).toHaveLength(before);
	});

	it('does not switch on a lamp the DESIGN says is off', () =>
	{
		// Two different questions with one answer each: `on` is what the record
		// says, and the circuit is what the viewer is doing. Neither overrides the
		// other, so an off lamp on a live bank stays off.
		fixtures.switchedOff = new Set();
		fixtures.sync(modelWith([
			{id: 'dead', mount: 'recessed', on: false, position: {x: 0, y: 240, z: 0}},
		]));
		expect(fixtures.groups).toHaveLength(0);
	});
});
