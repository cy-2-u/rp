// Offline regression: execute production cache/parser helpers without starting
// the browser bootstrap, IndexedDB, or any network client.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../DB/bootstrap.js', import.meta.url), 'utf8');
const section = (startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `production source boundaries: ${startMarker}`);
    return source.slice(start, end);
};
const encoder = new TextEncoder();
const calls = { parses: 0, encodes: 0, lastEncoded: null };
const helpers = new Function('textEncoder', 'JSON', [
    section('    const SNAPSHOT_SCHEMA_VERSION =', '    const MANIFEST_PAGE_FORMAT ='),
    section('    const STABLE_BUCKET_COUNT =', '    const state ='),
    section('    function stableKeyToken(', '    function readObjectStoreKeys('),
    section('    function serializeSnapshotObject(', '    function openLocalSyncCache('),
    section('    function stableHash(', '    function snapshotBytesEqual('),
    section('    async function parsePackSnapshot(', '    function assertPackEntryPlacement('),
    'return { buildCacheEntry, parsePackSnapshot, SNAPSHOT_SCHEMA_VERSION, MAX_SUPPORTED_OBJECT_BYTES };'
].join('\n'))({
    encode(text) {
        calls.encodes += 1;
        calls.lastEncoded = encoder.encode(text);
        return calls.lastEncoded;
    }
}, {
    stringify: JSON.stringify,
    parse(text) {
        calls.parses += 1;
        return JSON.parse(text);
    }
});

assert.equal(helpers.SNAPSHOT_SCHEMA_VERSION, 13);
assert.equal(helpers.MAX_SUPPORTED_OBJECT_BYTES, 64 * 1024 * 1024);
const PACK_BYTES = 1024 * 1024;
const value = {
    type: 'record', store: 'store', database: 'RPHubDB', key: 'buffer-regression',
    value: { z: 2, a: '\u6d4b\u8bd5' }
};
const canonical = encoder.encode('{"database":"RPHubDB","key":"buffer-regression","store":"store","type":"record","value":{"a":"\u6d4b\u8bd5","z":2}}');

// Local uploads must still serialize exactly once, retaining the encoder's
// already-owned buffer rather than introducing another copy on that path.
const serialized = helpers.buildCacheEntry(value);
assert.equal(calls.encodes, 1);
assert.equal(calls.parses, 0);
assert.strictEqual(serialized.bytes, calls.lastEncoded);
assert.deepEqual(serialized.bytes, canonical);
assert.equal(structuredClone(serialized).bytes.buffer.byteLength, canonical.byteLength);
const explicitNull = helpers.buildCacheEntry(value, null);
assert.equal(calls.encodes, 2);
assert.strictEqual(explicitNull.bytes, calls.lastEncoded);
assert.deepEqual(explicitNull, serialized);
console.log('PASS existing canonical serialization path uses one owned buffer');

function checkRestoredEntry(parsedValue, suppliedBytes, label) {
    const before = { parses: calls.parses, encodes: calls.encodes };
    const entry = helpers.buildCacheEntry(parsedValue, suppliedBytes);
    assert.equal(calls.parses, before.parses, `${label}: cache build must not reparse`);
    assert.equal(calls.encodes, before.encodes, `${label}: cache build must not reserialize`);

    // IndexedDB uses structured clone: the view length alone does not bound the
    // persisted buffer. Assert the actual buildCacheEntry result after cloning.
    const persisted = structuredClone(entry);
    assert.equal(persisted.bytes.buffer.byteLength, persisted.bytes.byteLength,
        `${label}: structured clone must not retain an oversized backing buffer`);
    assert.equal(persisted.bytes.byteLength, canonical.byteLength);
    assert.equal(persisted.bytes.byteOffset, 0);
    assert.equal(entry.bytes.buffer.byteLength, entry.bytes.byteLength);
    assert.equal(entry.bytes.byteOffset, 0);
    assert.notStrictEqual(entry.bytes.buffer, suppliedBytes.buffer,
        `${label}: cache bytes must own a separate buffer`);
    assert.notStrictEqual(persisted.bytes.buffer, entry.bytes.buffer);
    assert.deepEqual(entry, serialized, `${label}: bytes and cache metadata stay equivalent`);
    assert.deepEqual(persisted, serialized);

    suppliedBytes[0] ^= 0xff;
    assert.equal(entry.bytes[0], canonical[0], `${label}: input mutations must not reach cache bytes`);
    suppliedBytes[0] ^= 0xff;
    const last = entry.bytes.byteLength - 1;
    entry.bytes[last] ^= 0xff;
    assert.equal(suppliedBytes[last], canonical[last], `${label}: cache mutations must not reach input`);
    assert.deepEqual(persisted.bytes, canonical, `${label}: persisted bytes must remain independent`);
    entry.bytes[last] ^= 0xff;
}

