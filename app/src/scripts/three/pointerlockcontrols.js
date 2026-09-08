// @ts-check
import {Vector3} from 'three';
import {PointerLockControls as PointerLockControlsAddon} from 'three/addons/controls/PointerLockControls.js';


/**
 * JSDoc-only type imports (RM-005 C2).
 *
 * These names were already used in the annotations below and resolved to
 * nothing - 43 TS2304s across eleven files, every one of them a type the
 * project defines or three exports, named but never brought into scope. A
 * `@typedef` import costs no runtime code and no bundle bytes: it exists
 * entirely for the checker, which is the point of writing the JSDoc at all.

 *
 * @typedef {import('three').Camera} Camera
 */
/**
 * three's PointerLockControls, plus the walk-through rig this app built on it.
 *
 * The vendored copy was three's r98 controls with roughly ninety lines of
 * first-person physics grown into the middle of them: WASD, friction, gravity,
 * a jump, and a floor at eye height. The addon has since been rewritten - it
 * rotates the camera directly instead of parenting it into a yaw/pitch rig, and
 * `getObject()` is gone with that rig - but it still owns none of the physics.
 * So the physics is what gets kept here, and everything else is deleted.
 *
 * Behaviour is preserved deliberately, including the numbers: friction 10/s,
 * gravity 980/s^2, walk acceleration 3000, jump impulse 350, eye height 160
 * (Main sets that; the class defaults to 125). Mouse look needs no adjustment
 * at all - the addon's sensitivity constant is 0.002 and so was the fork's
 * `lookspeed`, so pointerSpeed 1.0 is exactly the old feel.
 *
 * Two things end here:
 *
 *   - `THREE.Clock`, deprecated in r183 in favour of a `Timer` that 0.185.1
 *     does not actually ship. `update()` now keeps its own clock, so nothing
 *     outside has to hold one.
 *   - the `disconnect()` bug, where two `addEventListener` calls sat where
 *     removals belonged and leaked a pair of key handlers per unmount. That was
 *     pulled forward to S2 to satisfy its exit gate; the file it was fixed in
 *     no longer exists.
 */
/**
 * Eye height standing, in centimetres. 5ft 5in.
 *
 * The EYE, which is what a camera is, and not the top of the head -- a
 * distinction this constant got right in prose and then wrong in the number. It
 * was 177.8, which is 5ft 10in, and 5ft 10in is how tall somebody IS: the eye
 * sits about four and a half inches below that. So the camera was walking around
 * with its lens where a 6ft 2in person's eyes would be, and every wall cabinet
 * read as lower than it is -- the same error the fork's 125 and `Main`'s 160
 * made in the other direction, and just as visible.
 *
 * 165.1 is the eye of somebody 5ft 10in tall. The whole point of walking the
 * model is to answer "can I reach that, and can I see over this", and the answer
 * is wrong whichever way the eye is wrong.
 */
export const EYE_HEIGHT = 165.1;

/**
 * Eye height crouching, in centimetres. 2ft 7in.
 *
 * Held on SHIFT, and not on Ctrl. Ctrl was the first choice and it is a trap:
 * pointer lock does not take the browser's own shortcuts away, so a walker who
 * held Ctrl and touched W closed the tab and lost the design. Shift has no
 * combination that does anything destructive here, and it is the key every game
 * that has a crouch already uses.
 *
 * The height a base cabinet is looked into from, which is the reason to crouch
 * in a kitchen at all: it is roughly the eye of somebody squatting at an open
 * drawer, and it is also a child's eye line. Dropped by the same five inches as
 * the standing height, for the same reason -- it was measured from a head and
 * not from an eye.
 */
export const CROUCH_HEIGHT = 78.74;

/** How fast the eye moves between the two. Seconds are `delta * this`. */
const CROUCH_EASE = 12;

