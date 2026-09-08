// @ts-check
import {Vector2, Vector3} from 'three';
import {EVENT_DELETED} from '../core/events.js';
import {Utils} from '../core/utils.js';
import {Item} from './item.js';


/** @typedef {import('../model/half_edge.js').HalfEdge} HalfEdge */

/**
 * What `metadata.wallEdge` says when an item is on NO wall.
 *
 * The same field as a half edge's name, because it answers the same question -
 * "which wall face is this item on" - and one of its answers is "none". A
 * `HalfEdge.id` is `wall:<corners>:front|back` and always has colons in it, so
 * this cannot collide with one, and a reader that does not know about free
 * placement simply fails to find a matching edge and falls back to geometry,
 * which is what every reader of this field already does when a wall is gone.
 */
export const FREE_STANDING = 'free';

/**
 * A Wall Item is an entity to be placed related to a wall.
 */
export class WallItem extends Item
{
	constructor(model, metadata, geometry, material, position, rotation, scale)
	{
		super(model, metadata, geometry, material, position, rotation, scale);
		/** The currently applied wall edge. */
		this.currentWallEdge = null;

		/**
		 * One listener, held so it can be taken off again (RM-004 B2).
		 *
		 * `changeWallEdge` used to declare this as a fresh closure on every call
		 * and then `removeEventListener` the NEW one off the old wall - removing a
		 * function that had never been added, and leaving the previous closure
		 * subscribed. Every re-bind leaked one, and there was no reference anywhere
		 * that could detach the item from a wall without destroying the item.
		 *
		 * B2 needs exactly that: a wall-bound item now survives a document load,
		 * and the way it used to die was its own subscription - `reset()` fires
		 * EVENT_DELETED on every wall, this handler ran, and the item removed
		 * itself before it could be re-bound. Bound once here so `releaseWall()`
		 * can undo it.
		 */
		// `Item.remove()` takes nothing and removes `this`, which is what this
		// listener wants - the wall it is attached to has gone (RM-005 C2). The
		// argument read as "remove that item" and did nothing.
		this._onWallDeleted = () => {this.remove();};
		/*
		 * This used to carry a TODO reading "This caused a huge headache.
		 * HalfEdges get destroyed/created every time floorplan is edited. This
		 * item should store a reference to a wall and front/back, and grab its
		 * edge reference dynamically whenever it needs it."
		 *
		 * RM-004 B2 solved it, by a different route than the one suggested.
		 * Rather than have the item resolve an edge on demand, walls were given
		 * ids derived from their corner pair, which made `HalfEdge.id`
		 * (`${wall.id}:front|back`) stable across a load. `Model.newRoom` now
		 * notes which face a bound item is on before the floorplan is destroyed
		 * and puts it back on that face afterwards - not merely on the nearest
		 * one, which is the same answer everywhere except where two walls meet.
		 *
		 * Left as a record rather than deleted: the headache was real, and the
		 * shape of the fix is worth knowing before anybody re-derives it.
		 */

		/** used for finding rotations */
		this.refVec = new Vector2(0, 1.0);
		/** */
		this.wallOffsetScalar = 0;
		/** */
		this.sizeX = 0;
		/** */
		this.sizeY = 0;
		/** */
		this.addToWall = false;
		/** */
		this.boundToFloor = false;
		/** */
		this.frontVisible = false;
		/** */
		this.backVisible = false;
		this.allowRotate = false;
		this._freePosition = false;
	}

