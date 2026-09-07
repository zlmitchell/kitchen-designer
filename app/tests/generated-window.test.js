/**
 * The generated window.
 *
 * Why this exists at all: `whitewindow.glb` is 123.0769cm wide and there is no
 * other width you can have. `extract.py` writes `scale_x = width_cm / 123.0769`
 * for every window on the traced plan, so a 24in window is the same model
 * squeezed to half size - frame, sash, muntins and all - and a 6ft one is it
 * stretched to 1.5x. Every assertion below that measures a MEMBER rather than
 * an overall size is guarding against that: a wider window has a wider pane and
 * the same stiles.
 */
import {describe, it, expect} from 'vitest';
import {Box3, Vector3} from 'three';
import {buildWindow, sashLayout, fullHeightFor} from '../src/scripts/items/generated/window.js';
import {grilleBars} from '../src/scripts/items/generated/opening.js';
import {generatedKind, GENERATED_BUILDERS, GENERATED_SCHEMAS} from '../src/scripts/items/generated/index.js';

/** A 36 x 60in double hung on a 32in sill, in a 2x4 wall. What the plan has. */
const SPEC = {kind: 'window', width: 91.44, height: 152.4, sillHeight: 81.28,
	wallThickness: 11.43, type: 'double-hung'};

/** World-space bounds of a part, after its own transforms. */
function boundsOf(object)
{
	object.updateMatrixWorld(true);
	return new Box3().setFromObject(object);
}

/** Every mesh under a built window's children, flattened. */
function meshesOf(built)
{
	const found = [];
	built.parts.forEach((part) => part.traverse((o) => {if (o.isMesh) {found.push(o);}}));
	return found;
}

function namedPart(built, name)
{
	return built.parts.find((p) => p.name === name);
}

