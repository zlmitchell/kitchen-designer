// @vitest-environment jsdom
/**
 * The splash that covers the load.
 *
 * The application is over a megabyte of JavaScript and ~64 models before there
 * is anything to look at, and until this existed the whole of that wait was a
 * blank page. Two pieces, tested here in that order: `boot-screen.js`, which
 * owns the element `index.html` ships, and `useBootScreen`, which decides what
 * it says and when it is allowed to leave.
 *
 * The markup is rebuilt here rather than parsed out of index.html. What the two
 * files share is four ids and a class name, and a test that reads the real page
 * would pass just as happily with the CSS deleted - so the ids are the contract
 * worth pinning, and `tests/asset-integrity.test.js` is where the page itself
 * is checked.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {effectScope, shallowRef} from 'vue';
import {BufferGeometry, MeshBasicMaterial} from 'three';

import {createBootScreen, DEADLINE_MS} from '../src/app/boot-screen.js';
import {useBootScreen, QUIET_MS} from '../src/app/composables/useBootScreen.js';
import {Model} from '../src/scripts/model/model.js';
import {textureLoadingManager} from '../src/scripts/core/texture_cache.js';
import {resetAll} from './helpers/harness.js';
import {installCanvas2D} from './helpers/dom.js';

/** The element index.html ships, minus the styling. */
function buildSplash()
{
	document.body.innerHTML = `
		<div id="boot">
			<div class="boot-track is-waiting" id="boot-track"><div class="boot-fill" id="boot-fill"></div></div>
			<p class="boot-status" id="boot-status">Loading the application</p>
		</div>`;
	return document.getElementById('boot');
}

function status()
{
	const line = document.getElementById('boot-status');
	return line ? line.textContent : null;
}

/** A loader that hands back deferred resolvers instead of loading. */
function deferredLoader()
{
	const pending = [];
	return {
		pending,
		loader: (fileName, metadata, onLoad) =>
		{
			pending.push(() => onLoad(new BufferGeometry().setFromPoints([]), new MeshBasicMaterial()));
		},
	};
}

function design(count)
{
	const items = [];
	for (let index = 0; index < count; index++)
	{
		items.push({
			item_name: `item${index}`, item_type: 1, model_url: `item${index}.glb`, format: 'gltf',
			xpos: index * 50, ypos: 0, zpos: 0, rotation: 0,
			scale_x: 1, scale_y: 1, scale_z: 1, fixed: false,
		});
	}
	return JSON.stringify({
		floorplan: {
			corners: {
				c1: {x: 0, y: 0, elevation: 0}, c2: {x: 400, y: 0, elevation: 0},
				c3: {x: 400, y: 400, elevation: 0}, c4: {x: 0, y: 400, elevation: 0},
			},
			walls: [
				{corner1: 'c1', corner2: 'c2'}, {corner1: 'c2', corner2: 'c3'},
				{corner1: 'c3', corner2: 'c4'}, {corner1: 'c4', corner2: 'c1'},
			],
			rooms: {}, units: 'cm', version: '2.0.0',
		},
		items: items,
	});
}

beforeEach(() =>
{
	resetAll();
	document.body.innerHTML = '';
});

afterEach(() =>
{
	document.body.innerHTML = '';
});

