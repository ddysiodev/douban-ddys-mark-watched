// ==UserScript==
// @name         豆瓣 DDYS 命中资源标记看过
// @namespace    ddys-douban-tools
// @version      0.4.0
// @description  读取 DDYS 插件在豆瓣选电影页检测到的资源命中缓存，直接批量标记为豆瓣“看过（私密）”。
// @match        https://movie.douban.com/explore*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  if (location.hostname !== 'movie.douban.com' || !location.pathname.startsWith('/explore')) {
    return;
  }

  const MARKED_KEY = 'ddys_tm_marked_watched_ids_v3';
  const DDYS_FOUND_KEYS = [
    'ddys_found_resources_v3',
    'ddys_found_resources_v2',
    'ddys_found_resources'
  ];
  const MIN_DELAY_MS = 2500;
  const MAX_DELAY_MS = 5500;
  const LOAD_MORE_TIMEOUT_MS = 22000;
  const LOAD_MORE_SETTLE_MS = 2500;

  let running = false;
  let markedIds = loadMarkedIds();
  let panel;
  let countEl;
  let statusEl;
  let startBtn;
  let stopBtn;
  let refreshBtn;
  let autoLoadMoreInput;

  function loadMarkedIds() {
    try {
      return new Set(JSON.parse(localStorage.getItem(MARKED_KEY) || '[]'));
    } catch (error) {
      return new Set();
    }
  }

  function saveMarkedIds() {
    localStorage.setItem(MARKED_KEY, JSON.stringify(Array.from(markedIds)));
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randomDelay() {
    return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
  }

  function getText(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function getCk() {
    const cookieMatch = document.cookie.match(/(?:^|;\s*)ck=([^;]+)/);
    if (cookieMatch) return decodeURIComponent(cookieMatch[1]);

    const ckLink = document.querySelector('a[href*="ck="]');
    if (ckLink) {
      const match = ckLink.href.match(/[?&]ck=([^&]+)/);
      if (match) return decodeURIComponent(match[1]);
    }

    return '';
  }

  function getSubjectIdFromUrl(url) {
    if (!url) return '';

    try {
      const parsed = new URL(url, location.href);
      const direct = parsed.pathname.match(/\/(?:subject|movie|tv)\/(\d+)(?:[/?#]|$)/);
      if (direct) return direct[1];

      const uri = parsed.searchParams.get('uri') || '';
      if (uri) return getSubjectIdFromUrl(uri);
    } catch (error) {
      const raw = String(url);
      const direct = raw.match(/\/(?:subject|movie|tv)\/(\d+)(?:[/?#]|$)/);
      if (direct) return direct[1];

      const subject = raw.match(/subject[\/=](\d{5,})/);
      if (subject) return subject[1];
    }

    return '';
  }

  function readFoundResourceMap() {
    const found = new Map();

    for (const key of DDYS_FOUND_KEYS) {
      let rows = [];
      try {
        rows = JSON.parse(sessionStorage.getItem(key) || '[]');
      } catch (error) {
        rows = [];
      }

      if (!Array.isArray(rows)) continue;

      rows.forEach(row => {
        if (!Array.isArray(row) || row.length < 1) return;
        const id = String(row[0] || '').trim();
        const ddysUrl = String(row[1] || '').trim();
        if (/^\d{5,}$/.test(id)) {
          found.set(id, ddysUrl);
        }
      });
    }

    return found;
  }

  function findSubjectLink(id) {
    const links = Array.from(document.querySelectorAll('a[href]'));
    return links.find(link => getSubjectIdFromUrl(link.href || link.getAttribute('href')) === String(id)) || null;
  }

  function findItemContainer(link) {
    if (!link) return null;
    return link.closest('.drc-subject-card') ||
      link.closest('.subject-card') ||
      link.closest('.item') ||
      link.closest('li') ||
      link.closest('[class*="card"]') ||
      link.closest('[class*="item"]') ||
      link.parentElement;
  }

  function getTitleFromContainer(container, link, id) {
    const selectors = [
      '.drc-subject-info-title-text',
      '.title',
      '[class*="title"]',
      'h3',
      'h4'
    ];

    if (container) {
      for (const selector of selectors) {
        const el = container.querySelector(selector);
        const text = getText(el);
        if (text) return text;
      }
    }

    return getText(link) || `豆瓣条目 ${id}`;
  }

  function markContainer(info, text, type) {
    const container = info.container;
    if (!container) return;

    let badge = container.querySelector('.ddys-tm-watch-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ddys-tm-watch-badge';
      badge.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'margin-left:6px',
        'padding:4px 8px',
        'border-radius:3px',
        'font-size:12px',
        'line-height:1.2',
        'white-space:nowrap'
      ].join(';');

      const host = container.querySelector('.ddys-list-actions') ||
        container.querySelector('.ddys-play-btn') ||
        container.querySelector('.ddys-resource-link') ||
        container;
      host.appendChild(badge);
    }

    const ok = type === 'done';
    const fail = type === 'fail';
    const working = type === 'working';
    badge.textContent = text;
    badge.style.background = ok ? '#f0fdf4' : fail ? '#fef2f2' : working ? '#eff6ff' : '#f9fafb';
    badge.style.color = ok ? '#166534' : fail ? '#b91c1c' : working ? '#1d4ed8' : '#374151';
    badge.style.border = ok ? '1px solid #86efac' : fail ? '1px solid #fca5a5' : working ? '1px solid #93c5fd' : '1px solid #d1d5db';
  }

  function collectCandidates() {
    const foundMap = readFoundResourceMap();
    const candidates = [];

    foundMap.forEach((ddysUrl, id) => {
      if (markedIds.has(id)) return;

      const link = findSubjectLink(id);
      const container = findItemContainer(link);
      candidates.push({
        id,
        ddysUrl,
        link,
        container,
        title: getTitleFromContainer(container, link, id)
      });
    });

    return candidates;
  }

  async function markWatched(info) {
    const ck = getCk();
    if (!ck) {
      throw new Error('没有拿到豆瓣 ck，请确认当前账号已登录');
    }

    const formData = new FormData();
    formData.append('interest', 'collect');
    formData.append('private', 'on');
    formData.append('ck', ck);

    const response = await fetch(`/j/subject/${info.id}/interest`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      }
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`豆瓣返回 ${response.status}`);
    }
    if (/captcha|verify|验证|登录|login/i.test(text)) {
      throw new Error('豆瓣要求验证或重新登录');
    }

    markedIds.add(info.id);
    saveMarkedIds();
    markContainer(info, '已标看过(私密)', 'done');
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function updateCount() {
    const foundCount = readFoundResourceMap().size;
    const candidates = collectCandidates();
    if (countEl) countEl.textContent = String(candidates.length);
    setStatus(`DDYS 缓存命中 ${foundCount} 个，待 POST 标记 ${candidates.length} 个。`);
    return candidates;
  }

  function getLoadedSubjectIds() {
    const ids = new Set();
    document.querySelectorAll('a[href]').forEach(link => {
      const id = getSubjectIdFromUrl(link.href || link.getAttribute('href'));
      if (id) ids.add(id);
    });
    return ids;
  }

  function readCheckedCount() {
    const keys = [
      'ddys_checked_items_v3',
      'ddys_checked_items_v2',
      'ddys_checked_items'
    ];
    let max = 0;
    keys.forEach(key => {
      try {
        const rows = JSON.parse(sessionStorage.getItem(key) || '[]');
        if (Array.isArray(rows)) max = Math.max(max, rows.length);
      } catch (error) {}
    });
    return max;
  }

  function findLoadMoreButton() {
    const controls = Array.from(document.querySelectorAll('button,a'));
    return controls.find(control => {
      if (control.disabled) return false;
      if (control.getAttribute('aria-disabled') === 'true') return false;
      if (control.offsetParent === null) return false;
      return /加载更多/.test(getText(control));
    }) || null;
  }

  async function clickLoadMoreAndWait() {
    const button = findLoadMoreButton();
    if (!button) {
      setStatus('没有找到“加载更多”按钮，已结束。');
      return false;
    }

    const beforeSubjectCount = getLoadedSubjectIds().size;
    const beforeFoundCount = readFoundResourceMap().size;
    const beforeCheckedCount = readCheckedCount();

    setStatus('当前页已处理完，正在点击“加载更多”...');
    button.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(600);
    button.click();

    const startedAt = Date.now();
    while (running && Date.now() - startedAt < LOAD_MORE_TIMEOUT_MS) {
      await sleep(900);

      const subjectCount = getLoadedSubjectIds().size;
      const foundCount = readFoundResourceMap().size;
      const checkedCount = readCheckedCount();
      const candidates = collectCandidates();

      if (candidates.length > 0) {
        setStatus(`加载更多后发现 ${candidates.length} 个待 POST 条目。`);
        return true;
      }

      if (subjectCount > beforeSubjectCount) {
        setStatus('新条目已加载，等待 DDYS 插件检测资源...');
      }

      if (foundCount > beforeFoundCount || checkedCount > beforeCheckedCount) {
        await sleep(LOAD_MORE_SETTLE_MS);
        return true;
      }
    }

    const changed = getLoadedSubjectIds().size > beforeSubjectCount;
    if (changed) {
      setStatus('新条目已加载，但暂时没有新的 DDYS 命中；继续尝试下一页。');
      return true;
    }

    setStatus('等待“加载更多”超时，已停止。');
    return false;
  }

  function setRunningState(value) {
    running = value;
    if (startBtn) startBtn.disabled = value;
    if (stopBtn) stopBtn.disabled = !value;
  }

  async function runBatch() {
    if (running) return;

    setRunningState(true);
    let success = 0;
    let loadMoreClicks = 0;

    try {
      while (running) {
        let candidates = collectCandidates();
        if (candidates.length === 0) {
          updateCount();
          if (autoLoadMoreInput && autoLoadMoreInput.checked) {
            const loaded = await clickLoadMoreAndWait();
            if (loaded) {
              loadMoreClicks += 1;
              continue;
            }
          } else if (success === 0) {
            setStatus('没有可处理条目：先等 DDYS 插件检测出“去观看”，再点刷新计数。');
          }
          break;
        }

        const info = candidates[0];
        setStatus(`POST 标记中：${info.title} (${info.id})`);
        markContainer(info, 'POST 标记中...', 'working');

        try {
          await markWatched(info);
          success += 1;
          setStatus(`已完成 ${success} 个，等待下一条...`);
        } catch (error) {
          markContainer(info, `失败：${error.message}`, 'fail');
          setStatus(`已停止：${error.message}`);
          break;
        }

        if (running) {
          await sleep(randomDelay());
        }
      }
    } finally {
      setRunningState(false);
      updateCount();
      if (success > 0) {
        setStatus(`本次 POST 完成 ${success} 个；加载更多 ${loadMoreClicks} 次；剩余 ${collectCandidates().length} 个。`);
      }
    }
  }

  function createPanel() {
    panel = document.createElement('div');
    panel.id = 'ddys-tm-watch-panel';
    panel.style.cssText = [
      'position:fixed',
      'right:28px',
      'top:260px',
      'z-index:2147483647',
      'width:250px',
      'padding:12px',
      'background:#fff',
      'border:1px solid #d8d8d8',
      'border-radius:6px',
      'box-shadow:0 2px 12px rgba(0,0,0,.12)',
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif',
      'color:#222'
    ].join(';');

    panel.innerHTML = `
      <div style="font-weight:600;margin-bottom:8px;">DDYS 直接 POST 标看过</div>
      <div style="margin-bottom:8px;">待标记：<strong id="ddys-tm-watch-count">0</strong></div>
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">
        <input id="ddys-tm-watch-auto-load" type="checkbox" checked>
        <span>处理完自动点“加载更多”</span>
      </label>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <button id="ddys-tm-watch-start" type="button" style="flex:1;padding:6px 8px;border:1px solid #e6c547;background:#f5d547;color:#8b4513;border-radius:3px;cursor:pointer;">开始POST</button>
        <button id="ddys-tm-watch-stop" type="button" disabled style="flex:1;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;color:#555;border-radius:3px;cursor:pointer;">停止</button>
      </div>
      <button id="ddys-tm-watch-refresh" type="button" style="width:100%;padding:6px 8px;margin-bottom:10px;border:1px solid #ddd;background:#fff;color:#555;border-radius:3px;cursor:pointer;">刷新计数</button>
      <div id="ddys-tm-watch-status" style="color:#666;font-size:12px;">等 DDYS 插件检测出“去观看”后，点刷新计数。</div>
    `;

    document.body.appendChild(panel);

    countEl = panel.querySelector('#ddys-tm-watch-count');
    statusEl = panel.querySelector('#ddys-tm-watch-status');
    startBtn = panel.querySelector('#ddys-tm-watch-start');
    stopBtn = panel.querySelector('#ddys-tm-watch-stop');
    refreshBtn = panel.querySelector('#ddys-tm-watch-refresh');
    autoLoadMoreInput = panel.querySelector('#ddys-tm-watch-auto-load');

    startBtn.addEventListener('click', runBatch);
    stopBtn.addEventListener('click', () => {
      setRunningState(false);
      setStatus('已手动停止。');
    });
    refreshBtn.addEventListener('click', updateCount);
  }

  function init() {
    createPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
