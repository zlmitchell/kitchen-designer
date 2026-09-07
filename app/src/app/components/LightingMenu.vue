<script setup>
// @ts-check
import {computed} from 'vue';
import {PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent} from 'reka-ui';
import {Lightbulb, ChevronDown, Sunrise, RotateCcw} from '@lucide/vue';

/**
 * The lighting menu: ambient fill, daylight, and exposure.
 *
 * ## Why it is in the top bar and not the inspector
 *
 * Because it belongs to the SCENE rather than to the selection. The inspector
 * answers "what is this thing", and every control here would still be the right
 * control with nothing selected at all - the same reason the render profile is a
 * viewport overlay and not a panel.
 *
 * ## The three controls are not independent, and the panel says so
 *
 * Turning the ambient fill down is what makes a placed fixture worth anything -
 * with the studio globals at full, a white floor is at or over 1.0 before a lamp
 * is switched on. But a room with the fill off and no lamps in it is black, and
 * a black viewport reads as a broken app. So the panel warns when the design has
 * been left with nothing lighting it, and the exposure control sits right there,
 * because opening the exposure is the honest fix rather than making the lamps
 * brighter than they are.
 */

const props = defineProps({
	/** 0..1. 1 is the scene as every earlier build drew it. */
	ambient: {type: Number, default: 1},
	daylight: {type: Boolean, default: false},
	/** Fractional hours. */
	hour: {type: Number, default: 16},
	heading: {type: Number, default: 0},
	exposure: {type: Number, default: 1},
	/** `HH:MM`, computed by the composable so the format lives in one place. */
	clock: {type: String, default: ''},
	/** Nothing is lighting the room. */
	dark: {type: Boolean, default: false},
	/** Whether the studio profile is on; none of this shows under classic. */
	studio: {type: Boolean, default: true},
	times: {
		/** @type {import('vue').PropType<Array<{hour: number, label: string}>>} */
		type: Array,
		default: () => [],
	},
	/** The banks this design has, which is derived from what is placed in it. */
	circuits: {
		/** @type {import('vue').PropType<Array<{id: string, label: string, count: number}>>} */
		type: Array,
		default: () => [],
	},
	/** Which of them are off. */
	switchedOff: {
		/** @type {import('vue').PropType<Array<string>>} */
		type: Array,
		default: () => [],
	},
});

const emit = defineEmits([
	'set-ambient', 'set-daylight', 'set-hour', 'set-heading', 'set-exposure', 'reset',
	'toggle-circuit', 'opened',
]);

const isOff = (id) => props.switchedOff.indexOf(id) !== -1;

/** Anything moved off its default, which is what the trigger dot reports. */
const touched = computed(() => props.ambient !== 1 || props.daylight
	|| props.exposure !== 1 || props.switchedOff.length > 0);

const number = (event) => Number(/** @type {HTMLInputElement} */ (event.target).value);
</script>

