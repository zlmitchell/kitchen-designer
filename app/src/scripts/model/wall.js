// @ts-check
import {EventDispatcher, Vector2} from 'three';
// bezier-js v3+ is ESM and exports Bezier as a NAMED export; v2 was a default
// export. Upgraded in S1 (2.4.0 -> 6.x); the APIs this file uses - the 8-scalar
// constructor, .points mutation + .update(), .length(), .get(t), .project(p)
// and .intersects(line) - are unchanged across that jump.
import {Bezier} from 'bezier-js';
import {WallTypes} from '../core/constants.js';
import {EVENT_ACTION,EVENT_MOVED,EVENT_DELETED} from '../core/events.js';
import {configurationOf,configWallThickness} from '../core/configuration.js';
import {Utils} from '../core/utils.js';


/** The default wall texture. */
export const defaultWallTexture = {url: 'rooms/textures/wallmap.png', stretch: true, scale: 0};

/**
 * Unpainted. White, because the colour MULTIPLIES the texture - so white is the
 * identity and anything else tints the map underneath it.
 */
export const defaultWallColor = '#ffffff';

/**
 * How glossy a painted face is, as a name rather than a number.
 *
 * A sheen IS a roughness, and roughness is a render concern - but the vocabulary
 * is a model one, because a saved file records `satin` and not `0.5`. Re-tuning
 * what satin looks like then changes every design at once instead of leaving
 * older files pinned to a number somebody has since decided was wrong.
 *
 * `matte` deliberately carries no number of its own. It is whatever the active
 * render profile already calls a wall (`wallRoughness`), which is what every
 * wall in every design was before this list existed - so a wall nobody has
 * chosen a finish for renders exactly as it used to, in either profile.
 *
 * Ordered flattest-first: that is the order a paint chart uses, and the order
 * the picker shows.
 */
export const WALL_SHEENS = Object.freeze([
	Object.freeze({id: 'matte', label: 'Matte', roughness: null}),
	Object.freeze({id: 'eggshell', label: 'Eggshell', roughness: 0.7}),
	Object.freeze({id: 'satin', label: 'Satin', roughness: 0.5}),
	Object.freeze({id: 'semi-gloss', label: 'Semi-gloss', roughness: 0.3}),
	Object.freeze({id: 'gloss', label: 'Gloss', roughness: 0.15}),
]);

/** Flat paint: the finish a face has when nobody has chosen one. */
export const defaultWallSheen = 'matte';

/**
 * The roughness a sheen name asks for.
 *
 * @param {?string} sheen One of `WALL_SHEENS`' ids.
 * @returns {?number} A linear 0..1 roughness, or null for "whatever the profile
 *          calls matte". Null is also the answer for a name this build does not
 *          know, so a file written by a later version - or one hand-edited -
 *          opens as flat paint rather than throwing.
 */
export function wallSheenRoughness(sheen)
{
	var entry = WALL_SHEENS.find((candidate) => candidate.id === sheen);
	return entry ? entry.roughness : null;
}

/**
 * A Wall is the basic element to create Rooms.
 *
 * Walls consists of two half edges.
 */
