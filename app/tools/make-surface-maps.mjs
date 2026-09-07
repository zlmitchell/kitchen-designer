/**
 * Generate the surface maps the material library finishes items with (Phase 8a).
 *
 * Run: `npm run surfaces`        write the files
 *      `npm run surfaces:check`  regenerate and compare, byte for byte
 *
 * ## Why generated rather than photographed
 *
 * Reproducible, no licence to track, no download at build time, and the byte
 * cost is ours to tune rather than whatever a texture site shipped. The same
 * argument `make-asset-manifest.mjs` and `resize-textures.mjs` already make for
 * living in `tools/`: an asset a command can rebuild is not really an asset.
 *
 * ## Three sets, not eleven
 *
 * A map MULTIPLIES the material's colour - the relationship a painted wall has
 * with its wallmap, and the reason `materials.json` keeps both. So these are
 * NEUTRAL: one wood grain tinted by `wood-walnut`'s brown and again by
 * `wood-maple`'s cream is two convincing woods off one image. Eleven mapped
 * entries therefore need three sets, which is the difference between fitting the
 * VRAM budget and not.
 *
 * ## Albedo and ORM, no normal maps
 *
 * The schema has a `normalMap` slot and this writes nothing into it. At the
 * distance a cabinet is looked at, grain is a colour phenomenon and roughness
 * variation does the rest; a normal map is a third upload per surface for relief
 * you cannot see from across a kitchen. The slot is there for when something
 * needs it - brushed metal under a moving highlight is the likeliest first case.
 *
 * ## Why not KTX2
 *
 * `core/texture_cache.js` cannot hold a `CompressedTexture`. It promises a
 * texture synchronously and fills in `.source` when the load lands, and a KTX2
 * load returns nothing at call time and produces mipmaps rather than a source.
 * `encode-textures.mjs` documents this at length and calls redesigning it a
 * sprint of its own, so: JPEG albedo, PNG ORM.
 *
 * ORM is PNG on purpose. Its three channels are separate measurements - R
 * occlusion, G roughness, B metalness - and JPEG's chroma subsampling averages
 * colour across neighbouring pixels, which is exactly the wrong thing to do to
 * data that only looks like a colour. The albedo really is a picture, so it
 * takes the lossy format. ORM is also written at half the albedo's edge length:
 * roughness varies slowly, and it is a quarter of the pixels.
 */
