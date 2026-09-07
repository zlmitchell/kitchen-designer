<script setup>
// @ts-check
/**
 * A labelled dropdown over a flat list of choices.
 *
 * `SpecInspector` writes its own `<select>` rather than using this one, and
 * should keep doing so: that list is grouped into `<optgroup>`s built from the
 * material catalog. This is the ungrouped case - a short, fixed vocabulary like
 * a paint sheen - which is the one that repeats.
 */

const props = defineProps({
	label: {type: String, required: true},
	modelValue: {type: String, required: true},
	/**
	 * `{value, label}` in the order they should appear.
	 *
	 * `PropType` rather than a bare `Array`, which vue-tsc reads as `unknown[]`
	 * and then rejects every `option.value` in the template (RM-004 B3).
	 */
	options: {
		/** @type {import('vue').PropType<{value: string, label: string}[]>} */
		type: Array,
		required: true,
	},
	disabled: {type: Boolean, default: false},
});

const emit = defineEmits(['update:modelValue']);
/**
 * Read the control's value from the event, typed (RM-004 B3) - the same
 * narrowing every other field in this directory does, and for the same reason:
 * `EventTarget` declares no `value`.
 *
 * @param {Event} event
 */
function onChange(event)
{
	const select = /** @type {HTMLSelectElement} */ (event.target);
	emit('update:modelValue', select.value);
}
</script>

<template>
	<label class="field field-select">
		<span class="field-label">{{ props.label }}</span>
		<select
			class="field-input" :value="props.modelValue" :disabled="props.disabled"
			@change="onChange">
			<option v-for="option in props.options" :key="option.value" :value="option.value">
				{{ option.label }}
			</option>
		</select>
	</label>
</template>
