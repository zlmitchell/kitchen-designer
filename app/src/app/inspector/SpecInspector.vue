<script setup>
// @ts-check
import {computed, ref, watch} from 'vue';
import NumberField from './fields/NumberField.vue';
import RangeField from './fields/RangeField.vue';
import {Dimensioning} from '../../scripts/blueprint.js';
import {schemaForSpec} from '../../scripts/items/generated/index.js';
import {materialOptions, MATERIAL_GROUPS} from '../../scripts/core/materials.js';
import {useDisplayUnit} from '../composables/useDisplayUnit.js';
import {useAssets} from '../composables/useAssets.js';

/**
 * The controls for a generated item, rendered from its builder's schema.
 *
 * ## Why this is one component and not one per kind
 *
 * Because a cabinet, a window and a door ask the same shapes of question -- a
 * length, a choice, a material, a fraction -- and only the list differs. A panel
 * per kind would mean writing the same four field types nine times and keeping
 * nine files in step with nine builders.
 *
 * So a builder exports a schema (`DOOR_SCHEMA`) and this renders it, the same
 * way `useCatalog` renders `catalog.json`. Adding an option to a door is a line
 * in `door.js`; it is not a change here. That is the test of whether this
 * abstraction is worth having, and it is the reason ROADMAP.md 0a asks for it.
 *
 * ## Rebuild, never scale
 *
 * Every edit goes through `Item.setSpec`, which asks the builder for the object
 * at the new size. `ItemInspector`'s width/height/depth fields do the opposite
 * -- they call `Item.resize`, which scales the mesh, so a 24in cabinet asked for
 * 36in gets 1.5x-wide stiles. Both panels can be on screen for the same item and
 * they are not redundant: one changes what the thing is, the other stretches it.
 * For a generated item the scale fields stay at 1 and this is what you use.
 *
 * ## Whole specs, not patches
 *
 * `getSpec()` hands back a copy, the edit is applied to that copy, and the whole
 * thing goes back through `setSpec`. So a field that throws mid-edit cannot
 * leave a half-applied spec on the item, and the item never observes an
 * intermediate state.
 */

const props = defineProps({
	item: {type: Object, required: true},
	items: {
		/**
		 * Everything placed, so a change can reach more than one thing.
		 *
		 * A bare `type: Array` infers `unknown[]`, which makes every property read
		 * off a member an error - the same shape RM-004 B3 found across the panels.
		 * The annotation goes on `type`, not on the prop object.
		 *
		 * @type {import('vue').PropType<Array<Object>>}
		 */
		type: Array,
		default: () => [],
	},
});

const emit = defineEmits(['changed']);

const {unit} = useDisplayUnit();
const assets = useAssets();

const schema = computed(() => schemaForSpec(props.item.metadata && props.item.metadata.spec));

/**
 * How far a change to a LOOK reaches.
 *
 * Nobody picks a door style for one cabinet. A kitchen has one door style and
 * one paint, and setting them twelve times is not a workflow - so a field the
 * schema marks `shared` can be applied to a whole run at once.
 *
 * Sizes are deliberately not shareable. A width applies to the cabinet you are
 * looking at and to nothing else, which is why the scope is a property of the
 * FIELD rather than a mode the panel is in: switching to "all cabinets" and then
 * typing a width would otherwise resize the kitchen.
 */
const SCOPES = [
	{value: 'one', label: 'This one'},
	{value: 'room', label: 'This room'},
	{value: 'all', label: 'All'},
	{value: 'wall', label: 'Uppers'},
	{value: 'base', label: 'Bases'},
];
const scope = ref('one');
const hasShared = computed(() =>
	Boolean(schema.value && schema.value.fields.some((field) => field.shared)));

/** The room a wall-bound item is in, or null for anything free-standing. */
function roomOf(item)
{
	return (item.currentWallEdge && item.currentWallEdge.room) || null;
}

/**
 * Everything a shared change should reach.
 *
 * Always includes the selected item, so the narrowest scope is still correct and
 * a scope that matches nothing else is a no-op rather than a surprise.
 */
function targets()
{
	const self = props.item;
	var all = props.items || [];
	if (scope.value === 'one' || !all.length)
	{
		return [self];
	}
	const kind = self.metadata.spec.kind;
	const room = roomOf(self);
	const matches = all.filter((other) =>
	{
		const spec = other.metadata && other.metadata.spec;
		if (!spec || spec.kind !== kind) {return false;}
		if (scope.value === 'wall') {return spec.variant === 'wall';}
		if (scope.value === 'base') {return spec.variant !== 'wall';}
		if (scope.value === 'room') {return room !== null && roomOf(other) === room;}
		return true;
	});
	return matches.indexOf(self) === -1 ? matches.concat([self]) : matches;
}
/** @type {import('vue').Ref<Object>} */
const spec = ref({});

