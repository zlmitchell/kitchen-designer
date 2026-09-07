// @ts-check
import {computed} from 'vue';
import catalog from '../../catalog/catalog.json';

/**
 * The furniture palette, read straight from the catalog.
 *
 * Sprint S6. `src/catalog/catalog.json` became the single source of truth in
 * S3, but only the generated jQuery palette (build/js/items.js) consumed it.
 * The Vue app reads the JSON itself, so adding a model is a data change with no
 * generator step.
 */

/**
 * Item types that hang off a wall edge, and so want an `edge` in their
 * placement hint: WallItem (2), InWallItem (3), InWallFloorItem (7) and
 * WallFloorItem (9). The list is the demo's (build/js/app.js:979), named.
 */
const WALL_BOUND_TYPES = [2, 3, 7, 9];

/**
 * What the catalog is divided into for a person, as opposed to for the code.
 *
 * `itemTypes` is the OTHER division and it is the wrong one to open a palette
 * with: "Floor Items", "Wall Items" and "In Wall Items" name the class that
 * PLACES a thing, so a door and a window share a bucket with a wall-mounted
 * television and a base cabinet is filed beside a bed. That is a fact about
 * `items/factory.js` and not about kitchens, which is why 196 models behind one
 * Furniture button were easier to search than to browse.
 *
 * These four are what somebody is actually shopping for. They stay a filter
 * ACROSS the type sections rather than replacing them, because the type still
 * decides where a thing can land and the drawer still has to say so.
 *
 * The id lives on the catalog row as `category`; absent means `furniture`, so
 * the common case is silent in the data and a new model is furniture until
 * somebody says otherwise.
 */
export const CATALOG_CATEGORIES = [
	{id: 'cabinets', label: 'Cabinets'},
	{id: 'openings', label: 'Windows & doors'},
	{id: 'lighting', label: 'Lighting'},
	{id: 'furniture', label: 'Furniture'},
];

/**
 * Which of the four a row belongs to.
 *
 * @param {Object} item A catalog row.
 * @returns {string}
 */
export function categoryOf(item)
{
	return (item && item.category) || 'furniture';
}

/** The label for a category id, or "Catalog" for everything at once. */
export function categoryLabel(id)
{
	var found = CATALOG_CATEGORIES.find(function (one) {return one.id === id;});
	return found ? found.label : 'Catalog';
}

/**
 * @returns {Array<{id: number, heading: string, items: Array<Object>}>}
 */
/**
 * One entry in the catalog, as `src/catalog/catalog.json` records it.
 *
 * Written down here rather than in the component that renders it, because this
 * is where the shape is produced - a typedef beside the consumer drifts from the
 * data the first time the data changes (RM-004 B3).
 *
 * @typedef {Object} CatalogItem
 * @property {string} [category] One of `CATALOG_CATEGORIES`. Absent is furniture.
 * @property {string} name Shown under the thumbnail, and used as the item name.
 * @property {string} image Thumbnail URL, a logical asset name.
 * @property {string} model The model's logical asset name.
 * @property {number} type One of the `itemTypes` keys; selects the Item class.
 * @property {string} [format] `gltf` or `obj`. Absent means the legacy JSON
 *           format, which `resolveModelUrl` rewrites on the way in.
 */

/**
 * A heading and the items under it.
 *
 * @typedef {Object} CatalogSection
 * @property {number} id
 * @property {string} heading
 * @property {Array<CatalogItem>} items Never empty - buildSections drops those.
 */

/** @returns {Array<CatalogSection>} */
function buildSections()
{
	return Object.keys(catalog.itemTypes)
		.map((key) => Object.assign({id: Number(key)}, catalog.itemTypes[key]))
		.sort((a, b) => a.order - b.order)
		.map((type) => ({
			id: type.id,
			heading: type.heading,
			items: catalog.items.filter((item) => item.type === type.id),
		}))
		.filter((section) => section.items.length > 0);
}

/**
 * @param {import('./useBlueprint.js').BlueprintStore} store
 * @param {import('vue').ShallowRef<{wall: ?Object, floor: ?Object}>} placementContext
 */
export function useCatalog(store, placementContext)
{
	var sections = computed(buildSections);
	var count = computed(() => catalog.items.length);

	/**
	 * Add one catalog entry to the scene.
	 *
	 * Placement follows the last thing clicked in the 3D view: a wall-bound item
	 * lands at the centre of the last clicked wall and is bound to that edge, and
	 * anything else lands at the centre of the last clicked floor. With neither,
	 * the item is added with no hint and the controller picks it up under the
	 * pointer for the user to drop.
	 *
	 * That last case is the deliberate fix. The demo wrote
	 * `if(... && aWall.currentWall)`, and `aWall` is only assigned by the
	 * wall-clicked and floor-clicked handlers - so on a fresh page, opening the
	 * catalog and clicking any of the four wall-bound types threw
	 * `Cannot read property 'currentWall' of null` and added nothing. Every other
	 * type worked, which is why it survived: the first thing anyone adds is
	 * usually a chair.
	 *
	 * @param {Object} entry A row from catalog.json.
	 */
	function addItem(entry)
	{
		var scene = store.model.value.scene;
		var context = placementContext.value;
		var metadata = {
			itemName: entry.name,
			resizable: true,
			modelUrl: entry.model,
			itemType: entry.type,
			format: entry.format,
		};

		// A generated entry carries the spec it should be built from. Copied, not
		// shared: the catalog is a module singleton, so handing the same object to
		// two placed items would make editing one edit the other - and the second
		// would only notice on its next rebuild, which is the kind of bug that
		// reads as random.
		if (entry.spec)
		{
			metadata.spec = JSON.parse(JSON.stringify(entry.spec));
		}

		// A lamp carries its own light. Copied for the same reason as the spec, and
		// more sharply: two sconces from one catalog row would otherwise share one
		// fixture record, so switching one off would switch off the other.
		//
		// This is what closes the audit's "placement yes, light no" rows -
		// `Lampwall`, `Chandelier` and the rest have always placed correctly and
		// emitted nothing, because there was nowhere for a lumen to live.
		if (entry.fixtures)
		{
			metadata.fixtures = JSON.parse(JSON.stringify(entry.fixtures));
		}

		if (WALL_BOUND_TYPES.indexOf(entry.type) !== -1 && context.wall)
		{
			scene.addItem(entry.type, entry.model, metadata, null, null, null, false,
				{position: context.wall.center.clone(), edge: context.wall});
			return;
		}

		if (context.floor)
		{
			scene.addItem(entry.type, entry.model, metadata, null, null, null, false,
				{position: context.floor.center.clone()});
			return;
		}

		scene.addItem(entry.type, entry.model, metadata);
	}

	return {sections, count, addItem};
}