	/**
	 * The wall face this item was PUT on, if anything ever said which.
	 *
	 * `closestWallEdge` decides by distance and is right almost always. Where it
	 * is not, there was until now no way to say so and have it stick: the choice
	 * was recomputed from position on every load and the answer thrown away, so
	 * `bindToNextWallEdge` - the control that exists for exactly this - could not
	 * outlive the session.
	 *
	 * Measured on the traced plan: a wall's half edge runs to the MITRE, not to
	 * the wall's own end, so the kitchen's west wall reaches 8.5cm past the corner
	 * at y=361.5. The peninsula cabinet on the other side of that corner is 31.5cm
	 * from that extended face and 34.0cm from the wall it actually stands on, so
	 * it bound to the wrong one, came out rotated ninety degrees, and could not be
	 * dragged straight because `boundMove` then held it against a plane it was
	 * never on. Distance cannot tell those two apart; only the file can.
	 *
	 * Null when the record names an edge this floorplan does not have, which is
	 * an ordinary thing for a design to outlive - the caller falls back to
	 * geometry, exactly as `Model.newRoom` already does when a bound wall is gone.
	 *
	 * @returns {?HalfEdge}
	 */
	namedWallEdge()
	{
		var named = this.metadata ? this.metadata.wallEdge : null;
		if (!named || named === FREE_STANDING)
		{
			return null;
		}
		/** @type {?HalfEdge} */
		var found = null;
		this.model.floorplan.wallEdges().forEach((edge) =>
		{
			if (edge.id === named)
			{
				found = edge;
			}
		});
		return found;
	}

	/**
	 * Whether this item is on no wall at all, and keeps what it was given.
	 *
	 * An island is the case. A peninsula or an island is a run with a counter,
	 * doors on more than one side and nothing behind it - and until now an item of
	 * this class would find a wall SOMEWHERE in the room and attach itself to it,
	 * however far away, because `closestWallEdge` has no way to answer "none of
	 * them". A 24in base unit in the middle of the floor came out square to the
	 * nearest wall three metres away and could not be turned, because a bound item
	 * takes its facing from that wall.
	 *
	 * Free is therefore the absence of every binding this class exists to impose:
	 * no rotation from a normal, no `boundMove` onto a plane, no membership of a
	 * wall's item list. What is left is an item that keeps the position and
	 * rotation it was given, which is what a free-standing thing is.
	 *
	 * @returns {boolean}
	 */
	get freeStanding()
	{
		return Boolean(this.metadata) && this.metadata.wallEdge === FREE_STANDING;
	}

	/**
	 * Whether "no wall" is even a thing this item could be.
	 *
	 * `addToWall` is the discriminator and it is exactly the right one: it is true
	 * for `InWallItem` and its subclasses, which are the items that cut a HOLE in
	 * the wall they are on. A window or a door is not a thing standing near a
	 * wall, it is an absence in one, and an absence with no wall around it is
	 * nothing at all - the item would keep its lining and its sashes and the wall
	 * would close up behind it.
	 *
	 * So types 2 and 9 - the cabinet, the appliance, the barn door on the face -
	 * may go free, and types 3 and 7 may not.
	 *
	 * @returns {boolean}
	 */
	get canBeFree()
	{
		return !this.addToWall;
	}

	/** Get the closet wall edge.
	 * @returns {?HalfEdge} The nearest wall edge, or null when the design has no
	 * walls at all - `wallEdges()` is empty, the loop never runs, and there is
	 * nothing to be nearest to.
	 */
	closestWallEdge()
	{
		var wallEdges = this.model.floorplan.wallEdges();
		/** @type {?HalfEdge} */
		var wallEdge = null;
		var minDistance = null;
		var itemX = this.position.x;
		var itemZ = this.position.z;
		wallEdges.forEach((edge) => {
			var distance = edge.distanceTo(itemX, itemZ);
			if (minDistance === null || distance < minDistance)
			{
				minDistance = distance;
				wallEdge = edge;
			}
		});
		return wallEdge;
	}

	/** */
	removed()
	{
		if (this.currentWallEdge != null && this.addToWall)
		{
			Utils.removeValue(this.currentWallEdge.wall.items, this);
			this.redrawWall();
		}
		// Detach from the wall FIRST, then release (RM-003 A0). redrawWall() above
		// rebuilds the wall's faces, which cuts the hole this item used to occupy -
		// and it reads this item's position and halfSize to do it. Releasing before
		// that would hand the rebuild a disposed geometry.
		super.removed();
	}