/**
 * What the item's HOST refused, if anything.
 *
 * A generated item may declare requirements of the thing it sits in, and the
 * host validates them on binding -- `door.js`'s `applyDoorFit` is the first one
 * that can answer no, because a pocket door needs a wall thick enough to hold
 * its leaf and a run of wall to slide into. The refusal has to surface
 * somewhere: the drawing already shows it, by leaving the door shut, and a door
 * that ignores its own "how far open" slider with no explanation is worse than
 * one that cannot be drawn at all.
 *
 * Read in `readBack` rather than computed off the item, because the item is a
 * `Mesh` and not reactive -- and `readBack` runs on selection, on a unit change,
 * and after every write, which are the three moments the answer can change.
 */
const refusals = ref([]);

function readBack()
{
	spec.value = props.item.getSpec() || {};
	refusals.value = props.item.specNotices || [];
}

/** `material.leaf` reaches into the spec's material block. */
function valueAt(key)
{
	const parts = key.split('.');
	let at = spec.value;
	for (const part of parts)
	{
		if (at === undefined || at === null) {return undefined;}
		at = at[part];
	}
	return at;
}

function apply(item, key, next)
{
	const edited = item.getSpec() || {};
	const parts = key.split('.');
	let at = edited;
	for (let i = 0; i < parts.length - 1; i++)
	{
		// A spec that never named a material has no block to write into.
		if (!at[parts[i]] || typeof at[parts[i]] !== 'object') {at[parts[i]] = {};}
		at = at[parts[i]];
	}
	at[parts[parts.length - 1]] = next;
	item.setSpec(edited);
}

function write(key, next, field)
{
	// Only a LOOK travels. A size belongs to the thing you are looking at.
	const reach = (field && field.shared) ? targets() : [props.item];
	for (const item of reach)
	{
		apply(item, key, next);
	}
	// Read back rather than trusting the write: a builder is entitled to
	// normalise what it was handed, and the panel should show what the item took.
	readBack();
	emit('changed');
}

/**
 * Fields whose `when` is satisfied.
 *
 * A cased opening has no leaf, so asking which way it swings is noise. Written
 * as data on the field rather than as `v-if` here, so the condition lives beside
 * the option it governs.
 */
const visibleFields = computed(() =>
{
	if (!schema.value) {return [];}
	return schema.value.fields.filter((field) =>
	{
		if (!field.when) {return true;}
		return Object.keys(field.when).every((key) =>
		{
			var wanted = field.when[key];
			// An array is a set of values the field is relevant for, which is what a
			// cabinet's `doors` control needs: it belongs to three of the seven face
			// layouts and to none of the drawer banks. A scalar is the older form
			// and still the common one.
			return Array.isArray(wanted) ? wanted.indexOf(valueAt(key)) !== -1 : valueAt(key) === wanted;
		});
	});
});

/**
 * How many options a segmented control can hold before it becomes a dropdown.
 *
 * A row of pills is the right control for two or three choices and the wrong one
 * for eight: `.segmented` is an inline flex row, so a cabinet's seven face
 * layouts ran straight out of the side of the panel. Every choice in the app was
 * two or three until then, which is why nothing had found it.
 *
 * Four, so the sink's five mounts become a dropdown too - "Semi-recessed" beside
 * four others was the same row about to overflow.
 */
const SEGMENT_LIMIT = 4;

/**
 * Read a choice back from a dropdown, as the type the schema declared.
 *
 * A `<select>` deals only in strings, and some of these values are numbers -
 * `doors` is 0, 1 or 2. Matching on the stringified value and writing back the
 * ORIGINAL keeps a number a number, rather than storing "2" in a spec and
 * leaving whoever reads it to guess.
 *
 * @param {Object} field
 * @param {Event} event
 */
function onChoice(field, event)
{
	const select = /** @type {HTMLSelectElement} */ (event.target);
	const chosen = field.options.find((option) => String(option.value) === select.value);
	if (chosen)
	{
		write(field.key, chosen.value, field);
	}
}

