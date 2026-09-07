// @vitest-environment jsdom
/**
 * Fitting a sink to the counter it cuts and the cabinet under it.
 *
 * Three bugs were one bug. Changing a sink's mount rebuilt the sink alone: the
 * worktop kept whichever hole `tools/fitout.py` had baked in offline, the
 * cabinet kept its front, and the sink did not move - because `buildSink`
 * reasons in "y = 0 is the top of the worktop" and then centres on its bounding
 * box, which throws that plane away. Its own comment said as much and deferred
 * the fix to "phase 3's run".
 *
 * These pin the rule that replaces it. The arithmetic is tested through
 * `fittingFor`, which computes without writing, so a coordinate flip can be
 * caught without standing up a scene.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {Vector3} from 'three';
import {hostsFor, fittingFor, cutoutFor, mergeCutout, fitSpecToHosts} from '../src/scripts/items/fitting.js';
import {buildSink, openingFor} from '../src/scripts/items/generated/sink.js';
import {buildCounter} from '../src/scripts/items/generated/counter.js';
import {Model} from '../src/scripts/model/model.js';
import {resetAll} from './helpers/harness.js';
import {installCanvas2D} from './helpers/dom.js';

/**
 * A stand-in for a placed item.
 *
 * `fitting.js` reads position, rotation, halfSize and the spec, and writes
 * through `setSpec` - so a fake that records what it was asked for is enough,
 * and is far clearer than driving a whole Scene to assert on a hole.
 */
function fakeItem(kind, {x = 0, y = 0, z = 0, half, rotation = 0, spec = {}, id = kind} = {})
{
	return {
		id: id,
		position: new Vector3(x, y, z),
		rotation: {y: rotation},
		halfSize: half,
		metadata: {spec: Object.assign({kind: kind}, spec)},
		specDatum: null,
		applied: null,
		getSpec()
		{
			return JSON.parse(JSON.stringify(this.metadata.spec));
		},
		setSpec(next)
		{
			this.applied = next;
			this.metadata.spec = next;
			return true;
		},
	};
}

/** A 244cm run of worktop, 64cm deep and 4cm thick, centred on the origin. */
function counterAt(options = {})
{
	return fakeItem('counter', Object.assign({
		y: 90,
		half: new Vector3(122, 2, 32),
		spec: {width: 244, depth: 64, thickness: 4, cutouts: []},
	}, options));
}

function sinkAt(options = {})
{
	return fakeItem('sink', Object.assign({
		y: 80,
		half: new Vector3(38.1, 12, 23.5),
		spec: {mount: 'undermount', width: 76.2, frontToBack: 47, depth: 24.1},
	}, options));
}

/** A counter over a cabinet with a sink in it, the way a run is built. */
function kitchen(mount)
{
	const model = new Model('/textures/');
	model.loadSerialized(JSON.stringify({
		floorplan: {
			version: '2.0.0', units: 'cm',
			corners: {
				a: {x: 0, y: 0, elevation: 243.84}, b: {x: 400, y: 0, elevation: 243.84},
				c: {x: 400, y: 300, elevation: 243.84}, d: {x: 0, y: 300, elevation: 243.84},
			},
			walls: [
				{corner1: 'a', corner2: 'b'}, {corner1: 'b', corner2: 'c'},
				{corner1: 'c', corner2: 'd'}, {corner1: 'd', corner2: 'a'},
			],
			rooms: {}, wallTextures: [], floorTextures: {}, newFloorTextures: {},
		},
		items: [
			{
				id: 'counter-1', item_name: 'Countertop', item_type: 0, format: 'generated',
				model_url: 'generated:counter',
				spec: {kind: 'counter', width: 244, depth: 64, thickness: 4, cutouts: []},
				xpos: 200, ypos: 90, zpos: 150,
				rotation: 0, scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
			},
			{
				id: 'cabinet-1', item_name: 'Sink base', item_type: 0, format: 'generated',
				model_url: 'generated:cabinet',
				spec: {kind: 'cabinet', width: 91.44, doors: 2, drawers: []},
				xpos: 200, ypos: 44, zpos: 150,
				rotation: 0, scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
			},
			{
				id: 'sink-1', item_name: 'Sink', item_type: 0, format: 'generated',
				model_url: 'generated:sink',
				spec: {kind: 'sink', mount: mount, width: 76.2, frontToBack: 47, depth: 24.1},
				xpos: 200, ypos: 80, zpos: 150,
				rotation: 0, scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
			},
		],
	}));
	const items = model.scene.getItems();
	const by = (kind) => items.find((item) => item.metadata.spec && item.metadata.spec.kind === kind);
	return {model: model, counter: by('counter'), cabinet: by('cabinet'), sink: by('sink')};
}

