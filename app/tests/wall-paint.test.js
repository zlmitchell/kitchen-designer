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
import {defaultWallColor} from '../src/scripts/model/wall.js';
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
