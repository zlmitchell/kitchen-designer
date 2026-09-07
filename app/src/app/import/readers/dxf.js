// @ts-check
/**
 * A DXF's linework.
 *
 * The odd one out in this directory, in the one way that matters: a DXF is not
 * a picture of a plan, it is the plan. Its coordinates are real lengths in a
 * unit the file names, so unlike a PDF or an SVG **its scale is a fact rather
 * than something a person has to type**. That is the whole reason this reader
 * exists rather than the file being rendered to a page first.
 *
 * ## What a drawing unit becomes
 *
 * One drawing unit is emitted as one point. Nothing is resampled and nothing
 * is fitted to a page: the "page" is simply the drawing's own extents, so a
 * 240in house is a 240pt sheet and `scale` comes back as 1.0 real inch per
 * point. A millimetre drawing of the same house is a 6096pt sheet at 1/25.4.
 * The clip rectangle the user drags means the same thing in both, because it
 * is in the same units the tracer measures in.
 *
 * y is flipped. DXF counts y upwards and every other reader here, MuPDF
 * included, counts it down from the top left - and the tracer's "top wall" has
 * to be the one at the top of the drawing.
 *
 * ## Two things dxf-parser does not do, which matter here
 *
 *   lineweight   It parses no group code 370, so every layer arrives with no
 *                pen width at all. `layers.split` keys on (colour, width,
 *                fill) and AGENTS.md records a drafter whose layers are
 *                separated ENTIRELY by width, so throwing that away would
 *                collapse such a sheet to one layer. The LAYER table is
 *                scanned for it directly.
 *   colour 7     Comes back as white (16777215). ACI 7 is the "same as the
 *                background" index, which on paper means BLACK - and black is
 *                what `extract.ARCHITECTURE` matches, so a wall layer left
 *                white is a wall layer the opening detectors cannot see.
 */

import {boundsOf} from './model.js';

/** Real inches per drawing unit, by `$INSUNITS`. 0 is "unitless". */
const UNITS = {
	1: 1, 2: 12, 3: 63360, 4: 1 / 25.4, 5: 1 / 2.54, 6: 1 / 0.0254,
	8: 1 / 25400, 9: 1 / 25400000, 10: 36, 14: 1 / 0.254, 15: 1 / 0.00254,
	16: 1 / 0.0000254,
};

/** A lineweight is hundredths of a millimetre; a point is 1/72 inch. */
const MM_TO_POINTS = 72 / 25.4;

/** How many `['c']` items a full closed curve is reported as, matching MuPDF. */
const CURVE_ITEMS = 4;

/** Blank margin around the invented page, as a fraction of the drawing. */
const MARGIN_FRACTION = 0.02;

/**
 * Open a DXF.
 *
 * @param {Uint8Array|string} data
 * @param {{DxfParser?: any}} [options] The parser class, for tests.
 * @returns {Promise<import('./index.js').Sheet>}
 */
