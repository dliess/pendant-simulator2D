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
  for (const id of ['heading', 'show_heading', 'transparent_background', 'background_color', 'text_color', 'display_width', 'particle_count', 'fill_level', 'gravity_strength', 'react_to_scrolling']) {
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
  for (const setting of block.settings.filter(setting => setting.type === 'range')) {
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
  const css = readFileSync('src/style.css', 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)];
  for (const [, selectors] of rules) {
    for (const selector of selectors.split(',')) {
      assert.match(selector.trim(), /^(?:\.pendant-simulator(?:[\s:.#[]|$)|pendant-simulator$)/);
    }
  }
  const mount = readFileSync('src/simulator.ts', 'utf8');
  assert.doesNotMatch(mount, /\bid\s*=|document\.querySelector|doc\.querySelector/);
});