describe('finding the host', () =>
{
	it('finds the counter a sink stands in', () =>
	{
		const counter = counterAt();
		const sink = sinkAt();
		expect(hostsFor(sink, [counter, sink]).counter).toBe(counter);
	});

	it('finds nothing for a sink standing on its own', () =>
	{
		// Not an error. `sink.js` describes a sink "placed by hand", and one with
		// no worktop over it keeps whatever position somebody gave it.
		const sink = sinkAt();
		expect(hostsFor(sink, [sink]).counter).toBe(null);
	});

	it('ignores a counter the sink is not under', () =>
	{
		// Same run, other end. The footprint test is what separates them.
		const counter = counterAt({x: 400});
		const sink = sinkAt();
		expect(hostsFor(sink, [counter, sink]).counter).toBe(null);
	});

	it('finds a counter that is rotated', () =>
	{
		// A run along the other axis. Its half extents are unchanged and its
		// footprint is rotated, so a test that ignored rotation would place this
		// sink outside a counter it is plainly inside.
		const counter = counterAt({rotation: Math.PI / 2});
		const sink = sinkAt({z: 100});
		expect(hostsFor(sink, [counter, sink]).counter).toBe(counter);
	});

	it('finds the cabinet under the sink', () =>
	{
		const counter = counterAt();
		const cabinet = fakeItem('cabinet', {
			y: 44, half: new Vector3(45.7, 44, 30.5), spec: {width: 91.4},
		});
		const sink = sinkAt();
		expect(hostsFor(sink, [counter, cabinet, sink]).cabinet).toBe(cabinet);
	});
});

describe('the hole each mount asks for', () =>
{
	it('leaves a reveal for an undermount, not a hole the sink falls through', () =>
	{
		// `sink.js` says "the cutout IS the opening", which is true of what you see
		// and false of what holds the sink up: an undermount is fixed to the
		// underside of the slab, so the stone has to overhang the bowl. Close to
		// the bowl, and never equal to it.
		const cut = cutoutFor({mount: 'undermount', width: 76.2, frontToBack: 47});
		expect(cut.width).toBeLessThan(76.2);
		expect(cut.width).toBeGreaterThan(74);
	});

	it('cuts an undermount wider than a drop-in of the same bowl', () =>
	{
		// The two mounts differ by what the hole has to support: a drop-in rests
		// its whole flange on the slab, an undermount only needs an edge to be
		// glued to. Same sink, and the holes are not the same hole.
		const under = cutoutFor({mount: 'undermount', width: 76.2, frontToBack: 47});
		const drop = cutoutFor({mount: 'drop-in', width: 76.2, frontToBack: 47});
		expect(under.width).toBeGreaterThan(drop.width);
	});

	it('undersizes it for a drop-in, so the flange has something to rest on', () =>
	{
		// The bug that started this: selecting drop-in changed nothing above the
		// slab. A drop-in whose hole is its own size falls through it.
		const cut = cutoutFor({mount: 'drop-in', width: 76.2, frontToBack: 47});
		expect(cut.width).toBeLessThan(76.2);
		expect(cut.depth).toBeLessThan(47);
	});

	it('cuts only a tap hole for a vessel', () =>
	{
		// It stands wholly on the slab: "no bowl cutout at all", says sink.js.
		const cut = cutoutFor({mount: 'vessel', width: 76.2, frontToBack: 47});
		expect(cut.width).toBeLessThan(10);
		expect(cut.depth).toBeLessThan(10);
	});

	it('never asks for a hole too small to be one', () =>
	{
		const cut = cutoutFor({mount: 'drop-in', width: 1, frontToBack: 1});
		expect(cut.width).toBeGreaterThan(0);
		expect(cut.depth).toBeGreaterThan(0);
	});
});