export class Wall extends EventDispatcher
{
	/**
	 * Constructs a new wall.
	 * @param start Start corner.
	 * @param end End corner.
	 * @param {?Object} [aa] Curve control point, or null for a straight wall.
	 * @param {?Object} [bb] Curve control point, or null for a straight wall.
	 * @param {string} [id] An assigned identity. Omitted for a wall an EDITING
	 *        action creates, which gets a fresh one; supplied by
	 *        `Floorplan.loadFloorplan`, which derives it from the corner pair the
	 *        file already records. Same shape as `Floorplan.newCorner`'s optional
	 *        id, and for the same reason.
	 */
	constructor(start, end, aa, bb, id)
	{
		super();
		this.start = start;
		this.end = end;
		this.name = 'wall';
		if(!aa && !bb)
		{
			this._walltype = WallTypes.STRAIGHT;
		}
		else
		{
			this._walltype = WallTypes.CURVED;
		}
		var o = new Vector2(0, 0);
		var abvector = end.location.clone().sub(start.location).multiplyScalar(0.5);
		
		var ab135plus = abvector.clone().rotateAround(o, Math.PI*0.75);
		var ab45plus = abvector.clone().rotateAround(o, Math.PI*0.25);
		
		if(aa)
		{
			this._a = new Vector2(0, 0);
			this._a.x = aa.x;
			this._a.y = aa.y;
		}
		else
		{
			this._a = start.location.clone().add(ab45plus);
		}
		
		if(bb)
		{
			this._b = new Vector2(0, 0);
			this._b.x = bb.x;
			this._b.y = bb.y;
		}
		else
		{
			this._b = end.location.clone().add(ab135plus);
		}		
		this._a_vector = this._a.clone().sub(start.location);
		this._b_vector = this._b.clone().sub(start.location);
		
		this._bezier = new Bezier(start.location.x,start.location.y , this._a.x,this._a.y , this._b.x,this._b.y , end.location.x,end.location.y);

		/**
		 * This wall's identity, assigned rather than derived (RM-003 A3).
		 *
		 * It used to be `getUuid()` - the two corner ids joined - computed once
		 * here and never recomputed. Frozen at construction, so it became a lie the
		 * moment either corner was merged into another, and two walls between the
		 * same pair of corners collided on it.
		 *
		 * `getUuid()` still returns the derived pair, because that is what the save
		 * file records and what a reader of an old file has. This is the handle
		 * everything in memory should use.
		 *
		 * RM-004 B2 made it survive a document load as well as an edit, by letting
		 * the load path supply one. A wall created by drawing still gets a fresh
		 * guid here - it has no file to be named by, and two walls drawn between
		 * the same corners in one session must still differ.
		 *
		 * @type {string}
		 */
		this.id = id || Utils.guide();

		this.start.attachStart(this);
		this.end.attachEnd(this);

		/** Front is the plane from start to end. */
		this.frontEdge = null;

		/** Back is the plane from end to start. */
		this.backEdge = null;

		/** */
		this.orphan = false;

		/** Items attached to this wall */
		this.items = [];

		/** */
		this.onItems = [];

		/** The front-side texture. */
		this.frontTexture = defaultWallTexture;

		/** The back-side texture. */
		this.backTexture = defaultWallTexture;

		/**
		 * What colour each face is painted, as `#rrggbb`.
		 *
		 * Multiplies the texture rather than replacing it, which is why white is
		 * "no colour": the stock wallmap is a near-white surface, so a tint over it
		 * is paint over plaster and reads the way paint does. `three/edge.js` had
		 * `var color = 0xFFFFFF` written into it, so every wall in every design was
		 * the same white and there was no way to say otherwise.
		 *
		 * Per FACE, not per wall, because the two sides of a wall are in different
		 * rooms and are routinely different colours. That is also why the texture
		 * is already per face.
		 */
		this.frontColor = defaultWallColor;

		/** @see Wall#frontColor */
		this.backColor = defaultWallColor;

		/**
		 * What finish each face is painted in - one of `WALL_SHEENS`' ids.
		 *
		 * Per face beside the colour, because it is part of the same decision: a
		 * kitchen is routinely satin where a bedroom on the other side of the same
		 * wall is matte, for the same reason the two sides are different colours.
		 *
		 * Only the studio profile can show it. Classic draws walls with
		 * MeshBasicMaterial, which has no roughness at all - so this is recorded
		 * and saved in both, and visible in one.
		 */
		this.frontSheen = defaultWallSheen;

		/** @see Wall#frontSheen */
		this.backSheen = defaultWallSheen;

		// A Wall has no floorplan of its own; it reaches one through its start
		// corner, which is what makes the model layer need no new plumbing for
		// P7. `Floorplan.newWall` is the only construction site.
		var configuration = configurationOf(start && start.floorplan);

		/** Wall thickness. */
		this.thickness = configuration.getNumericValue(configWallThickness);

		// Wall height is DERIVED from the two corners now - see the `height`
		// getter below. Assigning here would have shadowed the accessor with an own
		// property on every wall, which is the one way to make a getter silently
		// stop working. The corners carry the configured default themselves.


		/** Actions to be applied after movement. */

		/** Actions to be applied on removal. */

		/** Actions to be applied explicitly. */
		
		// One handler per wall, held on the instance. Before S2 this method built a
		// fresh closure on every call, so removeEventListener could never match the
		// function that was registered and listeners only ever accumulated - and
		// setEnd had its add and remove the wrong way round on top of that, leaving
		// the wall deaf to the corner it had just been attached to.
		this._cornerMovedEvent = () => {this.updateControlVectors();};
		this.addCornerMoveListener(this.start);
		this.addCornerMoveListener(this.end);
	}

	addCornerMoveListener(corner, remove=false)
	{
		if(!corner)
		{
			return;
		}
		if(remove)
		{
			corner.removeEventListener(EVENT_MOVED, this._cornerMovedEvent);
			return;
		}
		corner.addEventListener(EVENT_MOVED, this._cornerMovedEvent);
	}
	
	get a()
	{
		return this._a;
	}
	