	/**
	 * Ask the wall to rebuild its faces around this item.
	 *
	 * Guarded on the edge as well as on `addToWall`, because a free-standing item
	 * has no wall and every caller of this reaches it by a route that does not
	 * know that: `resized()` runs on any spec edit, and `removed()` on any delete.
	 * `addToWall` alone is not the guard it looks like - it is a property of the
	 * item's TYPE, and it stays true across going free.
	 */
	redrawWall()
	{
		if (this.addToWall && this.currentWallEdge)
		{
			this.currentWallEdge.wall.fireRedraw();
		}
	}

	/** */
	updateEdgeVisibility(visible, front)
	{
		if (front)
		{
			this.frontVisible = visible;
		}
		else
		{
			this.backVisible = visible;
		}
		this.visible = (this.frontVisible || this.backVisible);
	}

	/** */
	updateSize()
	{
		var box = this.bounds();
		this.wallOffsetScalar = (box.max.z - box.min.z) * this.scale.z / 2.0;
		this.sizeX = (box.max.x - box.min.x) * this.scale.x;
		this.sizeY = (box.max.y - box.min.y) * this.scale.y;
	}

	/** */
	resized()
	{
		if (this.boundToFloor)
		{
			var box = this.bounds();
			this.position.y = 0.5 * (box.max.y - box.min.y) * this.scale.y + 0.01;
		}
		this.updateSize();
		this.redrawWall();
	}

	/** */
	/**
	 * Wall-bound: this item holds a `HalfEdge`. Since RM-004 B2 that is a fact to
	 * be handled on load rather than a reason to discard the item. See
	 * {@link Item#boundToFloorplan}.
	 * @returns {boolean}
	 */
	get boundToFloorplan()
	{
		return true;
	}

	/**
	 * Every wall face this item could reasonably be on, nearest first.
	 *
	 * `closestWallEdge` picks one and is right almost always. In a CORNER it is a
	 * coin toss: two walls meet, both are within a few centimetres of the cabinet
	 * standing in the angle, and whichever wins decides which way the doors face.
	 * There was no way to say "the other one" - a wall-bound item turns
	 * `allowRotate` off, because `changeWallEdge` takes `rotation.y` from the
	 * edge's normal and would discard anything a rotation control wrote.
	 *
	 * So the answer is not to rotate the item, it is to bind it to a different
	 * face. This is the list to choose from.
	 *
	 * @param {number} [reach] How far to look, in centimetres. The default takes
	 *        in the far side of a wall and the return wall of a corner without
	 *        reaching across a room.
	 * @returns {Array<Object>} Wall edges, nearest first.
	 */
	nearbyWallEdges(reach)
	{
		var limit = (reach === undefined) ? 120 : reach;
		var itemX = this.position.x;
		var itemZ = this.position.z;
		return this.model.floorplan.wallEdges()
			.map(function (edge) {return {edge: edge, distance: edge.distanceTo(itemX, itemZ)};})
			.filter(function (entry) {return entry.distance <= limit;})
			.sort(function (a, b) {return a.distance - b.distance;})
			.map(function (entry) {return entry.edge;});
	}

	/**
	 * Move this item to the next wall face it could be on.
	 *
	 * Cycles, so pressing it repeatedly walks the candidates and comes back - in a
	 * corner that is usually four faces, being two walls with two sides each, and
	 * the one you want is one or two presses away.
	 *
	 * @returns {boolean} Whether there was another face to move to.
	 */
	bindToNextWallEdge()
	{
		var candidates = this.wallEdgeChoices();
		if (candidates.length < 2)
		{
			return false;
		}
		var current = this.freeStanding ? null : this.currentWallEdge;
		var index = candidates.indexOf(current);
		var next = candidates[(index + 1) % candidates.length];
		if (next === current)
		{
			return false;
		}
		if (next === null)
		{
			this.setFreeStanding(true);
			return true;
		}
		this.changeWallEdge(next);
		// The item is on a different plane now, so its position has to come back
		// onto it - `boundMove` is what holds an item against the wall it is on.
		this.boundMove(this.position);
		this.redrawWall();
		return true;
	}

