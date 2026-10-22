import assert from 'node:assert/strict';

// Shared invariants for a first restore into an empty cache: every entry is
// parsed twice (validate + apply), every pack moves through staging and the
// cache exactly once in transactions of at most six, and pull concurrency
// stays bounded.
export function assertRestoreBatching(metrics, manifest, { label = 'restore', parsesKey = 'snapshotParses' } = {}) {
    assert.equal(metrics[parsesKey], manifest.entryCount * 2,
        `${label}: each snapshot entry must be parsed once for validation and once for restore`);

    const batches = [
        ['staging reads', metrics.stagingReads.filter(batch => batch.count > 0), 'read'],
        ['staging writes', metrics.stagingWrites.filter(batch => batch.count > 0), 'staged'],
        ['cache writes', metrics.cachePackWrites, 'cached']
    ];
    for (const [name, list, verb] of batches) {
        assert.equal(list.reduce((sum, batch) => sum + batch.count, 0), manifest.packCount,
            `${label}: each pack must be ${verb} exactly once (${name})`);
        assert.equal(list.length, Math.ceil(manifest.packCount / 6),
            `${label}: ${name} must be batched six at a time`);
        assert.ok(list.every(batch => batch.count > 0 && batch.count <= 6),
            `${label}: ${name} must stay bounded to six objects per transaction`);
    }

    assert.ok(metrics.maxPullInflight >= 1 && metrics.maxPullInflight <= 6,
        `${label}: pull concurrency must stay within six requests, observed ${metrics.maxPullInflight}`);
    if ('pullRequests' in metrics) {
        assert.equal(metrics.pullRequests, manifest.pageCount + manifest.packCount,
            `${label}: restore must pull every manifest page and pack exactly once`);
    }
    if ('packNetworkRequests' in metrics) {
        assert.equal(metrics.packNetworkRequests, manifest.packCount,
            `${label}: first restore must fetch every pack when the local cache is empty`);
    }
}
