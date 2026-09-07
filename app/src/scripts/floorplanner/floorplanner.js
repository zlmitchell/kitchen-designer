// @ts-check
import {EventDispatcher, Vector2} from 'three';
import {cmPerPixel, pixelsPerCm} from '../core/dimensioning.js';
import {configDimUnit, snapTolerance, gridSpacing} from '../core/configuration.js';
import {EVENT_MODE_RESET, EVENT_LOADED} from '../core/events.js';
import {EVENT_CORNER_ATTRIBUTES_CHANGED, EVENT_WALL_ATTRIBUTES_CHANGED, EVENT_ROOM_ATTRIBUTES_CHANGED} from '../core/events.js';
import {EVENT_CORNER_2D_HOVER, EVENT_WALL_2D_HOVER, EVENT_ROOM_2D_HOVER} from '../core/events.js';
import {EVENT_CORNER_2D_CLICKED, EVENT_ROOM_2D_CLICKED, EVENT_WALL_2D_CLICKED} from '../core/events.js';
import {EVENT_CORNER_2D_DOUBLE_CLICKED, EVENT_ROOM_2D_DOUBLE_CLICKED, EVENT_WALL_2D_DOUBLE_CLICKED} from '../core/events.js';
import {EVENT_NOTHING_CLICKED} from '../core/events.js';
import {resolveCanvas} from '../core/dom.js';
import {FloorplannerView2D, floorplannerModes} from './floorplanner_view.js';


/**
 * JSDoc-only type imports (RM-005 C2).
 *
 * These names were already used in the annotations below and resolved to
 * nothing - 43 TS2304s across eleven files, every one of them a type the
 * project defines or three exports, named but never brought into scope. A
 * `@typedef` import costs no runtime code and no bundle bytes: it exists
 * entirely for the checker, which is the point of writing the JSDoc at all.

 *
 * @typedef {import('../model/floorplan.js').Floorplan} Floorplan
 */
/** how much will we move a corner to make a wall axis aligned (cm) */
//export const snapTolerance = 25;//In CMS
/**
* The Floorplanner implements an interactive tool for creation of floorplans in
* 2D.
*/
/**
 * The nearest grid line, at a given pitch.
 *
 * `Math.round`, where both snap sites used `Math.floor`. Flooring does not snap:
 * it drags everything down and left by up to a whole cell, always in the same
 * direction. On the default 25cm grid a point 24cm past a line lands back on that
 * line rather than on the one 1cm away. Rounding is symmetric, which is what
 * "snap to the nearest grid line" means and what the drawn grid implies.
 *
 * @param {number} value
 * @param {number} pitch Centimetres between grid lines. Zero would divide by
 *        nothing, so the value passes through untouched.
 * @returns {number}
 */
/**
 * The directions a drawn wall prefers, in degrees.
 *
 * 15 gives 24 of them, which includes every angle a house is actually built at
 * - 90 for the square corners, 45 for a bay or a cut corner, 30 and 60 for a
 * hipped return - without pretending 7 degrees is a thing somebody meant.
 */
const ANGLE_SNAP_DEGREES = 15;

/**
 * How far off one of those before it stops being what you meant, in degrees.
 *
 * Angular rather than a distance, and that is the point. The axis snap beside
 * it uses `snapTolerance`, which is in CENTIMETRES - so it gets weaker the
 * longer the wall. At 10m a 25cm tolerance is 1.4 degrees, which is why a long
 * wall was so hard to get exactly horizontal and a short one snapped whether
 * you wanted it to or not. An angle does not care how far away the far end is.
 *
 * 5 of every 15 degrees snap, so two thirds of the circle is still free.
 */
const ANGLE_SNAP_TOLERANCE = 5;

function snapToPitch(value, pitch)
{
	if (!pitch)
	{
		return value;
	}
	return Math.round(value / pitch) * pitch;
}

