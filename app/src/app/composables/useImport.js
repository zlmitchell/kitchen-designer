// @ts-check
/**
 * Importing a drawing: pick a file, pick a page, draw a box round the plan,
 * say what scale it is at, and trace it.
 *
 * The state behind `ImportDialog.vue`, and the seam between the interface and
 * `src/app/import/`, which knows nothing about Vue. Everything expensive is
 * lazy: the parsers are ~1MB and are imported when somebody opens the dialog,
 * never on first paint.
 *
 * ## Why a region and a scale have to be asked for
 *
 * A sheet is not a plan. It carries a title block, a schedule, elevations and
 * often several plans, and the tracer's first act is to decide which pen drew
 * the structure - a judgement made over whatever is inside the region. Hand it
 * the whole sheet and the dimension strings, which are long and dead straight
 * and reach further than the building, compete with the walls.
 *
 * The scale is worse, because nothing detects a wrong one: a plan traced at
 * half scale is a perfectly consistent plan of a house half the size. Only a
 * DXF states its own units, which is why `sheet.scale` is honoured when it is
 * there and a plot scale is asked for when it is not.
 */

import {computed, ref, shallowRef} from 'vue';

/**
 * What the file picker offers.
 *
 * Declared here rather than imported from `import/readers/` so that nothing
 * loaded at first paint reaches into that directory. The dialog needs this one
 * string, and a static import for it would pull all three readers into the
 * main bundle to get it - which is the opposite of the lazy loading everything
 * else here is arranged for.
 */
export const ACCEPT = '.pdf,.svg,.dxf,application/pdf,image/svg+xml';

/**
 * Real inches per point, for the scales American residential plans are drawn
 * at, plus the two metric ones. A point is 1/72 of a paper inch, so 1/4in = 1ft
 * is 48 real inches to the paper inch, or 48/72 to the point.
 */
export const PLOT_SCALES = [
	{label: '1/4" = 1\'', value: 48 / 72},
	{label: '3/16" = 1\'', value: 64 / 72},
	{label: '1/8" = 1\'', value: 96 / 72},
	{label: '1/2" = 1\'', value: 24 / 72},
	{label: '1" = 1\'', value: 12 / 72},
	// A ratio scale is simply that ratio to the point, since a point is a
	// length of paper and the ratio says how much real length it stands for.
	// 1:48 and 1/4in = 1ft are the same scale, which is why they sit together.
	{label: '1:50 (metric)', value: 50 / 72},
	{label: '1:100 (metric)', value: 100 / 72},
	{label: 'Full size (1:1)', value: 1 / 72},
];

/** What a fresh dialog starts at, and what `reset` returns to. */
const DEFAULT_SCALE = 48 / 72;
const DEFAULT_CEILING_IN = 96;

/**
 * @param {object} [deps] Injection seams for the tests, which have no DOM and
 * no bundler: `load` supplies the import modules, `read` turns a File into
 * bytes.
 */
