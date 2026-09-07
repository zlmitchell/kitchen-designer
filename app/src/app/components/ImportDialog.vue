<script setup>
// @ts-check
import {computed, ref} from 'vue';
import {
	DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle,
	DialogDescription, DialogClose,
} from 'reka-ui';
import {X, FileUp, Crop, Layers, TriangleAlert, Check} from '@lucide/vue';

import {ACCEPT, PLOT_SCALES} from '../composables/useImport.js';

/**
 * The legend's colours, and the only thing the dialog takes from `import/`.
 *
 * A literal rather than an import from `import/raster.js`, which would drag
 * the whole raster module - and the readers it pulls with it - into the eager
 * bundle for four strings. They are asserted against the module in
 * `tests/import-dialog.test.js`, so the copy cannot drift.
 */
const OPENING_COLOURS = {
	window: 'rgb(26, 89, 242)',
	door: 'rgb(217, 26, 179)',
	cased: 'rgb(242, 153, 13)',
	unknown: 'rgb(115, 115, 115)',
};

/**
 * Import a PDF, SVG or DXF as a floor plan.
 *
 * Three things have to be settled before a drawing can be traced, and this is
 * the interface for exactly those three:
 *
 *   which page    A set of construction documents is many sheets and only one
 *                 of them is the floor plan.
 *   which region  A sheet carries a title block, a schedule and often several
 *                 plans. The tracer decides which PEN drew the structure by
 *                 judging everything in the region, so handing it the whole
 *                 sheet makes the dimension strings compete with the walls.
 *   what scale    Nothing detects a wrong one: a plan traced at half scale is
 *                 a perfectly consistent plan of a house half the size. A DXF
 *                 states its own units and is not asked.
 *
 * The result is shown BEFORE it is applied, and the number that matters is the
 * overall size in feet - a wrong scale is invisible in a wall count and
 * obvious in "39 x 29 ft".
 */

const props = defineProps({
	open: {type: Boolean, default: false},
	/** The store returned by useImport(). */
	state: {type: Object, required: true},
});

const emit = defineEmits(['update:open', 'apply']);

/**
 * The <img> the region is dragged on.
 *
 * @type {import('vue').Ref<?HTMLImageElement>}
 */
const surface = ref(null);
/**
 * The drag in progress, in element pixels.
 *
 * @typedef {{x0: number, y0: number, x1: number, y1: number}} Box
 * @type {import('vue').Ref<?Box>}
 */
const drag = ref(null);

const state = computed(() => props.state);
const stats = computed(() => (state.value.result.value ? state.value.result.value.stats : null));

/** Points per element pixel, so a drag can be turned into page points. */
function pointsPerPixel()
{
	const size = state.value.pageSize.value;
	const element = surface.value;
	if (!size || !element)
	{
		return 1;
	}
	return size.width / element.getBoundingClientRect().width;
}

