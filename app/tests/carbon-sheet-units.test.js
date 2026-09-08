// @vitest-environment jsdom
/**
 * The carbon sheet's size, and the unit it is written in.
 *
 * A saved floorplan declares `units: "cm"` and every coordinate in it obeys
 * that - except the carbon sheet, whose `width` and `height` go through
 * `Dimensioning.cmFromMeasureRaw` and are therefore in whatever unit was on
 * SCREEN when somebody saved. A plan exported while the ruler said feet came
 * back 3.28 times too big in an app that opens in metres, drawn far enough
 * outside the walls to look like a different drawing over them.
 *
 * So the file gained a pair that says centimetres and means it. These are the
 * assertions that keep the two apart.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';

import {Floorplan} from '../src/scripts/model/floorplan.js';
import {CarbonSheet} from '../src/scripts/floorplanner/carbonsheet.js';
import {Configuration, configDimUnit} from '../src/scripts/core/configuration.js';
import {dimMeter, dimFeetAndInch, dimCentiMeter} from '../src/scripts/core/units.js';
import {installCanvas2D} from './helpers/dom.js';

installCanvas2D(window);

/** A sheet with a canvas under it, and nothing else it needs. */
function sheetOn(floorplan)
{
	const canvas = document.createElement('canvas');
	canvas.id = 'carbon-sheet-under-test';
	document.body.appendChild(canvas);
	return new CarbonSheet(floorplan, {}, canvas);
}

describe('a carbon sheet holds centimetres and shows the display unit', () =>
{
	let floorplan;
	let sheet;

	beforeEach(() =>
	{
		Configuration.setValue(configDimUnit, dimMeter);
		floorplan = new Floorplan();
		sheet = sheetOn(floorplan);
		// Off, or setting one dimension recomputes the other from the image's
		// aspect ratio - and there is no image here.
		sheet.maintainProportion = false;
	});

	afterEach(() =>
	{
		Configuration.setValue(configDimUnit, dimCentiMeter);
		document.body.innerHTML = '';
	});

	it('reads back the centimetres it was given, whatever the ruler says', () =>
	{
		sheet.widthCm = 1591.733;
		expect(sheet.widthCm).toBeCloseTo(1591.733, 2);
		Configuration.setValue(configDimUnit, dimFeetAndInch);
		expect(sheet.widthCm).toBeCloseTo(1591.733, 2);
	});

	it('shows that same size in whatever unit is on screen', () =>
	{
		sheet.widthCm = 1591.733;
		expect(sheet.width).toBeCloseTo(15.917, 2);
		Configuration.setValue(configDimUnit, dimFeetAndInch);
		expect(sheet.width).toBeCloseTo(52.222, 2);
	});

	it('takes a typed width in the unit it is being typed in', () =>
	{
		// The other direction, and the reason `width` exists at all: a number in a
		// panel is in the unit beside the panel.
		Configuration.setValue(configDimUnit, dimFeetAndInch);
		sheet.width = 52.222305;
		expect(sheet.widthCm).toBeCloseTo(1591.733, 1);
	});
});

describe('a saved floorplan writes the sheet in centimetres', () =>
{
	let floorplan;
	let sheet;

	beforeEach(() =>
	{
		Configuration.setValue(configDimUnit, dimFeetAndInch);
		floorplan = new Floorplan();
		sheet = sheetOn(floorplan);
		floorplan.carbonSheet = sheet;
		sheet.maintainProportion = false;
		sheet.widthCm = 1591.733;
		sheet.heightCm = 1016;
	});

	afterEach(() =>
	{
		Configuration.setValue(configDimUnit, dimCentiMeter);
		document.body.innerHTML = '';
	});

	it('carries both pairs, so an older build can still read it', () =>
	{
		const saved = floorplan.saveFloorplan().carbonSheet;
		expect(saved.widthCm).toBeCloseTo(1591.733, 1);
		expect(saved.heightCm).toBeCloseTo(1016, 1);
		// And the display-unit pair, which is what it always wrote.
		expect(saved.width).toBeCloseTo(52.222, 2);
	});

	it('comes back the same size in a different unit, which is the whole point', () =>
	{
		const saved = floorplan.saveFloorplan();
		Configuration.setValue(configDimUnit, dimMeter);

		const reloaded = new Floorplan();
		const back = sheetOn(reloaded);
		back.maintainProportion = false;
		reloaded.carbonSheet = back;
		reloaded.loadFloorplan(saved);

		expect(back.widthCm).toBeCloseTo(1591.733, 1);
	});

	it('still reads a file written before the centimetres existed', () =>
	{
		// The old shape, and it means what it meant: the display unit at save
		// time. Reinterpreting it would break every plan already on disk.
		const saved = floorplan.saveFloorplan();
		delete saved.carbonSheet.widthCm;
		delete saved.carbonSheet.heightCm;

		const reloaded = new Floorplan();
		const back = sheetOn(reloaded);
		back.maintainProportion = false;
		reloaded.carbonSheet = back;
		reloaded.loadFloorplan(saved);

		// Read in feet, the unit it was written in, so it is right.
		expect(back.widthCm).toBeCloseTo(1591.733, 0);
	});

	it('is the bug when that old file is opened in another unit', () =>
	{
		// Not a regression test - a statement of why the cm pair had to exist.
		// The same file, the same number, read in metres: 3.28 times too big.
		const saved = floorplan.saveFloorplan();
		delete saved.carbonSheet.widthCm;
		delete saved.carbonSheet.heightCm;
		Configuration.setValue(configDimUnit, dimMeter);

		const reloaded = new Floorplan();
		const back = sheetOn(reloaded);
		back.maintainProportion = false;
		reloaded.carbonSheet = back;
		reloaded.loadFloorplan(saved);

		expect(back.widthCm / 1591.733).toBeCloseTo(3.28, 1);
	});
});
