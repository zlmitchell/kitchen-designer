// @ts-check
import {Color, MeshStandardMaterial} from 'three';
import catalog from '../../catalog/materials.json';

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
 */

/** @type {Record<string, MaterialEntry>} */
export const MATERIALS = catalog.materials;

/** @type {Record<string, string>} */
export const MATERIAL_GROUPS = catalog.groups;

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
 * Build the material an id names.
 *
 * @param {string} id A key of `MATERIALS`. Unknown ids fall back rather than
 *        throw; see `FALLBACK_MATERIAL`.
 * @returns {MeshStandardMaterial} A fresh instance, named for the library entry
 *          so `mergeMeshes` pools it and the inspector can label it.
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
	return material;
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
