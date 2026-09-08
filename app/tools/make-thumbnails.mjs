/**
 * Draw the catalog thumbnail for a generated item.
 *
 *     npm run thumbnails -- "Vent Hood - Cabinet Front"   # one, by catalog name
 *     npm run thumbnails -- --all                         # every generated entry
 *     npm run thumbnails -- --list                        # what it could draw
 *
 * ## Why this exists, and why it did not
 *
 * Every thumbnail under `public/models/thumbnails_new/` was produced by hand,
 * once, by something nobody wrote down -- so adding a catalog entry meant either
 * pointing it at somebody else's picture or leaving it blank, and changing what
 * a builder DRAWS left its thumbnail quietly showing the old shape. A generated
 * item's picture should be as reproducible as its geometry, because it comes
 * from the same spec.
 *
 * ## Two things that make this harder than it looks, and how each is solved
 *
 * **Bare node cannot import this project's source.** `core/materials.js` does
 * `import catalog from '../../catalog/materials.json'`, which Vite resolves and
 * plain node rejects with `ERR_IMPORT_ATTRIBUTE_MISSING` -- so every builder is
 * unreachable from an ordinary script, which is why `docs/generated-items.md`
 * tells you to put scratch code in a vitest file instead. That advice is right
 * for a scratch test and wrong for a tool: a tool that is a test is a tool
 * nobody can run.
 *
 * The answer is Vite's own Node API. `createServer({middlewareMode: true})` plus
 * `ssrLoadModule` resolves the module graph exactly the way the application
 * does, JSON imports included, with no bundling step and no test runner. Any
 * future tool that needs to reach into `src/` should do this rather than
 * rediscovering the problem.
 *
 * **There is no GPU in the container**, which `docs/generated-items.md` says at
 * length. So this rasterises in software: project the triangles, z-buffer them,
 * shade each by its material's own colour. That is not a compromise for a
 * thumbnail -- these are 300x225 pictures of matte millwork, and the existing
 * ones are flat-shaded too. What it cannot show is a texture or a shadow, and
 * neither reads at this size.
 *
 * ## The view
 *
 * Three-quarter from front-right and above, orthographic, framed to the item's
 * own bounds with a fixed margin. Matched to the thumbnails that already exist
 * rather than chosen: a palette where one row is lit differently or seen from
 * another angle reads as a mistake, and the whole value of a thumbnail grid is
 * that the shapes can be compared down a column.
 */