describe('where the hole lands', () =>
{
	it('puts it where the sink is, along the counter', () =>
	{
		const counter = counterAt();
		const sink = sinkAt({x: 40});
		const fitting = fittingFor(sink, hostsFor(sink, [counter, sink]));
		expect(fitting.cutout.x).toBeCloseTo(40, 3);
	});

	it('follows the counter when the run is turned around', () =>
	{
		// Rotating by pi sends local +x backwards along world x, so a sink 40cm
		// one way is 40cm the other in the counter's own frame. `fitout.py`
		// documents this at length and for the same reason: miss it and you get
		// "a hole in the worktop with the sink somewhere else". On a symmetric
		// run it looks like nothing at all, which is why it is asserted.
		const counter = counterAt({rotation: Math.PI});
		const sink = sinkAt({x: 40});
		const fitting = fittingFor(sink, hostsFor(sink, [counter, sink]));
		expect(fitting.cutout.x).toBeCloseTo(-40, 3);
	});

	it('follows a run along the other axis', () =>
	{
		const counter = counterAt({rotation: Math.PI / 2});
		const sink = sinkAt({z: 40});
		const fitting = fittingFor(sink, hostsFor(sink, [counter, sink]));
		expect(Math.abs(fitting.cutout.x)).toBeCloseTo(40, 3);
	});
});

describe('which way is the front', () =>
{
	it('keeps a cutout on the side of the run the sink is on', () =>
	{
		// The regression this pins: `counter.js` maps a cutout into shape space as
		// `-cut.z`, and the slab is then tipped -90 about x, which sends shape y
		// back to world -z. The two negations cancel, so `cut.z` is simply the
		// counter's own z. Negating here as well mirrored every hole front to back
		// - invisible on a sink centred in its run, and for a farmhouse it took
		// the bite out of the BACK edge of the worktop.
		const counter = counterAt();
		const forward = sinkAt({z: 10});
		const fitting = fittingFor(forward, hostsFor(forward, [counter, forward]));
		expect(fitting.cutout.z).toBeCloseTo(10, 3);
	});

	it('leaves the back of the slab alone for a farmhouse', () =>
	{
		// "appears the back of the counter is being removed too" - it was, and
		// this is the arithmetic that says it is not any more. The notch reaches
		// the front edge and stops short of the back one.
		const counter = counterAt();
		const halfDepth = counter.halfSize.z;
		const sink = sinkAt({spec: {
			mount: 'farmhouse', width: 76.2, frontToBack: 60, depth: 24.1, apronHeight: 25.4,
		}});
		const fitting = fittingFor(sink, hostsFor(sink, [counter, sink]));

		const front = fitting.cutout.z + fitting.cutout.depth / 2;
		const back = fitting.cutout.z - fitting.cutout.depth / 2;
		expect(front).toBeGreaterThanOrEqual(halfDepth);
		expect(back).toBeGreaterThan(-halfDepth);
	});

	it('stands the apron proud of the worktop edge', () =>
	{
		// Flush is wrong, and it is the detail that makes an apron sink read as
		// one - the face breaks the line of the run and catches its own shadow.
		const counter = counterAt();
		const sink = sinkAt({spec: {
			mount: 'farmhouse', width: 76.2, frontToBack: 60, depth: 24.1, apronHeight: 25.4,
		}});
		const fitting = fittingFor(sink, hostsFor(sink, [counter, sink]));
		const sinkFront = fitting.z + 60 / 2;
		expect(sinkFront).toBeGreaterThan(counter.halfSize.z);
	});
});

