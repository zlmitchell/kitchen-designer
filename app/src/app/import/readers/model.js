// @ts-check
/**
 * The one shape every reader produces, and the tracer's only input.
 *
 * It is deliberately pymupdf's `page.get_drawings()` record, field for field,
 * because `tools/` is the reference implementation and a port that has to
 * translate its input as well as its logic is a port with two places to be
 * wrong. A path is a stroke colour, a stroke width in points, a fill colour,
 * a bounding box, and a list of items - and an item is `['l', a, b]` for a
 * line, `['c']` for anything curved.
 *
 * Rectangles are a third item kind, `['re']`, and carry no geometry for the
 * same reason MuPDF's do not reach the run builders: a filled box is not a
 * pair of wall faces, and reporting its edges as lines hands the wall tracer
 * four faces per cabinet fill.
 *
 * Curves are counted, never measured. `layers.describe` scores a layer partly
 * on how axis-aligned it is, and for that it only needs to know a curve
 * happened; nothing downstream ever asks where it went. Flattening beziers
 * would add error to a number that is only used as a ratio.
 *
 * ## Coordinates
 *
 * Points, y down, origin at the page's top left - MuPDF's page space, which is
 * also pdf.js's viewport space at scale 1 and rotation 0. Every clip rectangle
 * in this app and every `--clip` in `tools/` is in exactly these units, so a
 * region drawn in the browser and one typed on the command line mean the same
 * thing.
 *
 * @typedef {{x: number, y: number}} Point
 * @typedef {['l', Point, Point] | ['c'] | ['re']} PathItem
 * @typedef {object} DrawnPath
 * @property {?number[]} colour Stroke colour as r,g,b in 0..1, or null when
 * the path is not stroked. Floats rather than a hex string because
 * `symbols.js` asks whether a colour is grey, which is a question about the
 * channels.
 * @property {number} width Stroke width in points, after the transform.
 * @property {?number[]} fill Fill colour, or null when the path is not filled.
 * @property {number[]} rect `[x0, y0, x1, y1]`, the path's bounds.
 * @property {PathItem[]} items
 */

/**
 * A 2x3 affine transform, in PDF order: `[a, b, c, d, e, f]`.
 *
 * @typedef {number[]} Matrix
 */

/** @type {Matrix} */
export const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * `first`, then `second` - the order `ctx.transform()` composes in, which is
 * what the PDF `cm` operator means and what pdf.js's own Util.transform does.
 *
 * @param {Matrix} second
 * @param {Matrix} first
 * @returns {Matrix}
 */
export function compose(second, first)
{
	return [
		second[0] * first[0] + second[2] * first[1],
		second[1] * first[0] + second[3] * first[1],
		second[0] * first[2] + second[2] * first[3],
		second[1] * first[2] + second[3] * first[3],
		second[0] * first[4] + second[2] * first[5] + second[4],
		second[1] * first[4] + second[3] * first[5] + second[5],
	];
}

/**
 * @param {Matrix} m
 * @param {number} x
 * @param {number} y
 * @returns {Point}
 */
export function apply(m, x, y)
{
	return {x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5]};
}

/**
 * How much a transform scales a length.
 *
 * The square root of the determinant, which is the right answer for the
 * uniform scales a drawing uses and the only single number available for the
 * ones it does not. A stroke width is one number in the file, so it can only
 * come back as one number here.
 *
 * @param {Matrix} m
 * @returns {number}
 */
export function scaleOf(m)
{
	return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/**
 * `#rrggbb` or `#rgb` to r,g,b in 0..1. pdf.js reports colours as CSS strings
 * and DXF as integers; the tracer wants channels.
 *
 * @param {?string} css
 * @returns {?number[]}
 */
export function rgbOf(css)
{
	if (typeof css !== 'string')
	{
		return null;
	}
	let hex = css.trim().replace(/^#/, '');
	if (hex.length === 3)
	{
		hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
	}
	if (!/^[0-9a-f]{6}$/i.test(hex))
	{
		return null;
	}
	return [
		parseInt(hex.slice(0, 2), 16) / 255,
		parseInt(hex.slice(2, 4), 16) / 255,
		parseInt(hex.slice(4, 6), 16) / 255,
	];
}

/**
 * r,g,b in 0..1 to `#rrggbb`. The layer key's colour half, and a port of
 * `layers._hex` - which rounds rather than truncates, so a channel that
 * arrived as 254.6/255 keys as ff and not fe.
 *
 * @param {?number[]} colour
 * @returns {?string}
 */
export function hexOf(colour)
{
	if (!colour)
	{
		return null;
	}
	return '#' + colour
		.map((c) => Math.round(c * 255).toString(16).padStart(2, '0'))
		.join('');
}

/**
 * The bounds of a path's items, as pymupdf reports `rect`.
 *
 * Computed from the geometry rather than taken from the reader, because only
 * two of the three readers are given one and a bbox that means different
 * things per format is worse than no bbox at all. Curves contribute their
 * control points, which over-states a bezier's bounds - and `layers._overlaps`
 * is the only consumer, where over-stating means a path is considered rather
 * than silently dropped.
 *
 * @param {Point[]} points
 * @returns {number[]}
 */
export function boundsOf(points)
{
	if (!points.length)
	{
		return [0, 0, 0, 0];
	}
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const point of points)
	{
		x0 = Math.min(x0, point.x);
		y0 = Math.min(y0, point.y);
		x1 = Math.max(x1, point.x);
		y1 = Math.max(y1, point.y);
	}
	return [x0, y0, x1, y1];
}

/**
 * A clip rectangle, normalised to `[x0, y0, x1, y1]` with x0 <= x1.
 *
 * Dragging a box up and to the left is the same box as dragging it down and to
 * the right, and every consumer here assumes the ordered form.
 *
 * @param {number[]} rect
 * @returns {number[]}
 */
export function normaliseRect(rect)
{
	const [ax, ay, bx, by] = rect;
	return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/**
 * Is this point inside the clip? The port of `pymupdf.Rect.contains`, which
 * `layers.split` and `extract.segments` both use to drop linework that leaves
 * the region.
 *
 * **Half open, and deliberately so.** MuPDF's test is `x0 <= x < x1`, so a
 * point exactly on the right or bottom edge is OUTSIDE. That is not a detail
 * to smooth over in the port: a clip drawn exactly on the drawing's extents
 * loses every wall that touches those two edges, and since both endpoints of a
 * segment must be inside, it loses every wall that merely REACHES them. On the
 * test fixture a clip snapped to the plan dropped 8 of 22 wall faces - all
 * four exterior verticals among them, because they run the full height - and
 * the tracer then reported "no layer looks like structure", which is what a
 * wrong clip looks like too.
 *
 * @param {number[]} clip
 * @param {Point} point
 * @returns {boolean}
 */
export function containsPoint(clip, point)
{
	return (point.x >= clip[0] && point.x < clip[2]
		&& point.y >= clip[1] && point.y < clip[3]);
}

/**
 * Do these rectangles share any ground?
 *
 * The port of `layers._overlaps`, and it exists for the same reason: a
 * rectangle test that treats a zero-AREA rectangle as empty throws away every
 * path holding a single horizontal or vertical line, which on a floor plan is
 * every wall. Measured in Python: 10600 stroked paths down to 36.
 *
 * @param {number[]} clip
 * @param {number[]} rect
 * @returns {boolean}
 */
export function overlaps(clip, rect)
{
	return (rect[2] >= clip[0] && rect[0] <= clip[2]
		&& rect[3] >= clip[1] && rect[1] <= clip[3]);
}
