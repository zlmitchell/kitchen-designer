<script setup>
// @ts-check
import {onBeforeUnmount, reactive, ref, watch} from 'vue';
import NumberField from './fields/NumberField.vue';
import CheckField from './fields/CheckField.vue';
import ColorField from './fields/ColorField.vue';
import {Trash2, Copy, RotateCcw, RotateCw} from '@lucide/vue';
import {Dimensioning} from '../../scripts/blueprint.js';
import {useDisplayUnit} from '../composables/useDisplayUnit.js';

/**
 * The selected item: size, proportional coupling, lock, colours, delete.
 *
 * Sprint S7, and the one panel with a regression test attached to it by name.
 * Its dat.GUI ancestor was built against a constructor that never took the
 * item, with the binding line commented out beneath the call - so `currentItem`
 * stayed null, the panel showed a 10x10x10 placeholder, and every control it
 * offered was inert. S6 bound the item; this is the native version of the same
 * panel, and `tests/app-shell.test.js` pins that editing a field reaches the
 * item that is actually selected.
 */

const props = defineProps({
	item: {type: Object, required: true},
});

// Resizes and colour changes reach the design without touching the floorplan
// graph, so nothing the library dispatches would tell the history stack about
// them. See the note in InspectorPanel.
const emit = defineEmits(['changed', 'duplicate']);

const {unit} = useDisplayUnit();

const name = ref('');
const dimensions = reactive({width: 0, height: 0, depth: 0});
const rotation = ref(0);
const canRotate = ref(false);
/**
 * Whether there is another wall face this item could sit on.
 *
 * The answer to "there is no rotate button on the cabinets", which there is not
 * and should not be: a wall-bound item takes its facing from the wall, so a
 * rotation control would write a number the next bind discards. In a corner,
 * though, two walls are equally close and the automatic pick is a coin toss -
 * and the thing you actually want is the OTHER face, not a different angle.
 */
const canChangeWall = ref(false);
/** A generated item is sized by its spec, so scaling it is not on offer here. */
const generated = ref(false);
const flags = reactive({proportional: false, fixed: false});
// `ref([])` infers `Ref<never[]>`, so filling it is an error and reading from
// it is an error on `never` - one omission producing four (RM-004 B3).
/** @type {import('vue').Ref<Array<{index: number, label: string, color: string}>>} */
const materials = ref([]);

function readBack()
{
	name.value = props.item.metadata.itemName;
	dimensions.width = Dimensioning.cmToMeasureRaw(props.item.getWidth());
	dimensions.height = Dimensioning.cmToMeasureRaw(props.item.getHeight());
	dimensions.depth = Dimensioning.cmToMeasureRaw(props.item.getDepth());
	flags.proportional = props.item.getProportionalResize();
	flags.fixed = props.item.fixed;
	// Degrees, because nobody thinks in radians about which way a chair faces.
	// Normalised into 0..360 so dragging the handle past north does not read back
	// as -170.
	rotation.value = Math.round((((props.item.rotation.y * 180 / Math.PI) % 360) + 360) % 360);
	// Wall-bound items take their facing from the wall they are on
	// (`WallItem.changeWallEdge` overwrites rotation.y), so offering the control
	// would be offering a number the next bind discards.
	canRotate.value = Boolean(props.item.allowRotate) && !props.item.fixed;
	canChangeWall.value = Boolean(props.item.bindToNextWallEdge)
		&& !props.item.fixed
		&& props.item.nearbyWallEdges().length > 1;
	// Width/height/depth below call `Item.resize`, which SCALES the mesh. For a
	// generated item that is the wrong operation and a trap: it stretches the
	// stiles with the box, and it leaves a scale that then multiplies against the
	// next spec edit. A design carried a post drawn at 244cm whose spec said
	// 106.68 because of exactly this. SpecInspector owns size for these.
	generated.value = Boolean(props.item.metadata && props.item.metadata.spec);
}

/**
 * An item's `material` is a single material or an array of them, depending on
 * how the glTF was authored. Read once per selection: the list cannot change
 * while an item stays selected.
 */
function readMaterials()
{
	var list = Array.isArray(props.item.material) ? props.item.material : [props.item.material];
	materials.value = list.map((material, index) => ({
		index,
		label: material.name || `Material ${index + 1}`,
		color: `#${material.color.getHexString()}`,
	}));
}

/**
 * Resize, then read all three back.
 *
 * `Item.resize` may not do what it was asked: with proportional resize on it
 * scales the other two axes to match, and it ignores changes under 0.1cm. So
 * the panel writes its three numbers and then re-reads them from the item,
 * rather than assuming the edit took.
 */
function resize(axis, next)
{
	dimensions[axis] = next;
	props.item.resize(
		Dimensioning.cmFromMeasureRaw(dimensions.height),
		Dimensioning.cmFromMeasureRaw(dimensions.width),
		Dimensioning.cmFromMeasureRaw(dimensions.depth));
	readBack();
	emit('changed');
}

