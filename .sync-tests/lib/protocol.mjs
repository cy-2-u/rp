// 同步协议常量与快照构造：测试侧的独立实现，不 import 生产代码。
export const FORMAT = 'rp-sync-paged-jsonl-v4';
export const SCHEMA = 13;
export const PAGE_FORMAT = 'rp-sync-manifest-page-v1';
export const PAGE_PACKS = 32;
export const CHAIN_SEED = '0'.repeat(64);
export const BLOOM_BYTES = 32 * 1024;
export const PREFIX = 'rp-sync/main';
export const MANIFEST_KEY = `${PREFIX}/manifest.json`;
export const MIGRATION_KEY = `${PREFIX}/migration-v13.done`;

const encoder = new TextEncoder();

export async function sha256Bytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Buffer.from(digest).toString('hex');
}

export const sha256Text = text => sha256Bytes(encoder.encode(text));
export const packKey = checksum => `${PREFIX}/packs/${checksum}.bin`;
export const pageKey = (checksum, pageIndex) => `${PREFIX}/manifests/${checksum}/${String(pageIndex).padStart(4, '0')}.json`;
export const bloomKey = checksum => `${PREFIX}/blooms/${checksum}.bin`;
export const sessionKey = uploadId => `${PREFIX}/uploads/${uploadId}.json`;
export const tuple = pack => [pack.bucketKey, pack.group, pack.part, pack.checksum, pack.length, pack.entryCount];
export const pageSource = (pageIndex, previousPageHash, packs) => JSON.stringify([
    PAGE_FORMAT, pageIndex, previousPageHash, packs.map(tuple)
]);
export const rootSource = snapshot => JSON.stringify([
    FORMAT, SCHEMA, snapshot.totalBytes, snapshot.packCount, snapshot.entryCount,
    snapshot.pageCount, snapshot.pageRoot, snapshot.bloomChecksum
]);

export function bloomIndexes(checksum) {
    const bitCount = BLOOM_BYTES * 8;
    return [0, 8, 16, 24].map(offset => parseInt(checksum.slice(offset, offset + 8), 16) % bitCount);
}

export function bloomHas(bloom, checksum) {
    return bloomIndexes(checksum).every(bit => (bloom[bit >>> 3] & (1 << (bit & 7))) !== 0);
}

export function makeBloom(packs) {
    const bloom = new Uint8Array(BLOOM_BYTES);
    for (const pack of packs) {
        for (const bit of bloomIndexes(pack.checksum)) bloom[bit >>> 3] |= 1 << (bit & 7);
    }
    return bloom;
}

export async function buildSnapshot(count, { prefix = 'snapshot', mutatePacks, bloom } = {}) {
    const packs = [];
    for (let index = 0; index < count; index += 1) {
        const bytes = encoder.encode(`${prefix}-${index}\n`);
        packs.push({
            bucketKey: `${prefix}-bucket`,
            group: `${prefix}-group`,
            part: index,
            checksum: await sha256Bytes(bytes),
            length: bytes.byteLength,
            entryCount: 1,
            bytes
        });
    }
    if (mutatePacks) mutatePacks(packs);
    let previousPageHash = CHAIN_SEED;
    const pages = [];
    const pageCount = Math.ceil(packs.length / PAGE_PACKS);
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const pagePacks = packs.slice(pageIndex * PAGE_PACKS, (pageIndex + 1) * PAGE_PACKS)
            .map(({ bytes, ...pack }) => pack);
        const pageHash = await sha256Text(pageSource(pageIndex, previousPageHash, pagePacks));
        pages.push({ pageIndex, previousPageHash, pageHash, packs: pagePacks });
        previousPageHash = pageHash;
    }
    const bloomBytes = bloom || makeBloom(packs);
    const snapshot = {
        snapshotFormat: FORMAT,
        schemaVersion: SCHEMA,
        totalBytes: packs.reduce((sum, pack) => sum + pack.length, 0),
        packCount: packs.length,
        entryCount: packs.reduce((sum, pack) => sum + pack.entryCount, 0),
        pageCount,
        pageRoot: previousPageHash,
        bloomChecksum: await sha256Bytes(bloomBytes),
        packs,
        pages,
        bloom: bloomBytes
    };
    snapshot.checksum = await sha256Text(rootSource(snapshot));
    return snapshot;
}
