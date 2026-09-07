// @ts-check
/**
 * An SVG's linework.
 *
 * The reference is the same as everywhere else in this directory: what
 * pymupdf's `get_drawings()` returns for the same file, because `tools/` is
 * tuned against MuPDF's reading of a drawing and a port that reads its input
 * differently is a port that traces a different drawing. Measured on a probe
 * sheet, MuPDF turns SVG into path items like this:
 *
 *     line                  one `l`
 *     rect                  one `re`, stroked or filled - never four lines
 *     polyline, 3 points    two `l`
 *     polygon, 3 points     three `l`   (the closing edge is a segment)
 *     path M L L Z          three `l`   (so is `Z`)
 *     path M C              one `c`
 *     circle                four `c`
 *
 * ## Why the XML is parsed here rather than by the platform
 *
 * `DOMParser` exists in a browser and in jsdom, and not in node - and this
 * project's test environment is node by default, with jsdom opted into per
 * file. A reader that needs a DOM can only be tested in the environment it
 * does not run the rest of the suite in. So the parsing is a small tokeniser
 * over the text, which behaves identically in both and needs nothing.
 *
 * What that gives up is entity expansion beyond the five predefined ones, and
 * DTDs. Neither appears in a CAD export, and a `<text>` element is skipped
 * whatever is inside it: the tracer reads linework and never labels.
 */

import {IDENTITY, apply, boundsOf, compose, rgbOf} from './model.js';

/**
 * The paint in force at a point in the tree: what a child inherits.
 *
 * @typedef {object} Paint
 * @property {?number[]} stroke
 * @property {?number[]} fill
 * @property {number} width
 * @property {import('./model.js').Matrix} transform
 */

/**
 * SVG's own defaults: filled black, unstroked, one unit wide.
 *
 * @type {Paint}
 */
const INITIAL = {
	stroke: null,
	fill: [0, 0, 0],
	width: 1,
	transform: IDENTITY,
};

/**
 * The colour names a CAD export actually emits. Not the full CSS list: what is
 * here is what SketchUp LayOut, Illustrator and Inkscape write, plus the ones
 * a person types by hand. An unknown name is treated as no paint rather than
 * as black, so a colour this does not know cannot invent a wall.
 */
const NAMED = {
	black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
	blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff',
	magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080',
	silver: '#c0c0c0', maroon: '#800000', olive: '#808000', lime: '#00ff00',
	navy: '#000080', teal: '#008080', purple: '#800080', orange: '#ffa500',
	darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3',
	lightgrey: '#d3d3d3', dimgray: '#696969', dimgrey: '#696969',
};

/** Points per unit, for the length units an SVG root may declare its size in. */
const UNITS = {
	'': 1, px: 1, pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12,
};

/**
 * Open an SVG.
 *
 * @param {Uint8Array|string} data
 * @returns {import('./index.js').Sheet & {text: string}}
 */
export function openSvg(data)
{
	const text = typeof data === 'string'
		? data
		: new TextDecoder('utf-8').decode(data);
	const root = findRoot(text);
	if (!root)
	{
		throw new Error('That SVG has no <svg> element.');
	}

	const size = rootSize(root.attrs);
	return {
		kind: /** @type {'svg'} */ ('svg'),
		// Kept so the raster layer can hand the file straight to an <img>. The
		// browser renders SVG better than redrawing the parsed paths ever
		// would - gradients, dashes, text and all - and the picture is only
		// ever a backdrop to trace over, never something measured.
		text,
		pages: [{number: 1, width: size.width, height: size.height}],
		// An SVG of a floor plan is a picture at a plotted scale, exactly like a
		// PDF, and records no more about which one.
		scale: null,
		/**
		 * Async to match the Sheet contract, which a PDF cannot satisfy any
		 * other way - pdf.js parses off the main thread.
		 *
		 * @param {number} number
		 */
		paths: async (number) =>
		{
			if (number !== 1)
			{
				throw new Error(`There is no page ${number}: an SVG has one.`);
			}
			return readPaths(text, size.transform);
		},
		close: () => {},
	};
}

/**
 * The `<svg>` element's own size in points, and the transform that puts user
 * units into it.
 *
 * A viewBox is a scale and an offset, and CAD exports use one routinely - a
 * plan drawn in millimetres inside a sheet declared in inches. Ignoring it
 * puts every coordinate out by that factor, which looks exactly like a drawing
 * traced at the wrong plot scale.
 *
 * @param {Record<string, string>} attrs
 */