export async function openDxf(data, options = {})
{
	const text = typeof data === 'string'
		? data
		: new TextDecoder('utf-8').decode(data);
	const DxfParser = options.DxfParser || (await import('dxf-parser')).default;

	let document;
	try
	{
		document = new DxfParser().parseSync(text);
	}
	catch (error)
	{
		const why = error instanceof Error ? error.message : String(error);
		throw new Error(`That DXF could not be read: ${why}`, {cause: error});
	}
	if (!document || !document.entities)
	{
		throw new Error('That DXF holds no entities.');
	}

	const pens = pensOf(document, text);
	const drawn = [];
	collect(document.entities, document.blocks || {}, pens, IDENTITY_2D, drawn, 0);
	if (!drawn.length)
	{
		throw new Error('That DXF holds no linework - nothing to trace.');
	}

	// The extents come from the geometry rather than from $EXTMIN/$EXTMAX,
	// which are a cached hint that CAD updates on regeneration and which are
	// routinely stale or absent in an export.
	const bounds = boundsOf(drawn.flatMap((entry) => entry.points));
	// A margin, because a DXF has no page and one is being invented here - and
	// the extents themselves are the one size it must not be. Every clip test
	// downstream is half open (`x0 <= x < x1`, MuPDF's rule, ported in
	// model.containsPoint), so a page exactly as big as the drawing puts the
	// right-hand and bottom walls ON the boundary, where both endpoints of a
	// segment fail the test. Selecting the whole sheet then traces nothing at
	// all - measured on the fixture, which reported "no walls were traced in
	// that region" for a region containing the entire house.
	const margin = Math.max(
		(bounds[2] - bounds[0]) * MARGIN_FRACTION,
		(bounds[3] - bounds[1]) * MARGIN_FRACTION,
		1);
	const height = bounds[3] - bounds[1] + margin * 2;
	const flip = (point) => ({
		x: point.x - bounds[0] + margin,
		y: height - (point.y - bounds[1]) - margin,
	});

	const paths = drawn.map((entry) => ({
		colour: entry.colour,
		width: entry.width,
		fill: null,
		rect: boundsOf(entry.points.map(flip)),
		items: entry.items.map((item) => (item[0] === 'l'
			? ['l', flip(item[1]), flip(item[2])]
			: item)),
	}));

	const units = document.header ? document.header.$INSUNITS : 0;
	const inchesPerUnit = UNITS[units];
	return {
		kind: 'dxf',
		pages: [{
			number: 1,
			width: Math.round((bounds[2] - bounds[0] + margin * 2) * 100) / 100,
			height: Math.round(height * 100) / 100,
		}],
		// Null when the file says "unitless", which is a real answer and not a
		// missing one: the drawing's numbers are then a ratio, and only its
		// author knows to what.
		scale: inchesPerUnit || null,
		/**
		 * Async to match the Sheet contract; the work is already done by the
		 * time anybody asks, because a DXF is parsed whole on open.
		 *
		 * @param {number} number
		 */
		paths: async (number) =>
		{
			if (number !== 1)
			{
				throw new Error(`There is no page ${number}: a DXF has one.`);
			}
			return paths;
		},
		close: () => {},
	};
}

/** @type {number[]} `[a, b, c, d, e, f]`, applied to drawing coordinates. */
const IDENTITY_2D = [1, 0, 0, 1, 0, 0];

/**
 * Colour and width per layer name.
 *
 * @param {any} document
 * @param {string} text
 */
function pensOf(document, text)
{
	/** @type {Record<string, {colour: ?number[], width: number}>} */
	const out = {};
	const layers = (document.tables && document.tables.layer
		&& document.tables.layer.layers) || {};
	const weights = lineweights(text);
	for (const [name, layer] of Object.entries(layers))
	{
		out[name] = {
			colour: colourOf(/** @type {any} */ (layer)),
			width: weightToPoints(weights[name]),
		};
	}
	return out;
}

/**
 * A layer or entity's colour, as r,g,b.
 *
 * @param {{color?: number, colorIndex?: number}} owner
 * @returns {?number[]}
 */
function colourOf(owner)
{
	// See the module note: 7 is "whatever contrasts with the background", which
	// on a plotted sheet is black - and every colour test downstream is written
	// against a plotted sheet.
	if (owner.colorIndex === 7)
	{
		return [0, 0, 0];
	}
	if (typeof owner.color !== 'number')
	{
		return null;
	}
	return [
		((owner.color >> 16) & 0xff) / 255,
		((owner.color >> 8) & 0xff) / 255,
		(owner.color & 0xff) / 255,
	];
}

