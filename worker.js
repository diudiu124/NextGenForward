/**
 * Open Wegram Bot - Core Logic
 * Shared code between Cloudflare Worker and Vercel deployments
 */

const ADMIN_COOKIE_NAME = 'ngf_admin_session';
const ADMIN_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const KEYWORD_INDEX_KEY = 'keyword:index';
const AI_ENABLED_KEY = 'settings:ai_enabled';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

const textEncoder = new TextEncoder();

function utf8Bytes(value) {
    return textEncoder.encode(value);
}

function base64UrlEncode(bytes) {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(text) {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function safeJson(data) {
    return JSON.stringify(data).replace(/</g, '\\u003c');
}

function htmlResponse(html, status = 200) {
    return new Response(html, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...extraHeaders
        }
    });
}

function setCookieHeader(name, value, maxAgeSeconds) {
    const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure'];
    if (typeof maxAgeSeconds === 'number') {
        parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
    }
    return parts.join('; ');
}

function parseCookies(request) {
    const header = request.headers.get('Cookie') || '';
    const cookies = {};
    header.split(/;\s*/).forEach((item) => {
        if (!item) return;
        const index = item.indexOf('=');
        if (index < 0) return;
        const key = item.slice(0, index);
        const value = item.slice(index + 1);
        cookies[key] = value;
    });
    return cookies;
}

async function hmacSha256(secret, data) {
    const key = await crypto.subtle.importKey(
        'raw',
        utf8Bytes(secret),
        {name: 'HMAC', hash: 'SHA-256'},
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, utf8Bytes(data));
    return base64UrlEncode(new Uint8Array(signature));
}

async function createAdminSession(adminPassword) {
    const expiresAt = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
    const payload = String(expiresAt);
    const signature = await hmacSha256(adminPassword, payload);
    return `${payload}.${signature}`;
}

async function verifyAdminSession(token, adminPassword) {
    if (!token || !adminPassword) {
        return false;
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
        return false;
    }

    const expiresAt = Number(parts[0]);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
        return false;
    }

    const expected = await hmacSha256(adminPassword, parts[0]);
    return expected === parts[1];
}

async function isAdminAuthorized(request, env) {
    return verifyAdminSession(parseCookies(request)[ADMIN_COOKIE_NAME], env.ADMIN_PASSWORD || '');
}

function normalizeText(value) {
    return String(value || '')
        .replace(/\s+/g, '')
        .trim()
        .toLowerCase();
}

function normalizeTriggers(input) {
    if (Array.isArray(input)) {
        return input
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }

    return String(input || '')
        .split(/[\n,锛宂+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function toKeywordView(record) {
    return {
        id: record.id,
        triggers: record.triggers || [],
        reply_text: record.reply_text || '',
        image_key: record.image_key || '',
        enabled: Boolean(record.enabled),
        created_at: record.created_at || '',
        updated_at: record.updated_at || '',
        image_url: record.image_key ? `/admin/api/keywords/${record.id}/image` : ''
    };
}

async function loadKeywordIndex(env) {
    const raw = await env.NGF_KV.get(KEYWORD_INDEX_KEY);
    if (!raw) {
        return [];
    }

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter((item) => typeof item === 'string' && item.length > 0);
    } catch {
        return [];
    }
}

async function saveKeywordIndex(env, ids) {
    await env.NGF_KV.put(KEYWORD_INDEX_KEY, JSON.stringify(ids));
}

async function loadKeywordRecord(env, id) {
    const raw = await env.NGF_KV.get(`keyword:${id}`);
    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function saveKeywordRecord(env, record) {
    await env.NGF_KV.put(`keyword:${record.id}`, JSON.stringify(record));
}

async function deleteKeywordRecord(env, id) {
    await env.NGF_KV.delete(`keyword:${id}`);
}

async function listKeywords(env) {
    const ids = await loadKeywordIndex(env);
    const records = [];

    for (const id of ids) {
        const record = await loadKeywordRecord(env, id);
        if (record) {
            records.push(toKeywordView(record));
        }
    }

    return records;
}

async function getAiEnabled(env) {
    return (await env.NGF_KV.get(AI_ENABLED_KEY)) === '1';
}

async function setAiEnabled(env, enabled) {
    await env.NGF_KV.put(AI_ENABLED_KEY, enabled ? '1' : '0');
}

async function matchKeyword(env, text) {
    const normalizedMessage = normalizeText(text);
    if (!normalizedMessage) {
        return null;
    }

    const records = await listKeywords(env);
    for (const recordView of records) {
        if (!recordView.enabled) {
            continue;
        }
        for (const trigger of recordView.triggers) {
            if (normalizeText(trigger) === normalizedMessage) {
                const fullRecord = await loadKeywordRecord(env, recordView.id);
                return fullRecord ? toKeywordView(fullRecord) : recordView;
            }
        }
    }

    return null;
}

export function validateSecretToken(token) {
    return token.length > 15 && /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

export async function postToTelegramApi(token, method, body) {
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    });
}

async function postToTelegramMultipartApi(token, method, formData) {
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        body: formData
    });
}