export class Floorplanner2D extends EventDispatcher
{
	/**
	 * @param {(HTMLCanvasElement|string)} canvas The canvas to draw into, or its
	 * element id. The id form is the deprecated back-compat path.
	 * @param {Floorplan} floorplan
	 */
	constructor(canvas, floorplan)
	{
		super();
		/** */
		this.mode = 0;
		/** */
		this.activeWall = null;
		/** */
		this.activeCorner = null;
		/** */
		this.activeRoom = null;
		
		/** */
		this._clickedWall = null;
		/** */
		this._clickedWallControl = null;
		/** */
		this._clickedCorner = null;
		/** */
		this._clickedRoom = null;
		/** */
		this.originX = 0;
		/** */
		this.originY = 0;
		/** */
		this.unScaledOriginX = 0;
		/** */
		this.unScaledOriginY = 0;
		/** drawing state */
		this.targetX = 0;
		/** drawing state */
		this.targetY = 0;
		/** drawing state */
		this.lastNode = null;
		/** */
		this.wallWidth = 0;

		/** */
		this.mouseDown = false;
		/** */
		this.mouseMoved = false;
		/** in ThreeJS coords */
		this.mouseX = 0;
		/** in ThreeJS coords */
		this.mouseY = 0;
		/** in ThreeJS coords */
		this.rawMouseX = 0;
		/** in ThreeJS coords */
		this.rawMouseY = 0;
		/** mouse position at last click */
		this.lastX = 0;
		/** mouse position at last click */
		this.lastY = 0;

		this.canvasElement = resolveCanvas(canvas, 'floorplanner canvas');
		/** Kept for back-compat: callers used to read `.canvas` as an element id. */
		this.canvas = (typeof canvas === 'string') ? canvas : this.canvasElement.id;
		this.floorplan = floorplan;
		this.view = new FloorplannerView2D(this.floorplan, this, this.canvasElement);
		this._disposed = false;

		this.cmPerPixel = cmPerPixel;
		this.pixelsPerCm = pixelsPerCm;
		
		this.wallWidth = this.dimensioning.cmToPixel(this.configuration.getNumericValue('wallThickness'));
		this.gridsnapmode = false;
		this.shiftkey = false;
		/**
		 * The existing corner the pointer is snapped to while drawing, or null.
		 *
		 * Set by `updateTarget`, read by `mouseup` - so what the highlight promised
		 * and what the click does are the same value and cannot drift apart.
		 *
		 * @type {?Object}
		 */
		this.targetCorner = null;
		/**
		 * The preferred direction the drawn wall snapped to, in degrees, or null.
		 *
		 * @type {?number}
		 */
		this.targetAngle = null;
		// Initialization:

		this.setMode(floorplannerModes.MOVE);

		var scope = this;

		// One pointer stream instead of the old touch* + mouse* pairs. Registered
		// non-passive because the touch path calls preventDefault() to stop the
		// page scrolling out from under a drag; touch-action does the same job for
		// gestures the browser would otherwise claim before a listener ever runs.
		this._pointerOptions = {passive: false};
		this._pointerDownEvent = (event) => {scope.mousedown(event);};
		this._pointerMoveEvent = (event) => {scope.mousemove(event);};
		// These three take no event - `mouseup(/*event*/)` has its parameter
		// commented out - so they are called without one (RM-005 C2). Passing an
		// argument to a zero-parameter function is a no-op in JS and a TS2554 here;
		// the handlers below that DO read the event still get it.
		this._pointerUpEvent = () => {scope.mouseup();};
		this._pointerLeaveEvent = () => {scope.mouseleave();};
		this._doubleClickEvent = () => {scope.doubleclick();};
		this._keyUpEvent = (event) => {scope.keyUp(event);};
		this._keyDownEvent = (event) => {scope.keyDown(event);};
		this._floorplanLoadedEvent = () => {scope.reset();};
		this._updateViewEvent = () => {scope.view.invalidate();};

		this._previousTouchAction = this.canvasElement.style.touchAction;
		this.canvasElement.style.touchAction = 'none';

		this.canvasElement.addEventListener('pointerdown', this._pointerDownEvent, this._pointerOptions);
		this.canvasElement.addEventListener('pointermove', this._pointerMoveEvent, this._pointerOptions);
		this.canvasElement.addEventListener('pointerup', this._pointerUpEvent, this._pointerOptions);
		this.canvasElement.addEventListener('pointerleave', this._pointerLeaveEvent, this._pointerOptions);
		// A cancelled pointer (the browser took the gesture, the pen left range)
		// would otherwise leave mouseDown stuck true and the plan panning forever.
		this.canvasElement.addEventListener('pointercancel', this._pointerLeaveEvent, this._pointerOptions);
		this.canvasElement.addEventListener('dblclick', this._doubleClickEvent, this._pointerOptions);

		document.addEventListener('keyup', this._keyUpEvent);
		document.addEventListener('keydown', this._keyDownEvent);
		floorplan.addEventListener(EVENT_LOADED, this._floorplanLoadedEvent);
		floorplan.addEventListener(EVENT_CORNER_ATTRIBUTES_CHANGED, this._updateViewEvent);
		floorplan.addEventListener(EVENT_WALL_ATTRIBUTES_CHANGED, this._updateViewEvent);
		floorplan.addEventListener(EVENT_ROOM_ATTRIBUTES_CHANGED, this._updateViewEvent);
	}

