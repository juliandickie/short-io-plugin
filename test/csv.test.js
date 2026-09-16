import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../lib/csv.mjs';

test('parseCsv handles quotes, embedded commas, CRLF and a header row', () => {
  const { header, rows } = parseCsv('url,path,title,tags\r\nhttps://a.example/,a,"Title, with comma","x,y"\r\nhttps://b.example/,,,\r\n');
  assert.deepEqual(header, ['url', 'path', 'title', 'tags']);
  assert.deepEqual(rows[0], { url: 'https://a.example/', path: 'a', title: 'Title, with comma', tags: 'x,y' });
  assert.deepEqual(rows[1], { url: 'https://b.example/', path: '', title: '', tags: '' });
});

test('toCsv quotes what needs quoting', () => {
  assert.equal(toCsv(['a', 'b'], [{ a: 'x,y', b: 'say "hi"' }]), 'a,b\n"x,y","say ""hi"""\n');
});