describe('the height the mount asks for', () =>
{
	/** The datum a real build reports, so these are not asserting against a guess. */
	function datumFor(mount)
	{
		const built = buildSink({kind: 'sink', mount: mount, width: 76.2, frontToBack: 47, depth: 24.1});
		return built.datum.y;
	}

	it('reports where the worktop plane went', () =>
	{
		// The builder centres on its bounding box, which loses the frame every
		// mount was reasoned in. This is the number that puts it back.
		expect(typeof datumFor('undermount')).toBe('number');
	});

	it('hangs an undermount under the slab and stands a vessel on it', () =>
	{
		// The claim: the same worktop, two mounts, and the bowl ends up in
		// genuinely different places rather than recentred to the same one.
		const counter = counterAt();
		const slabTop = counter.position.y + counter.halfSize.y;

		const under = sinkAt({spec: {mount: 'undermount', width: 76.2, frontToBack: 47, depth: 24.1}});
		under.specDatum = {y: datumFor('undermount')};
		const vessel = sinkAt({spec: {mount: 'vessel', width: 76.2, frontToBack: 47, depth: 24.1}});
		vessel.specDatum = {y: datumFor('vessel')};

		const underFit = fittingFor(under, hostsFor(under, [counter, under]));
		const vesselFit = fittingFor(vessel, hostsFor(vessel, [counter, vessel]));

		// An undermount's body is below the slab; a vessel's is above it. So the
		// vessel's centre has to sit higher, whatever the two boxes measure.
		expect(vesselFit.y).toBeGreaterThan(underFit.y);
		expect(underFit.y).toBeLessThan(slabTop);
	});

	it('lifts a drop-in above an undermount', () =>
	{
		// The reported symptom, as an assertion: "when selecting dropin the sink
		// doesn't appear above the countertop".
		const counter = counterAt();
		const under = sinkAt();
		under.specDatum = {y: datumFor('undermount')};
		const drop = sinkAt({spec: {mount: 'drop-in', width: 76.2, frontToBack: 47, depth: 24.1, proud: 1}});
		drop.specDatum = {y: datumFor('drop-in')};

		const underFit = fittingFor(under, hostsFor(under, [counter, under]));
		const dropFit = fittingFor(drop, hostsFor(drop, [counter, drop]));
		expect(dropFit.y).toBeGreaterThan(underFit.y);
	});
});

describe('the cabinet front', () =>
{
	it('is cut away for a farmhouse apron', () =>
	{
		const counter = counterAt();
		const sink = sinkAt({spec: {
			mount: 'farmhouse', width: 76.2, frontToBack: 47, depth: 24.1, apronHeight: 25.4,
		}});
		const fitting = fittingFor(sink, hostsFor(sink, [counter, sink]));
		expect(fitting.apronHeight).toBeCloseTo(25.4, 5);
	});

	it('is put back for any other mount', () =>
	{
		// Zero is meaningful here: switching away from farmhouse has to restore a
		// front, not merely stop asking for it to be removed.
		const counter = counterAt();
		const sink = sinkAt();
		const fitting = fittingFor(sink, hostsFor(sink, [counter, sink]));
		expect(fitting.apronHeight).toBe(0);
	});
});

describe('owning a cutout', () =>
{
	it('replaces its own and leaves a hand-authored hole alone', () =>
	{
		// A hob is a hole somebody put there. Re-cutting for the sink must not
		// take it with it.
		const hob = {x: -60, z: 0, width: 58, depth: 50};
		const mine = {x: 0, z: 0, width: 76, depth: 47, owner: 'sink-1'};
		const merged = mergeCutout([hob, mine], {x: 20, z: 0, width: 70, depth: 44, owner: 'sink-1'});

		expect(merged).toHaveLength(2);
		expect(merged).toContain(hob);
		expect(merged.find((cut) => cut.owner === 'sink-1').x).toBe(20);
	});

	it('adds the first one without disturbing what fitout baked', () =>
	{
		// An existing design's cutout has no owner. It is superseded rather than
		// duplicated only once a sink claims one, so a file that has never been
		// refitted opens exactly as it did.
		const baked = {x: 12, z: 0, width: 72, depth: 43};
		const merged = mergeCutout([baked], {x: 12, z: 0, width: 76, depth: 47, owner: 'sink-1'});
		expect(merged).toHaveLength(2);
	});
});

/**
 * The wiring, through a real Scene.
 *
 * Everything above tests the arithmetic against fakes. These test the thing the
 * bug report was actually about: that editing a sink in the panel reaches the
 * counter at all. `Item.setSpec` -> `Scene.refit` -> `applyFitting` -> the
 * host's own `setSpec`.
 *
 * Generated items load synchronously and without network, which is what lets a
 * whole kitchen stand up in a unit test - see `appliances.test.js` for the same
 * trick and the reason it holds.
 */