/**
 * Layer name to lineweight, read straight out of the LAYER table.
 *
 * A DXF is nothing but (group code, value) pairs, two lines each, from the
 * first line of the file - so this walks them all and keeps track of which
 * table it is inside. Inside LAYER, code 2 is a layer's name and code 370 its
 * lineweight.
 *
 * Walking from the top rather than seeking to the table is deliberate, and the
 * first attempt is why. It sought the table with a multiline regex and sliced
 * from `match.index` - but JavaScript's `^` under `m` matches after
 * a bare CR as well as after a LF, so on a CRLF file the match began one
 * character early, the split produced a leading empty line, and every code was
 * then read as a value and every value as a code. It returned an empty map
 * rather than failing, which is the kind of silence that gets shipped: the
 * layers still separated by colour, so the drawing still traced.
 *
 * @param {string} text
 * @returns {Record<string, number>}
 */
export function lineweights(text)
{
	/** @type {Record<string, number>} */
	const out = {};
	const lines = text.split(/\r\n|\r|\n/);
	let at = 0;
	// A leading blank line or byte-order mark would put every pair out of step.
	while (at < lines.length && !lines[at].trim())
	{
		at += 1;
	}

	/** @type {?string} */
	let table = null;
	/** @type {?string} */
	let name = null;
	for (; at + 1 < lines.length; at += 2)
	{
		const code = lines[at].trim();
		const value = lines[at + 1].trim();
		if (code === '0')
		{
			if (value === 'TABLE')
			{
				// The table's own name is the next code 2.
				table = '';
			}
			else if (value === 'ENDTAB' || value === 'ENDSEC')
			{
				table = null;
			}
			name = null;
		}
		else if (code === '2')
		{
			if (table === '')
			{
				table = value;
			}
			else if (table === 'LAYER' && name === null)
			{
				name = value;
			}
		}
		else if (code === '370' && table === 'LAYER' && name !== null)
		{
			out[name] = Number(value);
		}
	}
	return out;
}


/**
 * Hundredths of a millimetre to points. The negative values are DXF's
 * "inherit" sentinels - by layer, by block, and the plotter's default - and
 * none of them is a width this reader can state, so they come back as none.
 *
 * @param {number|undefined} weight
 */
function weightToPoints(weight)
{
	if (typeof weight !== 'number' || weight < 0)
	{
		return 0;
	}
	return Math.round((weight / 100) * MM_TO_POINTS * 100) / 100;
}

/**
 * Walk entities, expanding block references, into flat drawn records.
 *
 * @param {any[]} entities
 * @param {Record<string, any>} blocks
 * @param {Record<string, {colour: ?number[], width: number}>} pens
 * @param {number[]} m
 * @param {any[]} out
 * @param {number} depth
 */
function collect(entities, blocks, pens, m, out, depth)
{
	// A block that references itself is a malformed file, and without a limit
	// it is a malformed file that hangs the browser rather than reporting
	// anything.
	if (depth > 8)
	{
		return;
	}
	for (const entity of entities || [])
	{
		if (entity.type === 'INSERT' || (entity.type === 'DIMENSION' && entity.block))
		{
			const block = blocks[entity.name || entity.block];
			if (!block || !block.entities)
			{
				continue;
			}
			collect(block.entities, blocks, pens, compose2d(m, insertMatrix(entity, block)),
				out, depth + 1);
			continue;
		}
		const shape = shapeOf(entity, m);
		if (!shape || !shape.items.length)
		{
			continue;
		}
		const pen = pens[entity.layer] || {colour: null, width: 0};
		// An entity may override its layer's colour, which is how a drafter
		// picks one line out of a layer - and the override is what the plotter
		// draws, so it is what the layer key has to hold.
		const own = colourOf(entity);
		out.push({
			colour: (entity.colorIndex !== undefined || entity.color !== undefined)
				? own
				: pen.colour,
			width: weightToPoints(entity.lineweight) || pen.width,
			items: shape.items,
			points: shape.points,
		});
	}
}

/**
 * The transform an INSERT applies to its block: the block's own base point
 * out, then scale, rotation and the insertion point in.
 *
 * @param {any} entity
 * @param {any} block
 */
