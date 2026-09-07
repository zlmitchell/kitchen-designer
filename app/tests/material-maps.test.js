/**
 * Maps on the material library (ROADMAP.md Phase 8a).
 *
 * `createMaterial` built a `MeshStandardMaterial` from colour, roughness and
 * metalness and nothing else, so every generated item was a flat colour while
 * the walls and floors around it carried images. These are the four things that
 * had to be true for a map to go on one without leaking or looking wrong.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SRGBColorSpace, NoColorSpace, RepeatWrapping, BoxGeometry} from 'three';
import {MATERIALS, createMaterial, setMaterialAssetResolver} from '../src/scripts/core/materials.js';
import {AssetResolver} from '../src/scripts/core/asset_resolver.js';
import {disposeMaterial} from '../src/scripts/core/resource_registry.js';
import {scaleBoxUVs, boxGeometryFor} from '../src/scripts/core/geometry_builders.js';
import {textureCacheStats, clearTextureCache, textureUrlOf} from '../src/scripts/core/texture_cache.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The entries this phase actually mapped, so the assertions below have subjects. */
const MAPPED = Object.keys(MATERIALS).filter((id) => MATERIALS[id].map);

describe('the material library points at real images', () =>
{
	it('mapped at least the woods, the stone and the brushed metal', () =>
	{
		// Guards the rest of this file: every assertion below iterates MAPPED, and
		// all of them pass vacuously if the catalog lost its maps.
		expect(MAPPED.length).toBeGreaterThanOrEqual(9);
	});

	it('names files that exist', () =>
	{
		const missing = [];
		MAPPED.forEach((id) =>
		{
			['map', 'normalMap', 'ormMap'].forEach((slot) =>
			{
				const url = MATERIALS[id][slot];
				if (url && !existsSync(join(ROOT, 'public', url)))
				{
					missing.push(`${id}.${slot} -> ${url}`);
				}
			});
		});
		expect(missing).toEqual([]);
	});

	it('gives every mapped entry a tile size', () =>
	{
		// A map with no tile size repeats once per panel face, which is the exact
		// failure `tile` exists to prevent - a 12ft run and a 24in door wearing the
		// same walnut at six times the grain.
		const untiled = MAPPED.filter((id) => !MATERIALS[id].tile);
		expect(untiled).toEqual([]);
	});
});

describe('createMaterial, with maps', () =>
{
	beforeEach(() => clearTextureCache());
	afterEach(() => clearTextureCache());

	it('decodes the albedo as a picture and the ORM as data', () =>
	{
		// The whole of what there is to get wrong here. An albedo is something a
		// person authored and looked at, so its bytes are sRGB; an ORM map is three
		// measurements packed into channels, and decoding it as a picture bends
		// every value it carries.
		const material = createMaterial('wood-walnut');

		expect(material.map.colorSpace).toBe(SRGBColorSpace);
		expect(material.roughnessMap.colorSpace).toBe(NoColorSpace);

		disposeMaterial(material);
	});

	it('hangs one ORM texture on all three of its slots', () =>
	{
		// glTF's convention: R occlusion, G roughness, B metalness. One image, so
		// one fetch and one upload - three separate greyscales would be three of
		// each for data that always travels together.
		const material = createMaterial('wood-walnut');

		expect(material.roughnessMap).toBe(material.aoMap);
		expect(material.roughnessMap).toBe(material.metalnessMap);
		expect(material.roughnessMap).not.toBe(material.map);

		disposeMaterial(material);
	});

	it('wraps, because a tiled map that clamps is a smear', () =>
	{
		const material = createMaterial('wood-walnut');
		expect(material.map.wrapS).toBe(RepeatWrapping);
		expect(material.map.wrapT).toBe(RepeatWrapping);
		disposeMaterial(material);
	});

	it('leaves an unmapped entry exactly as it was', () =>
	{
		// Most of the library is paint, and paint has no picture. The point of this
		// assertion is that Phase 8a cost the unmapped entries nothing.
		const material = createMaterial('paint-navy');

		expect(material.map).toBe(null);
		expect(material.userData.releaseMaps).toBeUndefined();
		expect(textureCacheStats().urls).toBe(0);

		disposeMaterial(material);
	});

	it('carries the tile size for whoever builds the geometry', () =>
	{
		expect(createMaterial('wood-walnut').userData.tile).toBe(MATERIALS['wood-walnut'].tile);
		expect(createMaterial('paint-navy').userData.tile).toBeUndefined();
	});

	it('still falls back rather than throwing on a retired id', () =>
	{
		// A saved design outlives the library, and this is the tolerance that lets
		// a file naming a finish this build dropped open anyway.
		const material = createMaterial('walnut-burl-that-never-shipped');
		expect(material.userData.materialId).toBe('paint-white');
		disposeMaterial(material);
	});
});

