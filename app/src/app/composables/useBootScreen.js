// @ts-check
import {onScopeDispose, watch} from 'vue';
import {EVENT_ITEM_LOADING, EVENT_ITEM_LOADED, textureLoadingManager} from '../../scripts/blueprint.js';
import {bootScreen} from '../boot-screen.js';

/**
 * What the splash in `index.html` is told, and when it is allowed to leave.
 *
 * `boot-screen.js` owns the element; this owns the *story* - how far through
 * the load the person is, and the one moment at which the application behind it
 * is worth looking at.
 *
 * ## The bar counts files, and why it did not always
 *
 * The first version counted items: one unit per object in the design, from the
 * EVENT_ITEM_LOADING / EVENT_ITEM_LOADED pair the scene dispatches. It read
 * well and it measured almost nothing. In this kitchen 63 of the 64 items are
 * `generated:*` - cabinets, doors, windows and counters built from their spec
 * by `items/generated/`, with no file behind them at all - so the bar sprinted
 * through 63 free units and then sat on the one real download.
 *
 * So the denominator is files now, taken from the two loading managers that
 * between them see every byte this application fetches:
 *
 *   `scene.loadingManager`     the models, and the Draco and KTX2 payloads
 *                              three fetches on the first compressed mesh or
 *                              texture. Per document.
 *   `textureLoadingManager`    every texture, including the maps behind the
 *                              generated cabinets - `core/texture_cache.js`
 *                              loads those, and it is what makes the count
 *                              honest for a design made mostly of them. Per
 *                              page.
 *
 * The items are still counted, because a file is not an object: geometry
 * arrives, and then an `Item` is constructed from it. They no longer drive the
 * bar - they are half of the condition for leaving.
 *
 * ## A discovered total, and a bar that does not go backwards
 *
 * Nothing knows the true file count up front. A `.glb` names its own textures,
 * and three does not fetch its transcoder until the first file needs it, so the
 * denominator grows as the load discovers work. That is what a loading manager
 * can tell you and it is honest, but a bar that retreats from 60% to 40%
 * because six textures were just discovered reads as a fault.
 *
 * So the *text* shows the real pair - "23 of 41 files", denominator and all -
 * and the *bar* is clamped never to retreat. The two disagree slightly while
 * the total is still growing, and that is the trade: the number is exact, the
 * bar is reassuring, and neither of them lies about being finished.
 *
 * ## When it leaves
 *
 * All three, and then a beat of quiet:
 *
 *   `ready()`     the design has loaded and been framed - App.vue calls it from
 *                 the same `then` that seeds the history stack.
 *   items         every object the document asked for has been built.
 *   files         both managers have nothing in flight.
 *
 * The beat is QUIET_MS, and it is there because those three can all be true one
 * tick before an item's material asks for its first texture. Waiting for the
 * files at all is the point of the exercise: a kitchen that pops in one cabinet
 * at a time over ten seconds looks broken in a way that a slightly longer
 * splash does not. `boot-screen.js` caps the total wait, so no signal failing
 * to arrive can strand anybody.
 */

/**
 * How long everything has to stay idle before the splash accepts that the load
 * is over. Long enough to cover a texture requested one tick after the model
 * that needs it, short enough not to be felt.
 */
export const QUIET_MS = 150;

/**
 * @param {import('./useBlueprint.js').BlueprintStore} store
 */