describe('the splash element', () =>
{
	beforeEach(() => {vi.useFakeTimers();});
	afterEach(() => {vi.useRealTimers();});

	it('writes the stage onto the status line', () =>
	{
		const screen = createBootScreen(buildSplash());

		screen.stage('Preparing the workspace');

		expect(status()).toBe('Preparing the workspace');
	});

	it('fills the bar in proportion, and stops sweeping once it can', () =>
	{
		const screen = createBootScreen(buildSplash());
		const track = document.getElementById('boot-track');
		const fill = document.getElementById('boot-fill');

		screen.progress(16, 64);

		expect(track.classList.contains('is-waiting')).toBe(false);
		expect(fill.style.width).toBe('25%');
	});

	it('keeps sweeping while the denominator is unknown', () =>
	{
		// A bar pinned at 0% for two seconds reads as a hang; a moving one reads
		// as work. Nothing knows how many models a design has until it is parsed.
		const screen = createBootScreen(buildSplash());
		const track = document.getElementById('boot-track');

		screen.progress(0, 0);

		expect(track.classList.contains('is-waiting')).toBe(true);
		expect(document.getElementById('boot-fill').style.width).toBe('');
	});

	it('fades, then takes itself out of the document', () =>
	{
		const root = buildSplash();
		const screen = createBootScreen(root);

		screen.done();

		// The class first - the element has to still be there to fade.
		expect(root.classList.contains('is-done')).toBe(true);
		expect(document.getElementById('boot')).toBe(root);

		vi.runAllTimers();

		// And gone: a fixed overlay left in the page hit-tests every pointer
		// event for the life of the session.
		expect(document.getElementById('boot')).toBeNull();
		expect(screen.finished).toBe(true);
	});

	it('says nothing more once it is done', () =>
	{
		const screen = createBootScreen(buildSplash());
		screen.stage('Loading the kitchen - 3 of 64');

		screen.done();
		screen.stage('Preparing the workspace');

		expect(status()).toBe('Loading the kitchen - 3 of 64');
	});

	it('leaves on the deadline even when nothing ever finishes', () =>
	{
		// A stalled request neither succeeds nor errors, so no count balances it.
		// Without this the splash covers the application forever, and there is no
		// interface behind it to reach.
		const screen = createBootScreen(buildSplash());

		vi.advanceTimersByTime(DEADLINE_MS);
		vi.runAllTimers();

		expect(document.getElementById('boot')).toBeNull();
		expect(screen.finished).toBe(true);
	});

	it('is a no-op where there is no splash at all', () =>
	{
		// Every test that mounts App.vue, and every embedder rendering the
		// application into a page of their own.
		const screen = createBootScreen(null);

		screen.stage('Ready');
		screen.progress(1, 2);
		screen.done();

		expect(screen.finished).toBe(true);
	});
});