	/**
	 * Detach everything this instance attached: canvas pointer listeners, the two
	 * document key listeners, the four floorplan listeners, and the view (which
	 * owns the window/ResizeObserver listeners and the carbon sheet). Safe to call
	 * more than once.
	 */
	dispose()
	{
		if (this._disposed)
		{
			return;
		}
		this._disposed = true;

		// No options object on removal (RM-005 C2). `removeEventListener` matches
		// on type, listener and `capture` only - `passive` is an addEventListener
		// concept and is not part of the identity, so passing `{passive: false}`
		// here was ignored at runtime and a TS2769 at build time. Both calls have
		// capture false, so the pairing is unchanged.
		this.canvasElement.removeEventListener('pointerdown', this._pointerDownEvent);
		this.canvasElement.removeEventListener('pointermove', this._pointerMoveEvent);
		this.canvasElement.removeEventListener('pointerup', this._pointerUpEvent);
		this.canvasElement.removeEventListener('pointerleave', this._pointerLeaveEvent);
		this.canvasElement.removeEventListener('pointercancel', this._pointerLeaveEvent);
		this.canvasElement.removeEventListener('dblclick', this._doubleClickEvent);
		this.canvasElement.style.touchAction = this._previousTouchAction;

		document.removeEventListener('keyup', this._keyUpEvent);
		document.removeEventListener('keydown', this._keyDownEvent);

		this.floorplan.removeEventListener(EVENT_LOADED, this._floorplanLoadedEvent);
		this.floorplan.removeEventListener(EVENT_CORNER_ATTRIBUTES_CHANGED, this._updateViewEvent);
		this.floorplan.removeEventListener(EVENT_WALL_ATTRIBUTES_CHANGED, this._updateViewEvent);
		this.floorplan.removeEventListener(EVENT_ROOM_ATTRIBUTES_CHANGED, this._updateViewEvent);

		this.view.dispose();

		this.activeWall = null;
		this.activeCorner = null;
		this.activeRoom = null;
		this._clickedWall = null;
		this._clickedWallControl = null;
		this._clickedCorner = null;
		this._clickedRoom = null;
		this.lastNode = null;
	}

	/**
	 * This design's settings, reached through the plan being drawn (RM-002 R-02, P7).
	 *
	 * The 2D view is per-Floorplan by construction - it is handed one and draws
	 * it - so the plan is the natural place to ask, and no new plumbing was
	 * needed to get here. Reading through a getter rather than caching the
	 * reference keeps a view correct if the floorplan it draws is ever swapped.
	 *
	 * @returns {import('../core/configuration.js').Configuration}
	 */
	get configuration()
	{
		return this.floorplan.configuration;
	}

	/**
	 * Unit and scale conversion for this design (P7).
	 *
	 * @returns {import('../core/dimensioning.js').Dimensioning}
	 */
	get dimensioning()
	{
		return this.floorplan.dimensioning;
	}

	/**
	 * Everything but a mouse gets the old touch treatment: the pointer position
	 * seeds the pan origin on press, and moves suppress the browser's own scroll.
	 */
	_isTouchLike(event)
	{
		return !!(event && event.pointerType && event.pointerType !== 'mouse');
	}
	
	get selectedCorner()
	{
		return this._clickedCorner;
	}
	
	get selectedWall()
	{
		return this._clickedWall;
	}
	
	get selectedRoom()
	{
		return this._clickedRoom;
	}

	get carbonSheet()
	{
		return this.view.carbonSheet;
	}