describe('a sink changing mount, in a scene', () =>
{
	beforeEach(() =>
	{
		resetAll();
		// jsdom has no 2D context, and `Item` builds two label canvases - so
		// without this every item throws on construction and the scene loads
		// nothing at all, which is a confusing way to discover a missing stub.
		installCanvas2D(window);
	});

	it('cuts the worktop when the mount changes', () =>
	{
		// The first reported symptom, end to end: "counter doesn't update when
		// changing sink type".
		const {counter, sink} = kitchen('undermount');
		expect(counter, 'the counter loaded').toBeTruthy();

		const spec = sink.getSpec();
		spec.mount = 'drop-in';
		sink.setSpec(spec);

		const cutouts = counter.metadata.spec.cutouts;
		expect(cutouts.length).toBe(1);
		expect(cutouts[0].owner).toBeTruthy();
		// A drop-in's hole is undersized so the flange rests on the slab.
		expect(cutouts[0].width).toBeLessThan(76.2);
	});

	it('lifts the sink above the worktop for a drop-in', () =>
	{
		// The second symptom: "when selecting dropin the sink doesn't appear above
		// the countertop". Measured against the slab rather than against the item's
		// old position, because the item is recentred on every rebuild.
		const {counter, sink} = kitchen('undermount');
		// The WORK SURFACE, not the top of the box: the fixture's counter carries
		// the default 10cm backsplash, so the two are 10cm apart and only one of
		// them is the thing a sink is cut into.
		const slabTop = counter.position.y - counter.specDatum.y;

		sink.setSpec(Object.assign(sink.getSpec(), {mount: 'undermount'}));
		const underTop = sink.position.y + sink.halfSize.y;

		sink.setSpec(Object.assign(sink.getSpec(), {mount: 'drop-in'}));
		const dropTop = sink.position.y + sink.halfSize.y;

		// An undermount is wholly below the surface; a drop-in's rim stands proud
		// of it. The second is the thing that was not happening.
		expect(underTop).toBeLessThanOrEqual(slabTop + 0.01);
		expect(dropTop).toBeGreaterThan(slabTop);
	});

	it('takes the cabinet front for a farmhouse and gives it back', () =>
	{
		// The third: "same with cabinet".
		const {cabinet, sink} = kitchen('undermount');
		expect(cabinet, 'the cabinet loaded').toBeTruthy();
		expect(cabinet.metadata.spec.apronCut || 0).toBe(0);

		sink.setSpec(Object.assign(sink.getSpec(), {mount: 'farmhouse', apronHeight: 25.4}));
		expect(cabinet.metadata.spec.apronCut).toBeCloseTo(25.4, 5);

		sink.setSpec(Object.assign(sink.getSpec(), {mount: 'undermount'}));
		expect(cabinet.metadata.spec.apronCut).toBe(0);
	});

	it('takes its hole with it when it is deleted', () =>
	{
		// The reported symptom: "when i delete a sink it doesn't fix the
		// counter/cabinet". A hole with nothing in it is worse than no hole.
		const {model, counter, cabinet, sink} = kitchen('farmhouse');
		sink.setSpec(Object.assign(sink.getSpec(), {mount: 'farmhouse', apronHeight: 25.4}));
		expect(counter.metadata.spec.cutouts.length).toBe(1);
		expect(cabinet.metadata.spec.apronCut).toBeGreaterThan(0);

		model.scene.removeItem(sink);

		expect(counter.metadata.spec.cutouts.length).toBe(0);
		expect(cabinet.metadata.spec.apronCut).toBe(0);
	});

	it('leaves a hand-authored hole behind when the sink goes', () =>
	{
		// Deleting a sink gives back the sink's hole and nothing else. A hob is
		// somebody else's decision.
		const {model, counter, sink} = kitchen('undermount');
		const withHob = counter.getSpec();
		withHob.cutouts = [{x: -80, z: 0, width: 58, depth: 50}];
		counter.setSpec(withHob);

		sink.setSpec(Object.assign(sink.getSpec(), {mount: 'drop-in'}));
		expect(counter.metadata.spec.cutouts.length).toBe(2);

		model.scene.removeItem(sink);
		expect(counter.metadata.spec.cutouts.length).toBe(1);
		expect(counter.metadata.spec.cutouts[0].owner).toBeUndefined();
	});

	it('shrinks a bowl that will not fit the base it is over', () =>
	{
		// End to end, for "it should auto fit to the size of the cabinet": the
		// fixture's base is 91.44 wide, so a 30in bowl has to come in.
		const {sink} = kitchen('undermount');
		sink.setSpec(Object.assign(sink.getSpec(), {shape: 'round', width: 200, frontToBack: 200}));
		expect(sink.metadata.spec.width).toBeLessThan(91.44);
	});

	it('leaves a sink with no counter over it where it is', () =>
	{
		// The "placed by hand" case sink.js describes. Refitting to nothing must
		// not drag it to the floor.
		const {sink, counter, model} = kitchen('undermount');
		model.scene.removeItem(counter);

		// Its DATUM holds still, not its centre. The worktop plane a sink was
		// drawn against is the thing that means something, and a rebuild that
		// changes the bowl's extent must not slide it - so the plane is what this
		// asserts, and the centre is free to move under it.
		const before = sink.position.y - sink.specDatum.y;
		sink.setSpec(Object.assign(sink.getSpec(), {mount: 'drop-in'}));
		expect(sink.position.y - sink.specDatum.y).toBeCloseTo(before, 5);
	});
});