export function useBootScreen(store)
{
	var screen = bootScreen();

	/** One object per document: what the scene has been asked to build. */
	var items = {started: 0, settled: 0};

	/**
	 * Per manager, the last `(loaded, total)` it reported.
	 *
	 * A Map because the two managers have different lifetimes - the texture one
	 * belongs to the page and the model one to this document - and because their
	 * counters are private to three: the callbacks are the only way to read them,
	 * so the latest pair each has handed us IS the state.
	 *
	 * @type {Map<Object, {loaded: number, total: number}>}
	 */
	var files = new Map();

	/** Undo functions for the handlers this composable installed. */
	var restores = [];

	var designReady = false;
	/** The highest ratio the bar has shown; it never goes below this. */
	var shown = 0;
	var quiet = null;
	var attached = null;

	/**
	 * @param {string} text
	 */
	function stage(text)
	{
		screen.stage(text);
	}

	function fileCount()
	{
		var loaded = 0;
		var total = 0;
		files.forEach(function (count)
		{
			loaded += count.loaded;
			total += count.total;
		});
		return {loaded, total};
	}

	function update()
	{
		var count = fileCount();

		if (count.total > 0)
		{
			// Clamped, not raw: see the note about a discovered total above.
			shown = Math.max(shown, count.loaded / count.total);
			// Nothing has come back yet, so the bar keeps sweeping rather than
			// sitting at zero - the count beneath it already says what is going on.
			if (shown > 0)
			{
				screen.progress(shown, 1);
			}
			screen.stage(`Loading the kitchen - ${count.loaded} of ${count.total} files`);
			return;
		}

		// No file has been requested yet. Everything in this design is generated,
		// or the first request has not gone out - either way the items are the
		// only measure there is, and they are better than a bar stuck at zero.
		if (items.started > 0)
		{
			shown = Math.max(shown, items.settled / items.started);
			if (shown > 0)
			{
				screen.progress(shown, 1);
			}
			screen.stage(`Building the kitchen - ${items.settled} of ${items.started}`);
		}
	}

	/** Whether everything asked for has come back. */
	function idle()
	{
		var count = fileCount();
		return items.settled >= items.started && count.loaded >= count.total;
	}

	function finishIfDone()
	{
		if (!designReady || !idle())
		{
			// Something started again during the beat of quiet. Whatever it is has
			// to come back before the splash may leave.
			clearTimeout(quiet);
			quiet = null;
			return;
		}
		if (quiet)
		{
			return;
		}
		quiet = setTimeout(function ()
		{
			quiet = null;
			if (!designReady || !idle())
			{
				return;
			}
			screen.progress(1, 1);
			screen.stage('Ready');
			screen.done();
			detach();
		}, QUIET_MS);
	}

	/**
	 * The design is on screen and framed. Called by App.vue; the models and their
	 * textures may or may not still be arriving.
	 */
	function ready()
	{
		designReady = true;
		finishIfDone();
	}

	/**
	 * Count what a `LoadingManager` fetches, without taking it over.
	 *
	 * Both handlers are chained rather than assigned: `onStart` and `onProgress`
	 * are single-slot properties on a manager the whole page shares, and a boot
	 * screen is not entitled to silence somebody else's. They are put back on
	 * detach for the same reason.
	 *
	 * three calls `onStart` once at the head of a batch and `onProgress` on every
	 * completion, and passes the running `(loaded, total)` to both - which is the
	 * only way to read them, since the manager keeps them in a closure.
	 *
	 * @param {?Object} manager
	 */
	function watchManager(manager)
	{
		if (!manager || files.has(manager))
		{
			return;
		}

		var count = {loaded: 0, total: 0};
		files.set(manager, count);

		var previousStart = manager.onStart;
		var previousProgress = manager.onProgress;

		manager.onStart = function (url, loaded, total)
		{
			count.loaded = loaded;
			count.total = total;
			update();
			if (previousStart) {previousStart(url, loaded, total);}
		};
		manager.onProgress = function (url, loaded, total)
		{
			count.loaded = loaded;
			count.total = total;
			update();
			finishIfDone();
			if (previousProgress) {previousProgress(url, loaded, total);}
		};

		restores.push(function ()
		{
			manager.onStart = previousStart;
			manager.onProgress = previousProgress;
		});
	}

	function attach(blueprint)
	{
		attached = {
			scene: blueprint.model.scene,
			onLoading: function ()
			{
				items.started += 1;
				update();
			},
			onLoaded: function ()
			{
				items.settled += 1;
				update();
				finishIfDone();
			},
		};
		attached.scene.addEventListener(EVENT_ITEM_LOADING, attached.onLoading);
		attached.scene.addEventListener(EVENT_ITEM_LOADED, attached.onLoaded);

		watchManager(attached.scene.loadingManager);
		watchManager(textureLoadingManager);
	}

	function detach()
	{
		clearTimeout(quiet);
		quiet = null;

		restores.forEach(function (restore) {restore();});
		restores = [];
		files.clear();

		if (!attached)
		{
			return;
		}
		attached.scene.removeEventListener(EVENT_ITEM_LOADING, attached.onLoading);
		attached.scene.removeEventListener(EVENT_ITEM_LOADED, attached.onLoaded);
		attached = null;
	}

	/**
	 * `flush: 'sync'` rather than the default, and it is not a preference.
	 *
	 * `App.vue` mounts the store and starts the design load in the same
	 * `onMounted`, and a `pre`-flush watcher does not run until the next tick -
	 * by which time `Model.newRoom` has already dispatched EVENT_ITEM_LOADING for
	 * every item in the document and the first models are in flight. The
	 * listeners have to be on the scene the instant the scene exists, or the
	 * count starts from whatever happened to be left.
	 */
	watch(store.instance, function (blueprint)
	{
		detach();
		if (blueprint)
		{
			attach(blueprint);
		}
	}, {immediate: true, flush: 'sync'});

	onScopeDispose(function ()
	{
		detach();
		// An unmount mid-boot - a route change, a test tearing the app down - must
		// not leave a full-screen overlay over whatever comes next.
		screen.done();
	});

	return {stage, ready, screen};
}