	doubleclick()
	{
		var userinput, cid;
		function getAValidInput(message, current)
		{
			var uinput = window.prompt(message, current);
			if(uinput != null)
			{
				return uinput;
			}
			return current;
		}
		if(this.activeCorner)
		{
			this.floorplan.dispatchEvent({type:EVENT_CORNER_2D_DOUBLE_CLICKED, item: this.activeCorner});
			if(!this.configuration.getNumericValue('systemUI'))
			{
				return;
			}
			cid = this.activeCorner.id;
			var units = this.configuration.getStringValue(configDimUnit);
			this.activeCorner.elevation = getAValidInput(`Elevation at this point (in ${units},\n${cid}): `, this.dimensioning.cmToMeasureRaw(this.activeCorner.elevation));//Number(userinput);
			var x = getAValidInput(`Location: X (${this.dimensioning.cmToMeasureRaw(this.activeCorner.x)}): `, this.dimensioning.cmToMeasureRaw(this.activeCorner.x));//Number(userinput);
			var y = getAValidInput(`Location: Y (${this.dimensioning.cmToMeasureRaw(this.activeCorner.y)}): `, this.dimensioning.cmToMeasureRaw(this.activeCorner.y));//Number(userinput);
			this.activeCorner.move(this.dimensioning.cmFromMeasureRaw(x), this.dimensioning.cmFromMeasureRaw(y));
			
		}
		else if(this.activeWall)
		{
			this.floorplan.dispatchEvent({type:EVENT_WALL_2D_DOUBLE_CLICKED, item: this.activeWall});
			if(!this.configuration.getNumericValue('systemUI'))
			{
				return;
			}
		}
		else if(this.activeRoom)
		{
			this.floorplan.dispatchEvent({type:EVENT_ROOM_2D_DOUBLE_CLICKED, item: this.activeRoom});
			if(!this.configuration.getNumericValue('systemUI'))
			{
				return;
			}
			userinput = window.prompt('Enter a name for this Room: ', this.activeRoom.name);
			if(userinput != null)
			{
				this.activeRoom.name = userinput;
			}
			this.view.invalidate();
		}
	}

	keyUp(e)
	{
		if (e.keyCode == 27)
		{
			this.escapeKey();
		}
		this.gridsnapmode = false;
		this.shiftkey = false;
	}

	keyDown(e)
	{
		if(e.shiftKey || e.keyCode == 16)
		{
			this.shiftkey = true;
		}
		this.gridsnapmode = this.shiftkey;
	}

	/** */
	escapeKey()
	{
		this.setMode(floorplannerModes.MOVE);
	}

	/**
	 * The corner a click would land on, or null for empty canvas.
	 *
	 * Joining an existing corner ALREADY WORKED, and that is worth stating plainly
	 * because the obvious diagnosis is wrong: `Floorplan.newCorner` returns an
	 * existing corner rather than making one whenever the two are within
	 * `cornerTolerance`, so a click near a junction has always attached to it and
	 * the run has always continued through it.
	 *
	 * What was missing is every way of KNOWING that. `updateTarget` only ever
	 * aligned to the last node's x or y, so the preview line went wherever the
	 * mouse was and stopped short of the corner it was about to join; the hover
	 * highlight is guarded on not being in DRAW mode, so nothing lit up. The 20cm
	 * grab circle was real and completely invisible, which is what "I drag and
	 * hope for the best" describes.
	 *
	 * So this snaps BEFORE the click. The target moves onto the corner, the
	 * preview ends there, and the corner lights up using the same `activeCorner`
	 * highlight MOVE mode already had - the plan says what the click will do
	 * before you commit to it.
	 *
	 * It also moves the grab radius off `cornerTolerance` and onto
	 * `snapTolerance`: the configured "how close before I grab", what the axis
	 * snapping below already uses, and the one the Settings panel exposes.
	 *
	 * @returns {?Object} A Corner, or null.
	 */
	cornerUnderPointer()
	{
		if (this.mode != floorplannerModes.DRAW)
		{
			return null;
		}
		return this.floorplan.overlappedCorner(this.mouseX, this.mouseY,
			this.configuration.getNumericValue(snapTolerance));
	}

