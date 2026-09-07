// @ts-check
/**
 * Python's `round()`, because this is a port and the constants were tuned
 * against it.
 *
 * The two languages disagree on exact halves. Python rounds half to EVEN -
 * `round(2.5)` is 2 - and JavaScript rounds half up, so `Math.round(2.5)` is
 * 3. Nothing in a floor plan is random enough for that to stay rare: the
 * tracer buckets measurements onto halves and quarters
 * (`round(gap * 2) / 2` in `layers.pair_gaps`, `round(gap * 4) / 4` in
 * `walls.thicknesses`), and a drawing is full of walls that are exactly 3.25
 * or 4.5 inches thick. A bucket landing one step out moves a wall thickness
 * into a neighbouring bucket, and a thickness with less than
 * MIN_TYPE_LENGTH_IN behind it is discarded as a coincidence - so the wall
 * type disappears, not the rounding.
 *
 * ## Why this is not `Math.round(value * 10 ** digits)`
 *
 * That was the first implementation and it is wrong in a way that only shows
 * up on a value nobody would suspect. Scaling first does its own rounding, and
 * that rounding can MANUFACTURE a tie:
 *
 *     2.675 as a double is 2.67499999999999982...
 *     2.675 * 100          is 267.5 exactly - the error is under half an ulp
 *                             at that magnitude, so the product rounds up to it
 *
 * The value is below the midpoint and Python rounds it down to 2.67; scaling
 * turns it into an exact half and rounds it up to 2.68. So the tie test has to
 * be made against the original number, not against a scaled copy of it.
 *
 * A double is an exact half at `d` decimal places if and only if it is
 * `m / 2^(d+1)` with `m` odd - a half at d decimals means `value * 2 * 10^d`
 * is an odd integer, and for that value to be representable at all the factor
 * of `5^d` has to divide out. Multiplying by a power of two is exact in binary
 * floating point, so the test costs nothing and cannot itself round.
 *
 * Everything else goes through `toFixed`, which the specification defines
 * against the number's exact value rather than a scaled one - and which,
 * having excluded ties, has only one candidate to choose.
 */

/**
 * @param {number} value
 * @param {number} [digits]
 * @returns {number}
 */
export function pyRound(value, digits = 0)
{
	if (!Number.isFinite(value))
	{
		return value;
	}

	// Exact in binary: a power of two never introduces error.
	const dyadic = value * (2 ** (digits + 1));
	if (Number.isInteger(dyadic) && Math.abs(dyadic % 2) === 1)
	{
		const factor = 10 ** digits;
		const below = Math.floor(value * factor);
		// To even.
		return (below % 2 === 0 ? below : below + 1) / factor;
	}

	return Number(value.toFixed(digits));
}
