// @vitest-environment jsdom
/**
 * The importer's state, and the button that opens it.
 *
 * jsdom, because the last case mounts the toolbar. The composable itself needs
 * no DOM at all: `useImport` takes its modules and its file read as injected
 * dependencies, so the readers and the raster layer - the one part that does
 * need a canvas - are stood in for here.
 *
 * What is pinned is the SEQUENCING the dialog depends on, which is where the
 * bugs in a multi-step form live. The arithmetic is covered against the Python
 * in `import-trace.test.js`.
 */
import {describe, expect, it, vi} from 'vitest';
import {watch} from 'vue';
import {mount} from '@vue/test-utils';

import {PLOT_SCALES, useImport} from '../src/app/composables/useImport.js';
import TopBar from '../src/app/components/TopBar.vue';

/** A sheet as a reader returns one. */
function fakeSheet(overrides = {})
{
	return {
		kind: 'pdf',
		scale: null,
		pages: [
			{number: 1, width: 612, height: 792},
			{number: 2, width: 612, height: 792},
		],
		paths: async () => [],
		close: vi.fn(),
		...overrides,
	};
}

function fakeModules(overrides = {})
{
	const traceSheet = vi.fn(async () => ({
		design: {floorplan: {corners: {}, walls: []}, items: []},
		stats: {walls: 11, openingCount: 4, widthFt: 19.5, heightFt: 14.5, layer: '#000000,0.5,none'},
	}));
	return {
		modules: {
			readers: {openDrawing: vi.fn(async () => overrides.sheet || fakeSheet())},
			trace: {traceSheet},
			raster: {
				PREVIEW_DPI: 96,
				UNDERLAY_DPI: 150,
				renderRegion: vi.fn(async () => ({url: 'data:image/png;base64,zz', width: 800, height: 620})),
				renderThumbnails: vi.fn(async () => [
					{number: 1, url: 'data:1', width: 40, height: 52},
					{number: 2, url: 'data:2', width: 40, height: 52},
				]),
			},
			layers: {listLayers: vi.fn(() => [{key: '#000000,0.5,none', segments: 22}])},
		},
		traceSheet,
	};
}

function importer(overrides = {})
{
	const {modules, traceSheet} = fakeModules(overrides);
	const state = useImport({
		load: async () => modules,
		read: async () => new Uint8Array([1, 2, 3]),
	});
	return {state, modules, traceSheet};
}

/** A File stand-in; node has one, but its name is all this code reads. */
function file(name = 'plan.pdf')
{
	return {name, arrayBuffer: async () => new ArrayBuffer(3)};
}

describe('the plot scales offered', () =>
{
	it('are real inches per point', () =>
	{
		// A point is 1/72 of a paper inch, and at 1/4in = 1ft one paper inch is
		// 48 real ones.
		const quarter = PLOT_SCALES.find((entry) => entry.label.startsWith('1/4'));
		expect(quarter.value).toBeCloseTo(48 / 72, 12);
		// A ratio scale is that ratio to the point. 1:48 and 1/4in = 1ft are
		// the same scale, so 1:50 sits just above it.
		const metric = PLOT_SCALES.find((entry) => entry.label.startsWith('1:50'));
		expect(metric.value).toBeCloseTo(50 / 72, 12);
	});
});