const backingPack = new Uint8Array(PACK_BYTES);
const offset = 4093;
backingPack.set(canonical, offset);
const smallView = backingPack.subarray(offset, offset + canonical.byteLength);
assert.equal(structuredClone(smallView).buffer.byteLength, PACK_BYTES,
    'fixture must reproduce whole-pack structured-clone amplification');
checkRestoredEntry(value, smallView, 'small subarray in a 1MiB pack');
console.log('PASS small subarray persists only its own bytes without aliasing');

const line = new Uint8Array(canonical.byteLength + 1);
line.set(canonical);
line[canonical.byteLength] = 10;
// Split inside a multibyte UTF-8 character as well as inside an earlier field.
const utf8Split = canonical.indexOf(0xe6) + 1;
assert.ok(utf8Split > 17 && utf8Split < canonical.byteLength);
for (const [label, boundaries] of [
    ['single-fragment parser output', [0, line.byteLength]],
    ['three-fragment parser output', [0, 17, utf8Split, line.byteLength]]
]) {
    const packs = boundaries.slice(1).map((end, index) => {
        const fragment = line.subarray(boundaries[index], end);
        const backing = new Uint8Array(PACK_BYTES);
        const start = 31 + index;
        backing.set(fragment, start);
        return {
            bucketKey: serialized.bucketKey,
            group: serialized.group,
            bytes: backing.subarray(start, start + fragment.byteLength),
            entryCount: end === line.byteLength ? 1 : 0
        };
    });
    const before = { parses: calls.parses, encodes: calls.encodes };
    // Exercise the same parser once for prevalidation and once for the cache
    // rebuild, ensuring the fix does not add a third parse/serialization pass.
    for (const cachePass of [false, true]) {
        let consumed = 0;
        let finished = false;
        await helpers.parsePackSnapshot(packs, packs.length, {
            consume(parsedValue, _pack, bytes) {
                consumed += 1;
                assert.deepEqual(parsedValue, value);
                assert.deepEqual(bytes, canonical);
                if (cachePass) checkRestoredEntry(parsedValue, bytes, label);
            },
            finish() { finished = true; }
        });
        assert.equal(consumed, 1);
        assert.equal(finished, true);
    }
    assert.equal(calls.parses - before.parses, 2, `${label}: exactly two parses across both passes`);
    assert.equal(calls.encodes, before.encodes, `${label}: canonical bytes bypass serialization`);
    console.log(`PASS ${label}: exact cloned buffer, no alias, two parses`);
}

// The size guard also applies when canonical bytes are supplied.
assert.throws(() => helpers.buildCacheEntry(value,
    new Uint8Array(helpers.MAX_SUPPORTED_OBJECT_BYTES + 1)), /64MiB/);
for (const invalid of [undefined, NaN, 1n]) {
    assert.throws(() => helpers.buildCacheEntry({ ...value, value: invalid }), /非 JSON/);
}
console.log('PASS 64MiB size guard and local serialization validation remain intact');
console.log('cache-entry-buffer-regression: ok');
