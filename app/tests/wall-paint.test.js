/**
 * Painting a wall.
 *
 * `three/edge.js` had `var color = 0xFFFFFF` written into it, so every wall in
 * every design was the same white and nothing anywhere could say otherwise -
 * not the inspector, not the save file, not the tracer.
 *
 * The colour MULTIPLIES the texture rather than replacing it, which is why white
 * is "unpainted": the stock wallmap is a near-white plaster surface, and a tint
 * over it reads the way paint does. Replacing the map would have thrown away the
 * surface and left flat colour.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {
	defaultWallColor, defaultWallSheen, WALL_SHEENS, wallSheenRoughness,
} from '../src/scripts/model/wall.js';
import {buildSquareRoom, resetAll} from './helpers/harness.js';

describe('a wall face carries its own colour', () =>
{
	beforeEach(() => resetAll());

	it('starts unpainted, which is white', () =>
	{
		const {floorplan} = buildSquareRoom();
		for (const wall of floorplan.getWalls())
		{
			expect(wall.frontColor).toBe(defaultWallColor);
			expect(wall.backColor).toBe(defaultWallColor);
		}
	});

	it('paints one face without painting the other', () =>
	{
		// The two sides of a wall are in different rooms and are routinely
		// different colours. That is also why the texture is already per face.
		const {floorplan} = buildSquareRoom();
		const edges = floorplan.wallEdges();
		const edge = edges[0];
		edge.setColor('#2f3d50');

		expect(edge.getColor()).toBe('#2f3d50');
		const other = edge.front ? edge.wall.backColor : edge.wall.frontColor;
		expect(other).toBe(defaultWallColor);
	});

	it('tells the view to rebuild', () =>
	{
		// Without the event the model changes and the wall on screen does not,
		// which is the failure mode the corner elevation setter had.
		const {floorplan} = buildSquareRoom();
		const edge = floorplan.wallEdges()[0];
		let redraws = 0;
		edge.addEventListener('REDRAW_EVENT', () => {redraws++;});
		edge.setColor('#9aa793');
		expect(redraws).toBe(1);
	});

	it('paints a whole room at once', () =>
	{
		// A room is painted one colour far more often than a single face is.
		const {floorplan} = buildSquareRoom();
		const room = floorplan.getRooms()[0];
		expect(room).toBeTruthy();
		room.setRoomWallsColor('#9aa793');

		const painted = floorplan.wallEdges().filter((edge) => edge.getColor() === '#9aa793');
		expect(painted.length).toBeGreaterThanOrEqual(4);
	});

	it('survives a save and a load', () =>
	{
		const {floorplan} = buildSquareRoom();
		floorplan.wallEdges()[0].setColor('#2f3d50');
		const saved = floorplan.saveFloorplan();

		expect(saved.walls.some((wall) => wall.frontColor === '#2f3d50'
			|| wall.backColor === '#2f3d50')).toBe(true);

		floorplan.loadFloorplan(saved);
		const back = floorplan.getWalls().some((wall) => wall.frontColor === '#2f3d50'
			|| wall.backColor === '#2f3d50');
		expect(back).toBe(true);
	});

	it('opens a file written before walls could be painted', () =>
	{
		// Asked of the record, like the thickness. A wall with no colour in the
		// file keeps the white its constructor took, rather than becoming black.
		const {floorplan} = buildSquareRoom();
		const saved = floorplan.saveFloorplan();
		for (const wall of saved.walls)
		{
			delete wall.frontColor;
			delete wall.backColor;
		}
		floorplan.loadFloorplan(saved);
		for (const wall of floorplan.getWalls())
		{
			expect(wall.frontColor).toBe(defaultWallColor);
		}
	});
});

/**
 * The finish on that paint.
 *
 * A sheen is a roughness, and the roughness was a constant on the render profile
 * - so every wall in the scene was the same near-flat matte and no face could
 * say otherwise, exactly as the colour had been.
 *
 * Stored as a NAME rather than a number, so re-tuning what satin looks like
 * changes every design at once instead of leaving old files pinned to a value
 * somebody has since decided was wrong.
 */