describe('useImport', () =>
{
	it('opens a file and shows its first page', async () =>
	{
		const {state, modules} = importer();
		expect(await state.pick(file())).toBe(true);

		expect(state.stage.value).toBe('region');
		expect(state.filename.value).toBe('plan.pdf');
		expect(state.page.value).toBe(1);
		expect(state.preview.value.url).toBe('data:image/png;base64,zz');
		// Two pages, so a picker is needed.
		expect(state.thumbnails.value).toHaveLength(2);
		expect(modules.readers.openDrawing).toHaveBeenCalledOnce();
		expect(state.busy.value).toBe(false);
	});

	it('does not offer a page picker for a single-page drawing', async () =>
	{
		const {state} = importer({sheet: fakeSheet({pages: [{number: 1, width: 400, height: 310}]})});
		await state.pick(file('plan.svg'));
		expect(state.thumbnails.value).toEqual([]);
		expect(state.thumbnailsLeft.value).toBe(0);
	});

	it('hands control back before the thumbnails are drawn', async () =>
	{
		// The bug this pins: a 19-sheet set spent 45 seconds on "Working…"
		// because every page was rastered before anything was shown. Every page
		// must be listed and pickable the moment the file opens, with the
		// pictures arriving behind it.
		const {state} = importer();
		let release;
		const drawn = new Promise((resolve) => {release = resolve;});
		const {modules} = fakeModules();
		void modules;

		await state.pick(file());
		// Back already, with a page list and the first page on screen.
		expect(state.busy.value).toBe(false);
		expect(state.preview.value).not.toBe(null);
		expect(state.thumbnails.value.map((thumb) => thumb.number)).toEqual([1, 2]);
		// Listed but not yet drawn.
		expect(state.thumbnails.value.every((thumb) => thumb.url === null)).toBe(true);
		expect(state.thumbnailsLeft.value).toBe(2);

		release();
		await drawn;
		// And they fill in behind, without anybody waiting.
		await vi.waitFor(() =>
		{
			expect(state.thumbnails.value.every((thumb) => thumb.url)).toBe(true);
			expect(state.thumbnailsLeft.value).toBe(0);
		});
	});

	it('abandons a thumbnail run when the drawing is closed under it', async () =>
	{
		// A run still in flight must not draw from a document that has been
		// destroyed, nor write thumbnails for a file nobody has open.
		const {state} = importer();
		await state.pick(file());
		state.reset();
		await vi.waitFor(() => expect(state.sheet.value).toBe(null));
		expect(state.thumbnails.value).toEqual([]);
	});

	it('takes the scale from the file when the file knows it', async () =>
	{
		const {state} = importer({sheet: fakeSheet({kind: 'dxf', scale: 1})});
		await state.pick(file('plan.dxf'));
		expect(state.scaleIsKnown.value).toBe(true);
		expect(state.scale.value).toBe(1);
	});

	it('falls back to a plot scale when it cannot', async () =>
	{
		const {state} = importer();
		await state.pick(file());
		expect(state.scaleIsKnown.value).toBe(false);
		expect(state.scale.value).toBeCloseTo(48 / 72, 12);
	});

	it('reports a file it cannot read, and keeps nothing', async () =>
	{
		const {state, modules} = importer();
		modules.readers.openDrawing.mockRejectedValueOnce(new Error('That is not a PDF, an SVG or a DXF.'));
		expect(await state.pick(file('notes.md'))).toBe(false);
		expect(state.error.value).toMatch(/not a PDF/);
		expect(state.sheet.value).toBe(null);
		expect(state.stage.value).toBe('idle');
		expect(state.busy.value).toBe(false);
	});

	it('drops the region when the page changes', async () =>
	{
		// A box drawn on page 1 means nothing on page 2, and silently tracing
		// the wrong part of a sheet is worse than asking again.
		const {state} = importer();
		await state.pick(file());
		state.setClip([10, 10, 200, 200]);
		expect(state.clip.value).not.toBe(null);

		await state.showPage(2);
		expect(state.page.value).toBe(2);
		expect(state.clip.value).toBe(null);
	});

	it('normalises a box dragged up and to the left', async () =>
	{
		const {state} = importer();
		await state.pick(file());
		state.setClip([300, 400, 100, 200]);
		expect(state.clip.value).toEqual([100, 200, 300, 400]);
	});

	it('traces the whole page when no box was drawn', async () =>
	{
		const {state, traceSheet} = importer();
		await state.pick(file());
		expect(state.region.value).toEqual([0, 0, 612, 792]);

		await state.run();
		expect(traceSheet.mock.calls[0][0].clip).toEqual([0, 0, 612, 792]);
	});

	it('traces the box, at the chosen scale, with a backdrop', async () =>
	{
		const {state, traceSheet, modules} = importer();
		await state.pick(file());
		state.setClip([100, 120, 400, 500]);
		state.scale.value = 96 / 72;
		state.ceiling.value = 108;
		state.openDoors.value = false;

		expect(await state.run()).toBe(true);
		const passed = traceSheet.mock.calls[0][0];
		expect(passed.clip).toEqual([100, 120, 400, 500]);
		expect(passed.scale).toBeCloseTo(96 / 72, 12);
		expect(passed.ceiling).toBe(108);
		expect(passed.openDoors).toBe(false);
		expect(passed.underlay).toEqual({url: 'data:image/png;base64,zz', width: 800, height: 620});
		// The backdrop is rendered over the same region, at the carbon sheet's
		// own resolution rather than the preview's.
		expect(modules.raster.renderRegion).toHaveBeenLastCalledWith(
			state.sheet.value, 1, {clip: [100, 120, 400, 500], dpi: 150});

		expect(state.stage.value).toBe('review');
		expect(state.result.value.stats.walls).toBe(11);
	});

	it('reports a region it cannot trace, and offers no result to apply', async () =>
	{
		const {state, traceSheet} = importer();
		await state.pick(file());
		traceSheet.mockRejectedValueOnce(new Error('No walls were traced in that region.'));

		expect(await state.run()).toBe(false);
		expect(state.error.value).toMatch(/No walls were traced/);
		expect(state.result.value).toBe(null);
		expect(state.busy.value).toBe(false);
	});

	it('lists the pens in the region on request', async () =>
	{
		const {state, modules} = importer();
		await state.pick(file());
		state.setClip([10, 10, 200, 200]);
		await state.inspectLayers();
		expect(modules.layers.listLayers).toHaveBeenCalled();
		expect(state.layers.value[0].key).toBe('#000000,0.5,none');
	});

	it('reports each real step, so a long wait is not a silent one', async () =>
	{
		// The first of these is a 2.6MB download of pdf.js and its worker.
		// A bar that does not say what it is doing looks like a hang.
		const {state} = importer();
		const seen = [];
		const stop = watch(state.progress, (now) =>
		{
			if (now) { seen.push([now.label, now.value]); }
		});

		await state.pick(file());
		stop();

		expect(seen.length).toBeGreaterThan(2);
		expect(seen[0][0]).toMatch(/reader/i);
		// Monotonic, and finished when the work is.
		const values = seen.map(([, value]) => value);
		expect(values).toEqual([...values].sort((one, two) => one - two));
		expect(state.progress.value).toBe(null);
	});

	it('starts fetching the parsers before a file is picked', async () =>
	{
		// The dialog opening is the cue: the download overlaps with choosing a
		// file rather than starting after it.
		const loaded = vi.fn(async () => fakeModules().modules);
		const state = useImport({load: loaded, read: async () => new Uint8Array([1])});
		state.warm();
		await vi.waitFor(() => expect(loaded).toHaveBeenCalledOnce());

		// And it is not fetched a second time when the file arrives.
		await state.pick(file());
		expect(loaded).toHaveBeenCalledOnce();
	});

	it('swallows a warm-up failure, and reports it when a file is picked', async () =>
	{
		const loaded = vi.fn(async () => {throw new Error('network gone');});
		const state = useImport({load: loaded, read: async () => new Uint8Array([1])});
		// Must not raise: nothing has been asked for yet.
		state.warm();
		await vi.waitFor(() => expect(loaded).toHaveBeenCalled());
		expect(state.error.value).toBe(null);

		expect(await state.pick(file())).toBe(false);
		expect(state.error.value).toMatch(/network gone/);
	});

	it('lets go of the parsed drawing when it is reset', async () =>
	{
		// A sheet holds a whole parsed document, and for a PDF a live worker
		// with it. Leaving it attached to a closed dialog keeps both alive.
		const sheet = fakeSheet();
		const {state} = importer({sheet});
		await state.pick(file());
		state.setClip([1, 2, 3, 4]);

		state.reset();
		expect(sheet.close).toHaveBeenCalledOnce();
		expect(state.sheet.value).toBe(null);
		expect(state.clip.value).toBe(null);
		expect(state.filename.value).toBe('');
		expect(state.stage.value).toBe('idle');
	});
});

describe('the toolbar', () =>
{
	it('offers the import beside the other document actions', async () =>
	{
		const bar = mount(TopBar, {
			props: {layout: 'split', theme: 'dark', unit: 'ft', units: [{value: 'ft', label: 'Feet'}]},
			global: {stubs: {AppTip: {template: '<div><slot /></div>'}}},
		});
		const button = bar.get('button[title="Import a PDF, SVG or DXF"]');
		await button.trigger('click');
		expect(bar.emitted('import-drawing')).toHaveLength(1);
	});
});