	/** */
	updateTarget()
	{
		// An existing corner beats every other rule, including the grid. Somebody
		// aiming at a junction means that junction and not the grid line nearest
		// it - and a wall that ends a centimetre short of one is exactly the defect
		// this whole snap exists to stop.
		this.targetCorner = this.cornerUnderPointer();
		// The view draws `activeCorner` as a hover, which is the feedback this
		// needs and which DRAW mode was never given: the hover block in
		// `mousemove` is guarded on not being in DRAW mode.
		//
		// ONLY in DRAW mode. `updateTarget` also runs on every MOVE-mode drag, and
		// `activeCorner` is what that drag is holding on to - writing null over it
		// here drops the corner mid-gesture.
		if (this.mode == floorplannerModes.DRAW)
		{
			this.activeCorner = this.targetCorner;
		}
		if (this.targetCorner)
		{
			this.targetX = this.targetCorner.x;
			this.targetY = this.targetCorner.y;
			this.view.invalidate();
			return;
		}

		if (this.mode == floorplannerModes.DRAW && this.lastNode)
		{
			if (Math.abs(this.mouseX - this.lastNode.x) < this.configuration.getNumericValue(snapTolerance))
			{
				this.targetX = this.lastNode.x;
			}
			else
			{
				this.targetX = this.mouseX;
			}
			if (Math.abs(this.mouseY - this.lastNode.y) < this.configuration.getNumericValue(snapTolerance))
			{
				this.targetY = this.lastNode.y;
			}
			else
			{
				this.targetY = this.mouseY;
			}
		}
		else
		{
			this.targetX = this.mouseX;
			this.targetY = this.mouseY;
		}
		
		if(this.gridsnapmode || this.configuration.getNumericValue('snapToGrid'))
		{
			// Snap to the grid you can SEE.
			//
			// This read snapTolerance, and the comment left here said so - "the
			// snapTolerance is necessary for X, Y axis snapping, whereas grid
			// snapping is for snapping to grid lines" - and then did it anyway.
			// gridSpacing drew the grid and nothing else, so the Settings panel's
			// "Grid resolution" changed what you looked at while "Snap every"
			// silently decided where things landed. Both default to 25, so it was
			// invisible until somebody changed one - and then the grid lied.
			//
			// They are different jobs and keep their own numbers: snapTolerance is
			// a DISTANCE, "how close before I grab", used by the axis snapping
			// above; gridSpacing is a PITCH, "how far apart the lines are".
			this.targetX = snapToPitch(this.targetX, this.configuration.getNumericValue(gridSpacing));
			this.targetY = snapToPitch(this.targetY, this.configuration.getNumericValue(gridSpacing));
		}

		// LAST, so the angle survives. Run before the grid and a 15 or 30 degree
		// wall is immediately pulled off it again - a square grid only preserves
		// the angles that happen to land on it, which is 0, 90 and whichever
		// diagonals the pitch allows. Run after, and the grid decides roughly how
		// LONG the wall is while the angle stays exact, which is the priority
		// somebody drawing at an angle is expressing.
		this.snapTargetAngle();

		this.view.invalidate();
	}

	/**
	 * Turn the target onto the nearest preferred direction from the last node.
	 *
	 * Rotates rather than projects: the distance from the last node to the
	 * pointer is kept and only the DIRECTION is corrected, so the far end follows
	 * the pointer out and back the way it looks like it should. Projecting onto
	 * the ray would shorten the wall as the pointer drifts off it, which reads as
	 * the wall shrinking for no reason. Within the tolerance the two differ by
	 * under half a percent of the length anyway.
	 *
	 * Records the angle it chose in `targetAngle` so the view can say which one -
	 * a snap nobody can see is indistinguishable from a shaky hand.
	 */
	snapTargetAngle()
	{
		this.targetAngle = null;
		if (this.mode != floorplannerModes.DRAW || !this.lastNode || this.targetCorner)
		{
			// A corner the pointer is already on wins outright: it is a POSITION,
			// and there is no angle that could be more important than landing on
			// the junction somebody aimed at.
			return;
		}

		var dx = this.targetX - this.lastNode.x;
		var dy = this.targetY - this.lastNode.y;
		var length = Math.sqrt(dx * dx + dy * dy);
		// Nothing to aim yet. Every direction is within tolerance of a snap when
		// the two points are on top of each other, and snapping then would make
		// the first millimetre of every wall jump to a multiple of 15 degrees.
		if (length < 1)
		{
			return;
		}

		var degrees = Math.atan2(dy, dx) * 180 / Math.PI;
		var nearest = Math.round(degrees / ANGLE_SNAP_DEGREES) * ANGLE_SNAP_DEGREES;
		if (Math.abs(degrees - nearest) > ANGLE_SNAP_TOLERANCE)
		{
			return;
		}

		var radians = nearest * Math.PI / 180;
		this.targetX = this.lastNode.x + Math.cos(radians) * length;
		this.targetY = this.lastNode.y + Math.sin(radians) * length;
		// Normalised to 0..360 for display; -90 and 270 are the same wall.
		this.targetAngle = (nearest + 360) % 360;
	}

