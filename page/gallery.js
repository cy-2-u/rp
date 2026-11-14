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
    const formatBytes = value => { let n = Number(value) || 0; if (n < 1024) return n + ' B'; const units = ['KB', 'MB', 'GB']; let index = -1; do { n /= 1024; index++; } while (n >= 1024 && index < units.length - 1); return n.toFixed(1) + ' ' + units[index]; };
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
    // 缩略图回填（v2 管线）：缩略图 404 时瓦片先直连原图保证立即可见，
    // 原图加载完成（load 委托）后从已解码的 <img> 画 480px WebP 上传，
    // 成功后瓦片切回缩略图；失败按 800ms 间隔重试至多 3 次。
    let thumbBackfillRunning = 0;
    const thumbBackfillQueue = [];
    const thumbBackfillQueued = new Set(), thumbBackfillDone = new Set(), thumbBackfillAttempts = new Map();
    window.thumbFailed = img => {
        const tile = img.closest('.photo');
        const key = tile && tile.dataset.key;
        if (!key) return;
        img.onerror = null;
        img.dataset.needsThumb = '1';
        img.src = originalUrl(key);
    };
    function thumbBlobFromImage(img) {
        return new Promise((resolve, reject) => {
            const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
            if (!w || !h) return reject(new Error('图片未加载完成'));
            const scale = Math.min(1, 480 / Math.max(w, h));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(w * scale));
            canvas.height = Math.max(1, Math.round(h * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('缩略图生成失败')), 'image/webp', 0.8);
        });
    }
    async function uploadAdminThumb(key, img) {
        if (!img.complete || !img.naturalWidth) return;
        const blob = await thumbBlobFromImage(img);
        const response = await request('thumb?key=' + encodeURIComponent(key), { method: 'PUT', headers: { 'content-type': 'image/webp' }, body: blob });
        if (!response.ok) throw new Error('缩略图上传失败');
        img.removeAttribute('data-needs-thumb');
        img.src = thumbUrl(key);
    }
    function queueThumbBackfill(img) {
        if (!img || !img.isConnected || !img.matches('img[data-needs-thumb="1"]') || !img.complete || !img.naturalWidth) return;
        const tile = img.closest('.photo');
        const key = tile && tile.dataset.key;
        if (!key || thumbBackfillDone.has(key) || thumbBackfillQueued.has(key)) return;
        thumbBackfillQueued.add(key);
        thumbBackfillQueue.push({ key, img });
        scheduleThumbBackfill();
    }
    function scheduleThumbBackfill() {
        while (thumbBackfillRunning < 3 && thumbBackfillQueue.length) {
            const item = thumbBackfillQueue.shift();
            if (!item || !item.img.isConnected) { if (item) thumbBackfillQueued.delete(item.key); continue; }
            thumbBackfillRunning++;
            Promise.resolve(uploadAdminThumb(item.key, item.img)).then(() => {
                thumbBackfillDone.add(item.key);
                thumbBackfillAttempts.delete(item.key);
            }).catch(() => {
                const attempts = (thumbBackfillAttempts.get(item.key) || 0) + 1;
                thumbBackfillAttempts.set(item.key, attempts);
                if (attempts < 3) setTimeout(() => { thumbBackfillQueued.delete(item.key); queueThumbBackfill(item.img); }, 800);
            }).finally(() => { thumbBackfillRunning--; thumbBackfillQueued.delete(item.key); scheduleThumbBackfill(); });
        }
    }
    library.addEventListener('load', event => {
        if (event.target && event.target.matches && event.target.matches('img[data-needs-thumb="1"]')) queueThumbBackfill(event.target);
    }, true);
    async function load() {
        if (loading) return;
        loading = true; syncToolbar();
        const scrollPosition = window.scrollY;
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
            // 重绘后恢复滚动位置（v2 管线）：长列表刷新/兜底重载不跳顶。
            requestAnimationFrame(() => window.scrollTo({ top: scrollPosition, behavior: 'instant' }));
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
    // 乐观更新（v2 removeDeletedImages 管线）：删除全部成功后直接改本地
    // 分组重渲染，省一次 library 全量重拉；后续 load() 兜底仍会校正。
    function removeLocal(payload) {
        if (!data) { load(); return; }
        const keys = new Set(payload.keys || []);
        const names = new Set(payload.characterNames || []);
        data.characters = (data.characters || []).map(group => {
            const images = names.has(group.name) ? [] : group.images.filter(image => !keys.has(image.key));
            if (!images.length) return null;
            const size = images.reduce((sum, image) => sum + (Number(image.size) || 0), 0);
            return { ...group, images, count: images.length, size, sizeHuman: formatBytes(size) };
        }).filter(Boolean);
        data.totalCount = data.characters.reduce((sum, group) => sum + group.images.length, 0);
        data.totalHuman = formatBytes(data.characters.reduce((sum, group) => sum + (Number(group.size) || 0), 0));
        characterRenderLimits = Object.create(null);
        setDeleteMode(false);
        stats.textContent = data.totalCount + ' 张图片 / ' + data.totalHuman;
        render();
    }
    async function deletePayload(payload, message) {
        if (deleteBusy || !confirm(message)) return;
        deleteBusy = true; syncToolbar();
        let attempted = false;
        try {
            const queue = [];
            if (payload.characterNames?.length) queue.push({ characterNames: payload.characterNames });
            else {
                const keys = [...new Set(payload.keys || [])];
                for (let offset = 0; offset < keys.length; offset += 20) queue.push({ keys: keys.slice(offset, offset + 20) });
            }
            for (let index = 0; index < queue.length; index++) {
                const result = await (await request('delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(queue[index]) })).json();
                attempted = true;
                if (result.failedCount) throw new Error('部分图片删除失败，请重试。');
                if (result.continuation) queue.push(result.continuation);
            }
            setNotice('删除完成。');
            removeLocal(payload);
        } catch (e) {
            // 云端已部分删除时重拉真值校正；notice 在 load 之后设置避免被清掉。
            if (attempted) await load();
            setNotice(e.message, true);
        }
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
