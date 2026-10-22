// 同步 Worker 的 HTTP 调用封装：上传/下载测试共用。
import assert from 'node:assert/strict';
import { FORMAT, SCHEMA, packKey } from './protocol.mjs';

export function createBarrier(parties) {
    let arrived = 0;
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return async () => {
        arrived += 1;
        if (arrived >= parties) release();
        await promise;
    };
}

export function makeApi(worker, bucket, password = '') {
    const auth = password ? { 'x-rp-sync-password': password } : {};
    return {
        async post(payload) {
            return worker.fetch(new Request('https://local.test/api/rp-sync', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...auth },
                body: JSON.stringify(payload)
            }), { RP_SYNC_R2: bucket, ...(password ? { RP_SYNC_PASSWORD: password } : {}) }, {});
        },
        async json(payload) {
            const response = await this.post(payload);
            const body = await response.json().catch(() => ({}));
            return { response, body };
        },
        async binary(action, params, bytes) {
            const url = new URL('https://local.test/api/rp-sync');
            url.searchParams.set('action', action);
            for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
            return worker.fetch(new Request(url, {
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream', ...auth },
                body: bytes
            }), { RP_SYNC_R2: bucket, ...(password ? { RP_SYNC_PASSWORD: password } : {}) }, {});
        }
    };
}

export async function initialize(api) {
    const { response } = await api.json({ action: 'initialize-storage', schemaVersion: SCHEMA });
    assert.equal(response.status, 200);
}

export async function begin(api, snapshot, baseVersion = 0, baseChecksum = '') {
    return api.json({
        action: 'begin-upload',
        baseVersion,
        baseChecksum,
        checksum: snapshot.checksum,
        bloomChecksum: snapshot.bloomChecksum,
        snapshotFormat: FORMAT,
        schemaVersion: SCHEMA,
        totalBytes: snapshot.totalBytes,
        packCount: snapshot.packCount,
        entryCount: snapshot.entryCount,
        pageCount: snapshot.pageCount,
        pageRoot: snapshot.pageRoot
    });
}

export async function uploadBloom(api, snapshot) {
    return api.binary('upload-bloom', { uploadId: snapshot.checksum }, snapshot.bloom);
}

export async function uploadPack(api, uploadId, pack) {
    return api.binary('upload-pack', {
        uploadId,
        checksum: pack.checksum,
        length: pack.length,
        entryCount: pack.entryCount
    }, pack.bytes);
}

export async function submitPage(api, snapshot, pageIndex) {
    return api.json({
        action: 'upload-manifest-page',
        uploadId: snapshot.checksum,
        pageIndex,
        packs: snapshot.pages[pageIndex].packs
    });
}

export async function seedPack(bucket, pack, uploaded = new Date()) {
    const result = await bucket.put(packKey(pack.checksum), pack.bytes, {
        customMetadata: { entryCount: String(pack.entryCount) },
        httpMetadata: { contentType: 'application/octet-stream' }
    });
    bucket.objects.get(packKey(pack.checksum)).uploaded = uploaded;
    return result;
}

export async function finishPages(api, snapshot) {
    for (let pageIndex = 0; pageIndex < snapshot.pageCount; pageIndex += 1) {
        let { response, body } = await submitPage(api, snapshot, pageIndex);
        assert.equal(response.status, 200);
        for (const checksum of body.missingPacks || []) {
            const pack = snapshot.packs.find(item => item.checksum === checksum);
            assert.ok(pack);
            assert.equal((await uploadPack(api, snapshot.checksum, pack)).status, 204);
        }
        ({ response, body } = await submitPage(api, snapshot, pageIndex));
        assert.equal(response.status, 200);
        assert.deepEqual(body.missingPacks, []);
    }
}

export async function prepareSnapshot(api, snapshot, baseVersion = 0, baseChecksum = '') {
    const started = await begin(api, snapshot, baseVersion, baseChecksum);
    assert.equal(started.response.status, 200);
    assert.equal(started.body.committed, false);
    assert.equal((await uploadBloom(api, snapshot)).status, 204);
    await finishPages(api, snapshot);
    return started.body;
}