import {writeFileSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';
import {createServer} from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** The size every thumbnail in the catalog already is. */
const WIDTH = 300;
const HEIGHT = 225;

/** Page white, so a thumbnail sits on the drawer's own background. */
const BACKGROUND = [255, 255, 255];

/**
 * Where the eye is, as a direction rather than a point.
 *
 * Front-right and above, which is the angle the existing thumbnails use: it
 * shows a front, a side and a top, so a cabinet reads as a box with a face
 * rather than as an elevation.
 */
const EYE = [0.62, 0.45, 1.0];

/** Where the key light comes from. Up and to the left, opposite the eye's side. */
const KEY = [-0.5, 0.8, 0.35];

/** How much of the frame is empty. A picture cropped to its own edges looks cramped. */
const MARGIN = 0.12;

/**
 * Ambient, and it is most of the light.
 *
 * These are pictures of matte painted millwork on a white page, not studies of
 * form. Tuned by looking, between two failures: at 0.42 a white cabinet came out
 * grey and the picture was about the lighting, and at 0.72 the top, the front and
 * the side of a box were three shades of the same thing and the shape stopped
 * reading. 0.6 separates the three faces while white paint still looks white,
 * and it leaves the reveal between two fronts visible - which on a cabinet hood
 * is the only thing distinguishing a cupboard from more mantel.
 */
const AMBIENT = 0.6;

function norm(v)
{
	const len = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a, b)
{
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The camera's own axes: right, up, and back towards the eye.
 *
 * Built from a world up of +Y, which is safe here because the eye is never
 * directly overhead - a thumbnail looking straight down at a cabinet would show
 * a rectangle.
 */
function basis()
{
	const back = norm(EYE);
	const right = norm(cross([0, 1, 0], back));
	return {right, up: cross(back, right), back};
}

/** sRGB bytes from a `0xrrggbb` and a brightness in 0..1. */
function shade(colour, light)
{
	const out = [];
	for (let i = 0; i < 3; i++)
	{
		const channel = (colour >> (16 - i * 8)) & 0xff;
		out.push(Math.max(0, Math.min(255, Math.round(channel * light))));
	}
	return out;
}

/**
 * Every triangle of a build, in camera space, with the colour it is drawn in.
 *
 * Flattened out of the merged geometry rather than walked as a scene graph,
 * because `mergeMeshes` has already baked every transform - which is the whole
 * reason a generated build is one geometry and a material list.
 */
function trianglesOf(built, view)
{
	const position = built.geometry.getAttribute('position');
	const out = [];
	for (const group of built.geometry.groups)
	{
		const material = built.materials[group.materialIndex];
		const colour = material && material.color ? material.color.getHex() : 0xcccccc;
		for (let i = group.start; i < group.start + group.count; i += 3)
		{
			const corners = [];
			for (let c = 0; c < 3; c++)
			{
				const world = [position.getX(i + c), position.getY(i + c), position.getZ(i + c)];
				corners.push([dot(world, view.right), dot(world, view.up), dot(world, view.back)]);
			}
			// The face normal, in camera space, from the winding.
			const ab = [corners[1][0] - corners[0][0], corners[1][1] - corners[0][1], corners[1][2] - corners[0][2]];
			const ac = [corners[2][0] - corners[0][0], corners[2][1] - corners[0][1], corners[2][2] - corners[0][2]];
			out.push({corners, normal: norm(cross(ab, ac)), colour});
		}
	}
	return out;
}

/**
 * Rasterise the triangles into a PNG.
 *
 * A plain z-buffer over the triangle's own bounding box. No clipping is needed:
 * the projection is orthographic and the frame is fitted to the geometry, so
 * nothing falls behind the eye and nothing leaves the picture.
 */
function render(triangles)
{
	// Frame it: the extent of everything, plus a margin, keeping the aspect.
	let lo = [Infinity, Infinity];
	let hi = [-Infinity, -Infinity];
	for (const tri of triangles)
	{
		for (const corner of tri.corners)
		{
			lo = [Math.min(lo[0], corner[0]), Math.min(lo[1], corner[1])];
			hi = [Math.max(hi[0], corner[0]), Math.max(hi[1], corner[1])];
		}
	}
	const span = Math.max(hi[0] - lo[0], (hi[1] - lo[1]) * WIDTH / HEIGHT, 1e-6) * (1 + MARGIN * 2);
	const scale = WIDTH / span;
	const midX = (lo[0] + hi[0]) / 2;
	const midY = (lo[1] + hi[1]) / 2;
	// Screen y runs down; world y runs up.
	const toX = (x) => (x - midX) * scale + WIDTH / 2;
	const toY = (y) => HEIGHT / 2 - (y - midY) * scale;

	const png = new PNG({width: WIDTH, height: HEIGHT});
	const depth = new Float64Array(WIDTH * HEIGHT).fill(-Infinity);
	for (let i = 0; i < WIDTH * HEIGHT; i++)
	{
		png.data[i * 4] = BACKGROUND[0];
		png.data[i * 4 + 1] = BACKGROUND[1];
		png.data[i * 4 + 2] = BACKGROUND[2];
		png.data[i * 4 + 3] = 255;
	}

	const key = norm(KEY);
	for (const tri of triangles)
	{
		// Lambert on the absolute dot, so a face is lit from whichever side it
		// turns towards the key. Two-sided on purpose: a generated build is made
		// of boxes and some of them are seen from inside.
		const light = Math.min(1, AMBIENT + (1 - AMBIENT) * Math.abs(dot(tri.normal, key)));
		const rgb = shade(tri.colour, light);

		const sx = tri.corners.map((c) => toX(c[0]));
		const sy = tri.corners.map((c) => toY(c[1]));
		const sz = tri.corners.map((c) => c[2]);
		const minX = Math.max(0, Math.floor(Math.min(...sx)));
		const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(...sx)));
		const minY = Math.max(0, Math.floor(Math.min(...sy)));
		const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(...sy)));
		const area = (sy[1] - sy[2]) * (sx[0] - sx[2]) + (sx[2] - sx[1]) * (sy[0] - sy[2]);
		if (Math.abs(area) < 1e-9)
		{
			continue;
		}

		for (let py = minY; py <= maxY; py++)
		{
			for (let px = minX; px <= maxX; px++)
			{
				const x = px + 0.5;
				const y = py + 0.5;
				const u = ((sy[1] - sy[2]) * (x - sx[2]) + (sx[2] - sx[1]) * (y - sy[2])) / area;
				const v = ((sy[2] - sy[0]) * (x - sx[2]) + (sx[0] - sx[2]) * (y - sy[2])) / area;
				const w = 1 - u - v;
				if (u < 0 || v < 0 || w < 0)
				{
					continue;
				}
				const z = u * sz[0] + v * sz[1] + w * sz[2];
				const at = py * WIDTH + px;
				if (z <= depth[at])
				{
					continue;
				}
				depth[at] = z;
				png.data[at * 4] = rgb[0];
				png.data[at * 4 + 1] = rgb[1];
				png.data[at * 4 + 2] = rgb[2];
			}
		}
	}
	return PNG.sync.write(png);
}

