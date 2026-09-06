/**
 * Phase 0: the pieces every generated item is built on.
 *
 * Three small units with no renderer between them - the material library, the
 * colour-temperature curve and the frame clock. Each is testable on its own
 * precisely because none of them needs a GPU, which is the point of putting them
 * in `core` rather than inside the feature that first wanted them.
 */
import {describe, it, expect} from 'vitest';
import {MATERIALS, createMaterial, materialOptions, materialsForSlots,
	FALLBACK_MATERIAL} from '../src/scripts/core/materials.js';
import {kelvinToRgb, kelvinToColor, COMMON_TEMPERATURES,
	MIN_KELVIN, MAX_KELVIN} from '../src/scripts/core/color_temperature.js';
import {FrameClock} from '../src/scripts/three/frame_clock.js';

describe('the material library', () =>
{
	it('describes a surface, not just a colour', () =>
	{
		// The gap this closes: a tint cannot tell white paint from white lacquer
		// from white quartz. Same colour, three surfaces, and the whole difference
		// is roughness and metalness.
		const paint = createMaterial('paint-white');
		const lacquer = createMaterial('lacquer-white');
		const quartz = createMaterial('stone-quartz-white');
		const roughness = [paint.roughness, lacquer.roughness, quartz.roughness];
		expect(new Set(roughness).size).toBe(3);
		expect(createMaterial('metal-brass').metalness).toBe(1);
		expect(paint.metalness).toBe(0);
	});

	it('carries the id it came from, so a rebuild can read back what was asked', () =>
	{
		expect(createMaterial('wood-walnut').userData.materialId).toBe('wood-walnut');
	});

	it('falls back rather than throwing on an id this build has retired', () =>
	{
		// A saved design outlives the library. It should open looking wrong, not
		// refuse to open.
		expect(createMaterial('nope').userData.materialId).toBe(FALLBACK_MATERIAL);
	});

	it('hands out fresh instances, never a shared one', () =>
	{
		// Sharing is a disposal bug waiting to happen: Item.removed() disposes the
		// materials its geometry carries, so a shared instance dies with whichever
		// item goes first and leaves the other drawing with a dead handle.
		const a = createMaterial('paint-navy');
		const b = createMaterial('paint-navy');
		expect(a).not.toBe(b);
		a.dispose();
		expect(b.color.getHexString()).toBe('2f3d50');
	});

	it('names materials uniquely, because mergeMeshes pools by name', () =>
	{
		const labels = Object.values(MATERIALS).map((m) => m.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it('offers its list for a picker, filterable by group', () =>
	{
		expect(materialOptions().length).toBe(Object.keys(MATERIALS).length);
		const metals = materialOptions('metal');
		expect(metals.length).toBeGreaterThan(0);
		expect(metals.every((m) => m.group === 'metal')).toBe(true);
	});

	it('keeps a builder default for any slot the spec does not name', () =>
	{
		const slots = materialsForSlots({leaf: 'wood-walnut'},
			{frame: 'paint-white', leaf: 'paint-white', hardware: 'metal-brass'});
		expect(slots.leaf.userData.materialId).toBe('wood-walnut');
		expect(slots.frame.userData.materialId).toBe('paint-white');
		expect(slots.hardware.userData.materialId).toBe('metal-brass');
	});
});

describe('colour temperature', () =>
{
	it('runs warm at the bottom and cool at the top', () =>
	{
		const warm = kelvinToRgb(2200);
		const cool = kelvinToRgb(6500);
		// A candle is red-heavy and blue-poor; that ordering is the whole point.
		expect(warm.r).toBeGreaterThan(warm.b);
		expect(cool.b).toBeGreaterThan(warm.b);
		expect(warm.r / warm.b).toBeGreaterThan(cool.r / cool.b);
	});

	it('is near white around 6500K', () =>
	{
		const white = kelvinToRgb(6500);
		expect(white.r).toBeGreaterThan(0.95);
		expect(white.g).toBeGreaterThan(0.9);
		expect(white.b).toBeGreaterThan(0.9);
	});

	it('moves monotonically in blue across the range people will drag', () =>
	{
		let previous = -1;
		for (let k = 2000; k <= 6500; k += 250)
		{
			const b = kelvinToRgb(k).b;
			expect(b).toBeGreaterThanOrEqual(previous);
			previous = b;
		}
	});

	it('stays in gamut for anything a slider can produce', () =>
	{
		for (const k of [0, -100, 1000, 2700, 5000, 20000, NaN])
		{
			const rgb = kelvinToRgb(k);
			for (const c of [rgb.r, rgb.g, rgb.b])
			{
				expect(c).toBeGreaterThanOrEqual(0);
				expect(c).toBeLessThanOrEqual(1);
			}
		}
	});

	it('clamps out of range rather than throwing', () =>
	{
		expect(kelvinToRgb(50)).toEqual(kelvinToRgb(MIN_KELVIN));
		expect(kelvinToRgb(99999)).toEqual(kelvinToRgb(MAX_KELVIN));
	});

	it('offers the temperatures fixtures are actually sold in', () =>
	{
		const kelvins = COMMON_TEMPERATURES.map((t) => t.kelvin);
		expect(kelvins).toContain(2700);
		expect(kelvins).toContain(3000);
		expect(kelvins).toContain(5000);
	});

	it('writes into a Color a caller already owns', () =>
	{
		const target = kelvinToColor(2700);
		const same = kelvinToColor(4000, target);
		expect(same).toBe(target);
	});
});

describe('the frame clock', () =>
{
	it('reports seconds, not milliseconds or frames', () =>
	{
		const clock = new FrameClock();
		expect(clock.tick(1000)).toBe(0);
		expect(clock.tick(1016)).toBeCloseTo(0.016, 5);
	});

	it('runs its updaters with the delta and the total', () =>
	{
		const clock = new FrameClock();
		const seen = [];
		clock.add((delta, elapsed) => seen.push([delta, elapsed]));
		clock.tick(0);
		clock.tick(20);
		clock.tick(40);
		expect(seen).toHaveLength(2);
		expect(seen[1][1]).toBeCloseTo(0.04, 5);
	});

	it('caps a huge delta, so a backgrounded tab does not jump the scene', () =>
	{
		// A tab that was away for a minute hands back a 60-second first frame, and
		// anything integrating it spins through a whole revolution at once.
		const clock = new FrameClock();
		clock.tick(0);
		expect(clock.tick(60000)).toBeLessThanOrEqual(0.066);
	});

	it('skips the gap after a reset instead of banking it', () =>
	{
		const clock = new FrameClock();
		clock.tick(0);
		clock.tick(16);
		clock.reset();
		expect(clock.tick(9999)).toBe(0);
	});

	it('lets an updater unsubscribe itself mid-tick', () =>
	{
		// Splicing the array being iterated skips the neighbour, which is the kind
		// of bug that shows up as every other fan stopping.
		const clock = new FrameClock();
		const ran = [];
		const stop = clock.add(() => {ran.push('a'); stop();});
		clock.add(() => ran.push('b'));
		clock.tick(0);
		clock.tick(16);
		expect(ran).toEqual(['a', 'b']);
		clock.tick(32);
		expect(ran).toEqual(['a', 'b', 'b']);
	});

	it('drops everything on dispose, so a spent viewer frees its scene', () =>
	{
		const clock = new FrameClock();
		let runs = 0;
		clock.add(() => {runs++;});
		clock.tick(0);
		clock.tick(16);
		expect(runs).toBe(1);
		clock.dispose();
		clock.tick(32);
		clock.tick(48);
		expect(runs).toBe(1);
	});
});