describe('borrowed images are given back', () =>
{
	beforeEach(() => clearTextureCache());
	afterEach(() => clearTextureCache());

	it('releases every handle when the material is disposed', () =>
	{
		// The leak this guards is the one RM-002 R-04 fixed for walls, arriving by
		// a new route: a material that borrows and never returns holds a decode
		// alive for the life of the page.
		expect(textureCacheStats().handles).toBe(0);

		const material = createMaterial('wood-walnut');
		expect(textureCacheStats().handles).toBe(2);
		// Two urls, not three: the ORM map is one image on three slots.
		expect(textureCacheStats().urls).toBe(2);

		disposeMaterial(material);
		expect(textureCacheStats().handles).toBe(0);
		expect(textureCacheStats().urls).toBe(0);
	});

	it('shares one decode across every material using the same image', () =>
	{
		// Oak, walnut and maple are one grain tinted three ways, which is the whole
		// reason there are three sets rather than eleven. If this ever reads more
		// than two urls, that economy has been lost.
		const oak = createMaterial('wood-white-oak');
		const walnut = createMaterial('wood-walnut');
		const maple = createMaterial('wood-maple');

		expect(textureCacheStats().urls).toBe(2);
		expect(textureCacheStats().handles).toBe(6);

		[oak, walnut, maple].forEach(disposeMaterial);
		expect(textureCacheStats().urls).toBe(0);
	});

	it('survives being disposed twice', () =>
	{
		// `disposeObject` and `disposeMaterial` can both reach the same material,
		// and three's own dispose is idempotent - this one has to be too.
		const material = createMaterial('wood-walnut');
		disposeMaterial(material);
		disposeMaterial(material);
		expect(textureCacheStats().handles).toBe(0);
	});
});

describe('scaleBoxUVs', () =>
{
	it('gives a face one repeat per tile of real surface', () =>
	{
		// A 120cm x 60cm face at a 60cm tile is two repeats across and one down.
		const geometry = new BoxGeometry(120, 60, 30);
		scaleBoxUVs(geometry, 120, 60, 30, 60);

		const uv = geometry.attributes.uv;
		// +Z is the front face: u runs along width, v along height.
		const front = 16;
		let maxU = 0;
		let maxV = 0;
		for (let i = front; i < front + 4; i++)
		{
			maxU = Math.max(maxU, uv.getX(i));
			maxV = Math.max(maxV, uv.getY(i));
		}
		expect(maxU).toBeCloseTo(2, 5);
		expect(maxV).toBeCloseTo(1, 5);
	});

	it('scales each face by its own dimensions', () =>
	{
		// The reason this is per face rather than one number: the six faces of a
		// box are three different sizes, and a single scale would stretch four of
		// them. +X spans depth by height, not width by height.
		const geometry = new BoxGeometry(120, 60, 30);
		scaleBoxUVs(geometry, 120, 60, 30, 30);

		const uv = geometry.attributes.uv;
		let maxU = 0;
		for (let i = 0; i < 4; i++)
		{
			maxU = Math.max(maxU, uv.getX(i));
		}
		// depth 30 / tile 30 == 1, where the front face would read 120 / 30 == 4.
		expect(maxU).toBeCloseTo(1, 5);
	});

	it('does nothing without a tile size', () =>
	{
		// Most of the library is unmapped, and those panels must keep the 0..1 UVs
		// three gave them - paying nothing for a feature they do not use.
		const geometry = new BoxGeometry(120, 60, 30);
		const before = Array.from(geometry.attributes.uv.array);
		scaleBoxUVs(geometry, 120, 60, 30, 0);
		expect(Array.from(geometry.attributes.uv.array)).toEqual(before);
	});

	it('reads the tile off the material it is given', () =>
	{
		const material = createMaterial('wood-walnut');
		const geometry = boxGeometryFor(material, 60, 60, 60);
		// tile 60 on a 60cm cube is exactly one repeat per face.
		expect(geometry.attributes.uv.getX(17)).toBeCloseTo(1, 5);
		disposeMaterial(material);
		clearTextureCache();
	});
});

describe('map urls go through the application resolver', () =>
{
	beforeEach(() => clearTextureCache());
	afterEach(() =>
	{
		setMaterialAssetResolver(null);
		clearTextureCache();
	});

	it('resolves through whichever resolver the app installed', () =>
	{
		// The defect this pins: `createMaterial` reached for `defaultAssetResolver`
		// while the application builds its viewer with a resolver of its own - the
		// one the manifest is installed into and the one `?assetBase=` reaches. A
		// wall resolving through the manifest while the cabinet in front of it
		// resolves through identity only shows up on a deployment with an asset
		// base, which is the worst place to find it.
		const cdn = new AssetResolver();
		cdn.setBase('https://cdn.example.com/assets/');
		setMaterialAssetResolver(cdn);

		const material = createMaterial('wood-walnut');
		expect(textureUrlOf(material.map)).toBe(
			cdn.resolve(MATERIALS['wood-walnut'].map).url);
		expect(textureUrlOf(material.map)).toContain('cdn.example.com');
	});

	it('falls back to the default resolver when the app installs none', () =>
	{
		// The library and every headless test run this way, where a resolver is
		// identity and the urls in materials.json are already real paths.
		setMaterialAssetResolver(null);
		const material = createMaterial('wood-walnut');
		expect(textureUrlOf(material.map)).toBe(MATERIALS['wood-walnut'].map);
	});
});