describe('a round bowl is round', () =>
{
	it('takes its diameter from the shorter span, not the width', () =>
	{
		// The reported symptom: "round blows out the front". A 76.2cm sink in a
		// 47cm opening was built as a 76.2cm circle, so 29cm of bowl hung past the
		// worktop and through the cabinet face.
		const opening = openingFor({shape: 'round', width: 76.2, frontToBack: 47});
		expect(opening.width).toBeCloseTo(47, 5);
		expect(opening.depth).toBeCloseTo(47, 5);
	});

	it('builds no deeper than the opening it was given', () =>
	{
		const built = buildSink({kind: 'sink', shape: 'round', width: 76.2, frontToBack: 47, depth: 24.1});
		built.geometry.computeBoundingBox();
		const size = built.geometry.boundingBox.getSize(new Vector3());
		expect(size.z).toBeLessThanOrEqual(47 + 0.01);
	});

	it('leaves an oval using both spans, which is what an oval is for', () =>
	{
		const opening = openingFor({shape: 'oval', width: 76.2, frontToBack: 47});
		expect(opening.width).toBeCloseTo(76.2, 5);
		expect(opening.depth).toBeCloseTo(47, 5);
	});

	it('cuts the worktop to the bowl and not to the spec', () =>
	{
		// Cutting a round sink to its spec would take 29cm more stone than the
		// sink covers, and leave a crescent of hole around it.
		const cut = cutoutFor({mount: 'undermount', shape: 'round', width: 76.2, frontToBack: 47});
		expect(cut.width).toBeLessThan(48);
	});
});

describe('fitting a sink to the cabinet it stands in', () =>
{
	const cabinetOf = (width) => fakeItem('cabinet', {
		y: 44, half: new Vector3(width / 2, 44, 30.5), spec: {kind: 'cabinet', width: width, panel: 1.9},
	});

	it('shrinks a bowl too wide for its base', () =>
	{
		// A 30in bowl does not go into a 24in cabinet, however firmly a panel is
		// told that it does.
		const hosts = {counter: counterAt(), cabinet: cabinetOf(60.96)};
		const fitted = fitSpecToHosts({mount: 'undermount', width: 76.2, frontToBack: 47}, hosts);
		expect(fitted.width).toBeLessThan(60.96 - 2 * 1.9);
	});

	it('leaves a bowl that already fits alone', () =>
	{
		// Shrink only. A deliberately small sink in a wide base stays small.
		const hosts = {counter: counterAt(), cabinet: cabinetOf(121.92)};
		const fitted = fitSpecToHosts({mount: 'undermount', width: 45, frontToBack: 40}, hosts);
		expect(fitted.width).toBe(45);
	});

	it('keeps the bowl clear of the worktop front and back', () =>
	{
		const hosts = {counter: counterAt(), cabinet: cabinetOf(91.44)};
		const fitted = fitSpecToHosts({mount: 'undermount', width: 76.2, frontToBack: 200}, hosts);
		// The counter is 64 deep; the bowl has to leave stone at both edges.
		expect(fitted.frontToBack).toBeLessThan(64);
	});

	it('sets a farmhouse to reach the front instead of clamping it', () =>
	{
		// The farmhouse is the one mount whose depth is not a preference: its
		// apron IS the front of the run.
		const hosts = {counter: counterAt(), cabinet: cabinetOf(91.44)};
		const fitted = fitSpecToHosts({mount: 'farmhouse', width: 76.2, frontToBack: 30}, hosts);
		expect(fitted.frontToBack).toBeGreaterThan(30);
	});
});

