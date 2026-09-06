<script setup>
// @ts-check
import {computed, ref, watch} from 'vue';
import NumberField from './fields/NumberField.vue';
import RangeField from './fields/RangeField.vue';
import {Dimensioning} from '../../scripts/blueprint.js';
import {schemaForSpec} from '../../scripts/items/generated/index.js';
import {materialOptions, MATERIAL_GROUPS} from '../../scripts/core/materials.js';
import {useDisplayUnit} from '../composables/useDisplayUnit.js';

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
});

const emit = defineEmits(['changed']);

const {unit} = useDisplayUnit();

const schema = computed(() => schemaForSpec(props.item.metadata && props.item.metadata.spec));
/** @type {import('vue').Ref<Object>} */
const spec = ref({});

function readBack()
{
	spec.value = props.item.getSpec() || {};
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

function write(key, next)
{
	const edited = props.item.getSpec() || {};
	const parts = key.split('.');
	let at = edited;
	for (let i = 0; i < parts.length - 1; i++)
	{
		// A spec that never named a material has no block to write into.
		if (!at[parts[i]] || typeof at[parts[i]] !== 'object') {at[parts[i]] = {};}
		at = at[parts[i]];
	}
	at[parts[parts.length - 1]] = next;

	props.item.setSpec(edited);
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
		return Object.keys(field.when).every((key) => valueAt(key) === field.when[key]);
	});
});

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
	write(field.key, /** @type {HTMLSelectElement} */ (event.target).value);
}

const toDisplay = (cm) => Dimensioning.cmToMeasureRaw(Number(cm) || 0);
const fromDisplay = (value) => Dimensioning.cmFromMeasureRaw(value);

watch(() => props.item, readBack, {immediate: true});
watch(unit, readBack);
</script>

<template>
	<section v-if="schema" class="inspector-section">
		<h3 class="inspector-heading">{{ schema.label }}</h3>

		<template v-for="field in visibleFields" :key="field.key">
			<NumberField
				v-if="field.type === 'length' && !field.readOnly"
				:label="field.label" :unit="unit"
				:min="field.min ? toDisplay(field.min) : undefined"
				:max="field.max ? toDisplay(field.max) : undefined"
				:step="0.1"
				:model-value="toDisplay(valueAt(field.key))"
				@update:model-value="write(field.key, fromDisplay($event))" />

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
				@update:model-value="write(field.key, $event)" />

			<div v-else-if="field.type === 'choice'" class="field">
				<span class="field-label">{{ field.label }}</span>
				<div class="segmented">
					<button
						v-for="option in field.options" :key="option.value"
						type="button" class="segment"
						:class="{'is-active': valueAt(field.key) === option.value}"
						:aria-pressed="valueAt(field.key) === option.value"
						@click="write(field.key, option.value)">
						{{ option.label }}
					</button>
				</div>
			</div>

			<div v-else-if="field.type === 'material'" class="field">
				<span class="field-label">{{ field.label }}</span>
				<select
					class="field-input"
					:value="valueAt(field.key)"
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