function rootSize(attrs)
{
	const box = (attrs.viewBox || attrs.viewbox || '')
		.trim().split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
	const declared = {width: length(attrs.width), height: length(attrs.height)};

	if (box.length === 4)
	{
		// With no width or height the viewBox IS the page, at one unit per
		// point, which is what MuPDF does with the same file.
		const width = declared.width || box[2];
		const height = declared.height || box[3];
		const sx = box[2] ? width / box[2] : 1;
		const sy = box[3] ? height / box[3] : 1;
		return {
			width: round(width),
			height: round(height),
			transform: [sx, 0, 0, sy, -box[0] * sx, -box[1] * sy],
		};
	}
	return {
		width: round(declared.width || 0),
		height: round(declared.height || 0),
		transform: IDENTITY,
	};
}

/**
 * A CSS length in points. Percentages are refused rather than guessed at:
 * without a viewport there is nothing for them to be a percentage of.
 *
 * @param {?string} value
 * @returns {number}
 */
function length(value)
{
	if (!value)
	{
		return 0;
	}
	const match = /^\s*(-?[\d.]+(?:e-?\d+)?)\s*([a-z%]*)\s*$/i.exec(value);
	if (!match || match[2] === '%')
	{
		return 0;
	}
	const unit = UNITS[match[2].toLowerCase()];
	return unit ? Number(match[1]) * unit : 0;
}

function round(value)
{
	return Math.round(value * 100) / 100;
}

/**
 * Every drawable element, with inherited paint and transform applied.
 *
 * @param {string} text
 * @param {import('./model.js').Matrix} base
 * @returns {import('./model.js').DrawnPath[]}
 */
function readPaths(text, base)
{
	/** @type {import('./model.js').DrawnPath[]} */
	const out = [];
	/** @type {Paint[]} */
	const stack = [{...INITIAL, transform: base}];
	let depth = 0;
	// How deep inside an element whose contents are not linework we are.
	// `<defs>` is the one that matters: everything in it is a template, drawn
	// only where a `<use>` refers to it, so tracing its contents puts geometry
	// on the sheet that the drawing does not show.
	let hidden = 0;

	for (const node of elements(text))
	{
		if (node.closing)
		{
			if (hidden > 0 && node.name === 'defs')
			{
				hidden -= 1;
			}
			if (depth > 1)
			{
				stack.pop();
				depth -= 1;
			}
			continue;
		}

		if (node.name === 'defs' || node.name === 'clipPath' || node.name === 'mask')
		{
			if (!node.selfClosing)
			{
				hidden += 1;
			}
			continue;
		}
		if (hidden)
		{
			continue;
		}

		const parent = stack[stack.length - 1];
		const state = inherit(parent, node.attrs);
		if (node.name === 'svg')
		{
			continue;
		}
		if (!node.selfClosing && (node.name === 'g' || node.name === 'a'))
		{
			stack.push(state);
			depth += 1;
			continue;
		}

		const items = shapeOf(node.name, node.attrs, state.transform);
		if (!items || !items.items.length)
		{
			continue;
		}
		// Neither painted is not linework - it is a clip source or a hit area,
		// and MuPDF reports no path for it either.
		if (!state.stroke && !state.fill)
		{
			continue;
		}
		out.push({
			colour: state.stroke,
			width: state.stroke ? state.width * scaleOfTransform(state.transform) : 0,
			fill: state.fill,
			rect: boundsOf(items.points),
			items: items.items,
		});
	}
	return out;
}

/**
 * Paint and transform for one element, resolved against its parent's.
 *
 * `style` is read after the presentation attributes and wins, which is what
 * the CSS cascade says and what every exporter relies on - Inkscape writes
 * `style="stroke:#000"` beside a `stroke="none"` it never removed.
 *
 * @param {Paint} parent
 * @param {Record<string, string>} attrs
 * @returns {Paint}
 */
function inherit(parent, attrs)
{
	const declared = {...attrs};
	for (const [key, value] of styleOf(attrs.style))
	{
		declared[key] = value;
	}

	/** @type {Paint} */
	const state = {
		stroke: parent.stroke,
		fill: parent.fill,
		width: parent.width,
		transform: parent.transform,
	};
	if (declared.stroke !== undefined)
	{
		state.stroke = paint(declared.stroke);
	}
	if (declared.fill !== undefined)
	{
		state.fill = paint(declared.fill);
	}
	if (declared['stroke-width'] !== undefined)
	{
		const width = Number.parseFloat(declared['stroke-width']);
		state.width = Number.isFinite(width) ? width : parent.width;
	}
	if (declared.transform)
	{
		state.transform = compose(parent.transform, parseTransform(declared.transform));
	}
	return state;
}