function insertMatrix(entity, block)
{
	const sx = entity.xScale === undefined ? 1 : entity.xScale;
	const sy = entity.yScale === undefined ? 1 : entity.yScale;
	const angle = ((entity.rotation || 0) * Math.PI) / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const at = entity.position || {x: 0, y: 0};
	const base = (block && block.position) || {x: 0, y: 0};
	// scale, then rotate, then translate - and the block's base point is
	// subtracted first, since a block's geometry is written about it.
	const scaled = [sx, 0, 0, sy, -base.x * sx, -base.y * sy];
	const turned = [cos, sin, -sin, cos, 0, 0];
	return compose2d([1, 0, 0, 1, at.x, at.y], compose2d(turned, scaled));
}

/**
 * `first`, then `second`.
 *
 * @param {number[]} second
 * @param {number[]} first
 */
function compose2d(second, first)
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
 * @param {number[]} m
 * @param {{x: number, y: number}} point
 */
function at(m, point)
{
	const x = point.x || 0;
	const y = point.y || 0;
	return {x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5]};
}

/**
 * One entity's items and the points they touch.
 *
 * Curved entities are reported as `['c']` and their extremes as points, which
 * is the same bargain every reader here makes: the tracer counts curves and
 * measures only straight runs, so flattening an arc would add error to a
 * number nobody reads.
 *
 * @param {any} entity
 * @param {number[]} m
 */
function shapeOf(entity, m)
{
	const type = entity.type;

	if (type === 'LINE' && entity.vertices && entity.vertices.length >= 2)
	{
		const a = at(m, entity.vertices[0]);
		const b = at(m, entity.vertices[1]);
		return {items: [['l', a, b]], points: [a, b]};
	}

	if (type === 'LWPOLYLINE' || type === 'POLYLINE')
	{
		const points = (entity.vertices || []).map((vertex) => at(m, vertex));
		if (points.length < 2)
		{
			return null;
		}
		/** @type {any[]} */
		const items = [];
		for (let index = 1; index < points.length; index += 1)
		{
			// A vertex carrying a bulge is an arc to the next one, not a chord.
			// Drawing it as a chord would put a straight run where the drawing
			// has a curve, and a long enough one pairs as a wall face.
			const bulge = (entity.vertices[index - 1] || {}).bulge;
			items.push(bulge ? ['c'] : ['l', points[index - 1], points[index]]);
		}
		if (entity.shape || entity.closed)
		{
			items.push(['l', points[points.length - 1], points[0]]);
		}
		return {items, points};
	}

	if (type === 'CIRCLE' || type === 'ARC')
	{
		const centre = entity.center || {x: 0, y: 0};
		const radius = entity.radius || 0;
		if (radius <= 0)
		{
			return null;
		}
		const points = [
			at(m, {x: centre.x - radius, y: centre.y - radius}),
			at(m, {x: centre.x + radius, y: centre.y - radius}),
			at(m, {x: centre.x + radius, y: centre.y + radius}),
			at(m, {x: centre.x - radius, y: centre.y + radius}),
		];
		return {items: Array.from({length: CURVE_ITEMS}, () => ['c']), points};
	}

	if (type === 'ELLIPSE' || type === 'SPLINE')
	{
		const raw = entity.controlPoints || entity.fitPoints || [];
		if (!raw.length)
		{
			return null;
		}
		const points = raw.map((point) => at(m, point));
		return {items: Array.from({length: CURVE_ITEMS}, () => ['c']), points};
	}

	if (type === 'SOLID' || type === '3DFACE')
	{
		const points = (entity.points || entity.vertices || []).map((point) => at(m, point));
		if (points.length < 3)
		{
			return null;
		}
		/** @type {any[]} */
		const items = [];
		for (let index = 1; index < points.length; index += 1)
		{
			items.push(['l', points[index - 1], points[index]]);
		}
		items.push(['l', points[points.length - 1], points[0]]);
		return {items, points};
	}

	// TEXT, MTEXT, POINT, HATCH and the rest draw nothing the tracer reads.
	return null;
}
