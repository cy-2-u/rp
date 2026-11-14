// 管理页图片通过鉴权 fetch 读取，密码不进入图片 URL。
(function () {
    'use strict';
    const key = 'rp_hub_sync_password_v1';
    const $ = id => document.getElementById(id);
    const grid = $('grid'), status = $('status'), selected = new Set(), urls = new Set(), cards = new Map();
    let cursor = null, loading = false, revision = 0, viewerUrl;
    async function request(path, options = {}) {
        const response = await fetch('/image/api/' + path, { ...options, headers: { 'x-rp-sync-password': localStorage.getItem(key) || '', ...options.headers } });
        if (response.status === 401) { if (!$('login').open) $('login').showModal(); throw new Error('请输入同步密码。'); }
        if (!response.ok) throw Object.assign(new Error('请求失败：HTTP ' + response.status), { status: response.status });
        return response;
    }
    const release = url => { if (url) { URL.revokeObjectURL(url); urls.delete(url); } };
    function visibility() {
        const name = $('filter').value;
        for (const card of cards.values()) card.hidden = Boolean(name && card.dataset.character !== name);
        $('delete').disabled = !selected.size || loading;
        $('clear').hidden = !name;
        $('clear').disabled = loading;
    }
    async function preview(imageKey) {
        const dialog = $('viewer'), expected = ++revision;
        status.textContent = '正在加载原图…';
        try {
            const blob = await (await request('image?key=' + encodeURIComponent(imageKey))).blob();
            if (expected !== revision) return;
            release(viewerUrl); viewerUrl = URL.createObjectURL(blob); urls.add(viewerUrl);
            dialog.querySelector('img').src = viewerUrl;
            if (!dialog.open) dialog.showModal();
            status.textContent = '';
        } catch (e) { status.textContent = e.message; }
    }
    const queue = [];
    let readers = 0;
    async function thumbnail(imageKey) {
        try { return await (await request('thumb?key=' + encodeURIComponent(imageKey))).blob(); }
        catch (e) { if (e.status !== 404) throw e; }
        const original = await (await request('image?key=' + encodeURIComponent(imageKey))).blob();
        const bitmap = await createImageBitmap(original);
        let blob;
        try {
            const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .78));
        } finally { bitmap.close(); }
        if (!blob || blob.type !== 'image/webp') throw new Error('浏览器无法生成 WebP 缩略图。');
        await request('thumb?key=' + encodeURIComponent(imageKey), { method: 'PUT', headers: { 'content-type': 'image/webp' }, body: blob });
        return blob;
    }
    function drain() {
        while (readers < 2 && queue.length) {
            const img = queue.shift();
            if (!img.isConnected) continue;
            readers++;
            thumbnail(img.dataset.key).then(blob => {
                if (!img.isConnected) return;
                const url = URL.createObjectURL(blob); urls.add(url); img.src = url;
            }).catch(() => { if (img.isConnected) img.alt = '缩略图加载失败，点击查看原图'; }).finally(() => { readers--; drain(); });
        }
    }
    const observer = new IntersectionObserver(entries => {
        for (const item of entries) if (item.isIntersecting) { observer.unobserve(item.target); queue.push(item.target); }
        drain();
    }, { rootMargin: '300px' });
    function add(image) {
        if (cards.has(image.key)) return;
        const card = document.createElement('article'), img = document.createElement('img'), label = document.createElement('label'), check = document.createElement('input');
        card.dataset.character = image.characterName; img.dataset.key = image.key; img.alt = image.characterName; img.decoding = 'async'; img.onclick = () => preview(image.key);
        check.type = 'checkbox'; check.onchange = () => { check.checked ? selected.add(image.key) : selected.delete(image.key); visibility(); };
        label.append(check, document.createTextNode(image.characterName)); card.append(img, label); cards.set(image.key, card); grid.append(card); observer.observe(img);
        if (![...$('filter').options].some(option => option.value === image.characterName)) { const option = document.createElement('option'); option.value = image.characterName; option.textContent = image.characterName; $('filter').append(option); }
    }
    async function load(reset = false) {
        if (loading) return;
        loading = true; $('more').disabled = true; $('refresh').disabled = true; visibility();
        if (reset) { observer.disconnect(); for (const url of [...urls]) if (url !== viewerUrl) release(url); grid.replaceChildren(); cards.clear(); selected.clear(); cursor = null; $('filter').replaceChildren(new Option('全部角色', '')); }
        try {
            status.textContent = '正在读取图片…';
            const result = await (await request('library' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''))).json();
            result.images.forEach(add); cursor = result.cursor; $('more').hidden = !cursor; status.textContent = cards.size ? '已加载 ' + cards.size + ' 张图片' : '暂无图片';
        } catch (e) { status.textContent = e.message; }
        finally { loading = false; $('more').disabled = false; $('refresh').disabled = false; visibility(); }
    }
    $('login').querySelector('form').onsubmit = async event => {
        event.preventDefault(); const input = $('login').querySelector('input'), old = localStorage.getItem(key);
        localStorage.setItem(key, input.value);
        try { const result = await (await request('auth-status')).json(); if (!result.authenticated) throw new Error('密码不正确。'); $('login').close(); await load(true); }
        catch (e) { if (old === null) localStorage.removeItem(key); else localStorage.setItem(key, old); $('login').querySelector('p').textContent = e.message; }
    };
    $('delete').onclick = async () => {
        if (loading || !selected.size || !confirm('删除所选图片？聊天中的对应图片会显示已清理。')) return;
        loading = true; visibility();
        try {
            const keys = [...selected];
            for (let offset = 0; offset < keys.length; offset += 20) {
                const result = await (await request('delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: keys.slice(offset, offset + 20) }) })).json();
                for (const imageKey of result.acceptedKeys) { const card = cards.get(imageKey); release(card?.querySelector('img').src); card?.remove(); cards.delete(imageKey); selected.delete(imageKey); }
                if (result.failedCount) throw new Error('部分图片删除失败，请重试。');
            }
            status.textContent = '已删除所选图片。';
        } catch (e) { status.textContent = e.message; }
        finally { loading = false; visibility(); }
    };
    $('clear').onclick = async () => {
        const name = $('filter').value;
        if (!name || loading || !confirm('删除角色「' + name + '」的全部图片？聊天中的对应图片会显示已清理。')) return;
        loading = true; visibility();
        try {
            let cursor = null;
            do {
                const body = { characterNames: [name], ...(cursor ? { cursor } : {}) };
                const result = await (await request('delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
                for (const imageKey of result.acceptedKeys) { const card = cards.get(imageKey); release(card?.querySelector('img').src); card?.remove(); cards.delete(imageKey); selected.delete(imageKey); }
                if (result.failedCount) throw new Error('部分图片删除失败，请重试。');
                cursor = result.continuation?.cursor || null;
            } while (cursor);
            status.textContent = '已清空角色「' + name + '」。';
            await load(true);
        } catch (e) { status.textContent = e.message; }
        finally { loading = false; visibility(); }
    };
    $('viewer').querySelector('button').onclick = () => $('viewer').close();
    $('viewer').addEventListener('close', () => { revision++; $('viewer').querySelector('img').removeAttribute('src'); release(viewerUrl); viewerUrl = null; });
    $('filter').onchange = visibility; $('more').onclick = () => load(); $('refresh').onclick = () => load(true);
    window.addEventListener('pagehide', () => { observer.disconnect(); for (const url of urls) URL.revokeObjectURL(url); });
    load();
})();