export function useImport(deps = {})
{
	const busy = ref(false);
	const stage = ref('idle');
	const error = ref(null);

	/** @type {import('vue').ShallowRef<?object>} */
	const sheet = shallowRef(null);
	const filename = ref('');
	/**
	 * One entry per page from the moment the file opens; each gets its `url`
	 * when its thumbnail has been drawn. See `startThumbnails`.
	 *
	 * @type {import('vue').Ref<Array<{number: number, url: ?string}>>}
	 */
	const thumbnails = ref([]);
	/** How many thumbnails are still to draw, for the progress line. */
	const thumbnailsLeft = ref(0);
	const page = ref(1);
	/** @type {import('vue').Ref<?{url: string, width: number, height: number}>} */
	const preview = ref(null);
	/** @type {import('vue').Ref<?number[]>} `[x0, y0, x1, y1]` in points. */
	const clip = ref(null);
	const scale = ref(DEFAULT_SCALE);
	const ceiling = ref(DEFAULT_CEILING_IN);
	const openDoors = ref(true);
	/** @type {import('vue').Ref<?string>} */
	const layer = ref(null);
	/** @type {import('vue').Ref<Array<object>>} */
	const layers = ref([]);
	/** @type {import('vue').ShallowRef<?object>} */
	const result = shallowRef(null);
	/**
	 * The trace drawn back over the drawing - `box_check.py` and
	 * `opening_truth.py`, in the dialog. Shown before anything is committed.
	 *
	 * @type {import('vue').Ref<?{url: string, width: number, height: number}>}
	 */
	const check = ref(null);

	/**
	 * What is happening, and roughly how far through it is.
	 *
	 * `value` is 0..1. Every step is a real one with an honest label rather
	 * than a spinner: the longest of them is fetching pdf.js, which is a 431 KB
	 * parser and a 2.23 MB worker, and a bar that does not say so looks like
	 * the application has hung.
	 *
	 * @type {import('vue').Ref<?{label: string, value: number}>}
	 */
	const progress = ref(null);

	/**
	 * @param {string} label
	 * @param {number} value
	 */
	function step(label, value)
	{
		progress.value = {label, value};
	}

	/**
	 * Which background thumbnail run is the live one. Bumped by every `pick`
	 * and every `reset`, so a run that started for a document nobody has open
	 * any more notices and stops.
	 */
	let job = 0;

	/**
	 * Start fetching the parsers before anybody picks a file.
	 *
	 * Called when the dialog opens. The modules are ~2.6 MB of lazily loaded
	 * JavaScript and the download is the single longest thing in the whole
	 * flow; kicking it off here overlaps it with choosing a file in the
	 * picker, which is dead time otherwise. Safe to call repeatedly - `load`
	 * caches - and deliberately not awaited by anything.
	 */
	function warm()
	{
		load().catch(() =>
		{
			// A failure here is not worth reporting: nothing has been asked
			// for yet, and `pick` will hit the same failure and say so with a
			// file in hand to name.
		});
	}

	/** The modules, once. Held rather than re-imported per call. */
	let modules = null;
	async function load()
	{
		if (!modules)
		{
			modules = deps.load
				? await deps.load()
				: {
					readers: await import('../import/readers/index.js'),
					trace: await import('../import/trace.js'),
					raster: await import('../import/raster.js'),
					layers: await import('../import/layers.js'),
				};
		}
		return modules;
	}

	/** The page currently chosen, as the reader described it. */
	const pageSize = computed(() =>
		(sheet.value ? sheet.value.pages[page.value - 1] : null));

	/** Whether the file states its own scale, in which case nobody types one. */
	const scaleIsKnown = computed(() => !!(sheet.value && sheet.value.scale));

	/** The region to trace: what was dragged, or the whole page. */
	const region = computed(() =>
	{
		if (clip.value)
		{
			return clip.value;
		}
		const size = pageSize.value;
		return size ? [0, 0, size.width, size.height] : null;
	});

	function fail(message)
	{
		error.value = message;
		progress.value = null;
		busy.value = false;
		return false;
	}

	/**
	 * Open a file and show its first page.
	 *
	 * @param {File} file
	 */
	async function pick(file)
	{
		if (!file)
		{
			return false;
		}
		busy.value = true;
		error.value = null;
		result.value = null;
		check.value = null;
		clip.value = null;
		layer.value = null;
		layers.value = [];
		filename.value = file.name;

		try
		{
			// Named rather than spun, because this one is a 2.6 MB download the
			// first time and silence looks like a hang.
			step('Loading the drawing reader…', 0.08);
			const {readers} = await load();
			step('Reading the file…', 0.3);
			const bytes = deps.read
				? await deps.read(file)
				: new Uint8Array(await file.arrayBuffer());
			step('Opening the drawing…', 0.5);
			const opened = await readers.openDrawing(bytes, file.name);
			sheet.value = opened;
			// A DXF says what its units are; a PDF or an SVG cannot.
			scale.value = opened.scale || DEFAULT_SCALE;
			page.value = 1;
			stage.value = 'region';
			// The first page, and only the first page, before handing control
			// back. Everything else is behind it.
			step('Drawing the first page…', 0.75);
			await showPage(1);
			progress.value = null;
			busy.value = false;
			startThumbnails(opened);
			return true;
		}
		catch (problem)
		{
			sheet.value = null;
			stage.value = 'idle';
			return fail(messageOf(problem));
		}
	}

	/**
	 * Draw the page thumbnails one at a time, behind the interface.
	 *
	 * NOT awaited by `pick`, and that is the whole point. A set of
	 * construction documents is 19 sheets of 5,000 to 8,000 paths each, and
	 * rendering every one of them before showing anything meant the dialog sat
	 * on "Working…" for **45 seconds** before a box could be drawn - measured
	 * on a real set. Parsing is not what costs: opening the document is 0.26s
	 * and reading one page's geometry 0.3s. It is the rasterising, and the PNG
	 * encode after it, once per page.
	 *
	 * So the picker is populated with an entry per page immediately, each
	 * without a picture, and the pictures arrive as they are drawn. The first
	 * page is on screen and draggable throughout.
	 *
	 * `job` cancels: picking another file or resetting abandons a run in
	 * flight rather than letting it write thumbnails for a document that is no
	 * longer open.
	 *
	 * @param {object} opened
	 */
	function startThumbnails(opened)
	{
		const mine = (job += 1);
		if (opened.pages.length < 2)
		{
			// One page is not a choice, so there is nothing to pick from.
			thumbnails.value = [];
			thumbnailsLeft.value = 0;
			return;
		}
		thumbnails.value = opened.pages.map((entry) => ({number: entry.number, url: null}));
		thumbnailsLeft.value = opened.pages.length;

		(async () =>
		{
			const {raster} = await load();
			for (const entry of opened.pages)
			{
				if (mine !== job)
				{
					return;
				}
				try
				{
					const image = await raster.renderRegion(opened, entry.number, {
						dpi: raster.THUMBNAIL_DPI,
						max: 512,
					});
					if (mine !== job)
					{
						return;
					}
					thumbnails.value = thumbnails.value.map((thumb) =>
						(thumb.number === entry.number ? {...thumb, ...image} : thumb));
				}
				catch
				{
					// One page that will not draw is not a reason to stop
					// drawing the rest, and its entry stays pickable without a
					// picture - the page may still trace perfectly well.
				}
				thumbnailsLeft.value = Math.max(0, thumbnailsLeft.value - 1);
			}
		})();
	}

	/**
	 * @param {number} number
	 */
	async function showPage(number)
	{
		if (!sheet.value)
		{
			return false;
		}
		busy.value = true;
		error.value = null;
		page.value = number;
		// A region drawn on one page means nothing on another.
		clip.value = null;
		layers.value = [];
		try
		{
			const {raster} = await load();
			preview.value = await raster.renderRegion(sheet.value, number, {
				dpi: raster.PREVIEW_DPI,
				max: 1600,
			});
			busy.value = false;
			return true;
		}
		catch (problem)
		{
			return fail(messageOf(problem));
		}
	}

	/**
	 * @param {?number[]} rect In page points; null clears it.
	 */
	function setClip(rect)
	{
		if (!rect)
		{
			clip.value = null;
			layers.value = [];
			return;
		}
		const [ax, ay, bx, by] = rect;
		clip.value = [
			Math.min(ax, bx), Math.min(ay, by),
			Math.max(ax, bx), Math.max(ay, by),
		];
		layers.value = [];
	}

	/**
	 * The pens in the region, best first, so the layer can be overridden.
	 *
	 * Offered rather than hidden because the ranking is wrong sometimes and is
	 * deliberately not tuned to any one drawing - `tools/AGENTS.md` records
	 * both, and `layer_check.py` is how the same question is answered on the
	 * command line.
	 */
	async function inspectLayers()
	{
		if (!sheet.value || !region.value)
		{
			return false;
		}
		busy.value = true;
		error.value = null;
		try
		{
			const modulesNow = await load();
			const paths = await sheet.value.paths(page.value);
			layers.value = modulesNow.layers.listLayers(paths, region.value, scale.value);
			busy.value = false;
			return true;
		}
		catch (problem)
		{
			return fail(messageOf(problem));
		}
	}

	/**
	 * Trace the region, and render it as a carbon sheet to lay underneath.
	 */
	async function run()
	{
		if (!sheet.value || !region.value)
		{
			return false;
		}
		busy.value = true;
		error.value = null;
		result.value = null;
		check.value = null;
		try
		{
			const modulesNow = await load();
			step('Rendering the backdrop…', 0.08);
			const underlay = await modulesNow.raster.renderRegion(sheet.value, page.value, {
				clip: region.value,
				dpi: modulesNow.raster.UNDERLAY_DPI,
			});
			const traced = await modulesNow.trace.traceSheet({
				// The tracer reports its own stages, which are the ones worth
				// naming: splitting the pens, tracing walls, finding openings.
				onProgress: (label, value) => step(label, 0.2 + value * 0.6),
				sheet: sheet.value,
				page: page.value,
				clip: region.value,
				scale: scale.value,
				ceiling: ceiling.value,
				layer: layer.value,
				openDoors: openDoors.value,
				underlay: {url: underlay.url, width: underlay.width, height: underlay.height},
			});
			result.value = traced;
			// The check render, over the same region. Drawn after the trace
			// rather than with it, so a failure to draw the picture cannot cost
			// the trace itself.
			try
			{
				step('Drawing the check…', 0.88);
				check.value = await modulesNow.raster.renderCheck(
					sheet.value, page.value, traced.check);
			}
			catch
			{
				check.value = null;
			}
			progress.value = null;
			stage.value = 'review';
			busy.value = false;
			return true;
		}
		catch (problem)
		{
			return fail(messageOf(problem));
		}
	}

	/** Forget everything, including the parsed document. */
	function reset()
	{
		// Before closing the document, or a thumbnail still in flight draws
		// from a destroyed pdf.js worker.
		job += 1;
		if (sheet.value && sheet.value.close)
		{
			sheet.value.close();
		}
		sheet.value = null;
		filename.value = '';
		thumbnails.value = [];
		thumbnailsLeft.value = 0;
		preview.value = null;
		clip.value = null;
		layers.value = [];
		layer.value = null;
		result.value = null;
		check.value = null;
		error.value = null;
		progress.value = null;
		scale.value = DEFAULT_SCALE;
		ceiling.value = DEFAULT_CEILING_IN;
		page.value = 1;
		stage.value = 'idle';
		busy.value = false;
	}

	return {
		busy, stage, error, filename, sheet, thumbnails, thumbnailsLeft, page,
		preview, clip, scale, ceiling, openDoors, layer, layers, result, check,
		progress, warm,
		pageSize, scaleIsKnown, region,
		pick, showPage, setClip, inspectLayers, run, reset,
	};
}

/**
 * A caught value is `unknown`, and `throw 'a string'` is legal JavaScript.
 *
 * @param {unknown} problem
 */
function messageOf(problem)
{
	return problem instanceof Error ? problem.message : String(problem);
}
