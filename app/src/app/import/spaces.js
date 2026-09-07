// @ts-check
/**
 * Rooms as the complement of the wall union.
 *
 * A port of the two functions from `tools/spaces.py` that the pipeline needs:
 * paint the walls into a grid, then flood fill what is left. The naming and
 * rendering halves are check tooling and are not ported.
 *
 * The app only asks one question of this - which openings have the outdoors on
 * one side of them - but that question needs the whole fill: the outside is
 * the region that touches the edge of the clip, and there is no way to know
 * which region that is without finding all of them.
 */

/**
 * Grid step, in real inches. Fine enough to keep a 3in wall solid, coarse
 * enough that a whole house is a few hundred thousand cells.
 */
export const CELL_IN = 1.5;

/**
 * A grid with every wall box burned into it, openings included.
 *
 * A door is still a wall PLANE for the purpose of enclosing a room - you do
 * not stop being in the kitchen because the doorway is open. The openings have
 * to be painted as barriers: `combine` bridges a wall over an opening only
 * where a jamb stub survives on the wall's own line, and across a 5ft picture
 * window the wall face is simply absent, so the fill escapes and takes the
 * rooms either side of it outside.
 *
 * @param {Array<object>} boxes
 * @param {number[]} bounds `[x0, y0, x1, y1]` in inches.
 * @param {Array<object>} [openings]
 */
export function paint(boxes, bounds, openings = [])
{
	const [x0, y0, x1, y1] = bounds;
	const wide = Math.trunc((x1 - x0) / CELL_IN) + 2;
	const high = Math.trunc((y1 - y0) / CELL_IN) + 2;
	const grid = new Uint8Array(wide * high);

	const all = boxes.concat(openings.map(
		(opening) => ({...opening, drawn_lo: opening.lo, drawn_hi: opening.hi})));

	for (const box of all)
	{
		const half = box.thickness / 2;
		let lo;
		let hi;
		let near;
		let far;
		if (box.horizontal)
		{
			lo = box.drawn_lo;
			hi = box.drawn_hi;
			near = box.centre - half;
			far = box.centre + half;
		}
		else
		{
			near = box.drawn_lo;
			far = box.drawn_hi;
			lo = box.centre - half;
			hi = box.centre + half;
		}
		const rowFrom = Math.max(0, Math.trunc((near - y0) / CELL_IN));
		const rowTo = Math.min(high, Math.trunc((far - y0) / CELL_IN) + 1);
		const columnFrom = Math.max(0, Math.trunc((lo - x0) / CELL_IN));
		const columnTo = Math.min(wide, Math.trunc((hi - x0) / CELL_IN) + 1);
		for (let row = rowFrom; row < rowTo; row += 1)
		{
			grid.fill(1, row * wide + columnFrom, row * wide + columnTo);
		}
	}
	return {grid, wide, high};
}

/**
 * Connected runs of unpainted cells, flood filled.
 *
 * @param {Uint8Array} grid
 * @param {number} wide
 * @param {number} high
 */
export function regions(grid, wide, high)
{
	const label = new Int32Array(wide * high);
	const found = [];
	// A plain array used as a queue, with a read index rather than shift():
	// a whole-house fill is a few hundred thousand cells and shift() is linear.
	const queue = new Int32Array(wide * high);

	for (let start = 0; start < grid.length; start += 1)
	{
		if (grid[start] || label[start])
		{
			continue;
		}
		const index = found.length + 1;
		let head = 0;
		let tail = 0;
		queue[tail] = start;
		tail += 1;
		label[start] = index;
		let cells = 0;
		let touchesEdge = false;

		while (head < tail)
		{
			const cell = queue[head];
			head += 1;
			cells += 1;
			const column = cell % wide;
			const row = Math.trunc(cell / wide);
			if (column === 0 || column === wide - 1 || row === 0 || row === high - 1)
			{
				touchesEdge = true;
			}
			const neighbours = [
				[column - 1, row], [column + 1, row],
				[column, row - 1], [column, row + 1],
			];
			for (const [nc, nr] of neighbours)
			{
				if (nc < 0 || nc >= wide || nr < 0 || nr >= high)
				{
					continue;
				}
				const other = nr * wide + nc;
				if (grid[other] || label[other])
				{
					continue;
				}
				label[other] = index;
				queue[tail] = other;
				tail += 1;
			}
		}
		found.push({
			index,
			cells,
			outside: touchesEdge,
			area_sqft: (cells * CELL_IN * CELL_IN) / 144,
		});
	}
	return {label, found};
}
