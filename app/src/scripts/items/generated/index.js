// @ts-check
import {buildDoor, DOOR_SCHEMA} from './door.js';
import {buildPost, POST_SCHEMA} from './post.js';
import {buildCabinet, CABINET_SCHEMA} from './cabinet.js';
import {buildCounter, COUNTER_SCHEMA} from './counter.js';
import {buildSink, SINK_SCHEMA} from './sink.js';

/**
 * Items whose geometry is generated from a spec instead of fetched.
 *
 * A generated item names itself with a `generated:` URL - `generated:door` -
 * carried in `model_url` exactly like a file name, and `format: "generated"`.
 * Keeping it in `model_url` rather than inventing a parallel field means the
 * save format gains one value in a field it already has, and every path that
 * round-trips a model name (`Item.getMetaData`, `Model.loadSerialized`,
 * `resolveModelUrl`) needs no change at all.
 *
 * The builder's parameters live in `spec`, a per-item object beside
 * `material_colors` in the save file. `material_colors` is the precedent: a
 * sparse, optional, per-instance blob that is absent when it has nothing to say.
 *
 * ## Why the prefix and not a bare name
 *
 * `Scene.addItem` asks the asset manifest whether a build ships a model before
 * it touches the network, and a generated item ships in the code rather than in
 * the manifest. A prefix makes the branch decidable from the name alone, ahead
 * of that check, without teaching the manifest about models that are not files.
 */

/**
 * @typedef {Object} GeneratedBuild
 * @property {Object} geometry The item's own geometry - and therefore its bounds,
 *           which is what the wall's hole is cut from.
 * @property {Array} materials
 * @property {Array<import('three').Object3D>} parts Children to hang off the item.
 *           Deliberately outside `geometry`; see `door.js`.
 * @property {function(Object): void} [onBound] Called when the item binds to a
 *           wall edge - the only moment its own axes are known.
 */
/**
 * A builder, plus the one optional thing it may declare about itself.
 *
 * `absorbScale` folds a mesh scale into a spec, for a design saved before a
 * generated item's size lived in its spec. Optional and per builder rather than
 * derived, because the mapping is not general: a post's spec fields ARE its
 * bounding box, while a door's `width` is the clear opening and its bounds are
 * that plus two jambs.
 *
 * @typedef {{(spec: Object): GeneratedBuild, absorbScale?: function(Object, {x: number, y: number, z: number}): Object}} GeneratedBuilder
 */
/** @type {Record<string, GeneratedBuilder>} */
export const GENERATED_BUILDERS = {
	door: buildDoor,
	post: buildPost,
	cabinet: buildCabinet,
	counter: buildCounter,
	sink: buildSink,
};

/**
 * What a panel may ask about each kind, keyed the same way.
 *
 * Separate from the builders because they are consumed by different layers - the
 * model layer builds, the app layer asks - and a builder must stay importable
 * without dragging a UI contract along with it.
 *
 * @type {Record<string, {label: string, fields: Array<Object>}>}
 */
export const GENERATED_SCHEMAS = {
	door: DOOR_SCHEMA,
	post: POST_SCHEMA,
	cabinet: CABINET_SCHEMA,
	counter: COUNTER_SCHEMA,
	sink: SINK_SCHEMA,
};

/**
 * The schema for whatever a spec is, or null.
 *
 * @param {?Object} spec
 * @returns {?{label: string, fields: Array<Object>}}
 */
export function schemaForSpec(spec)
{
	if (!spec || !spec.kind)
	{
		return null;
	}
	return GENERATED_SCHEMAS[spec.kind] || null;
}

const PREFIX = 'generated:';

/**
 * The builder name in a `generated:` URL, or null if this is an ordinary model.
 *
 * Returns null rather than throwing for a name with no builder: an unknown
 * generated kind is a load failure like a missing file, and `Scene.addItem`
 * already has one path for that which keeps the load-in-flight count balanced.
 *
 * @param {*} modelUrl
 * @returns {?string}
 */
export function generatedKind(modelUrl)
{
	if (typeof modelUrl !== 'string' || !modelUrl.startsWith(PREFIX))
	{
		return null;
	}
	return modelUrl.slice(PREFIX.length) || null;
}

/**
 * @param {*} modelUrl
 * @returns {boolean} Whether this names a generated item at all, builder or not.
 */
export function isGenerated(modelUrl)
{
	return typeof modelUrl === 'string' && modelUrl.startsWith(PREFIX);
}
