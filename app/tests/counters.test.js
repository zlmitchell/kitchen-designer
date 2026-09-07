/**
 * Countertops (ROADMAP.md phase 2).
 *
 * The thing worth testing hardest is the cutout, because a sink is a cutout plus
 * a basin and everything in phase 2's back half depends on this being right -
 * and because a hole that goes wrong here goes wrong SILENTLY, the same way a
 * wall opening does.
 */
import {describe, it, expect} from 'vitest';
import {Vector3} from 'three';
import {buildCounter} from '../src/scripts/items/generated/counter.js';

const bounds = (built) =>
{
	built.geometry.computeBoundingBox();
	return built.geometry.boundingBox;
};
const size = (built) => bounds(built).getSize(new Vector3());
const verts = (built) => built.geometry.attributes.position.count;


describe('a counter is a slab', () =>
{
	it('comes out the size asked for, whatever the edge profile', () =>
	{
		// A bevel grows a shape outward, so the outline is inset by it first. Skip
		// that and a 96in top with a bullnose comes out 96in plus two bevels, and
		// the number you typed is not the number you get.
		for (const edge of ['square', 'eased', 'bullnose'])
		{
			const s = size(buildCounter({edge, backsplash: 0}));
			expect(s.x, `${edge} length`).toBeCloseTo(243.84, 2);
			expect(s.z, `${edge} depth`).toBeCloseTo(63.5, 2);
			expect(s.y, `${edge} thickness`).toBeCloseTo(3.81, 2);
		}
	});

	it('spends geometry on the profile, and only on the profile', () =>
	{
		// square < eased < bullnose, in the same envelope.
		const square = buildCounter({edge: 'square', backsplash: 0});
		const eased = buildCounter({edge: 'eased', backsplash: 0});
		const bull = buildCounter({edge: 'bullnose', backsplash: 0});
		expect(verts(eased)).toBeGreaterThan(verts(square));
		expect(verts(bull)).toBeGreaterThan(verts(eased));
	});

	it('is centred, like every generated part', () =>
	{
		const centre = bounds(buildCounter({})).getCenter(new Vector3());
		expect(centre.x).toBeCloseTo(0, 4);
		expect(centre.y).toBeCloseTo(0, 4);
		expect(centre.z).toBeCloseTo(0, 4);
	});

	it('stands the backsplash ON the slab, not through it', () =>
	{
		// It was centred on `backsplash / 2` while the extrusion runs upward from
		// zero, so the splash started at the slab's underside and passed through
		// its own worktop. It measured as a counter 10.36cm tall instead of 13.97.
		const plain = size(buildCounter({edge: 'square', backsplash: 0}));
		const splashed = size(buildCounter({edge: 'square', backsplash: 10.16}));
		expect(splashed.y).toBeCloseTo(plain.y + 10.16, 2);
	});

	it('puts the backsplash at the back, where the wall is', () =>
	{
		// -z, matching the cabinet: its carcass back is at -z and its face at +z.
		const built = buildCounter({edge: 'square', backsplash: 10.16});
		const box = bounds(built);
		const position = built.geometry.getAttribute('position');
		let highestZ = 0;
		let highest = -Infinity;
		for (let i = 0; i < position.count; i++)
		{
			if (position.getY(i) > highest)
			{
				highest = position.getY(i);
				highestZ = position.getZ(i);
			}
		}
		expect(highestZ).toBeLessThan(0);
		expect(highest).toBeCloseTo(box.max.y, 3);
	});
});

