import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { themeFiles, obsoleteThemeFiles } from '../scripts/theme-files.mjs';
import { test } from 'node:test';

function schema(path) {
  const liquid = readFileSync(path, 'utf8');
  return { liquid, schema: JSON.parse(liquid.match(/{% schema %}([\s\S]*?){% endschema %}/)[1]) };
}

test('native theme block exposes configurable settings and editor identity without inline JavaScript', () => {
  const { liquid, schema: block } = schema('blocks/pendant-simulator.liquid');
  assert.equal(block.tag, null);
  assert.ok(block.presets.length > 0);
  assert.equal((liquid.match(/block\.shopify_attributes/g) ?? []).length, 1);
  assert.ok(liquid.replace(/{% doc %}[\s\S]*?{% enddoc %}/, '').trimStart().startsWith('<pendant-simulator'));
  assert.ok(liquid.includes('block.settings.heading | escape'));
  assert.doesNotMatch(liquid, /{% render /);
  assert.match(liquid, /<template data-pendant-simulator-assets>/);
  assert.match(liquid, /<link rel="stylesheet" href="{{ 'pendant-simulator\.css' \| asset_url }}">/);
  assert.match(liquid, /<script src="{{ 'pendant-simulator\.js' \| asset_url }}" defer><\/script>/);
  assert.doesNotMatch(liquid, /<script(?![^>]*\bsrc=)[^>]*>/);
  const bootstrap = liquid.match(/{% javascript %}([\s\S]*?){% endjavascript %}/)[1];
  assert.doesNotMatch(bootstrap, /{{|{%/);
  new Script(bootstrap);
  for (const id of ['heading', 'show_heading', 'show_motion_controls', 'transparent_background', 'background_color', 'text_color', 'show_housing', 'led_color', 'radius_scale', 'size_mode', 'container_padding', 'display_width', 'particle_count', 'fill_level', 'gravity_strength', 'react_to_scrolling']) {
    assert.ok(block.settings.some(setting => setting.id === id), `missing ${id}`);
  }
  assert.deepEqual(block.settings.filter(setting => setting.type === 'color').map(setting => [setting.id, setting.default]),
    [['background_color', '#101820'], ['text_color', '#ffffff']]);
  assert.match(liquid, /data-background-color="{{ block\.settings\.background_color \| default: '#101820' \| escape }}"/);
  assert.match(liquid, /data-text-color="{{ block\.settings\.text_color \| default: '#ffffff' \| escape }}"/);
  assert.equal(block.settings.find(setting => setting.id === 'transparent_background').type, 'checkbox');
  assert.equal(block.settings.find(setting => setting.id === 'transparent_background').default, false);
  assert.match(liquid, /data-transparent-background="{{ block\.settings\.transparent_background }}"/);
  assert.equal(block.settings.find(setting => setting.id === 'react_to_scrolling').type, 'checkbox');
  assert.equal(block.settings.find(setting => setting.id === 'react_to_scrolling').default, true);
  assert.match(liquid, /data-react-to-scrolling="{{ block\.settings\.react_to_scrolling }}"/);
  assert.equal(block.settings.find(setting => setting.id === 'show_motion_controls').type, 'checkbox');
  assert.equal(block.settings.find(setting => setting.id === 'show_motion_controls').default, true);
  assert.match(liquid, /data-show-motion-controls="{{ block\.settings\.show_motion_controls }}"/);
  assert.equal(block.settings.find(setting => setting.id === 'show_housing').type, 'checkbox');
  assert.equal(block.settings.find(setting => setting.id === 'show_housing').default, true);
  assert.match(liquid, /data-show-housing="{{ block\.settings\.show_housing }}"/);
  const ledColor = block.settings.find(setting => setting.id === 'led_color');
  assert.equal(ledColor.type, 'select');
  assert.equal(ledColor.default, 'blue');
  assert.deepEqual(ledColor.options.map(option => option.value), ['blue', 'green']);
  assert.match(liquid, /data-led-color="{{ block\.settings\.led_color \| default: 'blue' \| escape }}"/);
  const pixelLayout = block.settings.find(setting => setting.id === 'pixel_layout');
  assert.equal(pixelLayout.type, 'select');
  assert.equal(pixelLayout.default, 'layout-A');
  assert.deepEqual(pixelLayout.options.map(option => option.value), ['layout-A', 'layout-B']);
  assert.match(liquid, /data-pixel-layout="{{ block\.settings\.pixel_layout \| default: 'layout-A' \| escape }}"/);
  const radius = block.settings.find(setting => setting.id === 'radius_scale');
  assert.equal(radius.type, 'range');
  assert.deepEqual([radius.min, radius.max, radius.step, radius.default, radius.unit], [50, 150, 5, 100, '%']);
  assert.match(liquid, /data-radius-scale="{{ block\.settings\.radius_scale \| default: 100 }}"/);
  const mode = block.settings.find(setting => setting.id === 'size_mode');
  assert.equal(mode.type, 'select');
  assert.equal(mode.default, 'fixed');
  assert.deepEqual(mode.options.map(option => option.value), ['fixed', 'container']);
  assert.match(liquid, /data-size-mode="{{ block\.settings\.size_mode \| default: 'fixed' \| escape }}"/);
  const padding = block.settings.find(setting => setting.id === 'container_padding');
  assert.equal(padding.type, 'range');
  assert.deepEqual([padding.min, padding.max, padding.step, padding.default, padding.unit], [0, 40, 1, 4, '%']);
  assert.equal(padding.visible_if, "{{ block.settings.display_mode != 'photo' and block.settings.size_mode == 'container' }}");
  for (const id of ['display_width', 'radius_scale']) {
    assert.equal(block.settings.find(setting => setting.id === id).visible_if, "{{ block.settings.display_mode != 'photo' and block.settings.size_mode != 'container' }}");
  }
  assert.match(liquid, /data-container-padding="{{ block\.settings\.container_padding \| default: 4 }}"/);
  const offset = block.settings.find(setting => setting.id === 'vertical_offset');
  assert.equal(offset.type, 'range');
  assert.deepEqual([offset.min, offset.max, offset.step, offset.default, offset.unit], [-10, 10, 1, 0, '%']);
  assert.match(liquid, /data-vertical-offset="{{ block\.settings\.vertical_offset \| default: 0 }}"/);
  const displayMode = block.settings.find(setting => setting.id === 'display_mode');
  assert.equal(displayMode.default, 'simulator');
  assert.deepEqual(displayMode.options.map(option => option.value), ['simulator', 'photo']);
  assert.equal(block.settings.find(setting => setting.id === 'pendant_photo').type, 'image_picker');
  for (const id of ['pendant_photo', 'photo_center_x', 'photo_center_y', 'photo_diameter']) {
    assert.equal(block.settings.find(setting => setting.id === id).visible_if, "{{ block.settings.display_mode == 'photo' }}");
  }
  for (const id of ['show_housing', 'size_mode', 'vertical_offset']) {
    assert.equal(block.settings.find(setting => setting.id === id).visible_if, "{{ block.settings.display_mode != 'photo' }}");
  }
  assert.match(liquid, /<template data-pendant-simulator-photo>[\s\S]*?image_tag: widths:[\s\S]*?sizes: '100vw', loading: 'lazy'[\s\S]*?<\/template>/);
  assert.equal(block.settings.find(setting => setting.id === 'fill_level').default, 25);
  const particles = block.settings.find(setting => setting.id === 'particle_count');
  assert.equal(particles.type, 'select');
  assert.equal(particles.default, '2000');
  assert.deepEqual(particles.options.map(option => Number(option.value)),
    Array.from({ length: 20 }, (_, k) => (k + 1) * 500));
  const mobileParticles = block.settings.find(setting => setting.id === 'particle_count_mobile');
  assert.equal(mobileParticles.type, 'select');
  assert.equal(mobileParticles.default, '1000');
  assert.deepEqual(mobileParticles.options, particles.options);
  assert.match(liquid, /data-particle-count-mobile="{{ block\.settings\.particle_count_mobile \| default: '1000' }}"/);
  for (const setting of block.settings.filter(setting => setting.type === 'range')) {
    // Shopify rejects these ranges at upload even though Theme Check accepts them.
    assert.ok(setting.max < 10000, `Shopify range limit exceeded: ${setting.id}`);
    assert.ok(setting.default >= setting.min && setting.default <= setting.max);
    assert.equal((setting.default - setting.min) % setting.step, 0);
    assert.ok((setting.max - setting.min) / setting.step + 1 <= 101);
  }
});

test('Shopify integration is block-only with exactly three deployable files', () => {
  assert.deepEqual(themeFiles, ['assets/pendant-simulator.js', 'assets/pendant-simulator.css', 'blocks/pendant-simulator.liquid']);
  for (const file of obsoleteThemeFiles) assert.equal(existsSync(file), false);
});

test('embeddable CSS has no theme-wide selectors or global element IDs', () => {
  const css = readFileSync('src/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)];
  for (const [, selectors] of rules) {
    for (const selector of selectors.split(',')) {
      assert.match(selector.trim(), /^(?:\.pendant-simulator(?:[\s:.#[]|$)|pendant-simulator$)/);
    }
  }
  const mount = readFileSync('src/simulator.ts', 'utf8');
  assert.doesNotMatch(mount, /\bid\s*=|document\.querySelector|doc\.querySelector/);
});
