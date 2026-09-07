/**
 * Sinks (ROADMAP.md phase 2).
 *
 * The design claim under test is that five mounts are ONE builder with the bowl
 * at a different height against the slab, plus at most one extra piece - not
 * five models. So most of these compare two mounts rather than measuring one.
 */
import {describe, it, expect} from 'vitest';
import {Vector3} from 'three';
import {buildSink} from '../src/scripts/items/generated/sink.js';

const bounds = (built) =>
{
	built.geometry.computeBoundingBox();
	return built.geometry.boundingBox;
};
const size = (built) => bounds(built).getSize(new Vector3());
const verts = (built) => built.geometry.attributes.position.count;

/**
 * How far in from the outer edge the innermost wall sits, at the rim.
 *
 * This is the wall thickness, measured off the geometry rather than read back
 * from the constant - which is the point, since the claim is that the material
 * decides it and that you can see the difference.
 */
function wallAtRim(built)
{
	const box = bounds(built);
	const position = built.geometry.getAttribute('position');
	let innermost = 0;
	for (let i = 0; i < position.count; i++)
	{
		// Near the top, on the right-hand side.
		if (position.getY(i) > box.max.y - 1 && position.getX(i) > 0)
		{
			if (innermost === 0 || position.getX(i) < innermost) {innermost = position.getX(i);}
		}
	}
	return box.max.x - innermost;
}

describe('the mounts are one builder', () =>
{
	it('gives a drop-in a rim that a cutout can rest on, and an undermount none', () =>
	{
		// The visible lip all the way round is what makes a drop-in read as one.
		// It is also why its cutout is the UNDERSIZED case - the one that catches
		// a sign error.
		const under = buildSink({mount: 'undermount'});
		const drop = buildSink({mount: 'drop-in'});
		expect(size(drop).x).toBeGreaterThan(size(under).x);
		expect(size(drop).z).toBeGreaterThan(size(under).z);
		expect(verts(drop)).toBeGreaterThan(verts(under));
	});

	it('gives a farmhouse an apron and nothing else does', () =>
	{
		// The apron replaces the cabinet front below it, which is what makes this
		// a phase 3 dependency rather than only a cutout.
		const farm = buildSink({mount: 'farmhouse'});
		const under = buildSink({mount: 'undermount'});
		expect(size(farm).z).toBeGreaterThan(size(under).z);
		expect(verts(farm)).toBeGreaterThan(verts(under));
	});

	it('makes a vessel exactly its own bowl', () =>
	{
		// It stands wholly above the slab, so nothing is added and nothing hangs
		// below - the envelope is the bowl.
		const vessel = buildSink({mount: 'vessel', shape: 'round',
			width: 41, frontToBack: 41, depth: 14});
		const s = size(vessel);
		expect(s.x).toBeCloseTo(41, 0);
		expect(s.z).toBeCloseTo(41, 0);
		expect(s.y).toBeCloseTo(14, 0);
	});

	it('leaves the undermount envelope to the bowl alone', () =>
	{
		const under = buildSink({mount: 'undermount', width: 76.2, frontToBack: 47});
		expect(size(under).x).toBeCloseTo(76.2, 1);
		expect(size(under).z).toBeCloseTo(47, 1);
	});

	it('is centred, like every generated part', () =>
	{
		const centre = bounds(buildSink({})).getCenter(new Vector3());
		expect(centre.x).toBeCloseTo(0, 3);
		expect(centre.y).toBeCloseTo(0, 3);
		expect(centre.z).toBeCloseTo(0, 3);
	});
});

describe('shape is a real geometry fork', () =>
{
	it('lathes a round bowl instead of panelling it', () =>
	{
		// A revolved profile carries radius, wall, floor and rim in one object, so
		// it is far denser than four boxes - and shorter to write.
		const rect = buildSink({shape: 'rect'});
		const round = buildSink({shape: 'round', width: 41, frontToBack: 41, depth: 14});
		expect(verts(round)).toBeGreaterThan(verts(rect));
	});

	it('makes an oval the same lathe, squeezed on one axis', () =>
	{
		const round = buildSink({mount: 'vessel', shape: 'round',
			width: 50, frontToBack: 50, depth: 14});
		const oval = buildSink({mount: 'vessel', shape: 'oval',
			width: 50, frontToBack: 35, depth: 14});
		// Same geometry, so the same vertex count...
		expect(verts(oval)).toBe(verts(round));
		// ...and only the front-to-back changes.
		expect(size(oval).x).toBeCloseTo(size(round).x, 1);
		expect(size(oval).z).toBeLessThan(size(round).z);
		expect(size(oval).z).toBeCloseTo(35, 0);
	});
});

describe('bowls split the width', () =>
{
	it('builds two bowls where one was asked for one', () =>
	{
		const single = buildSink({bowls: [1]});
		const double = buildSink({bowls: [0.5, 0.5]});
		expect(verts(double)).toBeGreaterThan(verts(single));
		// Same sink, still: a bowl split is not a resize.
		expect(size(double).x).toBeCloseTo(size(single).x, 2);
	});

	it('takes an offset double', () =>
	{
		// 60/40 is a normal thing to want and is not two equal bowls.
		const even = buildSink({bowls: [0.5, 0.5]});
		const offset = buildSink({bowls: [0.6, 0.4]});
		expect(verts(offset)).toBe(verts(even));
		expect(size(offset).x).toBeCloseTo(size(even).x, 2);
	});

	it('survives a nonsense split rather than producing nothing', () =>
	{
		const built = buildSink({bowls: [0, 0]});
		expect(verts(built)).toBeGreaterThan(0);
		expect(size(built).x).toBeCloseTo(76.2, 1);
	});
});

describe('the material decides the wall', () =>
{
	it('makes a stainless bowl visibly thinner than a fireclay one', () =>
	{
		// A 2mm pressed bowl and a 25mm fireclay one are not the same object in a
		// different colour, and the thinness is the thing you actually see.
		// Stainless is the one to build first for exactly that reason.
		const steel = buildSink({material: {basin: 'metal-stainless'}});
		const clay = buildSink({material: {basin: 'paint-white'}});
		expect(wallAtRim(steel)).toBeLessThan(wallAtRim(clay));
		// Same envelope: thickness is interior.
		expect(size(steel).x).toBeCloseTo(size(clay).x, 2);
	});

	it('falls back to a sensible wall for a finish with no entry', () =>
	{
		const exotic = buildSink({material: {basin: 'wood-walnut'}});
		expect(wallAtRim(exotic)).toBeGreaterThan(0);
		expect(verts(exotic)).toBeGreaterThan(0);
	});

	it('takes a different material for the apron', () =>
	{
		const built = buildSink({mount: 'farmhouse',
			material: {basin: 'metal-stainless', apron: 'paint-navy'}});
		const ids = built.materials.map((m) => m.userData.materialId).sort();
		expect(ids).toContain('metal-stainless');
		expect(ids).toContain('paint-navy');
	});
});

describe('the basin is a basin', () =>
{
	it('has a drain in it, and can be told not to', () =>
	{
		// Sloping the floor to a waste costs nothing and is the difference between
		// a basin and a hole.
		const withDrain = buildSink({drain: true});
		const without = buildSink({drain: false});
		expect(verts(withDrain)).toBeGreaterThan(verts(without));
	});

	it('has no children, because nothing on it moves', () =>
	{
		expect(buildSink({}).parts).toEqual([]);
	});
});