import {writeFileSync, readFileSync, existsSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';
import jpeg from 'jpeg-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'rooms', 'surfaces');

/** Albedo edge length. 512 is where wood grain stops looking like stripes. */
const ALBEDO = 512;
/** ORM edge length. Half, because roughness has no fine detail to lose. */
const ORM = 256;
/** Quality for the albedo JPEGs. */
const JPEG_QUALITY = 88;

/**
 * Seeded, so the same command produces the same bytes on any machine - which is
 * what makes `--check` a real gate rather than a formality.
 *
 * mulberry32: small, fast, and good enough for texture noise.
 */
function rng(seed)
{
	let a = seed >>> 0;
	return function ()
	{
		a = (a + 0x6D2B79F5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * A lattice of random values that wraps, so every map made from it tiles.
 *
 * The wrap is the whole point: a surface is repeated across a 12ft counter run,
 * and a seam every tile is worse than no map at all.
 */
function lattice(size, random)
{
	const values = new Float32Array(size * size);
	for (let i = 0; i < values.length; i++)
	{
		values[i] = random();
	}
	return {size: size, values: values};
}

/** Smoothstep, so the interpolation leaves no visible lattice creases. */
function fade(t)
{
	return t * t * (3 - 2 * t);
}

/** Bilinear sample of a wrapping lattice, in [0,1) coordinates. */
function sample(grid, x, y)
{
	const fx = x * grid.size;
	const fy = y * grid.size;
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const tx = fade(fx - x0);
	const ty = fade(fy - y0);
	const xa = ((x0 % grid.size) + grid.size) % grid.size;
	const ya = ((y0 % grid.size) + grid.size) % grid.size;
	const xb = (xa + 1) % grid.size;
	const yb = (ya + 1) % grid.size;
	const v00 = grid.values[ya * grid.size + xa];
	const v10 = grid.values[ya * grid.size + xb];
	const v01 = grid.values[yb * grid.size + xa];
	const v11 = grid.values[yb * grid.size + xb];
	return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

/** Octaves of `sample`, halving amplitude and doubling frequency. */
function fbm(grids, x, y)
{
	let total = 0;
	let amplitude = 1;
	let sum = 0;
	for (let i = 0; i < grids.length; i++)
	{
		total += sample(grids[i], x, y) * amplitude;
		sum += amplitude;
		amplitude *= 0.5;
	}
	return total / sum;
}

/** Lattices at `base`, 2x base, 4x base... for one fbm stack. */
function octaves(random, count, base)
{
	const grids = [];
	for (let i = 0; i < count; i++)
	{
		grids.push(lattice(base * Math.pow(2, i), random));
	}
	return grids;
}

function clamp01(value)
{
	return value < 0 ? 0 : (value > 1 ? 1 : value);
}

/**
 * Wood: rings distorted by noise, plus fine striations along the grain.
 *
 * The grain runs along x and the rings cross it, which is a flatsawn board - the
 * cut nearly every cabinet door is.
 */
function woodField(u, v, warp, fine)
{
	// The ring coordinate, pushed around by low-frequency noise so the rings are
	// not a barcode.
	// Distortion is deliberately SMALL against the ring frequency. Wood's strongest
	// visual property is that it is linear - long parallel rings running the length
	// of the board, wandering slowly, with the occasional cathedral arc where the
	// saw crossed one. Push the distortion up and the rings stop being parallel;
	// the second cut of this used 3.2 against 7 and came out as cloud.
	const distortion = fbm(warp, u, v) - 0.5;
	const rings = v * 17 + distortion * 1.1;
	const phase = rings - Math.floor(rings);

	// An ASYMMETRIC TRIANGLE, and the asymmetry is the whole point. A growth ring
	// darkens quickly into the late wood and fades slowly back out through the
	// early wood, so a symmetric wave reads as a stripe and a sine reads as a
	// gradient. The first cut of this used a raw sawtooth, which has that profile
	// but also a discontinuity where it wraps - and a hard edge repeated across a
	// smooth field is exactly what makes an image read as a contour map rather
	// than as timber. This has the profile and no cliff.
	const peak = 0.24;
	const ring = phase < peak
		? phase / peak
		: 1 - (phase - peak) / (1 - peak);

	// Not every ring is as dark as its neighbour. Without this the board is a
	// repeating pattern, which no board is.
	const strength = 0.55 + fbm(fine, u * 0.2, v * 0.6) * 0.75;

	// Striations ALONG the grain - sampled at a fraction of the rate across it, so
	// they stretch into fibres. This is the detail that reads as timber rather
	// than as contour lines on a map, and it wants to be strong.
	const striation = (fbm(fine, u * 0.18, v * 16) - 0.5) * 0.42;
	// A high power keeps the dark late-wood line NARROW, which is what stops the
	// board reading as wide soft bands.
	return clamp01(0.55 + Math.pow(ring, 2.4) * 0.42 * strength + striation);
}

/** Marble: thin veins where a turbulence-warped wave crosses zero. */
function marbleField(u, v, warp, fine)
{
	const turbulence = (fbm(warp, u, v) - 0.5) * 2;

	// A DOMINANT DIRECTION, and rather more of it than turbulence. Bedded stone
	// veins in a direction; the first cut of this let the turbulence dominate and
	// produced closed loops - iso-contours of the noise, which is what they were.
	// The RATIO of direction to turbulence is what decides whether this reads as
	// stone or as a contour map, and it took three attempts to believe it. A
	// smooth 2D field's level sets are closed loops, so any `1 - |sin(field)|`
	// draws loops unless one direction dominates hard enough to stretch them into
	// lines. Wood gets there at 0.065; marble wants to wander, and 0.17 is where
	// it still wanders but stops closing.
	const wave = Math.sin((u * 0.8 + v * 5.1 + turbulence * 0.9) * Math.PI * 2);

	// A vein's width VARIES, and a constant power is what makes every line in an
	// iso-contour plot the same weight. Softer than the first cut, which drew
	// near-black hairlines; Carrara's veins are grey and feathered.
	const sharpness = 3 + fbm(fine, u * 0.4, v * 0.4) * 9;
	const vein = Math.pow(1 - Math.abs(wave), sharpness);

	// A second, fainter set crossing the first at its own angle. One family of
	// veins reads as a pattern; two read as stone.
	const secondary = Math.sin((u * 1.9 - v * 3.6 + turbulence * 1.1) * Math.PI * 2);
	const faint = Math.pow(1 - Math.abs(secondary), 14);

	// Broad grey drift, so the body between the veins is not paper.
	const mottle = (fbm(warp, u * 0.5, v * 0.5) - 0.5) * 0.13;
	return clamp01(1 - vein * 0.44 - faint * 0.2 + mottle);
}

/**
 * Brushed metal: noise stretched hard along the brush direction.
 *
 * Sampling `u` at a fraction of its rate and `v` at many times it is the whole
 * trick - the same noise, read as long thin streaks. Phase 2's sink brief asks
 * for exactly this ("anisotropy-ish streaks in the map").
 */
function brushedField(u, v, warp, fine)
{
	const streak = fbm(warp, u * 0.06, v * 14);
	const grit = (fbm(fine, u * 0.5, v * 26) - 0.5) * 0.1;
	return clamp01(0.5 + (streak - 0.5) * 0.9 + grit);
}

/**
 * The three sets.
 *
 * `roughness.spread` is variation around the material's own value, not an
 * absolute: `materials.json` still decides how rough walnut is, and this decides
 * how much that varies across the board. `metalness` is absolute, because a
 * surface either is metal or is not.
 */
const SETS = [
	{
		name: 'wood-grain',
		seed: 0x5EED0001,
		field: woodField,
		// Neutral and bright, so a tint reads as stain over timber rather than as
		// paint. The floor is set from a measurement rather than by eye: a map
		// MULTIPLIES the entry's colour, and a mean of 0.76 renders every mapped
		// wood a quarter darker than the hex somebody chose. 0.58 puts the mean at
		// 0.83 and still leaves a standard deviation of 0.10 - grain you can see,
		// over a palette that still matches its swatch. Compensating in the
		// colours instead would have clipped oak past white. Floor plus range is
		// 1.0 exactly, here and in both sets below; see the clamp in `render`.
		albedo: {floor: 0.58, range: 0.42},
		roughness: {spread: 0.3},
		metalness: 0,
	},
	{
		name: 'marble',
		seed: 0x5EED0002,
		field: marbleField,
		albedo: {floor: 0.46, range: 0.54},
		// Polished stone is a little smoother in the veins than in the body. A
		// big spread here reads as dirt rather than as stone.
		roughness: {spread: 0.18},
		metalness: 0,
	},
	{
		name: 'brushed-metal',
		seed: 0x5EED0003,
		field: brushedField,
		// Nearly flat: the streaks a person sees are the roughness map, not the
		// colour. An albedo doing that work looks like scratched paint.
		albedo: {floor: 0.88, range: 0.12},
		roughness: {spread: 0.45},
		metalness: 1,
	},
];

/**
 * Sample a field across a square, then stretch it to fill [0,1].
 *
 * The normalisation is not a nicety. Hand-calibrated noise constants land
 * wherever they land - the first cut of these three had standard deviations of
 * 0.04, 0.016 and 0.011, which is a wood grain nobody can see and a roughness
 * map that may as well be a constant. Normalising means the field functions only
 * have to get the SHAPE right and the contrast is set here, once, where it can
 * be reasoned about.
 *
 * Percentiles rather than min and max, because one stray pixel at either end
 * would otherwise set the scale for the whole image.
 */
function field(set, size, warp, fine)
{
	const values = new Float64Array(size * size);
	for (let y = 0; y < size; y++)
	{
		for (let x = 0; x < size; x++)
		{
			values[y * size + x] = set.field(x / size, y / size, warp, fine);
		}
	}

	const sorted = Float64Array.from(values).sort();
	const low = sorted[Math.floor(sorted.length * 0.01)];
	const high = sorted[Math.floor(sorted.length * 0.99)];
	const span = (high - low) || 1;
	for (let i = 0; i < values.length; i++)
	{
		values[i] = clamp01((values[i] - low) / span);
	}
	return values;
}

/** Build one set's two images as encoded buffers. */
function render(set)
{
	const random = rng(set.seed);
	const warp = octaves(random, 4, 4);
	const fine = octaves(random, 3, 8);

	const albedoField = field(set, ALBEDO, warp, fine);
	const albedo = Buffer.alloc(ALBEDO * ALBEDO * 4);
	for (let p = 0; p < albedoField.length; p++)
	{
		// Clamped, and not defensively: `floor + range` over 1.0 writes a byte
		// past 255, which wraps to near-black and salts the grain with holes.
		// It cost one regeneration to find, and a mean cannot see it.
		const level = Math.round(clamp01(set.albedo.floor + albedoField[p] * set.albedo.range) * 255);
		const i = p * 4;
		albedo[i] = level;
		albedo[i + 1] = level;
		albedo[i + 2] = level;
		albedo[i + 3] = 255;
	}

	const ormField = field(set, ORM, warp, fine);
	const orm = new PNG({width: ORM, height: ORM});
	for (let p = 0; p < ormField.length; p++)
	{
		const i = p * 4;
		// R: occlusion. Flat white - these are flat panels, and a baked occlusion
		// that does not match the geometry is worse than none.
		orm.data[i] = 255;
		// G: roughness, spanning [1 - spread, 1] so it SCALES the entry's own
		// value rather than replacing it. White where the surface is at its
		// roughest, dipping where it is polished.
		orm.data[i + 1] = Math.round(((1 - set.roughness.spread) + ormField[p] * set.roughness.spread) * 255);
		orm.data[i + 2] = Math.round(set.metalness * 255);
		orm.data[i + 3] = 255;
	}

	return {
		albedo: jpeg.encode({data: albedo, width: ALBEDO, height: ALBEDO}, JPEG_QUALITY).data,
		orm: PNG.sync.write(orm),
	};
}

function run()
{
	const check = process.argv.includes('--check');
	if (!check && !existsSync(OUT))
	{
		mkdirSync(OUT, {recursive: true});
	}

	let stale = 0;
	let bytes = 0;

	for (const set of SETS)
	{
		const built = render(set);
		const files = [
			{path: join(OUT, set.name + '-albedo.jpg'), data: built.albedo},
			{path: join(OUT, set.name + '-orm.png'), data: built.orm},
		];

		for (const file of files)
		{
			bytes += file.data.length;
			if (check)
			{
				if (!existsSync(file.path) || !readFileSync(file.path).equals(file.data))
				{
					stale++;
					console.error('stale or missing: ' + file.path);
				}
				continue;
			}
			writeFileSync(file.path, file.data);
			console.log(set.name + ': ' + file.path.split(/public[\\/]/)[1] + '  ' + file.data.length + ' bytes');
		}
	}

	console.log(SETS.length + ' sets, ' + bytes + ' bytes total');
	if (check && stale)
	{
		console.error(stale + ' file(s) differ. Run `npm run surfaces`.');
		process.exit(1);
	}
}

run();