export class PointerLockControls extends PointerLockControlsAddon
{
	/**
	 * @param {Camera} camera The first-person camera.
	 * @param {HTMLElement} [domElement] Element to lock and take fullscreen.
	 *   Defaults to document.body, which is what the fork did.
	 */
	constructor(camera, domElement)
	{
		super(camera, domElement || document.body);

		/** Eye height standing, in centimetres. The floor the walker cannot fall through. */
		this.characterHeight = EYE_HEIGHT;
		/** Eye height with Shift held. */
		this.crouchHeight = CROUCH_HEIGHT;
		/** Whether Shift is down right now. */
		this._crouching = false;
		/**
		 * The eye height in force this frame, eased between the two.
		 *
		 * Eased and not switched, because a snap from 178cm to 91cm is a
		 * teleport - the eye arrives before the body and it reads as the room
		 * jumping rather than as crouching. Standing back up is the same movement
		 * in reverse, and gravity cannot do it: the clamp below is what lifts the
		 * walker, so the ease has to live in the height and not in the velocity.
		 *
		 * Null until the first frame, and then whatever the standing height is at
		 * that moment. Seeded with `EYE_HEIGHT` instead, it eased from the
		 * constant towards a `characterHeight` an embedder had since set - so the
		 * walk STARTED with a transient, the floor drifted for a second, and a
		 * walker asked to be 160 came to rest at 160.02.
		 * @type {?number}
		 */
		this._eyeHeight = null;
		/** Ground acceleration while a direction key is held. */
		this.walkspeed = 3000;
		/** Kept for source compatibility; the addon expresses this as pointerSpeed. */
		this.lookspeed = 0.002;

		// The fork started disabled and was switched on by Main.switchFPSMode.
		this.enabled = false;

		this._velocity = new Vector3();
		this._direction = new Vector3();
		this._moveForward = false;
		this._moveBackward = false;
		this._moveLeft = false;
		this._moveRight = false;
		this._canJump = false;
		this._lastUpdate = 0;

		this._onKeyDown = (event) => this._setKey(event, true);
		this._onKeyUp = (event) => this._setKey(event, false);
		document.addEventListener('keydown', this._onKeyDown);
		document.addEventListener('keyup', this._onKeyUp);
	}

	/**
	 * The object the walker moves.
	 *
	 * The addon removed the yaw/pitch rig and moves the camera itself, so this
	 * is the camera. Kept because `Main` parents it into the scene and positions
	 * it by this name, and because it is part of the published surface.
	 */
	getObject()
	{
		return this.object;
	}

	/** WASD, the arrows, Space and Shift, by physical key so the layout does not matter. */
	_setKey(event, down)
	{
		// A key going UP is always honoured, even with the controls disabled.
		// Leaving walk mode with a key held used to leave the flag set, so the
		// walker was still moving - or now, still crouching - when it came back.
		// Nothing can be started while disabled, which is what the gate is for.
		if (this.enabled === false && down)
		{
			return;
		}
		switch (event.code)
		{
		case 'ShiftLeft':
		case 'ShiftRight':
			this._crouching = down;
			break;
		case 'ArrowUp':
		case 'KeyW':
			this._moveForward = down;
			break;
		case 'ArrowLeft':
		case 'KeyA':
			this._moveLeft = down;
			break;
		case 'ArrowDown':
		case 'KeyS':
			this._moveBackward = down;
			break;
		case 'ArrowRight':
		case 'KeyD':
			this._moveRight = down;
			break;
		case 'Space':
			if (down && this._canJump)
			{
				this._velocity.y += 350;
				this._canJump = false;
			}
			break;
		}
	}