	/**
	 * Everywhere this item could be, in the order the control walks them.
	 *
	 * The nearby faces, and then - for anything that is not a hole in a wall - a
	 * `null` meaning no wall at all. One list rather than a separate free control
	 * because it is one question with n+1 answers, and because it makes the cycle
	 * complete: press the button enough times and you come back to where you
	 * started, which is what makes a control with no labels safe to press.
	 *
	 * `null` last, so the first press from a bound item still reaches the return
	 * wall in a corner - which is the case the control was built for and by far
	 * the common one.
	 *
	 * @param {number} [reach] Passed through to {@link WallItem#nearbyWallEdges}.
	 * @returns {Array<?HalfEdge>}
	 */
	wallEdgeChoices(reach)
	{
		/** @type {Array<?HalfEdge>} */
		var choices = this.nearbyWallEdges(reach);
		if (this.canBeFree)
		{
			choices.push(null);
		}
		return choices;
	}

	/**
	 * Take this item off every wall, or put it back on the nearest one.
	 *
	 * Going free is mostly subtraction, and one addition that is easy to miss:
	 * `visible`. A bound item does not own that flag - `Edge` drives it through
	 * `updateEdgeVisibility` so the wall you are looking through fades - and it
	 * does so by walking the WALL's item lists. An item that leaves those lists
	 * while the near face happens to be hidden therefore keeps `visible === false`
	 * with nothing left in the scene that would ever set it back, and freeing a
	 * cabinet makes it disappear. Seen exactly once, from inside the room, and it
	 * looks like the item was deleted rather than moved.
	 *
	 * Rotation is not restored on the way back: `changeWallEdge` overwrites
	 * `rotation.y` from the face's normal, which is the whole reason a bound item
	 * turns `allowRotate` off. Whatever angle the island was turned to is gone the
	 * moment it goes back on a wall, and that is correct - it is against a wall
	 * now.
	 *
	 * @param {boolean} free
	 * @returns {boolean} Whether the item ended up as asked.
	 */
	setFreeStanding(free)
	{
		if (!free)
		{
			var edge = this.namedWallEdge() || this.closestWallEdge();
			if (!edge)
			{
				return false;
			}
			this.changeWallEdge(edge);
			this.boundMove(this.position);
			this.redrawWall();
			return true;
		}
		if (!this.canBeFree)
		{
			return false;
		}
		// Before `releaseWall`, which redraws the wall this item is leaving - and
		// that rebuild reads the item list this call is about to take it out of.
		this.releaseWall();
		this.metadata.wallEdge = FREE_STANDING;
		// `changeWallEdge` is the only thing that writes `rotation.y` from a wall
		// normal, and nothing is going to call it again until this item is bound
		// back. So the angle is the item's own now, and there is a control for it.
		this.allowRotate = true;
		this.visible = true;
		this.frontVisible = true;
		this.backVisible = true;
		if (this.boundToFloor)
		{
			// `boundMove` did this on every drag and it is gone with the binding, so
			// the one part of it that is not about a wall is done here instead: an
			// island still stands on the floor.
			var box = this.bounds();
			this.position.y = 0.5 * (box.max.y - box.min.y) * this.scale.y + 0.01;
		}
		if (this.bhelper)
		{
			this.bhelper.update();
		}
		return true;
	}