/** The chosen region drawn back over the preview, in element pixels. */
const boxStyle = computed(() =>
{
	if (drag.value)
	{
		const [x0, y0, x1, y1] = normalise(drag.value);
		return {left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px`};
	}
	const clip = state.value.clip.value;
	if (!clip)
	{
		return null;
	}
	const per = pointsPerPixel();
	return {
		left: `${clip[0] / per}px`,
		top: `${clip[1] / per}px`,
		width: `${(clip[2] - clip[0]) / per}px`,
		height: `${(clip[3] - clip[1]) / per}px`,
	};
});

/**
 * @param {Box} box
 * @returns {number[]}
 */
function normalise(box)
{
	return [
		Math.min(box.x0, box.x1), Math.min(box.y0, box.y1),
		Math.max(box.x0, box.x1), Math.max(box.y0, box.y1),
	];
}

/**
 * Where the pointer is inside the image, clamped to it - a drag that leaves
 * the picture still means the edge of the picture.
 *
 * @param {PointerEvent} event
 */
function pointerAt(event)
{
	const element = surface.value;
	if (!element)
	{
		return {x: 0, y: 0};
	}
	const bounds = element.getBoundingClientRect();
	return {
		x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
		y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
	};
}

/** @param {PointerEvent} event */
function onPointerDown(event)
{
	if (!surface.value)
	{
		return;
	}
	const at = pointerAt(event);
	drag.value = {x0: at.x, y0: at.y, x1: at.x, y1: at.y};
	// Captured so a drag that leaves the image still finishes, which is the
	// normal case when the plan runs to the edge of the sheet.
	const target = /** @type {HTMLElement} */ (event.currentTarget);
	target.setPointerCapture(event.pointerId);
}

/** @param {PointerEvent} event */
function onPointerMove(event)
{
	if (!drag.value)
	{
		return;
	}
	const at = pointerAt(event);
	drag.value = {...drag.value, x1: at.x, y1: at.y};
}

function onPointerUp()
{
	if (!drag.value)
	{
		return;
	}
	const [x0, y0, x1, y1] = normalise(drag.value);
	drag.value = null;
	// A click rather than a drag clears the region back to the whole page,
	// which is what a click on a picture with a box on it should do.
	if (x1 - x0 < 8 || y1 - y0 < 8)
	{
		state.value.setClip(null);
		return;
	}
	const per = pointsPerPixel();
	state.value.setClip([x0 * per, y0 * per, x1 * per, y1 * per]);
}

/** @param {Event} event */
function onFile(event)
{
	const input = /** @type {HTMLInputElement} */ (event.target);
	if (input.files && input.files.length)
	{
		state.value.pick(input.files[0]);
	}
	input.value = '';
}

/** @param {Event} event */
function onScale(event)
{
	state.value.scale.value = Number(/** @type {HTMLSelectElement} */ (event.target).value);
}

/** @param {Event} event */
function onCeiling(event)
{
	const inches = Number(/** @type {HTMLInputElement} */ (event.target).value);
	if (Number.isFinite(inches) && inches > 0)
	{
		state.value.ceiling.value = inches;
	}
}

/** @param {Event} event */
function onLayer(event)
{
	state.value.layer.value = /** @type {HTMLSelectElement} */ (event.target).value || null;
}

/**
 * The doors checkbox. Written as a handler rather than inline in the template
 * because `$event.target` is an EventTarget there, which declares no `checked`.
 *
 * @param {Event} event
 */
function onOpenDoors(event)
{
	state.value.openDoors.value = /** @type {HTMLInputElement} */ (event.target).checked;
}

function apply()
{
	emit('apply', state.value.result.value);
}

/**
 * A length in feet and inches, the way the rest of this app reads.
 *
 * @param {number} value
 */
function feet(value)
{
	const whole = Math.floor(value);
	const inches = Math.round((value - whole) * 12);
	return inches === 12 ? `${whole + 1}'` : `${whole}' ${inches}"`;
}

/** @param {{colour: ?string, fill: ?string}} layer */
function pen(layer)
{
	return layer.colour || layer.fill || '#888888';
}
</script>

<template>
	<DialogRoot :open="props.open" @update:open="emit('update:open', $event)">
		<DialogPortal>
			<DialogOverlay class="a3d-fade fixed inset-0 z-[550] bg-black/50 backdrop-blur-[2px]" />
			<DialogContent
				class="a3d-pop fixed left-1/2 top-1/2 z-[560] flex max-h-[86vh] w-[960px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-panel border border-line bg-surface shadow-float focus:outline-none">
				<div class="flex flex-none items-start gap-2 border-b border-line px-4 py-3">
					<div>
						<DialogTitle class="text-[14px] font-semibold">Import a floor plan</DialogTitle>
						<DialogDescription class="text-ink-faint">
							A PDF, SVG or DXF. Draw a box around the plan, set its scale, and the
							walls, doors and windows are traced from the drawing.
						</DialogDescription>
					</div>
					<DialogClose as-child>
						<button type="button" class="btn btn-icon ml-auto" aria-label="Close">
							<X :size="15" />
						</button>
					</DialogClose>
				</div>

				<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
					<!-- 1. the file -->
					<div class="flex flex-wrap items-center gap-2">
						<label class="btn gap-1.5 btn-file">
							<FileUp :size="15" />
							{{ state.sheet.value ? 'Choose another file' : 'Choose a drawing' }}
							<input type="file" :accept="ACCEPT" aria-label="Choose a drawing" @change="onFile">
						</label>
						<span v-if="state.filename.value" class="num truncate text-[12px] text-ink-soft">
							{{ state.filename.value }}
							<span v-if="state.sheet.value" class="text-ink-faint">
								· {{ state.sheet.value.kind.toUpperCase() }}
								· {{ state.sheet.value.pages.length }} page{{ state.sheet.value.pages.length === 1 ? '' : 's' }}
							</span>
						</span>
					</div>

					<!-- what is happening, and how far through it is -->
					<div v-if="state.progress.value" class="flex flex-none flex-col gap-1">
						<div class="flex items-baseline justify-between text-[12px]">
							<span class="text-ink-soft">{{ state.progress.value.label }}</span>
							<span class="num text-ink-faint">{{ Math.round(state.progress.value.value * 100) }}%</span>
						</div>
						<div class="h-1.5 overflow-hidden rounded-full bg-ground">
							<div
								class="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
								:style="{width: `${Math.max(2, state.progress.value.value * 100)}%`}" />
						</div>
					</div>

					<p
						v-if="state.error.value"
						class="flex items-start gap-2 rounded-panel border border-line bg-ground px-3 py-2 text-[12px] text-ink-soft">
						<TriangleAlert :size="15" class="mt-px flex-none text-amber-500" />
						{{ state.error.value }}
					</p>

					<template v-if="state.sheet.value">
						<!-- 2. the page -->
						<div v-if="state.thumbnails.value.length > 1" class="flex flex-none flex-col gap-1">
							<div class="flex gap-2 overflow-x-auto pb-1">
								<button
									v-for="thumb in state.thumbnails.value" :key="thumb.number"
									type="button"
									class="flex flex-none flex-col items-center gap-1 rounded-panel border p-1 text-[11px]"
									:class="thumb.number === state.page.value
										? 'border-accent text-ink' : 'border-line text-ink-faint hover:border-ink-faint'"
									:aria-pressed="thumb.number === state.page.value"
									@click="state.showPage(thumb.number)">
									<!-- Every page is pickable from the moment the file opens. The
									     picture arrives when it has been drawn; see startThumbnails. -->
									<img
										v-if="thumb.url" :src="thumb.url" :alt="`Page ${thumb.number}`"
										class="h-20 w-auto bg-white object-contain">
									<span v-else class="grid h-20 w-16 place-items-center bg-ground text-ink-faint">…</span>
									<span>{{ thumb.number }}</span>
								</button>
							</div>
							<p v-if="state.thumbnailsLeft.value" class="text-[11px] text-ink-faint">
								Drawing page previews — {{ state.thumbnailsLeft.value }} to go. You can
								pick a page and draw a box now; this only fills in the pictures.
							</p>
						</div>

						<!-- 3. the region -->
						<div class="flex min-h-0 flex-col gap-2 lg:flex-row">
							<div class="relative min-h-0 flex-1 overflow-hidden rounded-panel border border-line bg-white">
								<img
									v-if="state.preview.value"
									ref="surface"
									:src="state.preview.value.url"
									alt="The page being imported"
									draggable="false"
									class="block w-full cursor-crosshair select-none"
									@pointerdown="onPointerDown"
									@pointermove="onPointerMove"
									@pointerup="onPointerUp"
									@pointercancel="onPointerUp">
								<div
									v-if="boxStyle"
									class="pointer-events-none absolute border-2 border-accent bg-accent/10"
									:style="boxStyle" />
								<p
									v-if="!state.clip.value && !drag"
									class="pointer-events-none absolute inset-x-0 bottom-0 bg-black/55 px-2 py-1 text-center text-[11px] text-white">
									Drag a box around the floor plan. Without one the whole page is traced.
								</p>
							</div>

							<!-- 4. the settings -->
							<div class="flex w-full flex-none flex-col gap-3 lg:w-64">
								<div>
									<p class="eyebrow mb-1">Drawing scale</p>
									<select
										v-if="!state.scaleIsKnown.value"
										class="field-input num h-7 w-full text-left"
										:value="state.scale.value" aria-label="Drawing scale" @change="onScale">
										<option v-for="entry in PLOT_SCALES" :key="entry.label" :value="entry.value">
											{{ entry.label }}
										</option>
									</select>
									<p v-else class="text-[12px] text-ink-soft">
										<Check :size="13" class="inline text-emerald-500" />
										Read from the file: {{ state.scale.value.toFixed(4) }} in per unit.
									</p>
								</div>

								<div>
									<p class="eyebrow mb-1">Ceiling height</p>
									<div class="flex items-center gap-1.5">
										<input
											type="number" min="60" max="240" step="1"
											class="field-input num h-7 w-20" aria-label="Ceiling height in inches"
											:value="state.ceiling.value" @change="onCeiling">
										<span class="text-[12px] text-ink-faint">inches</span>
									</div>
								</div>

								<label class="flex items-center gap-2 text-[12px] text-ink-soft">
									<input
										type="checkbox" :checked="state.openDoors.value"
										@change="onOpenDoors">
									Draw interior doors open
								</label>

								<div>
									<div class="mb-1 flex items-center justify-between">
										<p class="eyebrow">Structure layer</p>
										<button
											type="button" class="btn h-6 gap-1 px-1.5 text-[11px]"
											:disabled="state.busy.value" @click="state.inspectLayers()">
											<Layers :size="12" /> Show pens
										</button>
									</div>
									<select
										v-if="state.layers.value.length"
										class="field-input num h-7 w-full text-left"
										:value="state.layer.value || ''" aria-label="Structure layer" @change="onLayer">
										<option value="">Best match (automatic)</option>
										<option v-for="entry in state.layers.value" :key="entry.key" :value="entry.key">
											{{ entry.key }} — {{ entry.segments }} segs
										</option>
									</select>
									<p v-else class="text-[11px] text-ink-faint">
										The tracer picks the pen that looks most like structure. If it picks
										wrong, list the pens and choose one.
									</p>
									<ul v-if="state.layers.value.length" class="mt-1.5 flex flex-col gap-0.5">
										<li
											v-for="entry in state.layers.value.slice(0, 5)" :key="`swatch-${entry.key}`"
											class="flex items-center gap-1.5 text-[11px] text-ink-faint">
											<span
												class="h-2.5 w-2.5 flex-none rounded-sm border border-line"
												:style="{background: pen(entry)}" />
											<span class="num truncate">{{ entry.key }}</span>
										</li>
									</ul>
								</div>

								<button
									type="button" class="btn btn-primary mt-auto w-full justify-center gap-1.5"
									:disabled="state.busy.value || !state.region.value"
									@click="state.run()">
									<Crop :size="15" />
									{{ state.result.value ? 'Trace again' : 'Trace the plan' }}
								</button>
							</div>
						</div>

						<!-- 5. what it found, drawn over what was there -->
						<div v-if="state.check.value" class="flex flex-col gap-1.5">
							<div class="flex flex-wrap items-center gap-x-4 gap-y-1">
								<p class="eyebrow">Check the trace</p>
								<span class="flex items-center gap-1 text-[11px] text-ink-faint">
									<span class="h-2.5 w-3.5 rounded-sm border" style="background: rgba(255,0,0,.35); border-color: rgb(255,0,0)" />
									walls
								</span>
								<span
									v-for="(colour, kind) in OPENING_COLOURS" :key="kind"
									class="flex items-center gap-1 text-[11px] text-ink-faint">
									<span class="h-2.5 w-3.5 rounded-sm border" :style="{background: colour, borderColor: colour}" />
									{{ kind }}
								</span>
							</div>
							<div class="overflow-auto rounded-panel border border-line bg-white">
								<img
									:src="state.check.value.url"
									alt="The traced walls and openings drawn over the drawing"
									class="block w-full">
							</div>
							<p class="text-[11px] text-ink-faint">
								Every red box is a wall this will create, and every coloured bar an
								opening. A wall in the wrong place shows here and in no number above.
							</p>
						</div>

						<div v-if="stats" class="flex flex-col gap-2 rounded-panel border border-line bg-ground p-3">
							<div class="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12px]">
								<span class="font-semibold">{{ feet(stats.widthFt) }} × {{ feet(stats.heightFt) }}</span>
								<span class="text-ink-soft">{{ stats.walls }} walls</span>
								<span class="text-ink-soft">
									{{ stats.openingCount }} opening{{ stats.openingCount === 1 ? '' : 's' }}
									<span v-if="stats.openingCount" class="text-ink-faint">
										({{ Object.entries(stats.openings).map(([k, n]) => `${n} ${k}`).join(', ') }})
									</span>
								</span>
								<span class="num text-ink-faint">
									walls {{ stats.thicknesses.map((t) => `${t}"`).join(', ') }}
								</span>
								<span class="num text-ink-faint">pen {{ stats.layer }}</span>
							</div>
							<p v-if="stats.dangling" class="text-[11px] text-ink-faint">
								{{ stats.dangling }} wall end{{ stats.dangling === 1 ? '' : 's' }} meets nothing.
								Rooms only close around a complete loop, so some may be missing.
							</p>
							<p class="text-[11px] text-ink-faint">
								Check the overall size against the drawing before you replace your layout —
								that is the one number a wrong scale always gets wrong.
							</p>
						</div>
					</template>
				</div>

				<div class="flex flex-none items-center gap-2 border-t border-line px-4 py-2.5">
					<p class="text-[11px] text-ink-faint">
						Importing replaces the current layout. The drawing is placed underneath as a
						backdrop to trace over.
					</p>
					<DialogClose as-child>
						<button type="button" class="btn ml-auto">Cancel</button>
					</DialogClose>
					<button
						type="button" class="btn btn-primary gap-1.5"
						:disabled="!state.result.value || state.busy.value"
						@click="apply">
						<Check :size="15" /> Use this plan
					</button>
				</div>
			</DialogContent>
		</DialogPortal>
	</DialogRoot>
</template>