/**
 * Turn the item on the spot.
 *
 * There has always been a way to do this and it is easy to miss: the HUD draws a
 * drag handle when an item is selected IN THE 3D VIEW - `hud.js` - and it sits
 * at `height = 5`, five centimetres off the floor, in white. On a 107cm post in
 * a white room that is an ankle-height white arrow against a white floor.
 *
 * A number is also just better for the cases the handle is bad at: square to a
 * wall, or the same angle as the thing next to it. The handle keeps its 90-degree
 * snapping; this does not, because typing 45 should give 45.
 */
function setRotation(next)
{
	var degrees = ((Number(next) % 360) + 360) % 360;
	props.item.rotation.y = degrees * Math.PI / 180;
	rotation.value = Math.round(degrees);
	emit('changed');
}

/**
 * A quarter turn, which is what furniture actually does.
 *
 * Separate from the field rather than folded into it because they are different
 * gestures: a quarter turn is the common one and should be one click, and typing
 * 45 should give 45 rather than snapping. The drag handle in the 3D view snaps to
 * 90 degrees too (`Item.rotate`), so the button agrees with it.
 */
function nudge(degrees)
{
	// From the item, not from the field: the handle may have moved it since the
	// panel last read back, and rounding here keeps repeated clicks landing on
	// exact quarters rather than drifting off whatever angle a drag left behind.
	var current = props.item.rotation.y * 180 / Math.PI;
	setRotation(Math.round((current + degrees) / degrees) * degrees);
}

/**
 * Put this item on the next wall face that will have it.
 *
 * Cycles, because in a corner there are usually four - two walls, two sides each
 * - and naming them in a dropdown would mean naming walls, which nothing else in
 * this app does.
 */
function nextWall()
{
	if (props.item.bindToNextWallEdge())
	{
		readBack();
		emit('changed');
	}
}

function setProportional(next)
{
	flags.proportional = next;
	props.item.setProportionalResize(next);
}

function setFixed(next)
{
	flags.fixed = next;
	props.item.setFixed(next);
}

function setColor(entry, hex)
{
	props.item.setMaterialColor(hex, entry.index);
	entry.color = hex;
	emit('changed');
}

function remove()
{
	// Removing dispatches EVENT_ITEM_REMOVED, the controller drops the selection,
	// and this component unmounts. Nothing to clean up here - and no `changed`
	// either, because that event IS what the history stack listens to.
	props.item.remove();
}

watch(() => props.item, () => {readBack(); readMaterials();}, {immediate: true});
watch(unit, readBack);
onBeforeUnmount(() => {materials.value = [];});
</script>

<template>
	<section class="inspector-section">
		<h3 class="inspector-heading">{{ name }}</h3>

		<template v-if="!generated">
			<NumberField
				label="Width" :unit="unit" :min="0.1" :step="0.1" :model-value="dimensions.width"
				@update:model-value="resize('width', $event)" />
			<NumberField
				label="Height" :unit="unit" :min="0.1" :step="0.1" :model-value="dimensions.height"
				@update:model-value="resize('height', $event)" />
			<NumberField
				label="Depth" :unit="unit" :min="0.1" :step="0.1" :model-value="dimensions.depth"
				@update:model-value="resize('depth', $event)" />
		</template>

		<div v-if="canChangeWall" class="field">
			<span class="field-label">Wall</span>
			<button
				type="button" class="btn btn-outline w-full"
				title="Put this item on the next wall face - the other side, or the return wall in a corner"
				@click="nextWall">
				Move to next wall
			</button>
		</div>

		<NumberField
			v-if="canRotate" label="Rotation" unit="degrees" :min="0" :max="360" :step="15"
			:model-value="rotation" @update:model-value="setRotation" />
		<div v-if="canRotate" class="mt-1 flex gap-1.5">
			<button
				type="button" class="btn btn-outline flex-1" title="Rotate a quarter turn left"
				@click="nudge(-90)">
				<RotateCcw :size="14" /> Left
			</button>
			<button
				type="button" class="btn btn-outline flex-1" title="Rotate a quarter turn right"
				@click="nudge(90)">
				<RotateCw :size="14" /> Right
			</button>
		</div>

		<CheckField
			v-if="!generated" label="Keep proportions" :model-value="flags.proportional"
			@update:model-value="setProportional" />
		<CheckField
			label="Lock in place" :model-value="flags.fixed"
			@update:model-value="setFixed" />

		<template v-if="materials.length">
			<h4 class="inspector-subheading">Materials</h4>
			<ColorField
				v-for="entry in materials" :key="entry.index"
				:label="entry.label" :model-value="entry.color"
				@update:model-value="setColor(entry, $event)" />
		</template>

		<div class="mt-2 flex gap-1.5">
			<button type="button" class="btn btn-outline flex-1" @click="emit('duplicate')">
				<Copy :size="14" /> Duplicate
			</button>
			<button type="button" class="btn btn-outline btn-danger flex-1" @click="remove">
				<Trash2 :size="14" /> Delete
			</button>
		</div>
	</section>
</template>