/** Every catalog row this tool could draw: generated, with a spec and an image. */
function drawable()
{
	const catalog = JSON.parse(readFileSync(join(ROOT, 'src', 'catalog', 'catalog.json'), 'utf8'));
	return catalog.items.filter((item) =>
		item.format === 'generated' && item.spec && item.spec.kind && item.image);
}

async function main()
{
	const args = process.argv.slice(2);
	const rows = drawable();

	if (args.includes('--list'))
	{
		rows.forEach((row) => console.log(`${row.name}  ->  ${row.image}`));
		return;
	}

	const wanted = args.includes('--all')
		? rows
		: rows.filter((row) => args.includes(row.name));

	// Several catalog rows share one picture on purpose - a gas range and a
	// slide-in are the same box - so drawing both would leave whichever ran last,
	// silently. Say so rather than picking.
	const seen = new Map();
	for (const row of wanted)
	{
		const clash = seen.get(row.image);
		if (clash)
		{
			console.error(`${row.image} is wanted by both "${clash}" and "${row.name}" `
				+ '- give one of them its own image, or name just the one you meant.');
			process.exitCode = 1;
			return;
		}
		seen.set(row.image, row.name);
	}
	if (!wanted.length)
	{
		console.error('Nothing named. Try --list, --all, or a catalog name in quotes.');
		process.exitCode = 1;
		return;
	}

	// Vite resolves the source graph the way the application does; see the note
	// at the top. `appType: custom` because nothing is being served.
	const server = await createServer({
		root: ROOT, logLevel: 'error',
		server: {middlewareMode: true}, appType: 'custom',
	});
	try
	{
		const {GENERATED_BUILDERS} = await server.ssrLoadModule(
			'/src/scripts/items/generated/index.js');
		const view = basis();

		for (const row of wanted)
		{
			const build = GENERATED_BUILDERS[row.spec.kind];
			if (!build)
			{
				console.error(`no builder for ${row.spec.kind} (${row.name})`);
				process.exitCode = 1;
				continue;
			}
			const triangles = trianglesOf(build(row.spec), view);
			const bytes = render(triangles);
			const path = join(ROOT, 'public', row.image);
			writeFileSync(path, bytes);
			console.log(`${row.name}  ->  ${row.image}  ${bytes.length} bytes`);
		}
	}
	finally
	{
		await server.close();
	}
}

main();