/**
 * Whether the slab's top surface actually covers a point.
 *
 * The arithmetic tests above say where the hole was ASKED for. This reads the
 * triangles that came out and answers "is there stone here", which is the only
 * thing that settles a screenshot showing a bite out of the wrong edge.
 */
function slabCovers(built, x, z)
{
	const position = built.geometry.attributes.position;
	let top = -Infinity;
	for (let i = 0; i < position.count; i++)
	{
		top = Math.max(top, position.getY(i));
	}

	for (let i = 0; i < position.count; i += 3)
	{
		const ys = [position.getY(i), position.getY(i + 1), position.getY(i + 2)];
		if (ys.some((y) => Math.abs(y - top) > 1e-3))
		{
			continue;
		}
		const ax = position.getX(i), az = position.getZ(i);
		const bx = position.getX(i + 1), bz = position.getZ(i + 1);
		const cx = position.getX(i + 2), cz = position.getZ(i + 2);
		// Barycentric sign test, tolerant of winding.
		const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
		if (Math.abs(d) < 1e-9)
		{
			continue;
		}
		const a = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
		const b = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
		const c = 1 - a - b;
		if (a >= -1e-6 && b >= -1e-6 && c >= -1e-6)
		{
			return true;
		}
	}
	return false;
}

describe('a farmhouse breaks the front edge', () =>
{
	it('asks for a cutout that is open at the front', () =>
	{
		const cut = cutoutFor({mount: 'farmhouse', width: 76.2, frontToBack: 47});
		expect(cut.open).toBe('front');
	});

	it('does not ask that of any other mount', () =>
	{
		expect(cutoutFor({mount: 'undermount', width: 76.2, frontToBack: 47}).open).toBeUndefined();
		expect(cutoutFor({mount: 'drop-in', width: 76.2, frontToBack: 47}).open).toBeUndefined();
	});

	it('takes the notch out of the slab, not out of its middle', () =>
	{
		// A hole that touches the outline is DISCARDED by triangulateShape rather
		// than clipped - silently - so an apron expressed as a hole either
		// vanished or left a lip of stone in front of the sink. The outline has to
		// change instead, and a notched slab is a different shape: fewer holes,
		// more outline.
		const plain = buildCounter({kind: 'counter', width: 244, depth: 64, thickness: 4, cutouts: []});
		const notched = buildCounter({kind: 'counter', width: 244, depth: 64, thickness: 4, cutouts: [
			{x: 0, z: 0, width: 76, depth: 60, open: 'front', owner: 'sink-1'},
		]});

		plain.geometry.computeBoundingBox();
		notched.geometry.computeBoundingBox();
		// Same slab, so the same envelope - the bite is out of the front edge, not
		// off the end of the run.
		expect(notched.geometry.boundingBox.getSize(new Vector3()).x)
			.toBeCloseTo(plain.geometry.boundingBox.getSize(new Vector3()).x, 2);
		// And it is genuinely a different outline rather than the same slab.
		expect(notched.geometry.attributes.position.count)
			.not.toBe(plain.geometry.attributes.position.count);
	});
});

