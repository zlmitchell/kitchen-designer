// @ts-check

/**
 * Elapsed time, and the things that want it each frame.
 *
 * ## The objection that does not apply here
 *
 * "Animating costs frames." It does not, in this app: `Main` drives the renderer
 * with `renderer.setAnimationLoop(...)` and that callback calls `render()`
 * unconditionally, with no dirty check. Every frame is already being drawn
 * whether anything moved or not. A turning fan blade is therefore free; what was
 * missing was never the loop, it was the clock.
 *
 * And there was no clock. No `Clock`, no `AnimationMixer`, no `getDelta`
 * anywhere in `src/` before this file - so nothing could know how much time a
 * frame took, and anything that moved would have moved at the frame rate rather
 * than in seconds.
 *
 * ## Deliberately about twenty lines
 *
 * This is not an animation system and should not grow into one. There is one
 * consumer in view - a ceiling fan - and the temptation with a file like this is
 * to add easing, tracks, and a scheduler for a feature nobody has asked for. If
 * a second consumer needs something this does not do, add exactly that.
 *
 * ## Paused means paused
 *
 * `Main.pauseRender` is set while the viewer is hidden and on the way to
 * `dispose()`. A clock that kept accumulating through it would hand the first
 * frame after a resume a delta of however long the user was on another tab, and
 * a fan would jump a quarter turn. `tick()` is only called from inside the
 * render loop, and `reset()` is what a resume calls so the gap is not counted.
 */
export class FrameClock
{
	constructor()
	{
		/** @type {?number} Milliseconds, from `performance.now()`. */
		this._last = null;
		/** @type {Array<function(number, number): void>} */
		this._updaters = [];
		/** Seconds since the clock started, excluding anything `reset()` skipped. */
		this.elapsed = 0;
	}

	/**
	 * Register something to run every frame.
	 *
	 * @param {function(number, number): void} fn Receives `(delta, elapsed)` in
	 *        seconds.
	 * @returns {function(): void} Call to stop. Returning the unsubscribe rather
	 *        than exposing `remove(fn)` means a caller cannot fail to hold the
	 *        identity needed to detach - the mistake `WallItem` made with its
	 *        wall listener, which leaked one closure per re-bind.
	 */
	add(fn)
	{
		this._updaters.push(fn);
		var self = this;
		return function ()
		{
			var at = self._updaters.indexOf(fn);
			if (at !== -1)
			{
				self._updaters.splice(at, 1);
			}
		};
	}

	/** Forget when the last frame was, so the next delta starts from now. */
	reset()
	{
		this._last = null;
	}

	/**
	 * Advance, and run every updater.
	 *
	 * @param {number} [now] Milliseconds. Injectable so a test can drive time
	 *        without waiting for it.
	 * @returns {number} The delta used, in seconds.
	 */
	tick(now)
	{
		var at = (now === undefined) ? performance.now() : now;
		if (this._last === null)
		{
			this._last = at;
			return 0;
		}

		var delta = (at - this._last) / 1000;
		this._last = at;
		// A tab that was in the background hands back an enormous first delta, and
		// a fan that integrated it would spin through a whole revolution in one
		// frame. Capped at two frames' worth of 30fps, which is long enough to
		// absorb a slow frame and short enough that nothing visibly jumps.
		if (delta > 0.066)
		{
			delta = 0.066;
		}
		if (delta < 0)
		{
			delta = 0;
		}

		this.elapsed += delta;
		// Copied before iterating: an updater is allowed to unsubscribe itself,
		// and splicing the array being walked skips its neighbour.
		this._updaters.slice().forEach((fn) => {fn(delta, this.elapsed);});
		return delta;
	}

	/** Drop every updater. */
	dispose()
	{
		this._updaters = [];
		this._last = null;
	}
}