describe('the generated window', () =>
{
	it('is registered as a builder, with a schema beside it', () =>
	{
		expect(generatedKind('generated:window')).toBe('window');
		expect(GENERATED_BUILDERS.window).toBe(buildWindow);
		expect(GENERATED_SCHEMAS.window.label).toBe('Window');
	});

	it('makes the item geometry the rough opening, with a sill a door has not', () =>
	{
		// The load-bearing one. three/edge.js cuts the wall's hole from
		// halfSize.x/.y, so the casing must not be merged in - it laps the wall
		// face, and a hole that wide shows daylight all round the opening.
		const built = buildWindow(SPEC);
		built.geometry.computeBoundingBox();
		const size = built.geometry.boundingBox.getSize(new Vector3());

		// Clear opening plus a liner on all FOUR sides. A door has three: it
		// stands on the floor.
		expect(size.x).toBeCloseTo(91.44 + 2 * 1.9, 3);
		expect(size.y).toBeCloseTo(152.4 + 2 * 1.9, 3);
		// The lining fills the wall exactly: no scaling, so a 2x4 and a 2x6 wall
		// both come out right.
		expect(size.z).toBeCloseTo(11.43, 3);
	});

	it('centres its geometry, so Item does not shift the sashes out from under it', () =>
	{
		// Item's constructor recentres geometry on its bounding box in all three
		// axes and does NOT recentre children, so authoring the lining off-centre
		// would move the lining and leave the glass behind.
		const built = buildWindow(SPEC);
		built.geometry.computeBoundingBox();
		const centre = built.geometry.boundingBox.getCenter(new Vector3());
		// Four places, not six: positions are float32 and a 156cm extent cannot
		// resolve better than a few microns.
		expect(centre.x).toBeCloseTo(0, 4);
		expect(centre.y).toBeCloseTo(0, 4);
		expect(centre.z).toBeCloseTo(0, 4);
	});

	it('keeps the sash and the casing out of the item geometry', () =>
	{
		const built = buildWindow(SPEC);
		expect(built.parts.filter((p) => p.name === 'window-casing')).toHaveLength(2);
		expect(namedPart(built, 'window-sash-lo')).toBeTruthy();
		expect(namedPart(built, 'window-sash-hi')).toBeTruthy();
	});

	it('widens the glass and not the stiles', () =>
	{
		// The whole reason this is generated. A scaled mesh gives a 1.8m window
		// stiles twice the width of a 0.9m one; a built one gives it the same
		// stiles and twice the glass.
		const sizes = [60.96, 182.88].map((width) =>
		{
			const built = buildWindow(Object.assign({}, SPEC, {width, type: 'fixed',
				material: {glass: 'glass-frosted'}}));
			const glass = meshesOf(built).find((m) => m.name === 'sash-glass');
			const stile = meshesOf(built)
				.filter((m) => m.material.userData.materialId === 'paint-white')
				// The sash members only - the casing is the same white, and pools
				// with them by name.
				.filter((m) => m.parent.name.startsWith('window-sash'))
				.map((m) => boundsOf(m).getSize(new Vector3()))
				.reduce((narrowest, s) => Math.min(narrowest, s.x), Infinity);
			return {glass: boundsOf(glass).getSize(new Vector3()).x, stile};
		});

		expect(sizes[1].glass - sizes[0].glass).toBeCloseTo(182.88 - 60.96, 1);
		expect(sizes[1].stile).toBeCloseTo(sizes[0].stile, 4);
	});

	it('fits the lining to the wall it is given, at any thickness', () =>
	{
		// The measured walls on this plan run 7.7 to 19cm. whitewindow.glb is
		// 14.75cm deep, so it stands proud of both faces of a 7.7cm wall and is
		// buried in a 19cm one - which is what `scale_z = thickness / 14.75` was
		// trying and failing to fix.
		for (const wallThickness of [7.7, 11.43, 18.41, 25.5])
		{
			const built = buildWindow(Object.assign({}, SPEC, {wallThickness}));
			built.geometry.computeBoundingBox();
			expect(built.geometry.boundingBox.getSize(new Vector3()).z).toBeCloseTo(wallThickness, 3);
			// And the sash keeps its own thickness rather than being squashed with
			// the lining.
			const sash = boundsOf(namedPart(built, 'window-sash-lo')).getSize(new Vector3());
			expect(sash.z).toBeGreaterThan(1.8);
		}
	});

	describe('the types are sash count and divide direction, and nothing else', () =>
	{
		it('gives a fixed light one sash and a hung or slider two', () =>
		{
			expect(sashLayout(specFor('fixed'))).toHaveLength(1);
			expect(sashLayout(specFor('picture'))).toHaveLength(1);
			expect(sashLayout(specFor('casement'))).toHaveLength(1);
			expect(sashLayout(specFor('awning'))).toHaveLength(1);
			expect(sashLayout(specFor('single-hung'))).toHaveLength(2);
			expect(sashLayout(specFor('double-hung'))).toHaveLength(2);
			expect(sashLayout(specFor('slider'))).toHaveLength(2);
		});

		it('offsets the two sashes ACROSS the wall and overlaps them along it', () =>
		{
			// The signature ROADMAP.md says a bypass gets wrong. Two leaves in one
			// plane cannot pass each other, and drawn that way a slider reads as a
			// single panel that magically clears its whole opening.
			for (const type of ['double-hung', 'slider'])
			{
				const [a, b] = sashLayout(specFor(type));
				expect(Math.abs(a.z - b.z), `${type} offsets across the wall`).toBeGreaterThan(1);
				const along = (type === 'slider')
					? a.width / 2 + b.width / 2 - Math.abs(a.x - b.x)
					: a.height / 2 + b.height / 2 - Math.abs(a.y - b.y);
				expect(along, `${type} overlaps along the wall`).toBeGreaterThan(0);
			}
		});

		it('never clears more than about half the opening, however far it is opened', () =>
		{
			// A hung sash slides past the other one; it does not vanish. Opened
			// fully, the glass still covers half the hole - which is the thing you
			// check by opening it, and the reason `openFraction` is worth having on
			// something that does not swing.
			for (const type of ['single-hung', 'double-hung', 'slider'])
			{
				const shut = buildWindow(Object.assign({}, specFor(type), {openFraction: 0}));
				const open = buildWindow(Object.assign({}, specFor(type), {openFraction: 1}));
				const moved = sashLayout(specFor(type)).filter((s) => s.moves);
				expect(moved.length, `${type} has something that moves`).toBeGreaterThan(0);
				moved.forEach((s) =>
				{
					const axis = (s.moves === 'slide-x') ? 'x' : 'y';
					const span = (axis === 'x') ? SPEC.width : SPEC.height;
					const before = boundsOf(namedPart(shut, s.name)).getCenter(new Vector3())[axis];
					const after = boundsOf(namedPart(open, s.name)).getCenter(new Vector3())[axis];
					expect(Math.abs(after - before), `${type} ${s.name} travels`).toBeGreaterThan(10);
					expect(Math.abs(after - before), `${type} ${s.name} clears at most half`)
						.toBeLessThanOrEqual(span / 2 + 0.01);
				});
			}
		});

		it('swings a casement clear of the wall and tips an awning out of it', () =>
		{
			// The same assertion the door needed, because it is the one open_door.glb
			// failed: a sash that opens has to LEAVE the wall. A 24in casement swung
			// 90 degrees projects about 60cm; the whole lining is 11.43cm deep.
			const shut = buildWindow(Object.assign({}, specFor('casement'), {openFraction: 0}));
			const open = buildWindow(Object.assign({}, specFor('casement'), {openFraction: 1}));
			expect(boundsOf(namedPart(shut, 'window-sash-pivot')).getSize(new Vector3()).z)
				.toBeLessThan(6);
			expect(boundsOf(namedPart(open, 'window-sash-pivot')).getSize(new Vector3()).z)
				.toBeGreaterThan(SPEC.width * 0.8);

			const awning = buildWindow(Object.assign({}, specFor('awning'), {openFraction: 1}));
			const tipped = boundsOf(namedPart(awning, 'window-sash-pivot'));
			// It tips out of the face `swing` names, which is -z by default.
			expect(tipped.min.z).toBeLessThan(-20);
			expect(tipped.max.z).toBeLessThan(6);
			// And it hangs BELOW the head it is hinged on, which is what separates
			// an awning from a hopper.
			expect(tipped.min.y).toBeLessThan(-SPEC.height / 4);
		});

		it('hinges a casement at the end the hand names', () =>
		{
			const lo = namedPart(buildWindow(Object.assign({}, specFor('casement'), {hand: 'lo'})),
				'window-sash-pivot');
			const hi = namedPart(buildWindow(Object.assign({}, specFor('casement'), {hand: 'hi'})),
				'window-sash-pivot');
			expect(lo.position.x).toBeLessThan(0);
			expect(hi.position.x).toBeGreaterThan(0);
			expect(lo.position.x).toBeCloseTo(-hi.position.x, 6);
		});

		it('puts one piece of ironmongery on the sash that moves, and none on a fixed light', () =>
		{
			// ON THE SASH, not in the frame. Authored in the frame's coordinates the
			// handle is left hanging in the middle of the empty opening as soon as
			// the casement swings away from it - which every measurement of its
			// position passes, because the triangles are exactly where they were
			// put. Only a render aimed at an open window shows it.
			const handles = (type) =>
			{
				const built = buildWindow(Object.assign({}, specFor(type),
					{openFraction: 1, material: {hardware: 'metal-matte-black'}}));
				return meshesOf(built).filter((m) => m.material.userData.materialId === 'metal-matte-black');
			};
			for (const type of ['single-hung', 'double-hung', 'casement', 'slider', 'awning'])
			{
				const found = handles(type);
				expect(found, `${type} has a handle`).toHaveLength(1);
				// Its ancestry is the sash, so it travels with it.
				expect(found[0].parent.name, `${type} handle rides the sash`).toMatch(/^window-sash/);
			}
			expect(handles('fixed')).toHaveLength(0);
			expect(handles('picture')).toHaveLength(0);
		});

		it('slides a slider toward the other sash, never out of the opening', () =>
		{
			// The mistake ROADMAP.md names, and the render caught it: slid the wrong
			// way the operable sash leaves the frame entirely and hangs in free air
			// beside the window. A measurement of TRAVEL passes either way.
			const opening = SPEC.width / 2;
			for (const hand of ['lo', 'hi'])
			{
				const built = buildWindow(Object.assign({}, specFor('slider'),
					{hand, openFraction: 1}));
				['window-sash-lo', 'window-sash-hi'].forEach((name) =>
				{
					const b = boundsOf(namedPart(built, name));
					expect(b.min.x, `${hand}: ${name} stays inside the left jamb`)
						.toBeGreaterThan(-opening - 1);
					expect(b.max.x, `${hand}: ${name} stays inside the right jamb`)
						.toBeLessThan(opening + 1);
				});
			}
		});

		it('does not let a double hung open into looking shut', () =>
		{
			// Given both sashes the full travel they simply swap ends, and every part
			// of the opening is still covered. Rendered, `openFraction: 1` was
			// indistinguishable from shut. Half the travel each is what leaves a gap
			// at the head AND at the sill.
			const spec = Object.assign({}, specFor('double-hung'), {openFraction: 1});
			const lo = boundsOf(namedPart(buildWindow(spec), 'window-sash-lo'));
			const hi = boundsOf(namedPart(buildWindow(spec), 'window-sash-hi'));
			const top = SPEC.height / 2;
			// Daylight above the upper sash and below the lower one.
			expect(top - hi.max.y, 'open at the head').toBeGreaterThan(20);
			expect(lo.min.y + top, 'open at the sill').toBeGreaterThan(20);
			// And they overlap in the middle rather than passing each other.
			expect(Math.min(lo.max.y, hi.max.y) - Math.max(lo.min.y, hi.min.y))
				.toBeGreaterThan(0);
		});
	});

	describe('the grille is four patterns, and three of them are not a grid', () =>
	{
		it('draws nothing at all for none', () =>
		{
			expect(grilleBars(100, 150, {pattern: 'none'})).toHaveLength(0);
			expect(grilleBars(100, 150)).toHaveLength(0);
		});

		it('gives a colonial one fewer bar than lights, on each axis', () =>
		{
			// rows x cols LIGHTS. A 2x2 colonial has one bar each way, not two, and
			// getting this off by one is how a 3x2 sash comes out with a muntin
			// sitting on the stile.
			const bars = grilleBars(100, 150, {pattern: 'colonial', rows: 3, cols: 2});
			expect(bars.filter((b) => b.vertical)).toHaveLength(1);
			expect(bars.filter((b) => !b.vertical)).toHaveLength(2);
			// Evenly spaced across the daylight opening, which is centred on zero.
			expect(bars.filter((b) => b.vertical)[0].pos).toBeCloseTo(0, 6);
			expect(bars.filter((b) => !b.vertical).map((b) => b.pos).sort((a, b) => a - b))
				.toEqual([-25, 25]);
			// A 1x1 colonial is a fixed light with no bars in it.
			expect(grilleBars(100, 150, {pattern: 'colonial', rows: 1, cols: 1})).toHaveLength(0);
		});

		it('makes a prairie a border, inset off the SHORTER side', () =>
		{
			// Four bars, not a grid, and the inset comes off the shorter dimension so
			// a wide sash does not get a border an inch deep one way and a foot the
			// other.
			const bars = grilleBars(200, 100, {pattern: 'prairie'});
			expect(bars).toHaveLength(4);
			const inset = 100 / 5;
			expect(bars.filter((b) => b.vertical).map((b) => b.pos).sort((a, b) => a - b))
				.toEqual([-100 + inset, 100 - inset]);
			expect(bars.filter((b) => !b.vertical).map((b) => b.pos).sort((a, b) => a - b))
				.toEqual([-50 + inset, 50 - inset]);
		});

		it('divides only a craftsman top light, and leaves the rest undivided', () =>
		{
			// The whole look. A craftsman sash divided all the way down is a
			// colonial, which is why the bars are returned as segments rather than
			// as lines.
			const bars = grilleBars(100, 160, {pattern: 'craftsman', cols: 3});
			const horizontal = bars.filter((b) => !b.vertical);
			const vertical = bars.filter((b) => b.vertical);
			expect(horizontal).toHaveLength(1);
			expect(horizontal[0].pos).toBeCloseTo(160 / 2 - 160 / 4, 6);
			expect(vertical).toHaveLength(2);
			vertical.forEach((bar) =>
			{
				expect(bar.from).toBeCloseTo(horizontal[0].pos, 6);
				expect(bar.to).toBeCloseTo(80, 6);
			});
		});

		it('stands the muntins proud of the glass, on both faces', () =>
		{
			// A solid swallows anything put inside it - the fault that made a vent
			// hood's filter render as nothing while its triangles were present and
			// correct. A muntin flush with the pane is a muntin nobody can see.
			const built = buildWindow(Object.assign({}, SPEC, {type: 'fixed',
				grille: {pattern: 'colonial', rows: 3, cols: 2},
				material: {glass: 'glass-frosted', grille: 'metal-matte-black'}}));
			const meshes = meshesOf(built);
			const glass = meshes.find((m) => m.name === 'sash-glass');
			const bars = meshes.filter((m) => m.material.userData.materialId === 'metal-matte-black');
			expect(bars).toHaveLength(3);

			const pane = boundsOf(glass);
			bars.forEach((bar) =>
			{
				const b = boundsOf(bar);
				expect(b.max.z).toBeGreaterThan(pane.max.z);
				expect(b.min.z).toBeLessThan(pane.min.z);
			});
		});

		it('holds the pane clear of the sash faces, so nothing z-fights', () =>
		{
			// Two coplanar faces z-fight and it reads as geometry - the fault that
			// stitched a dashed line along the top of a range's oven door.
			const built = buildWindow(Object.assign({}, SPEC, {type: 'fixed',
				material: {glass: 'glass-frosted'}}));
			const meshes = meshesOf(built);
			const pane = boundsOf(meshes.find((m) => m.name === 'sash-glass'));
			const sash = boundsOf(namedPart(built, 'window-sash'));
			expect(pane.max.z).toBeLessThan(sash.max.z - 0.5);
			expect(pane.min.z).toBeGreaterThan(sash.min.z + 0.5);
		});
	});

	describe('floor to ceiling', () =>
	{
		it('asks the wall for its height, less a liner top and bottom', () =>
		{
			// A floor-to-ceiling window cannot state its own height: the height it
			// wants belongs to the wall. `frameOf` adds a liner at each end, so the
			// clear opening is the wall less both of them and the lining lands
			// exactly on the floor and the wall top.
			expect(fullHeightFor(250, 1.9)).toBeCloseTo(246.2, 6);
			const built = buildWindow(Object.assign({}, SPEC, {height: fullHeightFor(250, 1.9)}));
			built.geometry.computeBoundingBox();
			expect(built.geometry.boundingBox.getSize(new Vector3()).y).toBeCloseTo(250, 3);
		});
	});

	it('finishes each slot from the material library', () =>
	{
		// A tint could not tell white paint from white lacquer: same colour, two
		// surfaces, and the difference is entirely roughness and metalness.
		const built = buildWindow(Object.assign({}, SPEC, {
			material: {frame: 'wood-walnut', glass: 'glass-frosted', hardware: 'metal-matte-black'},
		}));
		expect(built.materials[0].userData.materialId).toBe('wood-walnut');

		const ids = meshesOf(built).map((m) => m.material.userData.materialId);
		expect(ids).toContain('glass-frosted');
		expect(ids).toContain('metal-matte-black');
		// A slot the spec does not mention keeps the builder's own answer.
		expect(ids).toContain('paint-white');
	});

	it('glazes with a transparent material by default', () =>
	{
		// Settled once for the whole app - see the comment on `glass-clear` in
		// catalog/materials.json. Opacity rather than transmission, which costs a
		// render target, and the window is the case that has to look through.
		const glass = meshesOf(buildWindow(SPEC)).find((m) => m.name === 'sash-glass');
		expect(glass.material.userData.materialId).toBe('glass-clear');
		expect(glass.material.transparent).toBe(true);
		expect(glass.material.opacity).toBeLessThan(0.5);
	});

	it('falls back rather than throwing on a finish this build has retired', () =>
	{
		// A saved design outlives the library. Opening it should look wrong, not
		// fail.
		const built = buildWindow(Object.assign({}, SPEC, {material: {frame: 'no-such-finish'}}));
		expect(built.materials[0].userData.materialId).toBe('paint-white');
	});

	it('folds a saved mesh scale into the spec, off the BOUNDS and not the opening', () =>
	{
		// Every window on the traced plan is a scaled whitewindow.glb, and the
		// scale would otherwise multiply against the size the spec now asks for.
		// The mapping is not the door's: a window's width is the CLEAR opening and
		// its bounds are that plus a liner on all four sides.
		const folded = buildWindow.absorbScale(SPEC, {x: 2, y: 1, z: 1});
		expect(folded.width).toBeCloseTo((91.44 + 3.8) * 2 - 3.8, 4);
		expect(folded.height).toBeCloseTo(152.4, 4);

		const built = buildWindow(folded);
		built.geometry.computeBoundingBox();
		expect(built.geometry.boundingBox.getSize(new Vector3()).x)
			.toBeCloseTo((91.44 + 3.8) * 2, 2);
	});
});

/** SPEC at one of the types. */
function specFor(type)
{
	return Object.assign({}, SPEC, {type, jamb: 1.9, sashFace: 4.5, reveal: 0.3,
		sashThickness: 3.5, openAngle: 90, awningAngle: 30, hand: 'lo', swing: 'negative'});
}