	/**
	 * Advance the walk by one frame.
	 *
	 * @param {number} [delta] Seconds since the last update. Measured internally
	 *   when omitted, which is how Main calls it now that the Clock is gone.
	 */
	update(delta)
	{
		var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
		if (delta === undefined)
		{
			// Clamped, unlike the Clock this replaces. Entering walk mode after the
			// tab has been in the background used to hand over a delta of several
			// seconds, which gravity turned into an instant fall through the floor
			// and a jarring snap back to eye height.
			delta = this._lastUpdate ? Math.min((now - this._lastUpdate) / 1000, 0.1) : 0;
		}
		this._lastUpdate = now;

		var velocity = this._velocity;
		var direction = this._direction;

		// Where the eye wants to be, and how far it gets this frame. Clamped at 1
		// so a long frame settles rather than overshooting past the target.
		var wanted = this._crouching ? this.crouchHeight : this.characterHeight;
		if (this._eyeHeight === null)
		{
			this._eyeHeight = wanted;
		}
		this._eyeHeight += (wanted - this._eyeHeight) * Math.min(1, delta * CROUCH_EASE);
		// Settle rather than creep. A proportional ease is an asymptote and never
		// arrives, so the eye would sit a ten-thousandth of a millimetre off its
		// own height for ever - invisible, but it means the walker's height is
		// never actually the number anybody set, and `characterHeight = 160`
		// would never quite be 160.
		if (Math.abs(wanted - this._eyeHeight) < 0.01)
		{
			this._eyeHeight = wanted;
		}

		velocity.x -= velocity.x * 10.0 * delta;
		velocity.z -= velocity.z * 10.0 * delta;
		velocity.y -= 9.8 * 100.0 * delta; // 100.0 = mass

		direction.z = Number(this._moveForward) - Number(this._moveBackward);
		direction.x = Number(this._moveLeft) - Number(this._moveRight);
		direction.normalize(); // consistent speed on the diagonals

		if (this._moveForward || this._moveBackward)
		{
			velocity.z -= direction.z * this.walkspeed * delta;
		}
		if (this._moveLeft || this._moveRight)
		{
			velocity.x -= direction.x * this.walkspeed * delta;
		}

		// moveForward/moveRight read the camera's matrix, which is otherwise only
		// refreshed by the render pass - and Main updates the walk before it
		// renders, so every step would follow the previous frame's heading. The
		// fork had no such lag: it translated a rig by its quaternion. One call
		// puts that back and drops the dependency on render order.
		this.object.updateMatrix();

		// The fork translated a yaw-only rig, so its local axes were horizontal
		// and translateX/translateZ were safe. The camera carries pitch as well,
		// so walking has to go through moveRight/moveForward - which flatten the
		// direction - or looking up would fly you into the air. moveForward(d)
		// heads along -Z where translateZ(d) headed along +Z, hence the negation.
		this.moveRight(velocity.x * delta);
		this.moveForward(-velocity.z * delta);
		this.object.position.y += velocity.y * delta;

		// The floor, at whatever height the eye is currently at. Dropping into a
		// crouch lowers it and gravity does the rest; standing up raises it and
		// this clamp is what carries the walker back, which is why the ease is on
		// the height rather than on the velocity.
		if (this.object.position.y < this._eyeHeight)
		{
			velocity.y = 0;
			this.object.position.y = this._eyeHeight;
			this._canJump = true;
		}
	}

	/** Lock the pointer and, as the fork did, take the element fullscreen. */
	lock()
	{
		super.lock();

		// `domElement` is nullable on the addon's base class, and the vendor-prefixed
		// call is not in lib.dom - Safari carried `webkitRequestFullscreen` long
		// after the standard one existed and three's types do not describe it
		// (RM-005 C2). The cast is to a shape naming exactly the one method being
		// probed, rather than to `any`.
		var element = /** @type {(HTMLElement & {webkitRequestFullscreen?: function(): void})|null} */ (this.domElement);
		if (!element)
		{
			return;
		}
		if (element.requestFullscreen)
		{
			// Rejects if the call is not user-initiated; that is the browser's
			// decision to make, and an unhandled rejection here would be noise.
			var request = element.requestFullscreen();
			if (request && typeof request.catch === 'function')
			{
				request.catch(function () {});
			}
		}
		else if (element.webkitRequestFullscreen)
		{
			element.webkitRequestFullscreen();
		}
	}

	dispose()
	{
		document.removeEventListener('keydown', this._onKeyDown);
		document.removeEventListener('keyup', this._onKeyUp);
		super.dispose();
	}
}