	/** */
	mousedown(event)
	{
		this.mouseDown = true;
		this.mouseMoved = false;
		if(this._isTouchLike(event))
		{
			// A touch arrives with no preceding move, so seed the pan origin from
			// the press itself. With a mouse the last pointermove already did.
			this.rawMouseX = event.clientX;
			this.rawMouseY = event.clientY;
		}

		this.lastX = this.rawMouseX;
		this.lastY = this.rawMouseY;
		
				
		// delete
		if (this.mode == floorplannerModes.DELETE)
		{
			if (this.activeCorner)
			{
				this.activeCorner.removeAll();
			}
			else if (this.activeWall)
			{
				this.activeWall.remove();
			}
			else
			{
				//Continue the mode of deleting walls, this is necessary for deleting multiple walls
			}
		}
		
		var bounds = this.canvasElement.getBoundingClientRect();
		this.mouseX = this.dimensioning.pixelToCm((event.clientX - bounds.left)) + this.dimensioning.pixelToCm(this.originX);
		this.mouseY = this.dimensioning.pixelToCm((event.clientY - bounds.top)) + this.dimensioning.pixelToCm(this.originY);

		if(this._clickedWall)
		{
			// `tolerance` is optional in all three of these and was not declared so.
			this._clickedWallControl = this.floorplan.overlappedControlPoint(this._clickedWall, this.mouseX, this.mouseY, undefined);
			if(this._clickedWallControl != null)
			{
				this.view.invalidate();
				return;
			}
		}
		
		
		var mDownCorner = this.floorplan.overlappedCorner(this.mouseX, this.mouseY, undefined);
		var mDownWall = this.floorplan.overlappedWall(this.mouseX, this.mouseY, undefined);
		var mDownRoom = this.floorplan.overlappedRoom(this.mouseX, this.mouseY);
		this._clickedWallControl = null;
		
		if(mDownCorner == null && mDownWall == null && mDownRoom == null)
		{
			this._clickedCorner = undefined;
			this._clickedWall = undefined;
			this._clickedRoom = undefined;
			this.floorplan.dispatchEvent({type:EVENT_NOTHING_CLICKED});
		}
		
		else if(mDownCorner != null)
		{
			this._clickedCorner = undefined;
			this._clickedWall = undefined;
			this._clickedRoom = undefined;
			this._clickedCorner = mDownCorner;
			this.floorplan.dispatchEvent({type:EVENT_CORNER_2D_CLICKED, item: this._clickedCorner});
		}
		
		else if(mDownWall != null)
		{
			this._clickedCorner = undefined;
			this._clickedWall = undefined;
			this._clickedRoom = undefined;
			this._clickedWall = mDownWall;
			this.floorplan.dispatchEvent({type:EVENT_WALL_2D_CLICKED, item: this._clickedWall});
		}
		
		else if(mDownRoom != null)
		{
			this._clickedCorner = undefined;
			this._clickedWall = undefined;
			this._clickedRoom = undefined;
			this._clickedRoom = mDownRoom;
			this.floorplan.dispatchEvent({type:EVENT_ROOM_2D_CLICKED, item: this._clickedRoom});
		}
		this.view.invalidate();
	}

