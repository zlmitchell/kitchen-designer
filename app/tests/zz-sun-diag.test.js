/** SCRATCH. What the sun light actually is, on the real plan, with daylight on. */
// @vitest-environment jsdom
import {describe, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {Scene as ThreeScene, Vector3} from 'three';
import {Model} from '../src/scripts/model/model.js';
import {Lights} from '../src/scripts/three/lights.js';
import {Floorplan3D} from '../src/scripts/three/floorPlan.js';
import {sunAt} from '../src/scripts/core/daylight.js';
import {RENDER_STUDIO, createRenderProfile, setRenderProfile} from '../src/scripts/core/render_profile.js';
import {installCanvas2D} from './helpers/dom.js';

const STUDIO = createRenderProfile(RENDER_STUDIO);

describe('sun diagnostics', () =>
{
	it('reports the light and its shadow camera', async () =>
	{
		installCanvas2D(window);
		setRenderProfile(RENDER_STUDIO);
		const model = new Model('/textures/');
		model.loadSerialized(readFileSync('/plan/design.json', 'utf8'));
		await new Promise((r) => setTimeout(r, 400));

		const scene = new ThreeScene();
		const controls = {object: {position: new Vector3(970, 165, 400)},
			addEventListener() {}, removeEventListener() {}};
		const fp = new Floorplan3D(scene, model.floorplan, controls, STUDIO);
		fp.redraw();

		const size = model.floorplan.getSize();
		const centre = model.floorplan.getCenter();
		console.log('plan size', JSON.stringify(size));
		console.log('plan centre', JSON.stringify(centre), 'ctor', centre.constructor.name);

		const lights = new Lights(scene, model.floorplan, STUDIO);
		lights.setDaylight({hour: 12, heading: 180});
		fp.setSkyOpen(false);

		const key = lights.dirLight;
		console.log('sun at 12/180', JSON.stringify(sunAt(12, 180)));
		console.log('key position', JSON.stringify(key.position));
		console.log('key target  ', JSON.stringify(key.target.position));
		console.log('key intensity', key.intensity, 'visible', key.visible,
			'castShadow', key.castShadow);
		console.log('key colour', key.color.getHexString());
		const cam = key.shadow.camera;
		console.log('shadow cam L/R/T/B', cam.left, cam.right, cam.top, cam.bottom,
			'near', cam.near, 'far', cam.far);

		// Is the kitchen inside that frustum? The camera looks from the light at
		// the plan centre, so the test is in the camera's own space.
		key.updateMatrixWorld(true);
		key.target.updateMatrixWorld(true);
		cam.position.copy(key.position);
		cam.lookAt(key.target.position);
		cam.updateMatrixWorld(true);
		cam.updateProjectionMatrix();
		const probe = (label, p) =>
		{
			const local = cam.worldToLocal(p.clone());
			const inX = local.x >= cam.left && local.x <= cam.right;
			const inY = local.y >= cam.bottom && local.y <= cam.top;
			const depth = -local.z;
			const inZ = depth >= cam.near && depth <= cam.far;
			console.log(`  ${label} local ${local.x.toFixed(0)},${local.y.toFixed(0)},`
				+ `${depth.toFixed(0)}  inX ${inX} inY ${inY} inZ ${inZ}`);
		};
		probe('floor under window', new Vector3(944, 0, 120));
		probe('window itself     ', new Vector3(944, 157, 0));
		probe('plan centre       ', new Vector3(centre.x, 0, centre.z));

		// How many casters are in play, and do the walls really cast?
		let casters = 0;
		let receivers = 0;
		scene.traverse((o) =>
		{
			if (!o.isMesh) {return;}
			if (o.castShadow) {casters++;}
			if (o.receiveShadow) {receivers++;}
		});
		console.log('casters', casters, 'receivers', receivers);

		// WHERE does the light actually land? Sample a vertical slice through the
		// kitchen: the floor, the counter top, and the splashback.
		const {Raycaster} = await import('three');
		const ray = new Raycaster();
		ray.far = 6000;
		const shadowCasters = [];
		scene.traverse((o) => {if (o.isMesh && o.castShadow && o.visible) {shadowCasters.push(o);}});
		const sees = (x, y, z, dir) =>
		{
			ray.set(new Vector3(x, y, z), dir);
			return ray.intersectObjects(shadowCasters, false).length === 0;
		};
		// Which items are casting, and what are they?
		const items = model.scene.getItems();
		console.log('items casting shadows:', items.filter((i) => i.castShadow).length,
			'of', items.length);
		const win = items.find((i) => i.metadata && i.metadata.designId === 'window-2');
		console.log('window-2 castShadow', win && win.castShadow,
			'spec', win && win.metadata.spec, 'scale', win && JSON.stringify(win.scale));

		for (const [hour, heading] of [[12, 180], [9, 225], [7, 255], [16, 300], [17.5, 285]])
		{
			const sun = sunAt(hour, heading);
			const dir = new Vector3(sun.direction.x, sun.direction.y, sun.direction.z);
			const alt = (sun.altitude * 180 / Math.PI).toFixed(0);
			let floor = 0;
			let counter = 0;
			let splash = 0;
			for (let x = 800; x <= 1130; x += 15)
			{
				for (let z = 80; z <= 400; z += 15) {if (sees(x, 3, z, dir)) {floor++;}}
				for (let z = 15; z <= 70; z += 10) {if (sees(x, 93, z, dir)) {counter++;}}
				for (let y = 95; y <= 200; y += 10) {if (sees(x, y, 12, dir)) {splash++;}}
			}
			console.log(`hour ${hour} heading ${heading} alt ${alt} dirz ${sun.direction.z.toFixed(2)}`
				+ `  floor ${floor}  counter ${counter}  splash ${splash}`);
		}

		// One ray, and what it hits. Counting told me nothing; naming will.
		for (const [hour, heading] of [[12, 180], [7, 255]])
		{
			const sun = sunAt(hour, heading);
			const dir = new Vector3(sun.direction.x, sun.direction.y, sun.direction.z);
			for (const from of [[944, 150, 12], [944, 120, 40], [944, 3, 150]])
			{
				ray.set(new Vector3(from[0], from[1], from[2]), dir);
				const hits = ray.intersectObjects(shadowCasters, false);
				const first = hits[0];
				console.log(`RAY ${hour}/${heading} from ${from.join(',')} -> `
					+ (first
						? `${first.object.name || first.object.type} at `
							+ `${first.point.x.toFixed(0)},${first.point.y.toFixed(0)},`
							+ `${first.point.z.toFixed(0)} d=${first.distance.toFixed(0)}`
						: 'NOTHING (sees the sun)'));
			}
		}
	});
});