describe('what the slab actually keeps', () =>
{
	/** A 244 x 64 slab with a 76cm apron sink centred, notched to the front. */
	function notched()
	{
		return buildCounter({
			kind: 'counter', width: 244, depth: 64, thickness: 4, backsplash: 0,
			cutouts: [{x: 0, z: 3.5, width: 76, depth: 60, open: 'front', owner: 'sink-1'}],
		});
	}

	it('keeps the stone behind the sink', () =>
	{
		// The screenshot showed the opposite: the bite came out of the BACK edge,
		// so the run was open behind the sink and whole in front of it.
		const built = notched();
		// World z: the front of the run is +z, so the back strip is negative.
		expect(slabCovers(built, 0, -30)).toBe(true);
	});

	it('opens the front where the sink is', () =>
	{
		const built = notched();
		expect(slabCovers(built, 0, 30)).toBe(false);
	});

	it('keeps the run either side of the sink', () =>
	{
		// A notch is a bite, not a cut through the run.
		const built = notched();
		expect(slabCovers(built, -100, 30)).toBe(true);
		expect(slabCovers(built, 100, 30)).toBe(true);
	});

	it('leaves an ordinary hole surrounded by stone', () =>
	{
		// The control: an undermount is a hole, and the front edge stays whole.
		const built = buildCounter({
			kind: 'counter', width: 244, depth: 64, thickness: 4, backsplash: 0,
			cutouts: [{x: 0, z: 0, width: 76, depth: 44, owner: 'sink-1'}],
		});
		expect(slabCovers(built, 0, 0)).toBe(false);
		expect(slabCovers(built, 0, 30)).toBe(true);
		expect(slabCovers(built, 0, -30)).toBe(true);
	});
});

describe('a backsplash does not move the worktop', () =>
{
	beforeEach(() =>
	{
		resetAll();
		installCanvas2D(window);
	});

	/** One counter, alone, so nothing else can be moving it. */
	function counterOnly(backsplash)
	{
		const model = new Model('/textures/');
		model.loadSerialized(JSON.stringify({
			floorplan: {
				version: '2.0.0', units: 'cm',
				corners: {
					a: {x: 0, y: 0, elevation: 243.84}, b: {x: 400, y: 0, elevation: 243.84},
					c: {x: 400, y: 300, elevation: 243.84}, d: {x: 0, y: 300, elevation: 243.84},
				},
				walls: [
					{corner1: 'a', corner2: 'b'}, {corner1: 'b', corner2: 'c'},
					{corner1: 'c', corner2: 'd'}, {corner1: 'd', corner2: 'a'},
				],
				rooms: {}, wallTextures: [], floorTextures: {}, newFloorTextures: {},
			},
			items: [{
				id: 'counter-1', item_name: 'Countertop', item_type: 0, format: 'generated',
				model_url: 'generated:counter',
				spec: {kind: 'counter', width: 244, depth: 64, thickness: 4,
					backsplash: backsplash, cutouts: []},
				xpos: 200, ypos: 90, zpos: 150,
				rotation: 0, scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
			}],
		}));
		return model.scene.getItems()[0];
	}

	/** Where the worktop actually is, in world terms. */
	const surfaceOf = (item) => item.position.y - item.specDatum.y;

	it('keeps the work surface at the same height', () =>
	{
		// The reported symptom: "backsplash doesn't appear to be doing anything".
		// It was being built - and the counter was sinking by half its height at
		// the same time, so the splash's top landed about where the worktop had
		// been and the worktop went into the cabinets.
		const counter = counterOnly(0);
		const before = surfaceOf(counter);

		counter.setSpec(Object.assign(counter.getSpec(), {backsplash: 10.16}));
		expect(surfaceOf(counter)).toBeCloseTo(before, 3);
	});

	it('still grows upward when one is added', () =>
	{
		// The other half: the surface holds still and the splash is real.
		const counter = counterOnly(0);
		const flat = counter.halfSize.y * 2;

		counter.setSpec(Object.assign(counter.getSpec(), {backsplash: 10.16}));
		expect(counter.halfSize.y * 2).toBeGreaterThan(flat + 9);
	});

	it('puts a sink against the worktop and not the top of the splash', () =>
	{
		// A sink measured against the bounding box would hang off the splash, 10cm
		// above the surface it is meant to be cut into.
		const {counter, sink} = kitchen('undermount');
		counter.setSpec(Object.assign(counter.getSpec(), {backsplash: 10.16}));
		const surface = surfaceOf(counter);

		sink.setSpec(Object.assign(sink.getSpec(), {mount: 'drop-in'}));
		// The rim stands proud of the worktop, not of the splash.
		expect(sink.position.y + sink.halfSize.y).toBeLessThan(surface + 5);
	});
});
