// 图库前端：v2 视觉交互（album 分组/选择模式/全屏查看器）+ v3 引擎
//（鉴权 fetch 读取、密码不进 URL、缩略图按需回填、游标分页、游标清空角色）。
(function () {
    'use strict';
    const key = 'rp_hub_sync_password_v1';
    const $ = id => document.getElementById(id);
    const authBox = $('auth'), appBox = $('app'), library = $('library');
    const stats = $('stats'), notice = $('notice'), filter = $('filter');
    const deleteModeButton = $('deleteMode'), cancelDeleteButton = $('cancelDelete'), deleteSelectedButton = $('deleteSelected');
    const selectionCount = $('selectionCount'), moreButton = $('more');
    const viewer = $('viewer'), viewerImage = $('viewerImage'), viewerTitle = $('viewerTitle'), viewerCount = $('viewerCount');
    const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const formatBytes = bytes => {
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = Math.max(0, Number(bytes) || 0), i = 0;
        while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
        return (i ? value.toFixed(1) : value) + ' ' + units[i];
    };
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
    // 数据：photos 全量累积（游标分页），按角色分组渲染。
    const photos = new Map();
    const urls = new Set();
    const selected = new Set();
    let cursor = null, loading = false, deleteMode = false, deleteBusy = false;
    let revision = 0, viewerUrl = null, viewerList = [], viewerIndex = -1;
    function release(url) { if (url) { URL.revokeObjectURL(url); urls.delete(url); } }
    function setNotice(text, isError) { notice.textContent = text || ''; notice.style.color = isError ? '#dc2626' : ''; }
    function visibleCharacters() {
        const name = filter.value;
        const groups = new Map();
        for (const photo of photos.values()) {
            if (name && photo.characterName !== name) continue;
            if (!groups.has(photo.characterName)) groups.set(photo.characterName, []);
            groups.get(photo.characterName).push(photo);
        }
        return [...groups.entries()].map(([characterName, list]) => ({ characterName, list: list.sort((a, b) => a.key < b.key ? -1 : 1) })).sort((a, b) => a.characterName < b.characterName ? -1 : 1);
    }
    function viewerSequence() {
        const list = [];
        for (const group of visibleCharacters()) for (const photo of group.list) list.push(photo);
        return list;
    }
    function syncToolbar() {
        selectionCount.textContent = deleteMode ? '已选 ' + selected.size + ' 张' : '';
        selectionCount.classList.toggle('hidden', !deleteMode);
        deleteModeButton.classList.toggle('hidden', deleteMode);
        cancelDeleteButton.classList.toggle('hidden', !deleteMode);
        deleteSelectedButton.classList.toggle('hidden', !deleteMode);
        deleteSelectedButton.disabled = !selected.size || deleteBusy;
        moreButton.hidden = !cursor;
        moreButton.disabled = loading;
        $('refresh').disabled = loading;
    }
    function render() {
        const groups = visibleCharacters();
        if (!groups.length) { library.innerHTML = '<div class="empty">' + (photos.size ? '该角色暂无图片' : '没有图片') + '</div>'; syncToolbar(); return; }
        const html = [];
        for (const group of groups) {
            const tiles = group.list.map(photo => {
                const selectedClass = selected.has(photo.key) ? ' selected' : '';
                return '<button class="photo' + selectedClass + '" data-key="' + esc(photo.key) + '"><img loading="lazy" decoding="async" alt=""><span class="photo-check"></span><span class="photo-info">' + esc(formatBytes(photo.size)) + '</span></button>';
            }).join('');
            html.push('<section class="album"><div class="album-head"><div class="album-head-main"><div class="album-title">' + esc(group.characterName) + '</div><div class="album-meta">' + group.list.length + ' 张</div></div></div><div class="gallery">' + tiles + '</div><div class="album-actions"><div class="album-primary-actions"><button class="album-clear" data-character="' + esc(group.characterName) + '">清空本组</button></div></div></section>');
        }
        library.innerHTML = html.join('');
        scheduleThumbs();
        syncToolbar();
    }
    // 缩略图按需回填：读缓存缩略图，缺失时拉原图缩放并回传（并发 2）。
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
    function scheduleThumbs() {
        for (const img of library.querySelectorAll('.photo img:not([src])')) observer.observe(img);
    }
    async function load(reset = false) {
        if (loading) return;
        loading = true; syncToolbar();
        if (reset) {
            for (const url of [...urls]) if (url !== viewerUrl) release(url);
            observer.disconnect(); queue.length = 0;
            photos.clear(); selected.clear(); cursor = null;
            filter.replaceChildren(new Option('全部角色', ''));
        }
        try {
            stats.textContent = '正在读取…';
            const result = await (await request('library' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''))).json();
            for (const image of result.images) {
                if (!photos.has(image.key)) photos.set(image.key, image);
                if (![...filter.options].some(option => option.value === image.characterName)) filter.append(new Option(image.characterName, image.characterName));
            }
            cursor = result.cursor;
            const totalBytes = [...photos.values()].reduce((sum, p) => sum + (p.size || 0), 0);
            stats.textContent = photos.size + ' 张图片 / ' + formatBytes(totalBytes);
            setNotice('');
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
    async function preview(imageKey) {
        const sequence = viewerSequence();
        const index = sequence.findIndex(photo => photo.key === imageKey);
        if (index < 0) return;
        viewerList = sequence;
        viewerIndex = index;
        const expected = ++revision;
        setNotice('正在加载原图…');
        try {
            const blob = await (await request('image?key=' + encodeURIComponent(imageKey))).blob();
            if (expected !== revision) return;
            release(viewerUrl); viewerUrl = URL.createObjectURL(blob); urls.add(viewerUrl);
            viewerImage.src = viewerUrl;
            viewerTitle.textContent = sequence[index].characterName;
            viewerCount.textContent = (index + 1) + ' / ' + sequence.length;
            viewer.classList.remove('hidden');
            setNotice('');
        } catch (e) { if (e.status !== 401) setNotice(e.message, true); }
    }
    function stepViewer(delta) {
        if (!viewerList.length) return;
        viewerIndex = (viewerIndex + delta + viewerList.length) % viewerList.length;
        preview(viewerList[viewerIndex].key);
    }
    function closeViewer() {
        revision++;
        viewer.classList.add('hidden');
        viewerImage.removeAttribute('src');
        release(viewerUrl); viewerUrl = null; viewerList = []; viewerIndex = -1;
    }
    async function clearCharacter(name) {
        if (!name || deleteBusy || !confirm('删除角色「' + name + '」的全部图片？删除后旧链接不会重新生图。')) return;
        deleteBusy = true; syncToolbar();
        try {
            let pageCursor = null;
            do {
                const body = { characterNames: [name], ...(pageCursor ? { cursor: pageCursor } : {}) };
                const result = await (await request('delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
                for (const imageKey of result.acceptedKeys) { photos.delete(imageKey); selected.delete(imageKey); }
                if (result.failedCount) throw new Error('部分图片删除失败，请重试。');
                pageCursor = result.continuation?.cursor || null;
            } while (pageCursor);
            setNotice('已清空角色「' + name + '」。');
            render();
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
            await load(true);
        } catch (e) {
            if (old === null) localStorage.removeItem(key); else localStorage.setItem(key, old);
            $('authMsg').textContent = e.message;
        }
    });
    $('password').addEventListener('keydown', event => { if (event.key === 'Enter') $('login').click(); });
    deleteModeButton.addEventListener('click', () => setDeleteMode(true));
    cancelDeleteButton.addEventListener('click', () => setDeleteMode(false));
    deleteSelectedButton.addEventListener('click', async () => {
        if (deleteBusy || !selected.size || !confirm('确定删除选中的 ' + selected.size + ' 张图片吗？删除后旧链接不会重新生图。')) return;
        deleteBusy = true; syncToolbar();
        try {
            const keys = [...selected];
            for (let offset = 0; offset < keys.length; offset += 20) {
                const result = await (await request('delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: keys.slice(offset, offset + 20) }) })).json();
                for (const imageKey of result.acceptedKeys) { photos.delete(imageKey); selected.delete(imageKey); }
                if (result.failedCount) throw new Error('部分图片删除失败，请重试。');
            }
            setNotice('已删除所选图片。');
            render();
        } catch (e) { setNotice(e.message, true); }
        finally { deleteBusy = false; syncToolbar(); }
    });
    library.addEventListener('click', event => {
        const clearButton = event.target.closest('.album-clear');
        if (clearButton) { clearCharacter(clearButton.dataset.character); return; }
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
    $('refresh').addEventListener('click', () => load(true));
    moreButton.addEventListener('click', () => load());
    filter.addEventListener('change', render);
    $('closeViewer').addEventListener('click', closeViewer);
    $('prevImage').addEventListener('click', () => stepViewer(-1));
    $('nextImage').addEventListener('click', () => stepViewer(1));
    document.addEventListener('keydown', event => {
        if (viewer.classList.contains('hidden')) return;
        if (event.key === 'Escape') closeViewer();
        if (event.key === 'ArrowLeft') stepViewer(-1);
        if (event.key === 'ArrowRight') stepViewer(1);
    });
    window.addEventListener('pagehide', () => { observer.disconnect(); for (const url of urls) URL.revokeObjectURL(url); });
    // 入口：先探测密码态，决定显示锁卡还是直接进图库。
    (async () => {
        try {
            const result = await (await request('auth-status')).json();
            if (result.authenticated) { appBox.classList.remove('hidden'); await load(true); }
            else showAuth();
        } catch { showAuth('网络不可用，请刷新重试。'); }
    })();
})();