	/** */
	mousemove(event)
	{
		this.mouseMoved = true;

		if(this._isTouchLike(event))
		{
			event.stopPropagation();
			event.preventDefault();
		}

		// update mouse
		this.rawMouseX = event.clientX;
		this.rawMouseY = event.clientY;

		var bounds = this.canvasElement.getBoundingClientRect();
		this.mouseX = this.dimensioning.pixelToCm(event.clientX - bounds.left) + this.dimensioning.pixelToCm(this.originX);
		this.mouseY = this.dimensioning.pixelToCm(event.clientY - bounds.top) + this.dimensioning.pixelToCm(this.originY);


		// update target (snapped position of actual mouse)
		if (this.mode == floorplannerModes.DRAW || (this.mode == floorplannerModes.MOVE && this.mouseDown))
		{
			this.updateTarget();
		}

		// update object target
		if (this.mode != floorplannerModes.DRAW && !this.mouseDown)
		{
			var hoverCorner = this.floorplan.overlappedCorner(this.mouseX, this.mouseY, undefined);
			var hoverWall = this.floorplan.overlappedWall(this.mouseX, this.mouseY, undefined);
			var hoverRoom = this.floorplan.overlappedRoom(this.mouseX, this.mouseY);
			var draw = false;			
			
			// corner takes precendence
			if (hoverCorner != this.activeCorner && this.activeWall == null)
			{
				this.activeCorner = hoverCorner;
				this.floorplan.dispatchEvent({type:EVENT_CORNER_2D_HOVER, item: hoverCorner});
				draw = true;
			}
			
			if (hoverWall != this.activeWall && this.activeCorner == null)
			{
				this.activeWall = hoverWall;
				this.floorplan.dispatchEvent({type:EVENT_WALL_2D_HOVER, item: hoverWall});
				draw = true;
			}
			else
			{
				this.activeWall = null;
			}
			
			if(this.activeWall == null && this.activeCorner == null)
			{
				this.activeRoom = hoverRoom;
			}
			
			if(this.activeCorner == null && this.activeWall == null && this.activeRoom !=null)
			{
				this.floorplan.dispatchEvent({type:EVENT_ROOM_2D_HOVER, item: hoverRoom});				
			}
			
			if(this.activeRoom == null)
			{
				draw = true;
			}

			if (draw)
			{
				this.view.invalidate();
			}
		}

		var mx, my;
		// panning.
		if (this.mouseDown  && !this.activeCorner && !this.activeWall && !this._clickedWallControl)
//		else if (this.mouseDown && (this.activeCorner==null) && (this.activeWall==null) && (this._clickedWallControl == null))
//		else if (this.mouseDown && (!this._clickedCorner) && (!this._clickedWall) && (this._clickedWallControl == null))
		{
			this.originX += (this.lastX - this.rawMouseX);
			this.originY += (this.lastY - this.rawMouseY);
			this.unScaledOriginX += (this.lastX - this.rawMouseX) * (1 / this.configuration.getNumericValue('scale'));
			this.unScaledOriginY += (this.lastY - this.rawMouseY) * (1 / this.configuration.getNumericValue('scale'));
			this.lastX = this.rawMouseX;
			this.lastY = this.rawMouseY;
			this.view.invalidate();
		}
		// dragging
		if (this.mode == floorplannerModes.MOVE && this.mouseDown)
		{
			if(this._clickedWallControl != null)
			{
				mx = this.mouseX;
				my = this.mouseY;
				if(this.gridsnapmode || this.configuration.getNumericValue('snapToGrid'))
				{
					mx = snapToPitch(this.mouseX, this.configuration.getNumericValue(gridSpacing));
					my = snapToPitch(this.mouseY, this.configuration.getNumericValue(gridSpacing));
				}
				
				this._clickedWallControl.x = mx;
				this._clickedWallControl.y = my;
				// Guarded together: this branch only runs when a control point was
				// grabbed, which means both were set by the same mousedown.
				if (this._clickedWall) { this._clickedWall.updateControlVectors(); }
				this.view.invalidate();
				return;
			}
			if (this.activeCorner)
			{
				if(this.gridsnapmode || this.configuration.getNumericValue('snapToGrid'))
				{
					
					mx = Math.floor(this.mouseX / this.configuration.getNumericValue(snapTolerance)) * this.configuration.getNumericValue(snapTolerance);
					my = Math.floor(this.mouseY / this.configuration.getNumericValue(snapTolerance)) * this.configuration.getNumericValue(snapTolerance);
					
					this.activeCorner.move(Math.round(mx), Math.round(my));
				}
				else
				{
					this.activeCorner.move(this.mouseX, this.mouseY);
				}
			}
			else if (this.activeWall)
			{
				if(this.gridsnapmode || this.configuration.getNumericValue('snapToGrid'))
				{
					var dx = this.dimensioning.pixelToCm(this.rawMouseX - this.lastX);
					var dy = this.dimensioning.pixelToCm(this.rawMouseY - this.lastY);
					mx = Math.floor(dx / this.configuration.getNumericValue(snapTolerance)) * this.configuration.getNumericValue(snapTolerance);
					my = Math.floor(dy / this.configuration.getNumericValue(snapTolerance)) * this.configuration.getNumericValue(snapTolerance);
					this.activeWall.relativeMove(mx, my);
				}
				else
				{
					this.activeWall.relativeMove(this.dimensioning.pixelToCm(this.rawMouseX - this.lastX), this.dimensioning.pixelToCm(this.rawMouseY - this.lastY));
				}
				
				
				if(this.gridsnapmode || this.configuration.getNumericValue('snapToGrid'))
				{
					this.activeWall.snapToAxis(this.configuration.getNumericValue(snapTolerance));
				}
				this.lastX = this.rawMouseX;
				this.lastY = this.rawMouseY;
			}
			this.view.invalidate();
		}
	}

