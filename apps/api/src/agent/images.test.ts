import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkImages, imageBlocks, imageNote, isImageResult, MAX_IMAGE_BYTES } from './images.js';
import { toChat } from './provider.js';

// 1x1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64');

test('images: the real type wins over the declared one; non-images and oversize files are refused', () => {
  const [a] = checkImages([{ mediaType: 'image/jpeg', data: PNG, name: 'shot.png' }]);
  assert.equal(a.mediaType, 'image/png');
  assert.equal(checkImages([{ mediaType: 'image/png', data: JPEG }])[0].mediaType, 'image/jpeg');
  assert.throws(() => checkImages([{ mediaType: 'image/png', data: Buffer.from('%PDF-1.7 not an image').toString('base64'), name: 'doc.pdf' }]), /isn't a JPEG, PNG, GIF or WebP/);
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1); big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.throws(() => checkImages([{ mediaType: 'image/png', data: big.toString('base64') }]), /larger than 5 MB/);
  assert.deepEqual(checkImages(undefined), []);
});

test('images: saved conversations note them; tools can hand back an image', () => {
  assert.equal(imageNote(undefined), '');
  assert.equal(imageNote([{ mediaType: 'image/png', data: PNG, name: 'error.png' }]), '\n[Image: error.png]');
  assert.match(imageNote([{ mediaType: 'image/png', data: PNG }, { mediaType: 'image/png', data: PNG, name: 'b.png' }]), /2 images: image 1, b.png/);
  assert.ok(isImageResult({ __image: { mediaType: 'image/png', data: PNG } }));
  assert.ok(!isImageResult('text'));
});

test('images: other providers get them as data URLs, including images a tool returned', () => {
  const img = imageBlocks([{ mediaType: 'image/png', data: PNG }])[0];
  const req = {
    model: 'claude-opus-5-5', max_tokens: 100,
    messages: [
      { role: 'user', content: [img, { type: 'text', text: 'What is wrong here?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Image x.png' }, img] }] },
    ],
  };
  const out = toChat(req, { model: 'gpt-x', fastModel: 'gpt-x-mini' }) as { messages: any[] };
  const first = out.messages[0];
  assert.equal(first.role, 'user');
  assert.deepEqual(first.content[0], { type: 'text', text: 'What is wrong here?' });
  assert.match(first.content[1].image_url.url, /^data:image\/png;base64,iVBOR/);
  const tool = out.messages.find((m) => m.role === 'tool');
  assert.equal(tool.content, 'Image x.png');
  const after = out.messages[out.messages.indexOf(tool) + 1];
  assert.equal(after.role, 'user');
  assert.match(after.content[1].image_url.url, /^data:image\/png/);
});
