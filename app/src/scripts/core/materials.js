// @ts-check
import {Color, MeshStandardMaterial, SRGBColorSpace, RepeatWrapping} from 'three';
import catalog from '../../catalog/materials.json';
import {acquireTexture, releaseTexture} from './texture_cache.js';
import {defaultAssetResolver} from './asset_resolver.js';

/**
 * The material library generated items are finished with.
 *
 * ## Why this exists rather than a colour on the item
 *
 * `Item.setMaterialColor` tints one material slot, and that is all the app could
 * express about what something is made of. A tint cannot tell white paint from
 * white lacquer or from white quartz - they are the same colour and three
 * different surfaces, and the difference is entirely in roughness and metalness.
 * So a cabinet "in walnut" and a cabinet "in navy paint" were the same object
 * with a different hex, which is exactly the gap ROADMAP.md 0b describes.
 *
 * A library also makes the three questions the user asks - what material, what
 * door style, what colour - three lookups against one list rather than three
 * bespoke controls.
 *
 * ## A material per face group, not per item
 *
 * A cabinet has a carcass, a frame, a front, a counter and hardware, and they
 * are made of different things. So a spec names a material per SLOT and the
 * builder resolves each one. `door.js` is the smallest case: frame, leaf,
 * casing, hardware.
 *
 * ## Fresh instances, never shared
 *
 * `createMaterial` returns a new material every call and nothing is cached. That
 * is deliberate and it is about disposal, not about memory: `Item.removed()`
 * disposes the materials its geometry carries, and `Edge` refcounts through a
 * resource registry - a shared instance handed to two items would be disposed by
 * whichever died first and leave the other drawing with a dead handle. The
 * objects are tiny; the ownership question is not.
 *
 * `mergeMeshes` pools by `material.name`, so two parts finished the same way
 * still collapse to one draw call within a single build. That is why `name` is
 * set from the library entry and why the ids have to stay unique.
 */

/** @typedef {Object} MaterialEntry
 * @property {string} label Shown in a picker.
 * @property {string} group One of `catalog.groups`.
 * @property {string} color sRGB hex, as authored.
 * @property {number} roughness
 * @property {number} metalness
 * @property {number} [opacity]
 * @property {boolean} [transparent]
 * @property {string} [map] Albedo image. Multiplies `color`, so an entry with
 *           both is a tinted picture rather than a picture that replaced a
 *           colour - the same relationship a painted wall has with its wallmap.
 * @property {string} [normalMap] Surface detail. Linear data, not a picture.
 * @property {string} [ormMap] Occlusion, roughness and metalness in the R, G and
 *           B channels - glTF's convention, and one fetch and one upload where
 *           three separate greyscales would be three of each. Scales `roughness`
 *           and `metalness` rather than replacing them, which is how three reads
 *           the corresponding glTF material.
 * @property {number} [tile] What one repeat of the maps covers, in centimetres.
 *           A material property rather than a mesh one: walnut has a grain size,
 *           and it does not change because the panel did. See `scaleBoxUVs`.
 */

/** @type {Record<string, MaterialEntry>} */
export const MATERIALS = catalog.materials;

/** @type {Record<string, string>} */
export const MATERIAL_GROUPS = catalog.groups;

/**
 * Which resolver a map's url is looked up in.
 *
 * `defaultAssetResolver` is the fallback and not the answer. The application
 * builds its viewer with a resolver of its own (`useBlueprint.js` ->
 * `assetResolver()`), because that is the one the manifest is installed into and
 * the one `?assetBase=` reaches - and `Edge` and `Floor` already resolve through
 * it by way of `runtime.assets`. A material has no runtime to ask, so the app
 * points this at the same instance instead.
 *
 * Left as the default in the library and in tests, where `resolve(name).url` is
 * just `name` and every url in `materials.json` is already a real path.
 *
 * @type {import('./asset_resolver.js').AssetResolver}
 */
var mapResolver = defaultAssetResolver;

/**
 * Resolve map urls through `resolver` from now on.
 *
 * @param {?import('./asset_resolver.js').AssetResolver} resolver Null restores
 *        the default, which is what a test tearing down should pass.
 */
export function setMaterialAssetResolver(resolver)
{
	mapResolver = resolver || defaultAssetResolver;
}

/**
 * The id used when a spec asks for a material this build does not have.
 *
 * A saved design outlives the library, and a file naming a retired finish should
 * open looking wrong rather than fail to open - the same tolerance
 * `resolveModelUrl` extends to a retired model.
 */
export const FALLBACK_MATERIAL = 'paint-white';

/**
 * Every material, as `{id, label, group}`, for a picker to render.
 *
 * @param {string} [group] Only this group, if given.
 * @returns {Array<{id: string, label: string, group: string}>}
 */
export function materialOptions(group)
{
	return Object.keys(MATERIALS)
		.filter((id) => !group || MATERIALS[id].group === group)
		.map((id) => ({id: id, label: MATERIALS[id].label, group: MATERIALS[id].group}));
}