<template>
	<!--
		The circuit list is derived from what is placed, and items come and go
		without the model being reactive - so the panel asks for it as it opens,
		which is the only moment anybody looks at it.
	-->
	<PopoverRoot @update:open="(open) => open && emit('opened')">
		<!--
			No `AppTip` around this trigger, and that is not an oversight. `AppTip`
			is a `TooltipTrigger as-child`, so wrapping a `PopoverTrigger as-child`
			in one gives two components merging props onto the same single element
			and the popover's own handler does not survive it - the button renders
			and clicking it does nothing. The Export popover a few lines up has
			always used a plain `title` for the same reason; this is that pattern,
			followed rather than rediscovered.
		-->
		<PopoverTrigger as-child>
			<button type="button" class="btn gap-1 px-1.5" title="Lighting">
				<Lightbulb :size="15" :class="{'text-accent': touched}" />
				<ChevronDown :size="12" class="opacity-60" />
			</button>
		</PopoverTrigger>
		<PopoverPortal>
			<PopoverContent
				side="bottom" align="end" :side-offset="6"
				class="a3d-pop z-[600] w-72 rounded-panel border border-line bg-overlay p-2 shadow-float">
				<div class="flex items-center justify-between px-1 pb-1">
					<p class="eyebrow">Lighting</p>
					<button type="button" class="btn btn-icon" title="Back to defaults" @click="emit('reset')">
						<RotateCcw :size="13" />
					</button>
				</div>

				<!--
					Classic draws its walls with MeshBasicMaterial - they are not lit by
					anything and cannot be - so every control here would do nothing.
					Saying so beats offering a slider that has no effect.
				-->
				<p v-if="!props.studio" class="inspector-note px-1 pb-2">
					Switch the viewport to <strong>Studio</strong> to light the room.
					Classic draws its walls unlit.
				</p>

				<template v-else>
					<div class="field px-1">
						<span class="field-label">Ambient fill</span>
						<input
							type="range" min="0" max="1" step="0.05" class="w-full"
							:value="props.ambient" aria-label="Ambient fill"
							@input="emit('set-ambient', number($event))">
						<span class="num text-ink-faint">{{ Math.round(props.ambient * 100) }}%</span>
					</div>
					<p class="inspector-note px-1 pb-2">
						The sky and fill the scene has always had. Turn it down to see what
						the fixtures in the room are actually doing.
					</p>

					<div class="field px-1">
						<span class="field-label">Daylight</span>
						<div class="segmented">
							<button
								type="button" class="segment" :class="{'is-active': !props.daylight}"
								:aria-pressed="!props.daylight" @click="emit('set-daylight', false)">
								Off
							</button>
							<button
								type="button" class="segment" :class="{'is-active': props.daylight}"
								:aria-pressed="props.daylight" @click="emit('set-daylight', true)">
								<Sunrise :size="13" /> Sun
							</button>
						</div>
					</div>

					<template v-if="props.daylight">
						<div class="field px-1">
							<span class="field-label">Time of day</span>
							<input
								type="range" min="4" max="22" step="0.25" class="w-full"
								:value="props.hour" aria-label="Time of day"
								@input="emit('set-hour', number($event))">
							<span class="num text-ink-faint">{{ props.clock }}</span>
						</div>
						<div class="flex flex-wrap gap-1 px-1 pb-1">
							<button
								v-for="entry in props.times" :key="entry.hour"
								type="button" class="btn px-1.5 py-0.5 text-[11px]"
								:class="{'is-active': Math.abs(props.hour - entry.hour) < 0.13}"
								@click="emit('set-hour', entry.hour)">
								{{ entry.label }}
							</button>
						</div>
						<div class="field px-1">
							<span class="field-label">Facing</span>
							<input
								type="range" min="0" max="359" step="5" class="w-full"
								:value="props.heading" aria-label="Which way the building faces"
								@input="emit('set-heading', number($event))">
							<span class="num text-ink-faint">{{ Math.round(props.heading) }}&deg;</span>
						</div>
						<p class="inspector-note px-1 pb-2">
							Turns the building under the sun, so the light comes in through a
							different wall's windows.
						</p>
					</template>

					<!--
						Switches, above the exposure because this is the control somebody
						walking the house reaches for. One row per bank the design actually
						has: no lights, no switches, rather than four dead toggles.
					-->
					<template v-if="props.circuits.length">
						<p class="eyebrow px-1 pt-2">Switches</p>
						<div v-for="circuit in props.circuits" :key="circuit.id" class="field px-1">
							<span class="field-label">{{ circuit.label }}</span>
							<button
								type="button" class="btn w-full justify-between"
								:aria-pressed="!isOff(circuit.id)"
								@click="emit('toggle-circuit', circuit.id)">
								<span>{{ isOff(circuit.id) ? 'Off' : 'On' }}</span>
								<span class="num text-ink-faint">{{ circuit.count }}</span>
							</button>
						</div>
					</template>

					<div class="field px-1">
						<span class="field-label">Exposure</span>
						<input
							type="range" min="0.25" max="4" step="0.05" class="w-full"
							:value="props.exposure" aria-label="Exposure"
							@input="emit('set-exposure', number($event))">
						<span class="num text-ink-faint">{{ props.exposure.toFixed(2) }}&times;</span>
					</div>

					<p v-if="props.dark" class="inspector-refusal mx-1 mt-1">
						Nothing is lighting this room. Add a fixture, raise the ambient fill,
						or turn the sun back on.
					</p>
				</template>
			</PopoverContent>
		</PopoverPortal>
	</PopoverRoot>
</template>
