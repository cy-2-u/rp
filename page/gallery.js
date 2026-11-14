// 图库前端：v2 加载与显示管线（全量分组一次渲染、缩略图/原图 <img> 直连
// 原生并发与缓存、onerror 回填），管理操作（删除/清空/密码）仍走鉴权 fetch。
(function () {
    'use strict';
    const key = 'rp_hub_sync_password_v1';
    const $ = id => document.getElementById(id);
    const authBox = $('auth'), appBox = $('app'), library = $('library');
    const stats = $('stats'), notice = $('notice'), filter = $('filter');
    const deleteModeButton = $('deleteMode'), cancelDeleteButton = $('cancelDelete'), deleteSelectedButton = $('deleteSelected');
    const selectionCount = $('selectionCount');
    const viewer = $('viewer'), viewerImage = $('viewerImage'), viewerTitle = $('viewerTitle'), viewerCount = $('viewerCount');
    const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const thumbUrl = imageKey => '/image/api/thumb?key=' + encodeURIComponent(imageKey);
    const originalUrl = imageKey => '/image/api/image?key=' + encodeURIComponent(imageKey);
    async function request(path, options = {}) {
        const response = await fetch('/image/api/' + path, { ...options, headers: { 'x-rp-sync-password': localStorage.getItem(key) || '', ...options.headers } });
        if (response.status === 401) { showAuth('请输入同步密码。'); throw Object.assign(new Error('请输入同步密码。'), { status: 401 }); }
        if (!response.ok) throw Object.assign(new Error('请求失败：HTTP ' + response.status), { status: response.status });
        return response;
    }
    function showAuth(message) {
        appBox.classList.add('hidden');
        authBox.classList.remove('hidden');
        if (message) $('authMsg').textContent = message;
    }
    function setNotice(text, isError) { notice.textContent = text || ''; notice.style.color = isError ? '#dc2626' : ''; }
    // 数据：一次全量，characters 分组（Worker 返回形状与 v2 一致）；渲染
    // 每角色限量一页（手机 6 / 电脑 8），组尾"显示更多"按页展开。
    let data = null;
    let loading = false, deleteBusy = false, deleteMode = false;
    const selected = new Set();
    let characterRenderLimits = Object.create(null);
    let viewerList = [], viewerIndex = -1;
    const albumPageSize = () => window.matchMedia && window.matchMedia('(max-width:720px)').matches ? 6 : 8;
    const getCharacterRenderLimit = name => characterRenderLimits[name] || albumPageSize();
    const increaseCharacterRenderLimit = (name, total) => { characterRenderLimits[name] = Math.min(total, getCharacterRenderLimit(name) + albumPageSize()); };
    function syncToolbar() {
        selectionCount.textContent = deleteMode ? '已选 ' + selected.size + ' 张' : '';
        selectionCount.classList.toggle('hidden', !deleteMode);
        deleteModeButton.classList.toggle('hidden', deleteMode);
        cancelDeleteButton.classList.toggle('hidden', !deleteMode);
        deleteSelectedButton.classList.toggle('hidden', !deleteMode);
        deleteSelectedButton.disabled = !selected.size || deleteBusy;
        $('refresh').disabled = loading;
    }
    function visibleGroups() {
        const q = filter.value.trim().toLowerCase();
        return (data?.characters || []).filter(group => !q || group.name.toLowerCase().includes(q));
    }
    function render() {
        const groups = visibleGroups();
        const total = groups.reduce((sum, group) => sum + group.images.length, 0);
        if (!total) { library.innerHTML = '<div class="empty">' + (data ? '没有图片' : '') + '</div>'; syncToolbar(); return; }
        const html = [];
        for (const group of groups) {
            const limit = getCharacterRenderLimit(group.name);
            const shown = group.images.slice(0, limit);
            const remaining = Math.max(0, group.images.length - shown.length);
            const tiles = shown.map(image => {
                const selectedClass = selected.has(image.key) ? ' selected' : '';
                return '<button class="photo' + selectedClass + '" data-key="' + esc(image.key) + '"><img loading="lazy" decoding="async" src="' + esc(thumbUrl(image.key)) + '" onerror="thumbFailed(this)" alt=""><span class="photo-check"></span><span class="photo-info">' + esc(image.sizeHuman) + '</span></button>';
            }).join('');
            const more = remaining > 0 ? '<button class="album-more" data-character="' + esc(group.name) + '" data-total="' + group.images.length + '">显示更多 ' + Math.min(albumPageSize(), remaining) + '</button>' : '';
            html.push('<section class="album"><div class="album-head"><div class="album-head-main"><div class="album-title">' + esc(group.name) + '</div><div class="album-meta">' + shown.length + ' / ' + group.images.length + ' 张 · ' + esc(group.sizeHuman) + '</div></div></div><div class="gallery">' + tiles + '</div><div class="album-actions"><div class="album-primary-actions"><button class="album-clear" data-character="' + esc(group.name) + '">清空本组</button></div>' + more + '</div></section>');
        }
        library.innerHTML = html.join('');
        syncToolbar();
    }
    // 缩略图回填：直连 404 时拉原图缩放为 WebP 上传（并发 2），成功后原地重载。
    const backfillQueue = [];
    let backfillBusy = 0;
    window.thumbFailed = img => {
        if (!img.dataset.key || img.dataset.backfill) return;
        img.dataset.backfill = '1';
        backfillQueue.push(img);
        drainBackfill();
    };
    function drainBackfill() {
        while (backfillBusy < 2 && backfillQueue.length) {
            const img = backfillQueue.shift();
            if (!img.isConnected) continue;
            backfillBusy++;
            (async () => {
                const original = await (await request('image?key=' + encodeURIComponent(img.dataset.key))).blob();
                const bitmap = await createImageBitmap(original);
                let blob;
                try {
                    const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
                    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .78));
                } finally { bitmap.close(); }
                if (!blob || blob.type !== 'image/webp') throw new Error('浏览器无法生成 WebP 缩略图。');
                await request('thumb?key=' + encodeURIComponent(img.dataset.key), { method: 'PUT', headers: { 'content-type': 'image/webp' }, body: blob });
                if (img.isConnected) { img.dataset.backfill = '2'; img.src = thumbUrl(img.dataset.key) + '&t=' + Date.now(); }
            })().catch(() => { /* 回填失败保持占位，下次进入页面重试 */ }).finally(() => { backfillBusy--; drainBackfill(); });
        }
    }
    async function load() {
        if (loading) return;
        loading = true; syncToolbar();
        try {
            stats.textContent = '正在读取...';
            data = await (await request('library', { method: 'GET' })).json();
            const keys = new Set();
            for (const group of data.characters) for (const image of group.images) keys.add(image.key);
            for (const imageKey of [...selected]) if (!keys.has(imageKey)) selected.delete(imageKey);
            stats.textContent = data.totalCount + ' 张图片 / ' + data.totalHuman;
            setNotice('');
            characterRenderLimits = Object.create(null);
            render();
        } catch (e) { if (e.status !== 401) { stats.textContent = '读取失败'; setNotice(e.message, true); } }
        finally { loading = false; syncToolbar(); }
    }
    function setDeleteMode(value) {
        deleteMode = value;
        selected.clear();
        for (const tile of library.querySelectorAll('.photo.selected')) tile.classList.remove('selected');
        document.body.classList.toggle('delete-mode', deleteMode);
        syncToolbar();
    }
    function preview(imageKey) {
        const sequence = [];
        for (const group of visibleGroups()) for (const image of group.images) sequence.push(image);
        const index = sequence.findIndex(image => image.key === imageKey);
        if (index < 0) return;
        viewerList = sequence;
        viewerIndex = index;
        viewerImage.src = originalUrl(imageKey);
        viewerTitle.textContent = data.characters.find(group => group.images.some(image => image.key === imageKey))?.name || '';
        viewerCount.textContent = (index + 1) + ' / ' + sequence.length;
        viewer.classList.remove('hidden');
    }
    function stepViewer(delta) {
        if (!viewerList.length) return;
        viewerIndex = (viewerIndex + delta + viewerList.length) % viewerList.length;
        preview(viewerList[viewerIndex].key);
    }
    function closeViewer() {
        viewer.classList.add('hidden');
        viewerImage.removeAttribute('src');
        viewerList = []; viewerIndex = -1;
    }
    async function deletePayload(payload, message) {
        if (deleteBusy || !confirm(message)) return;
        deleteBusy = true; syncToolbar();
        try {
            const queue = [];
            if (payload.characterNames?.length) queue.push({ characterNames: payload.characterNames });
            else {
                const keys = [...new Set(payload.keys || [])];
                for (let offset = 0; offset < keys.length; offset += 20) queue.push({ keys: keys.slice(offset, offset + 20) });
            }
            for (let index = 0; index < queue.length; index++) {
                const result = await (await request('delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(queue[index]) })).json();
                if (result.failedCount) throw new Error('部分图片删除失败，请重试。');
                if (result.continuation) queue.push(result.continuation);
            }
            setNotice('删除完成。');
            await load();
        } catch (e) { setNotice(e.message, true); }
        finally { deleteBusy = false; syncToolbar(); }
    }
    $('login').addEventListener('click', async () => {
        const input = $('password'), old = localStorage.getItem(key);
        localStorage.setItem(key, input.value);
        try {
            const result = await (await request('auth-status')).json();
            if (!result.authenticated) throw new Error('密码不正确。');
            $('authMsg').textContent = '';
            authBox.classList.add('hidden');
            appBox.classList.remove('hidden');
            await load();
        } catch (e) {
            if (old === null) localStorage.removeItem(key); else localStorage.setItem(key, old);
            $('authMsg').textContent = e.message;
        }
    });
    $('password').addEventListener('keydown', event => { if (event.key === 'Enter') $('login').click(); });
    deleteModeButton.addEventListener('click', () => setDeleteMode(true));
    cancelDeleteButton.addEventListener('click', () => setDeleteMode(false));
    deleteSelectedButton.addEventListener('click', () => deletePayload({ keys: [...selected] }, '确定删除选中的 ' + selected.size + ' 张图片吗？删除后旧链接不会重新生图。'));
    library.addEventListener('click', event => {
        const moreButton = event.target.closest('.album-more');
        if (moreButton) { increaseCharacterRenderLimit(moreButton.dataset.character, Number(moreButton.dataset.total)); render(); return; }
        const clearButton = event.target.closest('.album-clear');
        if (clearButton) { deletePayload({ characterNames: [clearButton.dataset.character] }, '删除角色「' + clearButton.dataset.character + '」的全部图片？删除后旧链接不会重新生图。'); return; }
        const tile = event.target.closest('.photo');
        if (!tile) return;
        const imageKey = tile.dataset.key;
        if (deleteMode) {
            tile.classList.toggle('selected');
            tile.classList.contains('selected') ? selected.add(imageKey) : selected.delete(imageKey);
            syncToolbar();
        } else preview(imageKey);
    });
    $('back').addEventListener('click', () => { location.href = '/'; });
    $('refresh').addEventListener('click', () => load());
    filter.addEventListener('input', () => render());
    $('closeViewer').addEventListener('click', closeViewer);
    $('prevImage').addEventListener('click', () => stepViewer(-1));
    $('nextImage').addEventListener('click', () => stepViewer(1));
    document.addEventListener('keydown', event => {
        if (viewer.classList.contains('hidden')) return;
        if (event.key === 'Escape') closeViewer();
        if (event.key === 'ArrowLeft') stepViewer(-1);
        if (event.key === 'ArrowRight') stepViewer(1);
    });
    // 入口：先探测密码态，决定显示锁卡还是直接进图库。
    (async () => {
        try {
            const result = await (await request('auth-status')).json();
            if (result.authenticated) { appBox.classList.remove('hidden'); await load(); }
            else showAuth();
        } catch { showAuth('网络不可用，请刷新重试。'); }
    })();
})();
