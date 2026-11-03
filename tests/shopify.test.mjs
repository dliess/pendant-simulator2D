import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.ok(liquid.trimStart().startsWith('<pendant-simulator'));
  assert.ok(liquid.includes('block.settings.heading | escape'));
  assert.ok(liquid.includes("{% render 'pendant-simulator-assets' %}"));
  const assets = readFileSync('snippets/pendant-simulator-assets.liquid', 'utf8');
  assert.match(assets, /<script src="{{ 'pendant-simulator\.js' \| asset_url }}" defer><\/script>/);
  for (const id of ['heading', 'show_heading', 'display_width', 'particle_count', 'fill_level', 'gravity_strength']) {
    assert.ok(block.settings.some(setting => setting.id === id), `missing ${id}`);
  }
  for (const setting of block.settings.filter(setting => setting.type === 'range')) {
    assert.ok(setting.default >= setting.min && setting.default <= setting.max);
    assert.equal((setting.default - setting.min) % setting.step, 0);
    assert.ok((setting.max - setting.min) / setting.step + 1 <= 101);
  }
});

test('optional product-page section accepts native theme blocks and provides a preset', () => {
  const { liquid, schema: section } = schema('sections/pendant-simulator.liquid');
  assert.ok(liquid.includes("{% content_for 'blocks' %}"));
  assert.deepEqual(section.enabled_on.templates, ['product']);
  assert.ok(section.blocks.some(block => block.type === '@theme'));
  assert.equal(section.presets[0].blocks[0].type, 'pendant-simulator');
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