	set a(location)
	{
		this._a.x = location.x;
		this._a.y = location.y;
		this._a_vector = this._a.clone().sub(this.start.location);
		this.updateControlVectors();
	}
	
	get b()
	{
		return this._b;
	}
	
	set b(location)
	{
		this._b.x = location.x;
		this._b.y = location.y;
		this._b_vector = this._b.clone().sub(this.start.location);
		this.updateControlVectors();
	}
	
	get aVector()
	{
		return this._a_vector.clone();
	}
	
	get bVector()
	{
		return this._b_vector.clone();
	}
	
	get bezier()
	{
		return this._bezier;
	}
	
	updateControlVectors()
	{
		this._bezier.points[0].x = this.start.location.x;
		this._bezier.points[0].y = this.start.location.y;
		
		this._bezier.points[1].x = this.a.x;
		this._bezier.points[1].y = this.a.y;
		
		this._bezier.points[2].x = this.b.x;
		this._bezier.points[2].y = this.b.y;
		
		this._bezier.points[3].x = this.end.location.x;
		this._bezier.points[3].y = this.end.location.y;
		this._bezier.update();
		// Name the corners whose geometry this moved (RM-003 A2).
		//
		// It used to call `update(false)` with no payload at all - "something
		// geometric changed, work out what" - which was survivable only because
		// every consumer reacted to every change by rebuilding everything. A
		// consumer that reacts per entity can do nothing with an unnamed change.
		//
		// The two corners are the right answer for both callers: a control point
		// moved between them, or one of them moved and dragged the control vectors
		// with it. In the second case they are already in the corner's own change
		// and the union costs nothing - see Corner.move(), which batches the whole
		// gesture so this echo does not become a third announcement.
		//
		// Worth stating what this does NOT currently fix, so nobody credits it with
		// more than it does: bending a wall changes no mesh in the 3D view today.
		// Only HalfEdge's centre and length read the bezier, and the wall planes
		// are built from the corner offsets, so a curved wall is drawn as a
		// straight quad. `tests/change-projection.test.js` pins that under "curving
		// a wall - and the picture does not move". This is the payload being
		// correct, not a bug being fixed.
		var anchor = this.getStart() || this.getEnd();
		if (anchor)
		{
			var moved = [this.getStart(), this.getEnd()].filter(function (corner) {return corner != null;});
			anchor.floorplan.update(false, moved);
		}
	}

	getUuid()
	{
		return [this.start.id, this.end.id].join();
	}

	resetFrontBack()
	{
		this.frontEdge = null;
		this.backEdge = null;
		this.orphan = false;
	}
	
	snapToAxis(tolerance)
	{
		// order here is important, but unfortunately arbitrary
		this.start.snapToAxis(tolerance);
		this.end.snapToAxis(tolerance);
	}





	// Removed in S1: the fireOnMove / fireOnDelete / dontFireOnDelete /
	// fireOnAction registrars. Each called .add() or .remove() on a null
	// field, so any call was a guaranteed TypeError; nothing called them.
	// fireAction() below is live - it dispatches a real EVENT_ACTION.

	fireAction(action)
	{
		this.dispatchEvent({type:EVENT_ACTION, action: action});
	}

	relativeMove(dx, dy)
	{
		this.start.relativeMove(dx, dy);
		this.end.relativeMove(dx, dy);
		
		
		this.updateControlVectors();
		
	}

	fireMoved()
	{
		this.dispatchEvent({type: EVENT_MOVED, item: this, position: null});
	}

	fireRedraw()
	{
		if (this.frontEdge)
		{
			this.frontEdge.dispatchRedrawEvent();
		}
		if (this.backEdge)
		{
			this.backEdge.dispatchRedrawEvent();
		}
	}
	
