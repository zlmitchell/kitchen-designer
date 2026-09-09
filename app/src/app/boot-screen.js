// @ts-check

/**
 * The splash that covers the load, and the code that takes it away.
 *
 * The markup and the CSS are in `index.html`, not here, and that is the whole
 * point of the split: this application is over a megabyte of JavaScript before
 * three.js has fetched a single model, and nothing a bundle contains can be on
 * screen during the wait for that bundle. So the page ships the splash, already
 * painted by the time the module request goes out, and this module - which
 * arrives with everything else - is only ever allowed to *update and remove* it.
 *
 * ## Why it is a plain module and not a component
 *
 * Because `#boot` lives outside `#app`. Vue takes over its mount element on
 * `createApp().mount()`, so a splash inside it would be discarded a frame
 * before the viewport has anything to show - a flash of empty chrome, which is
 * the failure this exists to prevent. Nothing else in `src/app/` touches the
 * DOM directly and nothing else should; this is the one element Vue does not
 * own.
 *
 * ## The deadline
 *
 * A splash that waits for a signal is a splash that can wait forever, and a
 * user staring at a progress bar for a model that will never arrive has no way
 * out - there is no interface behind it to reach. `Scene` resolves a failed
 * load as EVENT_ITEM_LOADED, so a 404 or a broken .glb already balances the
 * count; what does not is a stalled connection, where the request neither
 * succeeds nor errors. DEADLINE_MS is the answer to that one: past it the
 * splash leaves regardless, and the session continues with whatever has
 * arrived. Furniture that lands afterwards simply appears in the scene.
 */

/** The ids in index.html. Changing one means changing both files. */
const ROOT_ID = 'boot';
const FILL_ID = 'boot-fill';
const TRACK_ID = 'boot-track';
const STATUS_ID = 'boot-status';

/** Set to fade; must match the transition duration on `#boot` in index.html. */
const DONE_CLASS = 'is-done';
const FADE_MS = 320;

/** Dropped from the track once there is a real denominator to show. */
const WAITING_CLASS = 'is-waiting';

/**
 * How long the splash may cover the application before it leaves anyway.
 *
 * Long enough that a cold cache on a slow connection still finishes underneath
 * it - the design is ~64 models - and short enough that a stalled request is
 * an inconvenience rather than a dead page.
 */
export const DEADLINE_MS = 25000;

/**
 * A boot screen that does nothing.
 *
 * Returned whenever the element is absent, which is every test that mounts
 * `App.vue` directly and every embedder that renders the application into a
 * page of their own. The application must not know the difference, so this
 * answers the whole interface rather than callers null-checking it.
 *
 * @returns {BootScreen}
 */
function noBootScreen()
{
	return {
		stage: function () {},
		progress: function () {},
		done: function () {},
		get finished() {return true;},
	};
}

/**
 * @typedef {Object} BootScreen
 * @property {function(string): void} stage Replace the status line.
 * @property {function(number, number): void} progress Loaded / total, as a bar.
 * @property {function(): void} done Fade out and remove the element.
 * @property {boolean} finished Whether `done` has already run.
 */

/**
 * Drive the splash element `root`.
 *
 * Exported for the tests, which build the markup themselves rather than
 * parsing index.html. Application code wants {@link bootScreen}.
 *
 * @param {?HTMLElement} root The `#boot` element, or null when there is none.
 * @returns {BootScreen}
 */
export function createBootScreen(root)
{
	if (!root)
	{
		return noBootScreen();
	}

	// `const`, and not `var` like everything else in here: the closures below
	// outlive this function, and TypeScript keeps a narrowing across a closure
	// boundary only for a binding it knows cannot be reassigned. Without it the
	// null check above is forgotten by the time `done` reads it.
	const element = root;
	var doc = element.ownerDocument;
	var fill = doc.getElementById(FILL_ID);
	var track = doc.getElementById(TRACK_ID);
	var status = doc.getElementById(STATUS_ID);
	var finished = false;

	/**
	 * Fires DEADLINE_MS after the screen is created - see the note at the top of
	 * this file. Cleared by `done`, whichever gets there first.
	 */
	var deadline = setTimeout(function () {done();}, DEADLINE_MS);

	/**
	 * @param {string} text
	 */
	function stage(text)
	{
		if (finished || !status)
		{
			return;
		}
		status.textContent = text;
	}

	/**
	 * Move the bar.
	 *
	 * A zero or negative total means "still counting": the bar goes back to its
	 * indeterminate sweep rather than showing 0%, because a bar pinned at zero
	 * for two seconds reads as a hang and a sweeping one reads as work.
	 *
	 * @param {number} loaded
	 * @param {number} total
	 */
	function progress(loaded, total)
	{
		if (finished || !fill || !track)
		{
			return;
		}
		if (!(total > 0))
		{
			track.classList.add(WAITING_CLASS);
			return;
		}
		track.classList.remove(WAITING_CLASS);
		var ratio = Math.max(0, Math.min(1, loaded / total));
		fill.style.width = `${Math.round(ratio * 100)}%`;
	}

	/**
	 * Fade the splash out and take it out of the document.
	 *
	 * Removed rather than hidden: it is a fixed overlay across the whole
	 * viewport, and one left in the page is one more thing hit-testing every
	 * pointer event for the life of the session. Idempotent, because the
	 * deadline and a finished load both call it.
	 */
	function done()
	{
		if (finished)
		{
			return;
		}
		finished = true;
		clearTimeout(deadline);
		element.classList.add(DONE_CLASS);
		setTimeout(function ()
		{
			if (element.parentNode)
			{
				element.parentNode.removeChild(element);
			}
		}, FADE_MS);
	}

	return {stage, progress, done, get finished() {return finished;}};
}

/**
 * The splash in the current document, or a no-op where there is none.
 *
 * @returns {BootScreen}
 */
export function bootScreen()
{
	if (typeof document === 'undefined')
	{
		return noBootScreen();
	}
	return createBootScreen(/** @type {?HTMLElement} */ (document.getElementById(ROOT_ID)));
}