/**
 * `stroke:#000;stroke-width:2` to pairs. Only the three properties this reader
 * reads are kept; anything else in a style attribute is not paint.
 *
 * @param {?string} style
 * @returns {Array<string[]>}
 */
function styleOf(style)
{
	if (!style)
	{
		return [];
	}
	const out = [];
	for (const rule of style.split(';'))
	{
		const at = rule.indexOf(':');
		if (at < 0)
		{
			continue;
		}
		const key = rule.slice(0, at).trim();
		if (key === 'stroke' || key === 'fill' || key === 'stroke-width')
		{
			out.push([key, rule.slice(at + 1).trim()]);
		}
	}
	return out;
}

/**
 * A paint value to r,g,b, or null for none.
 *
 * A gradient or pattern reference resolves to null: it paints something, but
 * not a colour the layer key can hold, and calling it black would put it in
 * the same layer as the walls.
 *
 * @param {string} value
 * @returns {?number[]}
 */
function paint(value)
{
	const text = (value || '').trim().toLowerCase();
	if (!text || text === 'none' || text === 'transparent' || text.startsWith('url('))
	{
		return null;
	}
	if (text === 'currentcolor')
	{
		return [0, 0, 0];
	}
	const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
	if (rgb)
	{
		const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3)
			.map((part) => (part.endsWith('%')
				? Number.parseFloat(part) * 2.55
				: Number.parseFloat(part)));
		if (parts.length === 3 && parts.every((n) => Number.isFinite(n)))
		{
			return parts.map((n) => Math.min(1, Math.max(0, n / 255)));
		}
		return null;
	}
	return rgbOf(NAMED[text] || text);
}

/**
 * How much a transform scales a stroke width. See `model.scaleOf` - repeated
 * here only to avoid importing a second name for one line.
 *
 * @param {import('./model.js').Matrix} m
 */