	set wallSize(value)
	{
		if(this.wallType == WallTypes.STRAIGHT)
		{
			var vector = this.getEnd().location.clone().sub(this.getStart().location);
			var currentLength = this.wallLength();

			// A zero-length wall has no direction to resize along: changeInLength
			// is Infinity and every coordinate derived from it is NaN.
			//
			// This used to be harmless by accident. three r98 built vectors with
			// `this.x = x || 0`, which turned NaN back into 0 on the next clone(),
			// so the corner simply never moved. r125 replaced that with default
			// parameters, NaN now survives, and the corner - plus every wall and
			// room touching it - is corrupted beyond recovery. The S0
			// characterization test flagged this as a migration tripwire; this is
			// the guard it asked for, and it keeps the old outcome: no movement.
			if(currentLength === 0)
			{
				return;
			}

			var changeInLength = value / currentLength;
			
			var neighboursCountStart = (this.getStart().adjacentCorners().length == 1);
			var neighboursCountEnd = (this.getEnd().adjacentCorners().length  == 1);
			
			var changeInLengthOffset, movementVector, startPoint, endPoint;
			
			changeInLengthOffset = (changeInLength - 1);
			
			if((!neighboursCountStart && !neighboursCountEnd) || (neighboursCountStart && neighboursCountEnd))
			{
				changeInLengthOffset *= 0.5;
				movementVector = vector.clone().multiplyScalar(changeInLengthOffset);
				startPoint = movementVector.clone().multiplyScalar(-1).add(this.getStart().location);
				endPoint = movementVector.clone().add(this.getEnd().location);
			}
			else if(neighboursCountStart)
			{
				movementVector = vector.clone().multiplyScalar(changeInLengthOffset);
				startPoint = movementVector.clone().multiplyScalar(-1).add(this.getStart().location);
				endPoint = this.getEnd().location;
			}
			
			else if(neighboursCountEnd)
			{
				movementVector = vector.clone().multiplyScalar(changeInLengthOffset);
				endPoint = movementVector.clone().add(this.getEnd().location);
				startPoint = this.getStart().location;
			}
			this.getStart().move(startPoint.x, startPoint.y);
			this.getEnd().move(endPoint.x, endPoint.y);		
			
			this.updateAttachedRooms();
			
		}
	}
	
	get wallSize()
	{
		return this.wallLength();
	}
		
	get wallType()
	{
		return this._walltype;
	}
	
	set wallType(value)
	{
		if(value == WallTypes.STRAIGHT || value == WallTypes.CURVED)
		{
			this._walltype = value;
		}
		this.updateControlVectors();
		this.updateAttachedRooms(true);
	}
	
	get startElevation()
	{
		if(this.start && this.start != null)
		{
			return this.start.elevation;
		}
		return 0.0;
	}
	
	get endElevation()
	{
		if(this.end && this.end != null)
		{
			return this.end.elevation;
		}
		return 0.0;
	}

	/**
	 * How tall this wall stands, in centimetres.
	 *
	 * The two ends can differ - that is what lets a wall slope - so this is the
	 * taller of them, which is the height the wall reaches.
	 *
	 * ## Why this is derived and not stored
	 *
	 * `this.height` used to be a field of its own, set once from the configured
	 * default and never serialized. Meanwhile the 3D view took the wall top from
	 * the two CORNERS' elevations (`three/edge.js`), which are serialized. So
	 * there were two heights: a real one that drew the wall and round-tripped, and
	 * a phantom one that drove the wall's texture repeat and where a new wall item
	 * was first placed. Drop a wall to half height and the phantom stayed at 250,
	 * so the texture tiled for a wall twice the size and a window landed above the
	 * wall it was on.
	 *
	 * Deriving it means they cannot disagree. Assignment is deliberately still
	 * accepted, and sets both corners - some caller somewhere may still write it,
	 * and silently discarding that would be worse than honouring it.
	 *
	 * @type {number}
	 */
	get height()
	{
		return Math.max(this.startElevation, this.endElevation);
	}

	set height(value)
	{
		this.setHeight(value);
	}

	/**
	 * Stand this wall at `height`, splitting its corners off any neighbour that is
	 * staying where it is.
	 *
	 * The splitting is the whole job. A wall takes its height from its corners and
	 * a corner is shared with everything that meets there, so setting the corners
	 * directly drops the neighbours too: making the pony wall by the sink 42in
	 * pulled the end of the full-height wall it runs into down with it. What is
	 * wanted is a corner each, at the same point, at two different heights - which
	 * `tools/extract.py` has emitted since it first wrote a pony wall, and which
	 * `Floorplan.newCorner` now preserves rather than fusing away.
	 *
	 * A corner is split only when it has to be: an end that carries nothing else,
	 * or whose neighbours are all coming along, is simply set. So a run of walls
	 * lowered together stays one connected run, and only the junction with
	 * something staying tall gains a corner.
	 *
	 * @param {number} height Centimetres.
	 * @param {Array<Wall>} [along] Other walls being set to the same height in the
	 *        same gesture. A corner shared only with these needs no split.
	 * @returns {Wall} this
	 */
	setHeight(height, along)
	{
		// Built rather than concatenated: `[this].concat(...)` infers `this[]`, and
		// a Wall is not assignable to a possible subtype of itself.
		/** @type {Array<Wall>} */
		var group = [this];
		(along || []).forEach(function (wall) {group.push(wall);});
		var scope = this;
		// A Wall holds no floorplan of its own and reaches one through its start
		// corner - see the note in the constructor.
		var floorplan = this.start && this.start.floorplan;
		if (!floorplan)
		{
			return this;
		}

		floorplan.beginBatch();
		try
		{
			['start', 'end'].forEach(function (which)
			{
				var corner = scope[which];
				if (!corner)
				{
					return;
				}

				// Everything else meeting here that is NOT part of this gesture. If
				// any of it is staying at a different height, this corner cannot
				// also be ours.
				var others = corner.wallStarts.concat(corner.wallEnds)
					.filter(function (wall) {return group.indexOf(wall) === -1;});
				var conflicts = others.some(function (wall)
				{
					return Math.abs(wall.height - height) > 0.5;
				});

				if (!conflicts)
				{
					corner.elevation = height;
					return;
				}

				// A corner of our own at the same point. newCorner keys on position
				// AND height, so this is a new corner rather than the one we are
				// standing on.
				var split = floorplan.newCorner(corner.x, corner.y, undefined, height);
				if (which === 'start')
				{
					scope.setStart(split);
				}
				else
				{
					scope.setEnd(split);
				}
				split.elevation = height;
			});
		}
		finally
		{
			floorplan.endBatch();
		}
		return this;
	}

