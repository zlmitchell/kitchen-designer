// @ts-check
import {WallItem} from './wall_item.js';
/** */
export class InWallItem extends WallItem
{
	constructor(model, metadata, geometry, material, position, rotation, scale)
	{
		super(model, metadata, geometry, material, position, rotation, scale);
		this.addToWall = true;
		/**
		 * An item that fills a hole must not shadow the hole.
		 *
		 * `Item` casts by default, which is right for furniture and wrong for
		 * everything in this class: an in-wall item exists to occupy an opening the
		 * wall has already been cut for, and a window that casts an opaque shadow
		 * across its own opening is, to every light in the scene, indistinguishable
		 * from bricked-up wall.
		 *
		 * That is not hypothetical. `whitewindow.glb` arrives from the loader as ONE
		 * merged mesh - frame, sash and glass together, because `mergeMeshes`
		 * flattens the hierarchy - so there is no per-part way to let the glazing
		 * through. With `castShadow` on, the traced plan's nine windows each sealed
		 * their own opening and daylight reached nothing at all.
		 *
		 * A generated window loses very little by this: its own geometry is the
		 * lining, which is a frame around the opening rather than across it, and its
		 * sashes are children that never cast anyway. The wall around the hole still
		 * casts, which is what shapes the patch of light on the floor.
		 */
		this.castShadow = false;
	}

	/** */
	getWallOffset()
	{
		// fudge factor so it saves to the right wall
		return -this.currentWallEdge.offset + 0.5;
	}
}