	/** */
	mouseup(/*event*/)
	{
		this.mouseDown = false;
		// drawing
		if (this.mode == floorplannerModes.DRAW && !this.mouseMoved)
		{
			// The corner the pointer snapped to, if any. `updateTarget` found it and
			// the highlight has been saying so since the pointer arrived.
			var existing = this.targetCorner;

			// Clicking the point you are drawing FROM ends the run.
			//
			// Two reasons, and the second is a real defect. There was no way to
			// stop drawing except the Escape key, which is not discoverable. And
			// clicking near the last node made `newCorner` hand back that very
			// corner, so `newWall(lastNode, corner)` built a wall from a corner to
			// ITSELF - a degenerate wall, produced by the gesture somebody would
			// most naturally try in order to finish.
			if (existing != null && existing === this.lastNode)
			{
				this.setMode(floorplannerModes.MOVE);
				return;
			}

			// Take the snapped corner directly. `newCorner` would usually return the
			// same one - it dedupes within `cornerTolerance` - but only for corners
			// inside ITS radius, not the one the highlight just promised. Going
			// through the target keeps the click and the highlight one answer.
			var corner = existing || this.floorplan.newCorner(this.targetX, this.targetY);

			if (this.lastNode != null)
			{
				this.floorplan.newWall(this.lastNode, corner);
				this.floorplan.newWallsForIntersections(this.lastNode, corner);
				this.view.invalidate();
			}
			// Only a corner this click invented can need welding onto a WALL it
			// landed in the middle of, which is the other thing this does.
			if (existing == null && corner.mergeWithIntersected() && this.lastNode != null)
			{
				this.setMode(floorplannerModes.MOVE);
			}
			this.lastNode = corner;
		}
		else
		{
			if(this.activeCorner != null)
			{
				this.activeCorner.updateAttachedRooms(true);
			}
			if(this.activeWall != null)
			{
				this.activeWall.updateAttachedRooms(true);
			}
			
			if(this._clickedCorner)
			{
				this._clickedCorner.updateAttachedRooms(true);
			}
			if(this._clickedWall)
			{
				this._clickedWall.updateAttachedRooms(true);
			}
		}
		this.view.invalidate();
	}

	/** */
	mouseleave()
	{
		this.mouseDown = false;
	}
	
	__updateInteractiveElements()
	{
		
	}

	/**
	 * Redraw the 2D view.
	 *
	 * Added in S6. The library redraws itself on every event that changes the
	 * plan, so this is only for the cases where something *outside* the plan
	 * changed what a drawn plan should look like - the display unit, the grid
	 * spacing, the zoom scale, the wall-measurement flags. All of those live in
	 * Configuration, which dispatches nothing.
	 *
	 * It exists because the legacy demo reached through to `floorplanner.view.draw()`
	 * in five places (app.js:198, 315, 321, 700, 719) and the Vue app is not
	 * allowed to: `view` is an implementation detail that S7's inspectors would
	 * otherwise pin in place.
	 *
	 * Coalesced since P6, and this is the call that benefits most: `useZoom2D`
	 * asks for a redraw from five places and a zoom gesture reaches several of
	 * them per step. Call `view.draw()` directly for the rare case that needs the
	 * canvas current before the next frame.
	 */
	redraw()
	{
		this.view.invalidate();
	}

	/** */
	reset()
	{
		this.view.carbonSheet.clear();
		this.resizeView();
		this.setMode(floorplannerModes.MOVE);
		this.resetOrigin();
		this.view.invalidate();
	}

	/** */
	resizeView()
	{
		this.view.handleWindowResize();
	}

	/** */
	setMode(mode)
	{
		this.lastNode = null;
		this.mode = mode;
		this.dispatchEvent({type:EVENT_MODE_RESET, mode: mode});
		this.updateTarget();
	}

	/** Sets the origin so that floorplan is centered */
	resetOrigin()
	{
		// The view owns the canvas' CSS size; the backing bitmap is DPR-scaled and
		// must not be used for layout maths.
		var centerX = this.view.canvasWidth / 2.0;
		var centerY = this.view.canvasHeight / 2.0;

		var centerFloorplan = this.floorplan.getCenter();		
		this.originX = this.dimensioning.cmToPixel(centerFloorplan.x) - centerX;
		this.originY = this.dimensioning.cmToPixel(centerFloorplan.z) - centerY;
		
		this.unScaledOriginX = this.dimensioning.cmToPixel(centerFloorplan.x, false) - centerX;
		this.unScaledOriginY = this.dimensioning.cmToPixel(centerFloorplan.z, false) - centerY;
		
	}
	
	zoom ()
	{
		var centerX = this.view.canvasWidth / 2.0;
		var centerY = this.view.canvasHeight / 2.0;
		var originScreen = new Vector2(centerX, centerY);
		var currentPan = new Vector2(this.unScaledOriginX+centerX, this.unScaledOriginY+centerY);
		currentPan = currentPan.multiplyScalar(this.configuration.getNumericValue('scale')).sub(originScreen);
		
		this.originX = currentPan.x;
		this.originY = currentPan.y;
	}

	/** Convert from THREEjs coords to canvas coords. */
	convertX(x)
	{
		return this.dimensioning.cmToPixel(x - this.dimensioning.pixelToCm(this.originX));
	}

	/** Convert from THREEjs coords to canvas coords. */
	convertY(y)
	{
		return this.dimensioning.cmToPixel(y - this.dimensioning.pixelToCm(this.originY));
	}
}