	getStart()
	{
		return this.start;
	}

	getEnd()
	{
		return this.end;
	}

	getStartX()
	{
		return this.start.getX();
	}

	getEndX()
	{
		return this.end.getX();
	}

	getStartY()
	{
		return this.start.getY();
	}

	getEndY()
	{
		return this.end.getY();
	}

	wallLength()
	{
		if(this.wallType == WallTypes.STRAIGHT)
		{
			var start = this.getStart();
			var end = this.getEnd();
			return Utils.distance(start, end);
		}
		else if(this.wallType == WallTypes.CURVED)
		{
			return this._bezier.length();
		}
		return -1;
	}

	wallCenter()
	{
		if(this.wallType == WallTypes.STRAIGHT)
		{
			return new Vector2((this.getStart().x + this.getEnd().x) / 2.0, (this.getStart().y + this.getEnd().y) / 2.0);
		}
		else if(this.wallType == WallTypes.CURVED)
		{
			var p = this._bezier.get(0.5); 
			return new Vector2(p.x, p.y);
		}
		return new Vector2(0,0);
	}

	remove()
	{
		this.start.detachWall(this);
		this.end.detachWall(this);
		// A removed wall must stop listening to corners that outlive it, or the
		// floorplan keeps a deleted wall alive through their listener lists.
		this.addCornerMoveListener(this.start, true);
		this.addCornerMoveListener(this.end, true);
		this.dispatchEvent({type:EVENT_DELETED, item: this});
	}

	setStart(corner)
	{
		this.start.detachWall(this);
		this.addCornerMoveListener(this.start, true);

		corner.attachStart(this);
		this.start = corner;
		this.addCornerMoveListener(this.start);
		this.fireMoved();
	}

	setEnd(corner)
	{
		this.end.detachWall(this);
		this.addCornerMoveListener(this.end, true);

		corner.attachEnd(this);
		this.end = corner;
		this.addCornerMoveListener(this.end);
		this.fireMoved();
	}

	distanceFrom(point)
	{
		if(this.wallType == WallTypes.STRAIGHT)
		{
			return Utils.pointDistanceFromLine(point, new Vector2(this.getStartX(), this.getStartY()), new Vector2(this.getEndX(), this.getEndY()));
		}
		else if(this.wallType == WallTypes.CURVED)
		{
			var p = this._bezier.project(point);
			var projected = new Vector2(p.x, p.y);
			return projected.distanceTo(point);
		}
		return -1;
	}

	/** Return the corner opposite of the one provided.
	 * @param corner The given corner.
	 * @returns The opposite corner.
	 */
	oppositeCorner(corner)
	{
		if (this.start === corner)
		{
			return this.end;
		}
		else if (this.end === corner)
		{
			return this.start;
		}
		else
		{
			console.log('Wall does not connect to corner');
			return null;
		}
	}

	getClosestCorner(point)
	{
		var startVector = new Vector2(this.start.x, this.start.y);
		var endVector = new Vector2(this.end.x, this.end.y);
		var startDistance = point.distanceTo(startVector);
		var endDistance = point.distanceTo(endVector);
		if(startDistance <= (this.thickness*2))
		{
			return this.start;
		}
		else if(endDistance <= (this.thickness*2))
		{
			return this.end;
		}
		return null;
	}

	updateAttachedRooms(explicit=false)
	{
		if(this.start != null)
		{
			this.start.updateAttachedRooms(explicit);
		}
		if(this.end)
		{
			this.end.updateAttachedRooms(explicit);
		}
	}
}
