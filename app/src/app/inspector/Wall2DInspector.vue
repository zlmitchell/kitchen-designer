<script setup>
// @ts-check
import {computed, onBeforeUnmount, ref, watch} from 'vue';
import NumberField from './fields/NumberField.vue';
import {Dimensioning, WallTypes, EVENT_MOVED, Configuration, configWallHeight} from '../../scripts/blueprint.js';
import {useDisplayUnit} from '../composables/useDisplayUnit.js';

/**
 * A wall: straight or curved, and how long.
 *
 * Sprint S7, replacing the dat.GUI "Current Wall 2D" folder. The dropdown is a
 * two-button segmented control, which is one click instead of two for a choice
 * with exactly two options.
 *
 * Length is offered only for straight walls, as in the demo: a curved wall's
 * size is a property of its bezier, and setting it directly would fight the
 * control points.
 */

const props = defineProps({
	wall: {type: Object, required: true},
	floorplanner: {type: Object, default: null},
});

// Height changes reach the 3D view through the corners' own events, but the
// history stack listens for this.
const emit = defineEmits(['changed']);

const {unit} = useDisplayUnit();

const curved = ref(false);
const length = ref(0);
const height = ref(0);
const isHalf = ref(false);

/**
 * What "half" means when you first ask for it. 42in is the usual pony wall - a
 * counter-height rail you can see over - and it is what `extract.py` defaults
 * `--half-wall-height` to.
 */
const HALF_DEFAULT_CM = 106.68;

const canSetLength = computed(() => !curved.value);

function readBack()
{
	curved.value = props.wall.wallType === WallTypes.CURVED;
	length.value = Dimensioning.cmToMeasureRaw(props.wall.wallSize);
	height.value = Dimensioning.cmToMeasureRaw(props.wall.height);
	isHalf.value = props.wall.height < fullHeight() - 0.5;
}

/** The height a wall stands at unless somebody lowers it. */
function fullHeight()
{
	return Configuration.getNumericValue(configWallHeight);
}

/**
 * Stand this wall full height, or drop it to a pony wall.
 *
 * `Wall.setHeight` does the work, including splitting this wall's corners off
 * any neighbour that is staying tall - a wall takes its height from its corners
 * and a corner is shared, so without that, dropping the pony wall by the sink
 * pulls the end of the wall it runs into down with it.
 */
function setHalf(next)
{
	props.wall.setHeight(next ? HALF_DEFAULT_CM : fullHeight());
	readBack();
	redraw();
	emit('changed');
}

function setHeight(next)
{
	props.wall.setHeight(Dimensioning.cmFromMeasureRaw(next));
	readBack();
	redraw();
	emit('changed');
}

function redraw()
{
	if (props.floorplanner)
	{
		props.floorplanner.redraw();
	}
}

function setCurved(next)
{
	props.wall.wallType = next ? WallTypes.CURVED : WallTypes.STRAIGHT;
	readBack();
	redraw();
}

function setLength(next)
{
	// Zero would have produced NaN coordinates before S4 fixed the setter; it is
	// a no-op now, and the field reads back whatever the wall actually took.
	props.wall.wallSize = Dimensioning.cmFromMeasureRaw(next);
	readBack();
	redraw();
}

let attached = null;

function attach(wall)
{
	detach();
	// Dragging either end changes the length under the panel.
	attached = {wall, onMoved: () => {readBack();}};
	wall.addEventListener(EVENT_MOVED, attached.onMoved);
	readBack();
}

function detach()
{
	if (attached)
	{
		attached.wall.removeEventListener(EVENT_MOVED, attached.onMoved);
		attached = null;
	}
}

watch(() => props.wall, attach, {immediate: true});
watch(unit, readBack);
onBeforeUnmount(detach);
</script>

<template>
	<section class="inspector-section">
		<h3 class="inspector-heading">Wall</h3>

		<div class="field">
			<span class="field-label">Type</span>
			<div class="segmented">
				<button
					type="button" class="segment" :class="{'is-active': !curved}"
					:aria-pressed="!curved" @click="setCurved(false)">
					Straight
				</button>
				<button
					type="button" class="segment" :class="{'is-active': curved}"
					:aria-pressed="curved" @click="setCurved(true)">
					Curved
				</button>
			</div>
		</div>

		<NumberField
			v-if="canSetLength" label="Length" :unit="unit" :min="0"
			:model-value="length" @update:model-value="setLength" />
		<p v-else class="inspector-note">
			A curved wall is sized by dragging its bezier handles on the plan.
		</p>

		<div class="field">
			<span class="field-label">Height</span>
			<div class="segmented">
				<button
					type="button" class="segment" :class="{'is-active': !isHalf}"
					:aria-pressed="!isHalf" @click="setHalf(false)">
					Full
				</button>
				<button
					type="button" class="segment" :class="{'is-active': isHalf}"
					:aria-pressed="isHalf" @click="setHalf(true)">
					Half
				</button>
			</div>
		</div>

		<NumberField
			label="Wall height" :unit="unit" :min="0" :step="0.1"
			:model-value="height" @update:model-value="setHeight" />
		<p v-if="isHalf" class="inspector-note">
			A half wall keeps its own corners where it meets a wall that is staying
			full height, so lowering it does not pull the neighbour down.
		</p>
	</section>
</template>