async function sendTelegramText(botToken, chatId, text) {
    const message = String(text || '').trim();
    if (!message) {
        return;
    }

    const chunks = [];
    let remaining = message;
    while (remaining.length > 0) {
        chunks.push(remaining.slice(0, 3500));
        remaining = remaining.slice(3500);
    }

    for (const chunk of chunks) {
        await postToTelegramApi(botToken, 'sendMessage', {
            chat_id: parseInt(chatId, 10),
            text: chunk
        });
    }
}

async function sendTelegramPhoto(botToken, chatId, fileBytes, filename, contentType, caption) {
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('photo', new Blob([fileBytes], {type: contentType || 'image/jpeg'}), filename || 'image.jpg');
    if (caption) {
        formData.append('caption', caption);
    }
    return postToTelegramMultipartApi(botToken, 'sendPhoto', formData);
}

async function sendKeywordReply(env, botToken, chatId, keyword) {
    const tasks = [];
    if (keyword.image_key) {
        const image = await env.NGF_IMAGES.get(keyword.image_key);
        if (image) {
            const bytes = await image.arrayBuffer();
            const contentType = image.httpMetadata?.contentType || 'image/jpeg';
            tasks.push(sendTelegramPhoto(botToken, chatId, bytes, keyword.image_key.split('/').pop() || 'image.jpg', contentType));
        }
    }

    if (keyword.reply_text) {
        tasks.push(sendTelegramText(botToken, chatId, keyword.reply_text));
    }

    for (const task of tasks) {
        await task;
    }
}

async function callDeepSeek(env, userText) {
    const apiKey = env.DEEPSEEK_API_KEY || '';
    if (!apiKey) {
        return '';
    }

    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL,
            messages: [
                {role: 'system', content: '浣犳槸涓€涓畝娲佽嚜鐒剁殑 Telegram 绉佽亰鍔╂墜锛岃鐩存帴鍥炵瓟鐢ㄦ埛闂銆?},
                {role: 'user', content: userText}
            ],
            temperature: 0.7
        })
    });

    if (!response.ok) {
        return '';
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || '';
}