describe('cutouts, which is what a sink needs', () =>
{
	it('actually removes material', () =>
	{
		const solid = buildCounter({edge: 'square', backsplash: 0});
		const cut = buildCounter({edge: 'square', backsplash: 0,
			cutouts: [{x: 0, z: 0, width: 76, depth: 46}]});
		// A hole adds geometry rather than removing it - it has walls.
		expect(verts(cut)).toBeGreaterThan(verts(solid));
		// And the slab is the same size: a hole is not a resize.
		expect(size(cut).x).toBeCloseTo(size(solid).x, 3);
	});

	it('walls the hole, so an undermount sink has a cut edge to show', () =>
	{
		// The slab has to show polished thickness at the cut. A cutout made by
		// hiding triangles would show paper.
		const cut = buildCounter({edge: 'square', backsplash: 0,
			cutouts: [{x: 0, z: 0, width: 76, depth: 46}]});
		const position = cut.geometry.getAttribute('position');
		const box = bounds(cut);
		// Vertices near the hole's edge exist at BOTH the top and bottom of the
		// slab, which is what a walled hole means.
		let atTop = 0;
		let atBottom = 0;
		for (let i = 0; i < position.count; i++)
		{
			const x = position.getX(i);
			const z = position.getZ(i);
			const onHoleEdge = Math.abs(Math.abs(x) - 38) < 1 && Math.abs(z) < 24;
			if (!onHoleEdge) {continue;}
			if (Math.abs(position.getY(i) - box.max.y) < 0.1) {atTop++;}
			if (Math.abs(position.getY(i) - box.min.y) < 0.1) {atBottom++;}
		}
		expect(atTop).toBeGreaterThan(0);
		expect(atBottom).toBeGreaterThan(0);
	});

	it('takes more than one', () =>
	{
		// A sink and a hob in the same run.
		const one = buildCounter({edge: 'square', backsplash: 0,
			cutouts: [{x: -60, width: 76, depth: 46}]});
		const two = buildCounter({edge: 'square', backsplash: 0,
			cutouts: [{x: -60, width: 76, depth: 46}, {x: 60, width: 76, depth: 46}]});
		expect(verts(two)).toBeGreaterThan(verts(one));
	});

	it('puts a forward cutout forward', () =>
	{
		// The shape's y becomes the world's -z, so a cutout asked for toward the
		// front came out toward the back. Invisible on a sink centred front to
		// back, and wrong on everything else - a hob sits forward.
		const built = buildCounter({edge: 'square', backsplash: 0,
			cutouts: [{x: 0, z: 20, width: 40, depth: 20}]});
		const position = built.geometry.getAttribute('position');
		let lo = Infinity;
		let hi = -Infinity;
		for (let i = 0; i < position.count; i++)
		{
			if (Math.abs(position.getX(i)) < 21)
			{
				lo = Math.min(lo, position.getZ(i));
				hi = Math.max(hi, position.getZ(i));
			}
		}
		// Asked for a 20cm-deep hole centred at +20, so it spans 10..30.
		expect((lo + hi) / 2).toBeCloseTo(20, 0);
	});

	it('refuses a hole that would reach the edge, rather than losing the lot', () =>
	{
		// `triangulateShape` discards a hole that strays outside its contour
		// silently, in full - the same trap the wall openings hit. A cutout wider
		// than the slab is clamped inside it instead.
		const oversize = buildCounter({edge: 'square', backsplash: 0, width: 100, depth: 60,
			cutouts: [{x: 0, z: 0, width: 500, depth: 500}]});
		// Still a slab, still the right size, and still holed.
		expect(size(oversize).x).toBeCloseTo(100, 2);
		expect(verts(oversize)).toBeGreaterThan(verts(
			buildCounter({edge: 'square', backsplash: 0, width: 100, depth: 60})));
	});

	it('drops a hole too small to be one', () =>
	{
		const built = buildCounter({edge: 'square', backsplash: 0,
			cutouts: [{x: 0, z: 0, width: 0.2, depth: 0.2}]});
		const plain = buildCounter({edge: 'square', backsplash: 0});
		expect(verts(built)).toBe(verts(plain));
	});
});

describe('a counter is finished from the material library', () =>
{
	it('takes a different material for the splash', () =>
	{
		// A tiled splash and a stone one are both normal, and they are not the
		// same decision as the surface.
		const built = buildCounter({backsplash: 10.16,
			material: {counter: 'stone-soapstone', splash: 'paint-white'}});
		const ids = built.materials.map((m) => m.userData.materialId).sort();
		expect(ids).toEqual(['paint-white', 'stone-soapstone']);
	});

	it('pools to one material when both slots match', () =>
	{
		// mergeMeshes pools by name, so the common case is one draw call.
		const built = buildCounter({backsplash: 10.16});
		expect(built.materials).toHaveLength(1);
	});
});
