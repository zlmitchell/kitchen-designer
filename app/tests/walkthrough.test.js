// @vitest-environment jsdom
/**
 * Walking the house: how tall you are, and crouching.
 *
 * The eye height is not a preference. The whole reason to walk a kitchen rather
 * than orbit it is to answer "can I reach that, and what can I see over" -- and
 * both answers are wrong if the eye is at the wrong height. It walked at 125cm
  * in the class and 160cm after `Main` overrode it, then briefly at 177.8, which
 * is a PERSON's height and not an eye's: the lens ended up where a 6ft 2in
 * person's eyes are. An eye is about four and a half inches below the top of
 * the head, and that is the difference between the two numbers below.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {PerspectiveCamera} from 'three';
import {
	CROUCH_HEIGHT, EYE_HEIGHT, PointerLockControls,
} from '../src/scripts/three/pointerlockcontrols.js';

/** Run the walk for a while, in frames, with no keys but the ones set. */
function settle(controls, seconds, step)
{
	const dt = step || 1 / 60;
	for (let t = 0; t < seconds; t += dt)
	{
		controls.update(dt);
	}
}

describe('a walker is 5ft 10in at the eye', () =>
{
	const built = [];

	function walker()
	{
		const controls = new PointerLockControls(new PerspectiveCamera(), document.body);
		controls.enabled = true;
		controls.getObject().position.set(0, 300, 0);
		built.push(controls);
		return controls;
	}

	afterEach(() =>
	{
		built.splice(0).forEach((controls) => controls.dispose());
	});

	const key = (controls, code, down) =>
		controls._setKey({code}, down);

	it('settles at eye height rather than at the fork\'s 125 or Main\'s 160', () =>
	{
		const controls = walker();
		settle(controls, 3);
		expect(controls.getObject().position.y).toBeCloseTo(EYE_HEIGHT, 3);
		// 5ft 5in at the eye, which is a person about 5ft 10in tall. Stated as the
		// number somebody would give, because that is the check: the constant is an
		// EYE and the temptation is always to type a height.
		expect(EYE_HEIGHT / 2.54 / 12).toBeCloseTo(5 + 5 / 12, 3);
	});

	it('crouches while Shift is held, and stands again when it is let go', () =>
	{
		// Roughly the eye of somebody squatting at an open drawer, which is the
		// reason to crouch in a kitchen at all.
		const controls = walker();
		settle(controls, 3);

		key(controls, 'ShiftLeft', true);
		settle(controls, 3);
		expect(controls.getObject().position.y).toBeCloseTo(CROUCH_HEIGHT, 1);
		// 2ft 7in: an eye, five inches under the standing one, and low enough to
		// look into a base cabinet.
		expect(CROUCH_HEIGHT / 2.54 / 12).toBeCloseTo(2 + 7 / 12, 3);
		expect(EYE_HEIGHT - CROUCH_HEIGHT).toBeCloseTo(86.36, 2);

		key(controls, 'ShiftLeft', false);
		settle(controls, 3);
		expect(controls.getObject().position.y).toBeCloseTo(EYE_HEIGHT, 1);
	});

	it('takes the right Shift as well, because keyboards have two', () =>
	{
		const controls = walker();
		settle(controls, 3);
		key(controls, 'ShiftRight', true);
		settle(controls, 3);
		expect(controls.getObject().position.y).toBeCloseTo(CROUCH_HEIGHT, 1);
	});

	it('moves the eye rather than teleporting it', () =>
	{
		// A snap of the best part of a metre reads as the room jumping, not as
		// crouching. So one frame must not do the whole distance.
		const controls = walker();
		settle(controls, 3);

		key(controls, 'ShiftLeft', true);
		controls.update(1 / 60);
		const afterOneFrame = controls.getObject().position.y;
		expect(afterOneFrame).toBeLessThan(EYE_HEIGHT);
		expect(afterOneFrame).toBeGreaterThan(CROUCH_HEIGHT + 20);
	});

	it('does not stay crouched after walk mode is left with Shift down', () =>
	{
		// A key going up is honoured even with the controls disabled. Leaving walk
		// mode mid-crouch used to leave the flag set, so you came back crouching -
		// the same stuck-key shape that WASD had.
		const controls = walker();
		settle(controls, 3);
		key(controls, 'ShiftLeft', true);
		settle(controls, 1);

		controls.enabled = false;
		key(controls, 'ShiftLeft', false);
		controls.enabled = true;
		settle(controls, 3);

		expect(controls.getObject().position.y).toBeCloseTo(EYE_HEIGHT, 1);
	});

	it('still refuses to START anything while disabled', () =>
	{
		// The gate is what stops the plan view answering to WASD; only releasing
		// is unconditional.
		const controls = walker();
		settle(controls, 3);
		controls.enabled = false;
		key(controls, 'ShiftLeft', true);
		controls.enabled = true;
		settle(controls, 3);

		expect(controls.getObject().position.y).toBeCloseTo(EYE_HEIGHT, 1);
	});
});