function buildDashboardHtml({authenticated, keywords, aiEnabled, adminPasswordMissing}) {
    const bootstrap = safeJson({authenticated, keywords, aiEnabled, adminPasswordMissing});

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NextGenForward Admin</title>
  <style>
    :root { color-scheme: light; --bg:#f5f7fb; --card:#ffffff; --line:#d9e1ee; --text:#102033; --muted:#61728a; --accent:#2563eb; --danger:#c02626; --ok:#15803d; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    .title h1 { font-size: 24px; margin: 0 0 4px; }
    .title p { margin: 0; color: var(--muted); font-size: 14px; }
    .grid { display: grid; grid-template-columns: 360px 1fr; gap: 20px; align-items: start; }
    .panel { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px; }
    .panel h2 { margin: 0 0 14px; font-size: 16px; }
    .field { margin-bottom: 12px; }
    label { display:block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
    input[type=text], input[type=password], textarea, select { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; font: inherit; background: #fff; }
    textarea { min-height: 100px; resize: vertical; }
    .row { display:flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    button { border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; font: inherit; }
    .primary { background: var(--accent); color: #fff; }
    .ghost { background: #eef3fb; color: var(--text); }
    .danger { background: #fee2e2; color: var(--danger); }
    .small { padding: 8px 12px; font-size: 13px; }
    .hint { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .status { margin-top: 12px; font-size: 13px; color: var(--muted); min-height: 20px; }
    .status.ok { color: var(--ok); }
    .status.err { color: var(--danger); }
    .list { display: grid; gap: 12px; }
    .item { border: 1px solid var(--line); border-radius: 10px; padding: 14px; background: #fff; display: grid; gap: 10px; }
    .item-head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .tags { display:flex; gap:6px; flex-wrap:wrap; }
    .tag { display:inline-flex; align-items:center; padding: 4px 8px; border-radius:999px; font-size:12px; background:#eef3fb; color:#29415f; }
    .muted { color: var(--muted); font-size: 13px; }
    .preview { display:flex; gap:12px; align-items:flex-start; flex-wrap:wrap; }
    .preview img { width: 120px; height: 120px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); background:#f8fafc; }
    .split { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .switch { display:inline-flex; align-items:center; gap:8px; user-select:none; }
    .switch input { width: 18px; height: 18px; }
    .hidden { display:none !important; }
    .login-wrap { max-width: 520px; margin: 10vh auto 0; }
    .badge { display:inline-flex; align-items:center; padding: 5px 10px; border-radius:999px; background:#e0f2fe; color:#075985; font-size:12px; }
    @media (max-width: 960px) { .grid { grid-template-columns: 1fr; } .split { grid-template-columns: 1fr; } .topbar { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div id="loginView" class="panel login-wrap${authenticated ? ' hidden' : ''}">
      <h2>绠＄悊鍛樼櫥褰?/h2>
      <div class="field">
        <label for="password">瀵嗙爜</label>
        <input id="password" type="password" placeholder="璇疯緭鍏?ADMIN_PASSWORD" autocomplete="current-password" />
      </div>
      <div class="row">
        <button id="loginBtn" class="primary">鐧诲綍</button>
      </div>
      <div id="loginStatus" class="status"></div>
      <p class="hint">濡傛灉杩欓噷鏄剧ず閿欒锛岃鍏堝湪 Cloudflare Secret 涓缃?<code>ADMIN_PASSWORD</code>銆?/p>
    </div>

    <div id="dashboardView" class="${authenticated ? '' : 'hidden'}">
      <div class="topbar">
        <div class="title">
          <h1>NextGenForward 绠＄悊鍚庡彴</h1>
          <p>鍏抽敭璇嶈嚜鍔ㄥ洖澶嶃€佸浘鐗囩鐞嗗拰 AI 寮€鍏抽兘鍦ㄨ繖閲屽畬鎴愩€?/p>
        </div>
        <div class="row">
          <span id="aiState" class="badge">AI: 鏈姞杞?/span>
          <button id="refreshBtn" class="ghost small">鍒锋柊</button>
          <button id="logoutBtn" class="ghost small">閫€鍑?/button>
        </div>
      </div>

      <div class="grid">
        <section class="panel">
          <h2 id="formTitle">鏂板鍏抽敭璇?/h2>
          <input id="keywordId" type="hidden" />
          <div class="field">
            <label for="triggers">鍏抽敭璇?/label>
            <textarea id="triggers" placeholder="姣忚涓€涓紝涔熷彲浠ョ敤閫楀彿鍒嗛殧"></textarea>
          </div>
          <div class="field">
            <label for="replyText">鍥炲鏂囧瓧</label>
            <textarea id="replyText" placeholder="鍛戒腑鍏抽敭璇嶅悗鑷姩鍙戦€?></textarea>
          </div>
          <div class="field">
            <label for="imageFile">鍥炲鍥剧墖</label>
            <input id="imageFile" type="file" accept="image/*" />
          </div>
          <div class="field">
            <label class="switch"><input id="enabled" type="checkbox" checked /> 鍚敤杩欐潯鍏抽敭璇?/label>
          </div>
          <div class="field">
            <label class="switch"><input id="removeImage" type="checkbox" /> 鍒犻櫎褰撳墠鍥剧墖</label>
          </div>
          <div class="row">
            <button id="saveBtn" class="primary">淇濆瓨</button>
            <button id="clearBtn" class="ghost">娓呯┖</button>
          </div>
          <div id="formStatus" class="status"></div>
        </section>

        <section class="panel">
          <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
            <h2 style="margin:0;">鍏抽敭璇嶅垪琛?/h2>
            <div class="row">
              <label class="switch" style="margin:0;"><input id="aiToggle" type="checkbox" /> 寮€鍚?DeepSeek AI 鍥炲</label>
            </div>
          </div>
          <div id="adminNotice" class="status"></div>
          <div id="keywordList" class="list"></div>
        </section>
      </div>
    </div>
  </div>

  <script>
    window.__NGF_BOOTSTRAP__ = ${bootstrap};

    const bootstrap = window.__NGF_BOOTSTRAP__;
    const loginView = document.getElementById('loginView');
    const dashboardView = document.getElementById('dashboardView');
    const loginBtn = document.getElementById('loginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const saveBtn = document.getElementById('saveBtn');
    const clearBtn = document.getElementById('clearBtn');
    const aiToggle = document.getElementById('aiToggle');
    const aiState = document.getElementById('aiState');
    const keywordList = document.getElementById('keywordList');
    const formStatus = document.getElementById('formStatus');
    const loginStatus = document.getElementById('loginStatus');
    const adminNotice = document.getElementById('adminNotice');
    const formTitle = document.getElementById('formTitle');
    const keywordId = document.getElementById('keywordId');
    const triggersInput = document.getElementById('triggers');
    const replyTextInput = document.getElementById('replyText');
    const imageFileInput = document.getElementById('imageFile');
    const enabledInput = document.getElementById('enabled');
    const removeImageInput = document.getElementById('removeImage');

    function setStatus(node, message, type) {
      node.textContent = message || '';
      node.className = 'status' + (type ? ' ' + type : '');
    }

    function setDashboardVisible(visible) {
      loginView.classList.toggle('hidden', visible);
      dashboardView.classList.toggle('hidden', !visible);
    }

    function resetForm() {
      keywordId.value = '';
      triggersInput.value = '';
      replyTextInput.value = '';
      imageFileInput.value = '';
      enabledInput.checked = true;
      removeImageInput.checked = false;
      formTitle.textContent = '鏂板鍏抽敭璇?;
      saveBtn.textContent = '淇濆瓨';
      setStatus(formStatus, '');
    }

    function renderAiState(enabled) {
      aiToggle.checked = Boolean(enabled);
      aiState.textContent = enabled ? 'AI: 宸插紑鍚? : 'AI: 宸插叧闂?;
    }

    function renderKeywords(items) {
      keywordList.innerHTML = '';
      if (!items.length) {
        keywordList.innerHTML = '<div class="muted">鏆傛棤鍏抽敭璇嶏紝璇峰厛鍦ㄥ乏渚ф柊澧炰竴鏉°€?/div>';
        return;
      }

      for (const item of items) {
        const node = document.createElement('div');
        node.className = 'item';

        const head = document.createElement('div');
        head.className = 'item-head';

        const left = document.createElement('div');
        const title = document.createElement('div');
        title.innerHTML = '<strong>' + item.id + '</strong> ' + (item.enabled ? '<span class="tag">鍚敤</span>' : '<span class="tag">鍋滅敤</span>');
        const tags = document.createElement('div');
        tags.className = 'tags';
        for (const trigger of item.triggers || []) {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = trigger;
          tags.appendChild(tag);
        }
        left.appendChild(title);
        left.appendChild(tags);

        const actions = document.createElement('div');
        actions.className = 'row';
        const editBtn = document.createElement('button');
        editBtn.className = 'ghost small';
        editBtn.textContent = '缂栬緫';
        editBtn.addEventListener('click', () => {
          keywordId.value = item.id;
          triggersInput.value = (item.triggers || []).join('\n');
          replyTextInput.value = item.reply_text || '';
          enabledInput.checked = Boolean(item.enabled);
          removeImageInput.checked = false;
          imageFileInput.value = '';
          formTitle.textContent = '缂栬緫鍏抽敭璇?;
          saveBtn.textContent = '鏇存柊';
          setStatus(formStatus, '姝ｅ湪缂栬緫 ' + item.id + '銆?);
          window.scrollTo({top: 0, behavior: 'smooth'});
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'danger small';
        deleteBtn.textContent = '鍒犻櫎';
        deleteBtn.addEventListener('click', async () => {
          if (!confirm('纭鍒犻櫎杩欐潯鍏抽敭璇嶏紵')) return;
          await apiDelete('/admin/api/keywords/' + encodeURIComponent(item.id));
          await loadData();
        });

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);

        head.appendChild(left);
        head.appendChild(actions);
        node.appendChild(head);

        const reply = document.createElement('div');
        reply.className = 'muted';
        reply.textContent = item.reply_text ? item.reply_text : '鏈缃洖澶嶆枃瀛?;
        node.appendChild(reply);

        if (item.image_url) {
          const preview = document.createElement('div');
          preview.className = 'preview';
          const img = document.createElement('img');
          img.src = item.image_url + '?t=' + Date.now();
          img.alt = 'keyword image';
          const meta = document.createElement('div');
          meta.className = 'muted';
          meta.innerHTML = '宸茬粦瀹氬浘鐗囥€?;
          preview.appendChild(img);
          preview.appendChild(meta);
          node.appendChild(preview);
        }

        keywordList.appendChild(node);
      }
    }

    async function apiGet(url) {
      const response = await fetch(url, {credentials: 'same-origin'});
      if (!response.ok) {
        throw new Error(await response.text());
      }
      return response.json();
    }

    async function apiJson(url, method, body) {
      const response = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.message || response.statusText || '璇锋眰澶辫触');
      }
      return data;
    }

    async function apiDelete(url) {
      const response = await fetch(url, {method: 'DELETE', credentials: 'same-origin'});
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.message || response.statusText || '璇锋眰澶辫触');
      }
      return data;
    }

    async function uploadImage(keywordIdValue, file) {
      const formData = new FormData();
      formData.append('image', file);
      const response = await fetch('/admin/api/keywords/' + encodeURIComponent(keywordIdValue) + '/image', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.message || response.statusText || '鍥剧墖涓婁紶澶辫触');
      }
      return data;
    }

    async function loadData() {
      const data = await apiGet('/admin/api/keywords');
      renderAiState(data.ai_enabled);
      renderKeywords(data.keywords || []);
      setStatus(adminNotice, '鍏抽敭璇嶅凡鍔犺浇锛屽叡 ' + (data.keywords || []).length + ' 鏉°€?, 'ok');
    }

    loginBtn?.addEventListener('click', async () => {
      try {
        setStatus(loginStatus, '姝ｅ湪鐧诲綍...');
        await apiJson('/admin/api/login', 'POST', {password: document.getElementById('password').value});
        location.reload();
      } catch (error) {
        setStatus(loginStatus, error.message, 'err');
      }
    });

    logoutBtn?.addEventListener('click', async () => {
      await apiJson('/admin/api/logout', 'POST', {});
      location.reload();
    });

    refreshBtn?.addEventListener('click', async () => {
      try {
        await loadData();
      } catch (error) {
        setStatus(adminNotice, error.message, 'err');
      }
    });

    clearBtn?.addEventListener('click', () => resetForm());

    aiToggle?.addEventListener('change', async () => {
      try {
        await apiJson('/admin/api/ai', 'POST', {enabled: aiToggle.checked});
        renderAiState(aiToggle.checked);
        setStatus(adminNotice, 'AI 寮€鍏冲凡鏇存柊銆?, 'ok');
      } catch (error) {
        aiToggle.checked = !aiToggle.checked;
        setStatus(adminNotice, error.message, 'err');
      }
    });

    saveBtn?.addEventListener('click', async () => {
      try {
        const payload = {
          triggers: triggersInput.value,
          reply_text: replyTextInput.value,
          enabled: enabledInput.checked,
          remove_image: removeImageInput.checked
        };

        let keyword;
        if (keywordId.value) {
          keyword = await apiJson('/admin/api/keywords/' + encodeURIComponent(keywordId.value), 'PUT', payload);
        } else {
          keyword = await apiJson('/admin/api/keywords', 'POST', payload);
          keywordId.value = keyword.keyword.id;
        }

        const file = imageFileInput.files && imageFileInput.files[0];
        if (file) {
          await uploadImage(keywordId.value, file);
        } else if (removeImageInput.checked) {
          await apiDelete('/admin/api/keywords/' + encodeURIComponent(keywordId.value) + '/image');
        }

        setStatus(formStatus, '淇濆瓨鎴愬姛銆?, 'ok');
        await loadData();
        resetForm();
      } catch (error) {
        setStatus(formStatus, error.message, 'err');
      }
    });

    if (bootstrap.adminPasswordMissing) {
      setStatus(loginStatus, '鏈娴嬪埌 ADMIN_PASSWORD锛岃鍏堝湪 Cloudflare Secret 涓缃€?, 'err');
    }

    if (bootstrap.authenticated) {
      setDashboardVisible(true);
      renderAiState(bootstrap.aiEnabled);
      renderKeywords(bootstrap.keywords || []);
      loadData().catch((error) => setStatus(adminNotice, error.message, 'err'));
    } else {
      setDashboardVisible(false);
    }
  </script>
</body>
</html>`;
}

async function handleAdminLogin(request, env) {
    const adminPassword = env.ADMIN_PASSWORD || '';
    if (!adminPassword) {
        return jsonResponse({success: false, message: 'ADMIN_PASSWORD is not configured.'}, 500);
    }

    let payload = {};
    try {
        payload = await request.json();
    } catch {
        try {
            const form = await request.formData();
            payload = {password: form.get('password') || ''};
        } catch {
            payload = {};
        }
    }

    if (String(payload.password || '') !== adminPassword) {
        return jsonResponse({success: false, message: '瀵嗙爜閿欒銆?}, 401);
    }

    const session = await createAdminSession(adminPassword);
    return jsonResponse(
        {success: true, message: '鐧诲綍鎴愬姛銆?},
        200,
        {'Set-Cookie': setCookieHeader(ADMIN_COOKIE_NAME, session, ADMIN_SESSION_TTL_SECONDS)}
    );
}

async function handleAdminLogout() {
    return jsonResponse(
        {success: true, message: '宸查€€鍑虹櫥褰曘€?},
        200,
        {'Set-Cookie': setCookieHeader(ADMIN_COOKIE_NAME, '', 0)}
    );
}

async function handleAdminPage(request, env) {
    const authenticated = await isAdminAuthorized(request, env);
    const keywords = authenticated ? await listKeywords(env) : [];
    const aiEnabled = authenticated ? await getAiEnabled(env) : false;
    const adminPasswordMissing = !env.ADMIN_PASSWORD;
    return htmlResponse(buildDashboardHtml({authenticated, keywords, aiEnabled, adminPasswordMissing}));
}

function getKeywordIdFromPath(path) {
    const match = path.match(/^\/admin\/api\/keywords\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : '';
}

function getImagePathKeywordId(path) {
    const match = path.match(/^\/admin\/api\/keywords\/([^/]+)\/image$/);
    return match ? decodeURIComponent(match[1]) : '';
}

async function handleAdminKeywords(request, env) {
    const authed = await isAdminAuthorized(request, env);
    if (!authed) {
        return jsonResponse({success: false, message: 'Unauthorized'}, 401);
    }

    if (request.method === 'GET') {
        return jsonResponse({success: true, ai_enabled: await getAiEnabled(env), keywords: await listKeywords(env)});
    }

    if (request.method === 'POST') {
        let payload = {};
        try {
            payload = await request.json();
        } catch {
            return jsonResponse({success: false, message: 'Invalid JSON.'}, 400);
        }

        const triggers = normalizeTriggers(payload.triggers);
        if (!triggers.length) {
            return jsonResponse({success: false, message: '鑷冲皯闇€瑕佷竴涓叧閿瘝銆?}, 400);
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const record = {
            id,
            triggers,
            reply_text: String(payload.reply_text || ''),
            image_key: '',
            enabled: payload.enabled !== false,
            created_at: now,
            updated_at: now
        };

        const index = await loadKeywordIndex(env);
        index.push(id);
        await saveKeywordRecord(env, record);
        await saveKeywordIndex(env, index);
        return jsonResponse({success: true, keyword: toKeywordView(record)});
    }

    return jsonResponse({success: false, message: 'Method not allowed'}, 405);
}

async function handleAdminKeywordItem(request, env, id) {
    const authed = await isAdminAuthorized(request, env);
    if (!authed) {
        return jsonResponse({success: false, message: 'Unauthorized'}, 401);
    }

    const record = await loadKeywordRecord(env, id);
    if (!record) {
        return jsonResponse({success: false, message: '鍏抽敭璇嶄笉瀛樺湪銆?}, 404);
    }

    if (request.method === 'PUT' || request.method === 'PATCH') {
        let payload = {};
        try {
            payload = await request.json();
        } catch {
            return jsonResponse({success: false, message: 'Invalid JSON.'}, 400);
        }

        const triggers = normalizeTriggers(payload.triggers);
        if (!triggers.length) {
            return jsonResponse({success: false, message: '鑷冲皯闇€瑕佷竴涓叧閿瘝銆?}, 400);
        }

        record.triggers = triggers;
        record.reply_text = String(payload.reply_text || '');
        record.enabled = payload.enabled !== false;
        record.updated_at = new Date().toISOString();
        await saveKeywordRecord(env, record);

        if (payload.remove_image) {
            if (record.image_key) {
                await env.NGF_IMAGES.delete(record.image_key);
            }
            record.image_key = '';
            await saveKeywordRecord(env, record);
        }

        return jsonResponse({success: true, keyword: toKeywordView(record)});
    }

    if (request.method === 'DELETE') {
        const index = await loadKeywordIndex(env);
        await saveKeywordIndex(env, index.filter((item) => item !== id));
        if (record.image_key) {
            await env.NGF_IMAGES.delete(record.image_key);
        }
        await deleteKeywordRecord(env, id);
        return jsonResponse({success: true});
    }

    return jsonResponse({success: false, message: 'Method not allowed'}, 405);
}

async function handleAdminKeywordImage(request, env, id) {
    const authed = await isAdminAuthorized(request, env);
    if (!authed) {
        return jsonResponse({success: false, message: 'Unauthorized'}, 401);
    }

    const record = await loadKeywordRecord(env, id);
    if (!record) {
        return jsonResponse({success: false, message: '鍏抽敭璇嶄笉瀛樺湪銆?}, 404);
    }

    if (request.method === 'GET') {
        if (!record.image_key) {
            return new Response('Not Found', {status: 404});
        }

        const object = await env.NGF_IMAGES.get(record.image_key);
        if (!object) {
            return new Response('Not Found', {status: 404});
        }

        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        headers.set('Cache-Control', 'no-store');
        return new Response(object.body, {status: 200, headers});
    }

    if (request.method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('image');
        if (!(file instanceof File)) {
            return jsonResponse({success: false, message: '璇蜂笂浼犲浘鐗囨枃浠躲€?}, 400);
        }

        if (!file.type.startsWith('image/')) {
            return jsonResponse({success: false, message: '浠呮敮鎸佸浘鐗囨枃浠躲€?}, 400);
        }

        if (record.image_key) {
            await env.NGF_IMAGES.delete(record.image_key);
        }

        const extension = (file.name.split('.').pop() || 'jpg').replace(/[^a-zA-Z0-9]/g, '');
        const imageKey = `keyword-images/${id}/${Date.now()}.${extension || 'jpg'}`;
        const body = await file.arrayBuffer();
        await env.NGF_IMAGES.put(imageKey, body, {
            httpMetadata: {contentType: file.type}
        });

        record.image_key = imageKey;
        record.updated_at = new Date().toISOString();
        await saveKeywordRecord(env, record);

        return jsonResponse({success: true, keyword: toKeywordView(record)});
    }

    if (request.method === 'DELETE') {
        if (record.image_key) {
            await env.NGF_IMAGES.delete(record.image_key);
            record.image_key = '';
            record.updated_at = new Date().toISOString();
            await saveKeywordRecord(env, record);
        }
        return jsonResponse({success: true, keyword: toKeywordView(record)});
    }

    return jsonResponse({success: false, message: 'Method not allowed'}, 405);
}

async function handleAdminAi(request, env) {
    const authed = await isAdminAuthorized(request, env);
    if (!authed) {
        return jsonResponse({success: false, message: 'Unauthorized'}, 401);
    }

    if (request.method === 'GET') {
        return jsonResponse({success: true, enabled: await getAiEnabled(env)});
    }

    if (request.method === 'POST') {
        let payload = {};
        try {
            payload = await request.json();
        } catch {
            return jsonResponse({success: false, message: 'Invalid JSON.'}, 400);
        }

        const enabled = Boolean(payload.enabled);
        await setAiEnabled(env, enabled);
        return jsonResponse({success: true, enabled});
    }

    return jsonResponse({success: false, message: 'Method not allowed'}, 405);
}

async function handleAdminApi(request, env, path) {
    if (path === '/admin/api/login') {
        if (request.method !== 'POST') {
            return jsonResponse({success: false, message: 'Method not allowed'}, 405);
        }
        return handleAdminLogin(request, env);
    }

    if (path === '/admin/api/logout') {
        if (request.method !== 'POST') {
            return jsonResponse({success: false, message: 'Method not allowed'}, 405);
        }
        return handleAdminLogout();
    }

    if (path === '/admin/api/keywords') {
        return handleAdminKeywords(request, env);
    }

    if (path === '/admin/api/ai') {
        return handleAdminAi(request, env);
    }

    const keywordId = getKeywordIdFromPath(path);
    if (keywordId) {
        return handleAdminKeywordItem(request, env, keywordId);
    }

    const imageKeywordId = getImagePathKeywordId(path);
    if (imageKeywordId) {
        return handleAdminKeywordImage(request, env, imageKeywordId);
    }

    return jsonResponse({success: false, message: 'Not found'}, 404);
}

export async function handleInstall(request, ownerUid, botToken, prefix, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({
            success: false,
            message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
        }, 400);
    }

    const url = new URL(request.url);
    const baseUrl = url.origin;
    const webhookUrl = `${baseUrl}/${prefix}/webhook/${ownerUid}/${botToken}`;

    try {
        const response = await postToTelegramApi(botToken, 'setWebhook', {
            url: webhookUrl,
            allowed_updates: ['message'],
            secret_token: secretToken
        });

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully installed.'});
        }

        return jsonResponse({success: false, message: `Failed to install webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error installing webhook: ${error.message}`}, 500);
    }
}

export async function handleUninstall(botToken, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({
            success: false,
            message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
        }, 400);
    }

    try {
        const response = await postToTelegramApi(botToken, 'deleteWebhook', {});

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully uninstalled.'});
        }

        return jsonResponse({success: false, message: `Failed to uninstall webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error uninstalling webhook: ${error.message}`}, 500);
    }
}

export async function handleWebhook(request, ownerUid, botToken, secretToken, env) {
    if (secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
        return new Response('Unauthorized', {status: 401});
    }

    const update = await request.json();
    if (!update.message) {
        return new Response('OK');
    }

    const message = update.message;
    const reply = message.reply_to_message;
    try {
        if (reply && message.chat.id.toString() === ownerUid) {
            const rm = reply.reply_markup;
            if (rm && rm.inline_keyboard && rm.inline_keyboard.length > 0) {
                let senderUid = rm.inline_keyboard[0][0].callback_data;
                if (!senderUid) {
                    senderUid = rm.inline_keyboard[0][0].url.split('tg://user?id=')[1];
                }

                await postToTelegramApi(botToken, 'copyMessage', {
                    chat_id: parseInt(senderUid, 10),
                    from_chat_id: message.chat.id,
                    message_id: message.message_id
                });
            }

            return new Response('OK');
        }

        if ("/start" === message.text) {
            return new Response('OK');
        }

        const sender = message.chat;
        const senderUid = sender.id.toString();
        const senderName = sender.username ? `@${sender.username}` : [sender.first_name, sender.last_name].filter(Boolean).join(' ');

        const copyMessage = async function (withUrl = false) {
            const ik = [[{
                text: `棣冩敽 From: ${senderName} (${senderUid})`,
                callback_data: senderUid,
            }]];

            if (withUrl) {
                ik[0][0].text = `棣冩晛 From: ${senderName} (${senderUid})`;
                ik[0][0].url = `tg://user?id=${senderUid}`;
            }

            return await postToTelegramApi(botToken, 'copyMessage', {
                chat_id: parseInt(ownerUid, 10),
                from_chat_id: message.chat.id,
                message_id: message.message_id,
                reply_markup: {inline_keyboard: ik}
            });
        };

        const response = await copyMessage(true);
        if (!response.ok) {
            await copyMessage();
        }

        const plainText = String(message.text || message.caption || '').trim();
        if (plainText) {
            const matchedKeyword = await matchKeyword(env, plainText);
            if (matchedKeyword) {
                await sendKeywordReply(env, botToken, senderUid, matchedKeyword);
            } else if (await getAiEnabled(env)) {
                const aiReply = await callDeepSeek(env, plainText);
                if (aiReply) {
                    await sendTelegramText(botToken, senderUid, aiReply);
                }
            }
        }

        return new Response('OK');
    } catch (error) {
        console.error('Error handling webhook:', error);
        return new Response('Internal Server Error', {status: 500});
    }
}

export async function handleRequest(request, env) {
    const prefix = env.PREFIX || 'public';
    const secretToken = env.SECRET_TOKEN || '';

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/admin' || path === '/admin/') {
        return handleAdminPage(request, env);
    }

    if (path.startsWith('/admin/api/')) {
        return handleAdminApi(request, env, path);
    }

    const INSTALL_PATTERN = new RegExp(`^/${prefix}/install/([^/]+)/([^/]+)$`);
    const UNINSTALL_PATTERN = new RegExp(`^/${prefix}/uninstall/([^/]+)$`);
    const WEBHOOK_PATTERN = new RegExp(`^/${prefix}/webhook/([^/]+)/([^/]+)$`);

    let match;

    if (match = path.match(INSTALL_PATTERN)) {
        return handleInstall(request, match[1], match[2], prefix, secretToken);
    }

    if (match = path.match(UNINSTALL_PATTERN)) {
        return handleUninstall(match[1], secretToken);
    }

    if (match = path.match(WEBHOOK_PATTERN)) {
        return handleWebhook(request, match[1], match[2], secretToken, env);
    }

    return new Response('Not Found', {status: 404});
}

export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env);
    }
};
