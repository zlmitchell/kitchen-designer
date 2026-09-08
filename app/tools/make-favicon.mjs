/**
 * Draw the application's icon, in every form the page asks for.
 *
 *   npm run favicon      (writes public/favicon.svg, favicon-32.png,
 *                         apple-touch-icon.png)
 *
 * ## Why a generator and not three files
 *
 * Because there are three of them and they have to be the same picture. An SVG
 * for anything modern, a 32px PNG for the browsers that still will not take one,
 * and a 180px PNG for an iOS home screen -- hand-drawn, those are three chances
 * to change one and forget the others, and nothing would ever fail. Here the
 * shapes are written once and the three files are output formats.
 *
 * The same argument `make-surface-maps.mjs` makes about its six textures.
 *
 * ## What the mark is
 *
 * A kitchen elevation, which is the shortest way to say what this application
 * is: a wall cabinet, a counter, and a pair of base doors under it.
 *
 * Three details are deliberate and all three survive at 16px as texture even
 * once they stop being legible as objects:
 *
 *   - **the counter overhangs the cabinets**, both sides. Without it the mark is
 *     three stacked bars and reads as a form, not as cabinetry.
 *   - **the base doors are split by a reveal.** `cabinet.js` opens by arguing
 *     that the gap between two fronts is what makes a run read as cabinetry
 *     rather than as one surface; the icon is that claim at 16 pixels.
 *   - **the doors stop short of the bottom**, leaving the background as a toe
 *     kick. A carcass sitting flat on the floor reads as a crate.
 *
 * ## Colour
 *
 * The accent, `--accent` in `app.css`, on white. A solid accent field means the
 * icon needs no light and dark variants: it carries its own background, so it
 * reads the same on either tab strip. That is worth more here than matching the
 * theme, because a favicon is looked at next to twenty other favicons and never
 * next to the application.
 */
import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');

/** `--accent`, the pencil amber the light theme uses. */
const ACCENT = [217, 96, 26];
const WHITE = [255, 255, 255];

/** Everything below is in a 32-unit square, whatever it is finally drawn at. */
const SIZE = 32;

/**
 * The mark, as rounded rectangles back to front.
 *
 * Coordinates rather than a path because every shape here IS a rectangle -- the
 * subject is millwork, and millwork is boxes. It is also what lets the same
 * description produce an SVG and a rasteriser's coverage test without either of
 * them growing a path parser.
 */
const SHAPES = [
	/** The wall cabinet. One box: at this size a reveal in it would be noise. */
	{x0: 6, y0: 4.4, x1: 26, y1: 11.6, r: 1.2, fill: WHITE},
	/** The counter, proud of the cabinets on both sides. */
	{x0: 4, y0: 14.6, x1: 28, y1: 17.4, r: 1.0, fill: WHITE},
	/** Two base doors, and the reveal between them. */
	{x0: 6, y0: 18.8, x1: 15.4, y1: 27.2, r: 1.2, fill: WHITE},
	{x0: 16.6, y0: 18.8, x1: 26, y1: 27.2, r: 1.2, fill: WHITE},
];

/** How round the field's own corners are. */
const FIELD_RADIUS = 7;

/**
 * Is this point inside the rounded rectangle?
 *
 * The usual trick: push the point towards the nearest corner's centre and ask
 * how far outside the inner rectangle it got. Zero on both axes means the
 * straight part, and the radius test only decides the corners.
 */
function inside(shape, x, y)
{
	const r = Math.max(0, Math.min(shape.r, (shape.x1 - shape.x0) / 2, (shape.y1 - shape.y0) / 2));
	const dx = Math.max(shape.x0 + r - x, 0, x - (shape.x1 - r));
	const dy = Math.max(shape.y0 + r - y, 0, y - (shape.y1 - r));
	if (dx === 0 || dy === 0)
	{
		return x >= shape.x0 && x <= shape.x1 && y >= shape.y0 && y <= shape.y1;
	}
	return dx * dx + dy * dy <= r * r;
}

/** `#rrggbb` for an SVG. */
const hex = (rgb) => '#' + rgb.map((one) => one.toString(16).padStart(2, '0')).join('');

function toSvg()
{
	const field = {x0: 0, y0: 0, x1: SIZE, y1: SIZE, r: FIELD_RADIUS};
	const rect = (shape, fill) =>
		`\t<rect x="${shape.x0}" y="${shape.y0}" width="${(shape.x1 - shape.x0).toFixed(2)}"`
		+ ` height="${(shape.y1 - shape.y0).toFixed(2)}" rx="${shape.r}" fill="${hex(fill)}"/>`;

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">`,
		'\t<title>Kitchen Designer</title>',
		rect(field, ACCENT),
		...SHAPES.map((shape) => rect(shape, shape.fill)),
		'</svg>',
		'',
	].join('\n');
}

/**
 * Rasterise at `pixels` square.
 *
 * Supersampled 4x4 per pixel and averaged, because the shapes have curved
 * corners and a 32px icon drawn with hard edges looks like a screenshot of
 * itself. Sixteen samples is well past the point where more stops showing.
 *
 * @param {number} pixels
 * @param {number} fieldRadius In the 32-unit space. Zero is full bleed, which is
 *        what an iOS home screen wants -- it applies its own mask, and an icon
 *        that rounds its own corners first ends up with a pale halo inside them.
 */
function toPng(pixels, fieldRadius)
{
	const png = new PNG({width: pixels, height: pixels});
	const field = {x0: 0, y0: 0, x1: SIZE, y1: SIZE, r: fieldRadius};
	const step = SIZE / pixels;
	const SAMPLES = 4;

	for (let py = 0; py < pixels; py++)
	{
		for (let px = 0; px < pixels; px++)
		{
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let sy = 0; sy < SAMPLES; sy++)
			{
				for (let sx = 0; sx < SAMPLES; sx++)
				{
					const x = (px + (sx + 0.5) / SAMPLES) * step;
					const y = (py + (sy + 0.5) / SAMPLES) * step;
					if (!inside(field, x, y))
					{
						continue;
					}
					// Back to front, so the last shape covering the sample wins -
					// the same order the SVG paints in.
					let colour = ACCENT;
					for (const shape of SHAPES)
					{
						if (inside(shape, x, y))
						{
							colour = shape.fill;
						}
					}
					r += colour[0];
					g += colour[1];
					b += colour[2];
					a += 255;
				}
			}
			const total = SAMPLES * SAMPLES;
			const idx = (py * pixels + px) << 2;
			// Premultiplied against nothing: outside the field is transparent, and
			// the colour there is whatever the covered samples averaged to, so the
			// edge fades to the field's own colour rather than to black.
			const covered = a / 255;
			png.data[idx] = covered ? Math.round(r / covered) : 0;
			png.data[idx + 1] = covered ? Math.round(g / covered) : 0;
			png.data[idx + 2] = covered ? Math.round(b / covered) : 0;
			png.data[idx + 3] = Math.round(a / total);
		}
	}
	return PNG.sync.write(png);
}

const written = [
	['favicon.svg', Buffer.from(toSvg(), 'utf8')],
	['favicon-32.png', toPng(32, FIELD_RADIUS)],
	// Full bleed: iOS masks it itself.
	['apple-touch-icon.png', toPng(180, 0)],
];

for (const [name, bytes] of written)
{
	writeFileSync(join(PUBLIC, name), bytes);
	console.log(`${name}  ${bytes.length} bytes`);
}