describe('useBootScreen', () =>
{
	let scope;
	let store;
	let model;
	let deferred;
	// An item builds a label texture on construction, and jsdom has no 2D
	// context to build it into. Every suite that loads furniture installs this.
	let canvasStub;

	function run(fn)
	{
		let value;
		scope.run(() => {value = fn();});
		return value;
	}

	/** Attach to a blueprint the way the store does when App.vue mounts it. */
	function mount()
	{
		store.instance.value = {model};
	}

	/** The manager three's model loaders report through, for this document. */
	function fileQueue()
	{
		return model.scene.loadingManager;
	}

	/** `23 of 41` out of whatever the status line currently says. */
	function counts()
	{
		const found = /(\d+) of (\d+)/.exec(status() || '');
		return found ? {loaded: Number(found[1]), total: Number(found[2])} : null;
	}

	beforeEach(() =>
	{
		vi.useFakeTimers();
		canvasStub = installCanvas2D(window);
		buildSplash();
		scope = effectScope();
		store = {instance: shallowRef(null)};
		model = new Model('');
		deferred = deferredLoader();
		model.scene.setItemLoader(deferred.loader);
	});

	afterEach(() =>
	{
		scope.stop();
		canvasStub.restore();
		vi.useRealTimers();
	});

	it('counts files, not items - most of this kitchen is generated', () =>
	{
		// 63 of the 64 items in the real plan are `generated:*` and download
		// nothing at all, which is what made an item count useless as a bar.
		run(() => useBootScreen(store));
		mount();

		fileQueue().itemStart('cabinet.glb');
		fileQueue().itemStart('fan.gltf');
		fileQueue().itemEnd('cabinet.glb');

		expect(status()).toBe('Loading the kitchen - 1 of 2 files');
		expect(document.getElementById('boot-fill').style.width).toBe('50%');
	});

	it('adds the textures to the same count as the models', () =>
	{
		// Two managers: models come through the scene's, and every texture -
		// including the maps behind a generated cabinet - through the page's.
		// A bar that watched only the first would ignore most of this design.
		run(() => useBootScreen(store));
		mount();

		fileQueue().itemStart('cabinet.glb');
		const before = counts();

		textureLoadingManager.itemStart('oak.png');
		textureLoadingManager.itemEnd('oak.png');

		const after = counts();
		expect(after.total - before.total).toBe(1);
		expect(after.loaded - before.loaded).toBe(1);
	});

	it('never lets the bar retreat when more files are discovered', () =>
	{
		// A .glb names its own textures, so the denominator grows as the load
		// finds work. The count stays honest; the bar does not go backwards.
		run(() => useBootScreen(store));
		mount();

		fileQueue().itemStart('a.glb');
		fileQueue().itemStart('b.glb');
		fileQueue().itemEnd('a.glb');
		expect(document.getElementById('boot-fill').style.width).toBe('50%');

		['c', 'd', 'e', 'f', 'g', 'h'].forEach((name) => fileQueue().itemStart(`${name}.png`));
		fileQueue().itemEnd('b.glb');

		expect(status()).toBe('Loading the kitchen - 2 of 8 files');
		expect(document.getElementById('boot-fill').style.width).toBe('50%');
	});

	it('sweeps rather than sitting at zero before anything has landed', () =>
	{
		run(() => useBootScreen(store));
		mount();

		fileQueue().itemStart('a.glb');

		expect(status()).toBe('Loading the kitchen - 0 of 1 files');
		expect(document.getElementById('boot-track').classList.contains('is-waiting')).toBe(true);
	});

	it('falls back to the items while no file has been asked for', () =>
	{
		// A design of nothing but generated cabinets fetches no model at all. The
		// items are then the only measure there is, and they beat a dead bar.
		run(() => useBootScreen(store));
		mount();

		model.loadSerialized(design(4));
		deferred.pending[0]();
		deferred.pending[1]();

		expect(status()).toBe('Building the kitchen - 2 of 4');
	});

	it('stays up until the last file has landed', () =>
	{
		const boot = run(() => useBootScreen(store));
		mount();
		model.loadSerialized(design(1));

		// Everything the document asked for is built, and the design is framed -
		// but a texture is still on the wire.
		deferred.pending[0]();
		fileQueue().itemStart('oak.ktx2');
		boot.ready();
		vi.advanceTimersByTime(QUIET_MS * 2);
		expect(boot.screen.finished).toBe(false);

		fileQueue().itemEnd('oak.ktx2');
		vi.advanceTimersByTime(QUIET_MS);

		expect(boot.screen.finished).toBe(true);
		expect(status()).toBe('Ready');
	});

	it('waits a beat, in case one more file is about to start', () =>
	{
		// The three conditions can all hold one tick before an item's material
		// asks for its first texture.
		const boot = run(() => useBootScreen(store));
		mount();
		model.loadSerialized(design(1));
		deferred.pending[0]();

		boot.ready();
		expect(boot.screen.finished).toBe(false);

		fileQueue().itemStart('oak.ktx2');
		vi.advanceTimersByTime(QUIET_MS);

		expect(boot.screen.finished).toBe(false);
	});

	it('leaves as soon as the design is framed when it has no furniture', () =>
	{
		// Walls only - the default design, and any plan traced before anything was
		// placed in it.
		const boot = run(() => useBootScreen(store));
		mount();
		model.loadSerialized(design(0));

		boot.ready();
		vi.advanceTimersByTime(QUIET_MS);

		expect(document.getElementById('boot').classList.contains('is-done')).toBe(true);
	});

	it('does not leave on the files alone, before the design is framed', () =>
	{
		const boot = run(() => useBootScreen(store));
		mount();
		model.loadSerialized(design(1));

		deferred.pending[0]();
		vi.advanceTimersByTime(QUIET_MS * 4);

		expect(boot.screen.finished).toBe(false);
	});

	it('gives the loading managers their own handlers back', () =>
	{
		// The texture manager belongs to the whole page, and `onProgress` is one
		// slot on it. A boot screen may borrow it; it may not keep it, and it may
		// not silence whoever was there first.
		const theirs = vi.fn();
		textureLoadingManager.onProgress = theirs;

		run(() => useBootScreen(store));
		mount();
		textureLoadingManager.itemStart('oak.png');
		textureLoadingManager.itemEnd('oak.png');
		expect(theirs).toHaveBeenCalled();

		scope.stop();

		expect(textureLoadingManager.onProgress).toBe(theirs);
		textureLoadingManager.onProgress = undefined;
	});

	it('uncovers the page if the application is torn down mid-boot', () =>
	{
		run(() => useBootScreen(store));
		mount();
		model.loadSerialized(design(2));

		scope.stop();

		expect(document.getElementById('boot').classList.contains('is-done')).toBe(true);
	});

	it('stops counting once the splash is gone', () =>
	{
		// A session's own furniture loads on the same events and through the same
		// managers. Nothing should still be counting them into a screen that left.
		const boot = run(() => useBootScreen(store));
		mount();
		model.loadSerialized(design(1));
		deferred.pending[0]();
		boot.ready();
		vi.advanceTimersByTime(QUIET_MS);

		model.loadSerialized(design(2));
		fileQueue().itemStart('later.glb');

		expect(status()).toBe('Ready');
	});
});