	placeInRoom()
	{
		// "On no wall" is a thing the file can say, and it is said in the same
		// field as a wall's name - so it is answered here, before anything looks
		// for an edge. Ahead of `namedWallEdge()` rather than folded into it: that
		// method answers "which edge", and the whole point of free is that there
		// is not one, so a null from it would be indistinguishable from a design
		// naming a wall that has since been deleted - which falls back to geometry
		// and would bind the island to whatever wall it happened to be nearest.
		if (this.freeStanding)
		{
			this.releaseWall();
			this.updateSize();
			return;
		}
		// What the file says, then what the geometry says. One order, everywhere:
		// a named face that still exists wins, and everything else is unchanged.
		var closestWallEdge = this.namedWallEdge() || this.closestWallEdge();
		// Null on a design with no walls, and `changeWallEdge` dereferences it on
		// its first line - so adding a wall item before drawing a wall was a
		// TypeError, the same shape as the RoofItem crash RM-005 C2 fixed one file
		// over (J-5). Both were named by the checker and neither had a test.
		//
		// Doing nothing is the honest answer: the item keeps the position it was
		// created with and attaches to a wall the next time one is nearby, which
		// is what `placeInRoom` is for.
		if (!closestWallEdge)
		{
			return;
		}
		this.changeWallEdge(closestWallEdge);
		this.updateSize();

		if (!this.position_set)
		{
			// position not set
			var center = closestWallEdge.interiorCenter();
			var newPos = new Vector3(center.x, closestWallEdge.wall.height / 2.0, center.y);
			this.boundMove(newPos);
			this.position.copy(newPos);
			this.redrawWall();
		}
	}

	/** */
	moveToPosition(vec3, intersection)
	{
		// A free item is dragged like furniture: where the mouse says, and it stays
		// there. Not merely a skipped `boundMove` - the re-bind above it has to go
		// too, or dragging an island across the floor would silently re-attach it
		// to whatever wall the drag passed near and take its facing from that.
		if (this.freeStanding)
		{
			super.moveToPosition(vec3);
			if (this.onPlaced)
			{
				this.onPlaced(this);
			}
			return;
		}
		var intersectionEdge = (intersection) ? (intersection.object) ? intersection.object.edge: intersection : this.closestWallEdge();
		this.changeWallEdge(intersectionEdge);
		this.boundMove(vec3);

		super.moveToPosition(vec3);
		// Where the item ENDED UP, which is not what it was asked for: `boundMove`
		// clamps along the wall and pins the across-wall offset, and
		// `changeWallEdge` above may have re-handed the item first. A generated
		// item whose spec holds a position - a window's sill height - has to read
		// this back or the panel and the mouse disagree, and the next bind throws
		// away whichever the mouse set. See `Item.onPlaced`.
		if (this.onPlaced)
		{
			this.onPlaced(this);
		}
		this.redrawWall();
	}

	/** */
	getWallOffset()
	{
		return this.wallOffsetScalar;
	}

	/** */
	/**
	 * Let go of the wall this item is on, without destroying the item.
	 *
	 * The detach half of `changeWallEdge`, split out because `Model.newRoom`
	 * needs it on its own: a document load destroys every wall, and an item still
	 * subscribed to EVENT_DELETED removes itself when that happens. Calling this
	 * first is what lets the item be re-bound afterwards instead of reloaded.
	 *
	 * Safe to call when unbound, and idempotent - it is also the first thing
	 * `changeWallEdge` does.
	 */
	releaseWall()
	{
		if (this.currentWallEdge == null)
		{
			return;
		}

		if (this.addToWall)
		{
			Utils.removeValue(this.currentWallEdge.wall.items, this);
			this.redrawWall();
		}
		else
		{
			Utils.removeValue(this.currentWallEdge.wall.onItems, this);
		}

		this.currentWallEdge.wall.removeEventListener(EVENT_DELETED, this._onWallDeleted);
		this.currentWallEdge = null;
	}