function scaleOfTransform(m)
{
	return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/**
 * An SVG `transform` attribute to a matrix. The list composes left to right,
 * which is the order they are written and the opposite of how they are applied
 * to a point.
 *
 * @param {string} value
 * @returns {import('./model.js').Matrix}
 */
export function parseTransform(value)
{
	let out = IDENTITY;
	const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
	let match = pattern.exec(value);
	while (match)
	{
		const n = match[2].trim().split(/[\s,]+/).map(Number);
		const radians = (degrees) => (degrees * Math.PI) / 180;
		let step = IDENTITY;
		if (match[1] === 'matrix' && n.length >= 6)
		{
			step = [n[0], n[1], n[2], n[3], n[4], n[5]];
		}
		else if (match[1] === 'translate')
		{
			step = [1, 0, 0, 1, n[0] || 0, n[1] || 0];
		}
		else if (match[1] === 'scale')
		{
			step = [n[0] || 0, 0, 0, (n.length > 1 ? n[1] : n[0]) || 0, 0, 0];
		}
		else if (match[1] === 'rotate')
		{
			const angle = radians(n[0] || 0);
			const spin = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
			step = n.length >= 3
				// About a point: move it to the origin, turn, put it back.
				? compose(compose([1, 0, 0, 1, n[1], n[2]], spin), [1, 0, 0, 1, -n[1], -n[2]])
				: spin;
		}
		else if (match[1] === 'skewX')
		{
			step = [1, 0, Math.tan(radians(n[0] || 0)), 1, 0, 0];
		}
		else if (match[1] === 'skewY')
		{
			step = [1, Math.tan(radians(n[0] || 0)), 0, 1, 0, 0];
		}
		out = compose(out, step);
		match = pattern.exec(value);
	}
	return out;
}

/**
 * One shape element's items and the points they touch.
 *
 * @param {string} name
 * @param {Record<string, string>} attrs
 * @param {import('./model.js').Matrix} m
 * @returns {?{items: import('./model.js').PathItem[], points: import('./model.js').Point[]}}
 */
function shapeOf(name, attrs, m)
{
	const number = (key) => Number.parseFloat(attrs[key] || '0') || 0;

	if (name === 'line')
	{
		const a = apply(m, number('x1'), number('y1'));
		const b = apply(m, number('x2'), number('y2'));
		return {items: [['l', a, b]], points: [a, b]};
	}

	if (name === 'rect')
	{
		const x = number('x');
		const y = number('y');
		const width = number('width');
		const height = number('height');
		if (width <= 0 || height <= 0)
		{
			return null;
		}
		const points = [
			apply(m, x, y), apply(m, x + width, y),
			apply(m, x + width, y + height), apply(m, x, y + height),
		];
		// A rounded rect is not a rectangle to MuPDF either, and its corners
		// are curves.
		if (number('rx') > 0 || number('ry') > 0)
		{
			return {items: [['l', points[0], points[1]], ['c'], ['c'], ['c'], ['c']], points};
		}
		return {items: [['re']], points};
	}

	if (name === 'polyline' || name === 'polygon')
	{
		const numbers = (attrs.points || '').trim().split(/[\s,]+/).map(Number)
			.filter((value) => !Number.isNaN(value));
		/** @type {import('./model.js').Point[]} */
		const points = [];
		for (let at = 0; at + 1 < numbers.length; at += 2)
		{
			points.push(apply(m, numbers[at], numbers[at + 1]));
		}
		if (points.length < 2)
		{
			return null;
		}
		/** @type {import('./model.js').PathItem[]} */
		const items = [];
		for (let at = 1; at < points.length; at += 1)
		{
			items.push(['l', points[at - 1], points[at]]);
		}
		if (name === 'polygon')
		{
			items.push(['l', points[points.length - 1], points[0]]);
		}
		return {items, points};
	}

	if (name === 'circle' || name === 'ellipse')
	{
		const cx = number('cx');
		const cy = number('cy');
		const rx = name === 'circle' ? number('r') : number('rx');
		const ry = name === 'circle' ? number('r') : number('ry');
		if (rx <= 0 || ry <= 0)
		{
			return null;
		}
		const points = [
			apply(m, cx - rx, cy - ry), apply(m, cx + rx, cy - ry),
			apply(m, cx + rx, cy + ry), apply(m, cx - rx, cy + ry),
		];
		// Four arcs, which is how it is drawn and how MuPDF reports it.
		return {items: [['c'], ['c'], ['c'], ['c']], points};
	}

	if (name === 'path')
	{
		return pathData(attrs.d || '', m);
	}
	return null;
}

/**
 * A `d` attribute to items.
 *
 * Curves are recorded as `['c']` and their endpoints tracked, which is all the
 * tracer asks of them - it counts curves and measures lines. Arcs are the same
 * case: the endpoint is exactly known from the command, and nothing downstream
 * needs the sweep.
 *
 * @param {string} d
 * @param {import('./model.js').Matrix} m
 */
function pathData(d, m)
{
	/** @type {import('./model.js').PathItem[]} */
	const items = [];
	/** @type {import('./model.js').Point[]} */
	const points = [];
	// Numbers may be separated by commas, spaces, or nothing at all when the
	// sign does the separating - `M10-20` is two numbers.
	const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\.?\d+(?:\.\d*)?(?:e[-+]?\d+)?/gi) || [];

	let at = 0;
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	let command = '';
	const take = () => Number(tokens[at++]);
	const move = (nx, ny) =>
	{
		const from = apply(m, x, y);
		const to = apply(m, nx, ny);
		x = nx;
		y = ny;
		points.push(to);
		return [from, to];
	};

	while (at < tokens.length)
	{
		if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(tokens[at]))
		{
			command = tokens[at++];
		}
		else if (!command)
		{
			break;
		}
		// A repeated coordinate pair after M is an implicit L, which is how
		// most exporters write a polyline.
		const implicit = command === 'M' ? 'L' : (command === 'm' ? 'l' : command);
		const relative = command === command.toLowerCase();

		if (command === 'M' || command === 'm')
		{
			const nx = relative ? x + take() : take();
			const ny = relative ? y + take() : take();
			x = nx;
			y = ny;
			startX = nx;
			startY = ny;
			points.push(apply(m, x, y));
			command = implicit;
		}
		else if (command === 'L' || command === 'l')
		{
			const nx = relative ? x + take() : take();
			const ny = relative ? y + take() : take();
			const [from, to] = move(nx, ny);
			items.push(['l', from, to]);
		}
		else if (command === 'H' || command === 'h')
		{
			const nx = relative ? x + take() : take();
			const [from, to] = move(nx, y);
			items.push(['l', from, to]);
		}
		else if (command === 'V' || command === 'v')
		{
			const ny = relative ? y + take() : take();
			const [from, to] = move(x, ny);
			items.push(['l', from, to]);
		}
		else if (command === 'Z' || command === 'z')
		{
			if (x !== startX || y !== startY)
			{
				const [from, to] = move(startX, startY);
				items.push(['l', from, to]);
			}
			x = startX;
			y = startY;
		}
		else if ('CcSsQqTtAa'.includes(command))
		{
			// Everything up to the endpoint is control data; only the endpoint
			// moves the pen, and only the pen's position is needed again.
			const arity = {c: 6, s: 4, q: 4, t: 2, a: 7}[command.toLowerCase()];
			for (let skip = 0; skip < arity - 2; skip += 1)
			{
				take();
			}
			const nx = relative ? x + take() : take();
			const ny = relative ? y + take() : take();
			move(nx, ny);
			items.push(['c']);
		}
		else
		{
			break;
		}
	}
	return {items, points};
}