/**
 * Which slots take a picture and which take linear data (Phase 8a).
 *
 * The distinction is the whole of what there is to get wrong here. An albedo is
 * something a person looked at and authored, so its bytes are sRGB; a normal map
 * and an ORM map are measurements packed into channels, and decoding them as
 * though they were a picture bends every value. `three/skybox.js:96` and
 * `three/edge.js:417` each document this trap from the other direction.
 */
const MAP_SLOTS = [
	{entry: 'map', target: 'map', srgb: true},
	{entry: 'normalMap', target: 'normalMap', srgb: false},
	// One image, three uses. three samples R for occlusion, G for roughness and
	// B for metalness, which is why the same texture goes on three slots rather
	// than being loaded three times.
	{entry: 'ormMap', target: 'aoMap', srgb: false},
	{entry: 'ormMap', target: 'roughnessMap', srgb: false},
	{entry: 'ormMap', target: 'metalnessMap', srgb: false},
];

/**
 * Build the material an id names.
 *
 * ## Maps arrive late, and that is deliberate
 *
 * Any images the entry names are borrowed from the shared cache, which hands
 * back a clone immediately and fills in the pixels when the decode lands. So
 * this returns a finished flat material now and the surface gains its grain a
 * moment later, rather than a caller waiting on a fetch to build a cabinet. A
 * design that never places a walnut door never fetches walnut.
 *
 * The urls are resolved before they are handed over: `texture_cache` is the
 * fetch primitive and takes physical urls only, which
 * `tests/asset-integrity.test.js` asserts of every caller.
 *
 * @param {string} id A key of `MATERIALS`. Unknown ids fall back rather than
 *        throw; see `FALLBACK_MATERIAL`.
 * @returns {MeshStandardMaterial} A fresh instance, named for the library entry
 *          so `mergeMeshes` pools it and the inspector can label it. Carries
 *          `userData.releaseMaps` when it borrowed anything - see
 *          `disposeMaterial`, which is what calls it.
 */
export function createMaterial(id)
{
	var key = Object.prototype.hasOwnProperty.call(MATERIALS, id) ? id : FALLBACK_MATERIAL;
	var entry = MATERIALS[key];
	var material = new MeshStandardMaterial({
		color: new Color(entry.color),
		roughness: entry.roughness,
		metalness: entry.metalness,
	});
	if (entry.transparent)
	{
		material.transparent = true;
		material.opacity = (entry.opacity === undefined) ? 1 : entry.opacity;
	}
	material.name = entry.label;
	// Which library entry this came from, so a rebuild can read back what a spec
	// asked for without re-deriving it from a colour.
	material.userData.materialId = key;
	// How big the grain is, in centimetres, for whoever builds the geometry this
	// goes on - `boxGeometryFor` reads it. On the material because it is a
	// property of the surface and not of the panel: walnut does not change grain
	// size because the door did.
	if (entry.tile)
	{
		material.userData.tile = entry.tile;
	}
	attachMaps(material, entry);
	return material;
}

/**
 * Borrow the entry's images and hang them on the material.
 *
 * One acquire per distinct url rather than per slot, so an ORM map used by three
 * slots is one handle and one release. Split out of `createMaterial` because the
 * ownership it sets up is the interesting half and reads badly inline.
 *
 * @param {MeshStandardMaterial} material
 * @param {MaterialEntry} entry
 */
function attachMaps(material, entry)
{
	/** @type {Map<string, import('three').Texture>} */
	var borrowed = new Map();

	MAP_SLOTS.forEach(function (slot)
	{
		var name = entry[slot.entry];
		if (!name)
		{
			return;
		}
		var texture = borrowed.get(name);
		if (!texture)
		{
			var physical = mapResolver.resolve(name).url;
			texture = acquireTexture(physical);
			texture.wrapS = RepeatWrapping;
			texture.wrapT = RepeatWrapping;
			if (slot.srgb)
			{
				texture.colorSpace = SRGBColorSpace;
			}
			borrowed.set(name, texture);
		}
		material[slot.target] = texture;
	});

	if (!borrowed.size)
	{
		return;
	}

	// The one thing that gives these back. `Material.dispose()` in three does not
	// touch maps - which is what lets the cache refcount across designs - so a
	// material that borrowed has to say so, and `disposeMaterial` asks.
	material.userData.releaseMaps = function ()
	{
		borrowed.forEach(function (texture) {releaseTexture(texture);});
		borrowed.clear();
	};
}

/**
 * Resolve a spec's `material` block against a builder's slot defaults.
 *
 * Written once here rather than in each builder because every builder needs the
 * same three lines and the same tolerance: a spec that names only the slot it
 * cares about must keep the builder's answer for the rest.
 *
 * @param {?Object} chosen A spec's `material` block, or null.
 * @param {Record<string, string>} defaults Slot name to material id.
 * @returns {Record<string, MeshStandardMaterial>} One material per slot.
 */
export function materialsForSlots(chosen, defaults)
{
	/** @type {Record<string, MeshStandardMaterial>} */
	var out = {};
	Object.keys(defaults).forEach((slot) =>
	{
		var id = (chosen && chosen[slot]) ? chosen[slot] : defaults[slot];
		out[slot] = createMaterial(id);
	});
	return out;
}