/**
 * Start fetching the surface maps when a material control is reached.
 *
 * A pointer resting on the dropdown is the same signal the catalog palette
 * already acts on (`CatalogDrawer` -> `prefetchItem`), and it arrives a few
 * hundred milliseconds before the click, which is most of the fetch. Nothing is
 * downloaded until then: a design in painted cabinets never asks for any of it.
 *
 * Fire and forget - a prefetch that fails costs nothing, and the real load
 * reports through the ordinary path where somebody is waiting.
 */
function warmSurfaces()
{
	assets.prefetchSurfaces();
}

/** Grouped for the picker, so 20 finishes are not one flat list. */
function optionsFor(field)
{
	const list = materialOptions(field.group);
	const groups = {};
	for (const option of list)
	{
		if (!groups[option.group]) {groups[option.group] = [];}
		groups[option.group].push(option);
	}
	return Object.keys(groups).map((key) => ({
		label: MATERIAL_GROUPS[key] || key,
		options: groups[key],
	}));
}

/** `$event.target` is an EventTarget until something says otherwise. */
function onSelect(field, event)
{
	write(field.key, /** @type {HTMLSelectElement} */ (event.target).value, field);
}

const toDisplay = (cm) => Dimensioning.cmToMeasureRaw(Number(cm) || 0);
const fromDisplay = (value) => Dimensioning.cmFromMeasureRaw(value);

watch(() => props.item, readBack, {immediate: true});
watch(unit, readBack);
</script>

<template>
	<section v-if="schema" class="inspector-section">
		<h3 class="inspector-heading">{{ schema.label }}</h3>

		<p v-for="refusal in refusals" :key="refusal" class="inspector-refusal">
			{{ refusal }}
		</p>

		<div v-if="hasShared" class="field">
			<span class="field-label">Style applies to</span>
			<div class="segmented">
				<button
					v-for="option in SCOPES" :key="option.value"
					type="button" class="segment" :class="{'is-active': scope === option.value}"
					:aria-pressed="scope === option.value" @click="scope = option.value">
					{{ option.label }}
				</button>
			</div>
		</div>
		<p v-if="hasShared && scope !== 'one'" class="inspector-note">
			Styles, finishes and hardware reach {{ targets().length }} of these.
			Sizes only ever change this one.
		</p>

		<template v-for="field in visibleFields" :key="field.key">
			<NumberField
				v-if="field.type === 'length' && !field.readOnly"
				:label="field.label" :unit="unit"
				:min="field.min ? toDisplay(field.min) : undefined"
				:max="field.max ? toDisplay(field.max) : undefined"
				:step="0.1"
				:model-value="toDisplay(valueAt(field.key))"
				@update:model-value="write(field.key, fromDisplay($event), field)" />

			<div v-else-if="field.type === 'length'" class="field">
				<span class="field-label">{{ field.label }}</span>
				<!-- Read-only because it is the wall's, not the door's. A door that
				     disagrees with its wall is a bug rather than a choice. -->
				<span class="field-readonly">{{ toDisplay(valueAt(field.key)).toFixed(1) }} {{ unit }}</span>
			</div>

			<RangeField
				v-else-if="field.type === 'fraction'"
				:label="field.label" :min="field.min" :max="field.max" :step="field.step"
				:model-value="Number(valueAt(field.key)) || 0"
				@update:model-value="write(field.key, $event, field)" />

			<div v-else-if="field.type === 'choice'" class="field">
				<span class="field-label">{{ field.label }}</span>
				<select
					v-if="field.options.length > SEGMENT_LIMIT"
					class="field-input"
					:value="String(valueAt(field.key))"
					@change="onChoice(field, $event)">
					<option v-for="option in field.options" :key="option.value" :value="String(option.value)">
						{{ option.label }}
					</option>
				</select>
				<div v-else class="segmented">
					<button
						v-for="option in field.options" :key="option.value"
						type="button" class="segment"
						:class="{'is-active': valueAt(field.key) === option.value}"
						:aria-pressed="valueAt(field.key) === option.value"
						@click="write(field.key, option.value, field)">
						{{ option.label }}
					</button>
				</div>
			</div>

			<div v-else-if="field.type === 'material'" class="field">
				<span class="field-label">{{ field.label }}</span>
				<select
					class="field-input"
					:value="valueAt(field.key)"
					@pointerenter="warmSurfaces"
					@focus="warmSurfaces"
					@change="onSelect(field, $event)">
					<optgroup
						v-for="group in optionsFor(field)" :key="group.label" :label="group.label">
						<option v-for="option in group.options" :key="option.id" :value="option.id">
							{{ option.label }}
						</option>
					</optgroup>
				</select>
			</div>
		</template>
	</section>
</template>