/**
 * The `<svg>` element, with its attributes.
 *
 * @param {string} text
 */
function findRoot(text)
{
	for (const node of elements(text))
	{
		if (node.name === 'svg' && !node.closing)
		{
			return node;
		}
	}
	return null;
}

/**
 * Walk the elements of an XML document.
 *
 * Comments, processing instructions, doctypes and CDATA are skipped whole
 * rather than parsed: none of them can contain an element, so nothing that
 * draws is inside them.
 *
 * @param {string} text
 * @returns {Generator<{name: string, attrs: Record<string, string>, closing: boolean, selfClosing: boolean}>}
 */
function* elements(text)
{
	let at = 0;
	while (at < text.length)
	{
		const open = text.indexOf('<', at);
		if (open < 0)
		{
			return;
		}
		if (text.startsWith('<!--', open))
		{
			const end = text.indexOf('-->', open);
			at = end < 0 ? text.length : end + 3;
			continue;
		}
		if (text.startsWith('<![CDATA[', open))
		{
			const end = text.indexOf(']]>', open);
			at = end < 0 ? text.length : end + 3;
			continue;
		}
		if (text.startsWith('<?', open) || text.startsWith('<!', open))
		{
			const end = text.indexOf('>', open);
			at = end < 0 ? text.length : end + 1;
			continue;
		}

		const end = closeOf(text, open);
		if (end < 0)
		{
			return;
		}
		const body = text.slice(open + 1, end);
		at = end + 1;

		const closing = body.startsWith('/');
		const selfClosing = body.endsWith('/');
		const inner = body.slice(closing ? 1 : 0, selfClosing ? -1 : undefined);
		const space = inner.search(/[\s/>]/);
		// The namespace prefix is dropped: `<svg:line>` and `<line>` draw the
		// same line, and the tracer has no use for which document it came from.
		const name = (space < 0 ? inner : inner.slice(0, space)).replace(/^[^:]*:/, '');
		if (!name)
		{
			continue;
		}
		yield {
			name,
			attrs: closing ? {} : attributesOf(space < 0 ? '' : inner.slice(space)),
			closing,
			selfClosing,
		};
	}
}

/**
 * Where the tag opened at `open` ends.
 *
 * Quoted attribute values can hold a `>` - a `style` with a CSS selector in it
 * does - so the first `>` after the tag name is not necessarily the end of it.
 *
 * @param {string} text
 * @param {number} open
 */
function closeOf(text, open)
{
	let quote = '';
	for (let at = open + 1; at < text.length; at += 1)
	{
		const char = text[at];
		if (quote)
		{
			if (char === quote)
			{
				quote = '';
			}
		}
		else if (char === '"' || char === '\'')
		{
			quote = char;
		}
		else if (char === '>')
		{
			return at;
		}
	}
	return -1;
}

/** The five entities XML predefines, which is all a CAD export writes. */
const ENTITIES = {'&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': '\''};

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
function attributesOf(text)
{
	/** @type {Record<string, string>} */
	const out = {};
	const pattern = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
	let match = pattern.exec(text);
	while (match)
	{
		const value = match[3] !== undefined ? match[3] : match[4];
		out[match[1].replace(/^xml:/, '')] = value.replace(
			/&(?:lt|gt|amp|quot|apos);/g, (entity) => ENTITIES[entity]);
		match = pattern.exec(text);
	}
	return out;
}