	changeWallEdge(wallEdge)
	{
		this.releaseWall();
		wallEdge.wall.addEventListener(EVENT_DELETED, this._onWallDeleted);

		// find angle between wall normals
		var normal2 = new Vector2();
		// Was geometry.faces[0].normal. BufferGeometry has no per-face normals,
		// so HalfEdge.generatePlane precomputes this one when it builds the plane.
		var normal3 = wallEdge.planeNormal;
		normal2.x = normal3.x;
		normal2.y = normal3.z;

		var angle = Utils.angle( new Vector2(this.refVec.x, this.refVec.y), new Vector2(normal2.x, normal2.y));
		this.rotation.y = angle;
		// update currentWall
		this.currentWallEdge = wallEdge;
		// And REMEMBER it, which is the whole of the fix: one rule, always true -
		// `metadata.wallEdge` is the face this item is on. Written here rather than
		// at each caller because every way an item changes wall comes through this
		// method: a load, a drag onto another face, `bindToNextWallEdge`, and
		// `Model.newRoom` putting an item back after a floorplan rebuild.
		//
		// Recording the geometric guess too, on an item that never named a face, is
		// deliberate. A design that has been opened once stops drifting: the answer
		// is in the file rather than recomputed from a distance that a wall edit
		// three rooms away can change.
		this.metadata.wallEdge = wallEdge.id;
		// And undo `setFreeStanding`, which is the other half of one rule: an item
		// takes its facing from the wall it is on, so it does not also get a
		// rotation control. Set here rather than only in `setFreeStanding(false)`
		// because that is not the only way back onto a wall - a free item whose
		// design is reloaded into a floorplan is re-bound straight through here.
		this.allowRotate = false;
		if (this.addToWall)
		{
			wallEdge.wall.items.push(this);
			this.redrawWall();
		}
		else
		{
			wallEdge.wall.onItems.push(this);
		}

		// `rotation.y` was just set from this edge's normal, so anything the item
		// holds in PLAN axes can finally be resolved into its own. See
		// `Item.onBound`; a generated door re-hands itself here.
		//
		// After the wall bookkeeping, so a hook that inspects `currentWallEdge`
		// or the wall's item list sees the finished state.
		if (this.onBound)
		{
			this.onBound(this);
		}
	}

	/** Returns an array of planes to use other than the ground plane
	 * for passing intersection to clickPressed and clickDragged */
	customIntersectionPlanes()
	{
		// Nothing, when free, which sends the controller to the ground plane -
		// `Controller.itemIntersection` falls back to `this.plane` on an empty
		// list. That is the right surface for an island: it is dragged about the
		// FLOOR, not through the air, so `Item.freePosition` - which means "any
		// point in 3D" and is what a picture on a wall would want - is the wrong
		// mechanism here even though it shares the word.
		if (this.freeStanding)
		{
			return [];
		}
		return this.model.floorplan.wallEdgePlanes();
	}

	/** takes the move vec3, and makes sure object stays bounded on plane */
	boundMove(vec3)
	{
		var tolerance = 1;
		var edge = this.currentWallEdge;
		vec3.applyMatrix4(edge.interiorTransform);
		if (vec3.x < this.sizeX / 2.0 + tolerance)
		{
			vec3.x = this.sizeX / 2.0 + tolerance;
		}
		else if (vec3.x > (edge.interiorDistance() - this.sizeX / 2.0 - tolerance))
		{
			vec3.x = edge.interiorDistance() - this.sizeX / 2.0 - tolerance;
		}

		if (this.boundToFloor)
		{
			var box = this.bounds();
			vec3.y = 0.5 * (box.max.y - box.min.y) * this.scale.y + 0.01;
		}
		else
		{
			if (vec3.y < this.sizeY / 2.0 + tolerance)
			{
				vec3.y = this.sizeY / 2.0 + tolerance;
			}
			// Deliberately no upper clamp. Restricting vec3.y to
			// `edge.height - sizeY/2 - tolerance` would pin every wall item to a
			// uniform height and stop it being dragged up a sloped wall.
		}
		vec3.z = this.getWallOffset();
		vec3.applyMatrix4(edge.invInteriorTransform);
	}
}