describe('a wall face carries its own finish', () =>
{
	beforeEach(() => resetAll());

	it('starts matte', () =>
	{
		const {floorplan} = buildSquareRoom();
		for (const wall of floorplan.getWalls())
		{
			expect(wall.frontSheen).toBe(defaultWallSheen);
			expect(wall.backSheen).toBe(defaultWallSheen);
		}
	});

	it('leaves matte to the render profile, and names a number for the rest', () =>
	{
		// Matte is whatever the profile already calls a wall, which is what every
		// wall was before this list existed - so an unspecified wall renders
		// exactly as it used to, in either profile. Null is how that is said.
		expect(wallSheenRoughness('matte')).toBe(null);
		expect(wallSheenRoughness('satin')).toBe(0.5);
		expect(wallSheenRoughness('gloss')).toBe(0.15);
	});

	it('reads an unknown name as flat rather than throwing', () =>
	{
		// A file from a later build, or one somebody hand-edited. It opens.
		expect(wallSheenRoughness('crackle-glaze')).toBe(null);
		expect(wallSheenRoughness(undefined)).toBe(null);
	});

	it('gets glossier down the list', () =>
	{
		// The picker shows this order and a paint chart uses it, so the order is
		// part of the contract rather than an accident of how it was typed.
		const numbered = WALL_SHEENS.filter((sheen) => sheen.roughness !== null);
		for (let i = 1; i < numbered.length; i++)
		{
			expect(numbered[i].roughness).toBeLessThan(numbered[i - 1].roughness);
		}
	});

	it('finishes one face without finishing the other', () =>
	{
		const {floorplan} = buildSquareRoom();
		const edge = floorplan.wallEdges()[0];
		edge.setSheen('gloss');

		expect(edge.getSheen()).toBe('gloss');
		const other = edge.front ? edge.wall.backSheen : edge.wall.frontSheen;
		expect(other).toBe(defaultWallSheen);
	});

	it('tells the view to rebuild', () =>
	{
		// The material is built in updatePlanes, so without the event the model
		// changes and the wall on screen keeps its old roughness.
		const {floorplan} = buildSquareRoom();
		const edge = floorplan.wallEdges()[0];
		let redraws = 0;
		edge.addEventListener('REDRAW_EVENT', () => {redraws++;});
		edge.setSheen('satin');
		expect(redraws).toBe(1);
	});

	it('finishes a whole room at once, and reads it back', () =>
	{
		const {floorplan} = buildSquareRoom();
		const room = floorplan.getRooms()[0];
		room.setRoomWallsSheen('eggshell');

		const finished = floorplan.wallEdges().filter((edge) => edge.getSheen() === 'eggshell');
		expect(finished.length).toBeGreaterThanOrEqual(4);
		expect(room.getRoomWallsSheen()).toBe('eggshell');
	});

	it('reports the default for a room whose faces disagree', () =>
	{
		// There is no single answer, and picking the first face's would make the
		// dropdown claim a finish three of the four walls do not have.
		const {floorplan} = buildSquareRoom();
		const room = floorplan.getRooms()[0];
		room.setRoomWallsSheen('gloss');
		room.edgePointer.setSheen('satin');

		expect(room.getRoomWallsSheen()).toBe(defaultWallSheen);
	});

	it('survives a save and a load', () =>
	{
		const {floorplan} = buildSquareRoom();
		floorplan.wallEdges()[0].setSheen('semi-gloss');
		const saved = floorplan.saveFloorplan();

		expect(saved.walls.some((wall) => wall.frontSheen === 'semi-gloss'
			|| wall.backSheen === 'semi-gloss')).toBe(true);

		floorplan.loadFloorplan(saved);
		const back = floorplan.getWalls().some((wall) => wall.frontSheen === 'semi-gloss'
			|| wall.backSheen === 'semi-gloss');
		expect(back).toBe(true);
	});

	it('opens a file written before walls had a finish', () =>
	{
		// Asked of the record, like the colour and the thickness before it.
		const {floorplan} = buildSquareRoom();
		const saved = floorplan.saveFloorplan();
		for (const wall of saved.walls)
		{
			delete wall.frontSheen;
			delete wall.backSheen;
		}
		floorplan.loadFloorplan(saved);
		for (const wall of floorplan.getWalls())
		{
			expect(wall.frontSheen).toBe(defaultWallSheen);
		}
	});
});
