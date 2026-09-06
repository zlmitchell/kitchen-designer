// @vitest-environment jsdom
/**
 * Turning an item on the spot.
 *
 * There has always been a way to do this and it is easy to miss: `hud.js` draws
 * a drag handle when an item is selected IN THE 3D VIEW, and it sits at
 * `height = 5` - five centimetres off the floor - in white. On a 107cm post in a
 * white room that is an ankle-height white arrow against a white floor, and
 * selecting the item on the 2D plan does not produce one at all.
 *
 * So: a number and two buttons, in the panel that is already open.
 */
import {describe, it, expect} from 'vitest';
import {mount} from '@vue/test-utils';
import ItemInspector from '../src/app/inspector/ItemInspector.vue';
import {installCanvas2D} from './helpers/dom.js';
import {Color} from 'three';

function fakeItem(over = {}) {
  return Object.assign({
    metadata: {itemName: 'Post'},
    rotation: {y: 0},
    material: {name: 'm', color: new Color('#ffffff')},
    allowRotate: true, fixed: false,
    getWidth: () => 10, getHeight: () => 100, getDepth: () => 10,
    getProportionalResize: () => false,
    setProportionalResize() {}, setFixed() {}, resize() {}, setMaterialColor() {}, remove() {},
  }, over);
}

describe('the item rotation control', () => {
  it('shows for a rotatable item and writes radians', async () => {
    installCanvas2D(window);
    const item = fakeItem();
    const w = mount(ItemInspector, {props: {item}});
    const labels = w.findAll('.field-label, label').map((n) => n.text());
    expect(labels.some((t) => /rotation/i.test(t))).toBe(true);

    const field = w.findAll('input[type=number]').at(3);
    await field.setValue(90);
    await field.trigger('change');
    expect(item.rotation.y).toBeCloseTo(Math.PI / 2, 5);
  });

  it('steps a quarter turn with the buttons, both ways', async () => {
    installCanvas2D(window);
    const item = fakeItem();
    const w = mount(ItemInspector, {props: {item}});
    const buttons = w.findAll('button').filter((b) => /Left|Right/.test(b.text()));
    expect(buttons.length).toBe(2);
    const [left, right] = buttons;

    await right.trigger('click');
    expect(item.rotation.y).toBeCloseTo(Math.PI / 2, 5);

    await right.trigger('click');
    expect(item.rotation.y).toBeCloseTo(Math.PI, 5);

    await left.trigger('click');
    await left.trigger('click');
    expect(item.rotation.y).toBeCloseTo(0, 5);
  });

  it('snaps back onto quarters from an angle a drag left behind', async () => {
    installCanvas2D(window);
    // The 3D handle can leave any angle; a button press should land on a quarter
    // rather than carry the drift forward.
    const item = fakeItem({rotation: {y: 37 * Math.PI / 180}});
    const w = mount(ItemInspector, {props: {item}});
    const right = w.findAll('button').filter((b) => /Right/.test(b.text()))[0];
    await right.trigger('click');
    expect(item.rotation.y).toBeCloseTo(Math.PI / 2, 5);
  });

  it('hides for a wall-bound item, whose facing comes from its wall', () => {
    installCanvas2D(window);
    const w = mount(ItemInspector, {props: {item: fakeItem({allowRotate: false})}});
    const labels = w.findAll('.field-label, label').map((n) => n.text());
    expect(labels.some((t) => /rotation/i.test(t))).toBe(false);
  });
});
