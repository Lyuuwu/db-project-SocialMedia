// ✅ 建議：同源部署時，直接用 location.origin，避免 https 頁面去抓 http API（Mixed Content）
// 若你要改成「前後端不同網域」，才把 BASE_URL 換成 "https://..."。
const BASE_URL = ""; // 例如："https://xxxx.ngrok-free.dev"（不要尾斜線）
const AUTH_PAGE_URL = "/static/auth.html"; // Flask 靜態頁面路徑（需要就改）

const API = {
  ping: "/db_test",
  register: "/api/v1/auth/register",
  login: "/api/v1/auth/login",
  refresh: "/api/v1/auth/refresh",
  logout: "/api/v1/auth/logout",
  me: "/api/v1/users/me",
  users: "/api/v1/users",
  posts: "/api/v1/posts",
  comments: "/api/v1/comments",
  upload: "/api/upload"
};

let postsCache = [];
const $ = (id) => document.getElementById(id);

// hover 顯示最多幾個人（改 5 / 10 都可以）
const LIKES_HOVER_LIMIT = 8;

let likesHoverState = { postId: null, isOpen: false };

// 如果你本來就有 tooltip 狀態，就把這兩個變數對應到你的即可
// ✅ 每篇貼文 likes 名單的版本號：避免舊 request 回來把舊資料塞回快取
const likesPreviewVer = new Map(); // postId -> integer

function bumpLikesPreviewVer(postId){
  likesPreviewVer.set(postId, (likesPreviewVer.get(postId) || 0) + 1);
}

// ✅ 核心：清掉某篇貼文的 hover 名單快取，避免顯示舊資料
function invalidateLikesPreview(postId){
  likesPreviewCache.delete(postId);
  bumpLikesPreviewVer(postId);

  // 如果 popover 正在顯示這篇貼文的名單，直接關掉（避免畫面顯示舊資料）
  if (typeof activeLikesPostId !== "undefined" && activeLikesPostId === postId){
    hideLikesPopover();
  }
}


function showMsg(el, type, text){
  if (!el) return;
  el.className = "msg " + (type || "");
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

function setApiStatus(ok, text){
  const dot = $("apiDot");
  const t = $("apiText");
  if (!dot || !t) return;
  dot.classList.remove("ok","err");
  dot.classList.add(ok ? "ok" : "err");
  t.textContent = text;
}

function escapeHtml(str){
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;");
}

function fmtTime(t){
  try{
    const d = new Date(t);
    if (isNaN(d)) return "";
    return d.toLocaleString();
  }catch{ return ""; }
}

/* ===== session ===== */
function getSession(){
  const raw = localStorage.getItem("miniig_session");
  return raw ? JSON.parse(raw) : null; // { accessToken, user }
}

function setSession(session){
  if (!session) localStorage.removeItem("miniig_session");
  else localStorage.setItem("miniig_session", JSON.stringify(session));

  syncWhoAmI();
  syncAccountUI();
}

function syncWhoAmI(){
  const el = $("whoami");
  if (!el) return;
  const s = getSession();
  const u = s?.user;
  el.textContent = u ? (u.userName || u.email || "已登入") : "未登入";
}

function initialsFromUser(u){
  const name = (u?.userName || "").trim();
  const email = (u?.email || "").trim();
  const base = name || email || "U";
  return base.slice(0, 1).toUpperCase();
}

function baseOrigin(){
  const v = (BASE_URL || "").trim().replace(/\/$/, "");
  return v || location.origin;
}

function normalizeBackendUrl(p){
  const v = (p || "").trim();
  if (!v) return "";
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  return baseOrigin() + (v.startsWith("/") ? v : ("/" + v));
}

function syncAccountUI(){
  const loginBtn = $("loginNavBtn");
  const avatarMenu = $("avatarMenu");
  if (!loginBtn || !avatarMenu) return;

  const s = getSession();
  const loggedIn = !!s?.accessToken;

  loginBtn.style.display = loggedIn ? "none" : "inline-flex";
  avatarMenu.style.display = loggedIn ? "flex" : "none";

  if (!loggedIn) return;

  const u = s.user || {};
  const nameEl = $("popName");
  const emailEl = $("popEmail");
  const bioEl = $("popBio");
  if (nameEl) nameEl.textContent = u.userName || "已登入";
  if (emailEl) emailEl.textContent = u.email || "";
  if (bioEl) bioEl.textContent = u.bio || "";

  const img = $("avatarImg");
  const fallback = $("avatarFallback");

  const pic = (u.profilePic || "").trim();
  if (pic && img && fallback){
    img.src = normalizeBackendUrl(pic);
    img.style.display = "block";
    fallback.style.display = "none";
  }else{
    if (img) img.style.display = "none";
    if (fallback){
      fallback.style.display = "grid";
      fallback.textContent = initialsFromUser(u);
    }
  }
}

/* ===== navigation to auth page ===== */
function safeNextUrl(){
  const params = new URLSearchParams(location.search);
  const next = params.get("next");
  if (!next) return "/";
  try{
    const u = new URL(next, location.origin);
    if (u.origin !== location.origin) return "/";
    return u.href;
  }catch{
    return "/";
  }
}

function goToAuth(){
  const next = encodeURIComponent(location.href);
  // 你若不是 Flask 靜態路徑，改成 "./auth.html" 或你的路由即可
  location.href = `${AUTH_PAGE_URL}?next=${next}`;
}

function goBackFromAuth(){
  const next = safeNextUrl();
  location.href = next;
}

let refreshInFlight = null;

async function refreshAccessToken(){
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try{
      // refresh token 在 HttpOnly cookie，前端不用保存
      const res = await fetch(baseOrigin() + API.refresh, {
        method: "POST",
        credentials: "same-origin",
      });

      let data = null;
      try { data = await res.json(); } catch { data = null; }

      if (!res.ok || !data?.accessToken) return false;

      const s = getSession();
      if (!s) return false;

      setSession({ ...s, accessToken: data.accessToken });
      return true;
    }catch{
      return false;
    }finally{
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/* ===== API helper ===== */
async function apiFetch(path, options = {}){
  const { _retry, ...rest } = options;

  const url = baseOrigin() + path;
  const headers = Object.assign({ "Content-Type":"application/json" }, rest.headers || {});
  const opts = Object.assign({}, rest, { headers, credentials: "same-origin" });

  const s = getSession();
  if (s?.accessToken) headers.Authorization = `Bearer ${s.accessToken}`;

  const res = await fetch(url, opts);

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  // ✅ 如果是 401，而且使用者「以為自己是登入狀態」，就嘗試 refresh 再重試一次
  if (res.status === 401 && !_retry && getSession()?.accessToken){
    const ok = await refreshAccessToken();
    if (ok){
      return await apiFetch(path, Object.assign({}, options, { _retry: true }));
    }else{
      // refresh 也失敗：代表 refresh cookie 也沒了/過期了 → 清 session
      setSession(null);
    }
  }

  if (!res.ok){
    const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/* ===== backend ping ===== */
async function pingBackend(){
  try{
    const data = await apiFetch(API.ping, { method:"GET" });
    setApiStatus(true, `後端 OK：${data?.db ?? data?.db_name ?? "db"} / ${data?.login ?? data?.login_name ?? "login"}`);
  }catch(e){
    setApiStatus(false, `後端失敗：${e.message}`);
  }
}

/* ===== auth page UI ===== */
function uiSetAuthTab(tab){
  const isLogin = (tab === "login");
  const tabLogin = $("tabLogin");
  const tabRegister = $("tabRegister");
  const panelLogin = $("panelLogin");
  const panelRegister = $("panelRegister");

  if (tabLogin) tabLogin.classList.toggle("active", isLogin);
  if (tabRegister) tabRegister.classList.toggle("active", !isLogin);
  if (panelLogin) panelLogin.style.display = isLogin ? "block" : "none";
  if (panelRegister) panelRegister.style.display = isLogin ? "none" : "block";
}

/* ===== auth ===== */
async function register(){
  const msg = $("regMsg");
  showMsg(msg, "", "");

  const email = $("regEmail")?.value.trim();
  const password = $("regPwd")?.value;
  const userName = $("regUserName")?.value.trim();

  const bio = $("regBio")?.value.trim();
  const profilePic = $("regPic")?.value.trim();

  if (!email || !password || !userName){
    return showMsg(msg, "err", "必填：email / password / userName");
  }

  try{
    const data = await apiFetch(API.register, {
      method:"POST",
      body: JSON.stringify({ email, password, userName })
    });

    setSession({ accessToken: data.accessToken, user: data.user });

    if (bio || profilePic){
      const patchBody = {};
      if (bio) patchBody.bio = bio;
      if (profilePic) patchBody.profilePic = profilePic;

      const me = await apiFetch(API.me, {
        method:"PATCH",
        body: JSON.stringify(patchBody),
      });

      setSession({ accessToken: data.accessToken, user: me });
    }

    showMsg(msg, "ok", "註冊成功並已登入！");
    // ✅ 登入後回到上一頁
    setTimeout(()=> goBackFromAuth(), 350);

  }catch(e){
    showMsg(msg, "err", `註冊失敗：${e.message}`);
  }
}

async function login(){
  const msg = $("authMsg");
  showMsg(msg, "", "");

  const email = $("loginEmail")?.value.trim();
  const password = $("loginPwd")?.value;
  if (!email || !password) return showMsg(msg, "err", "請輸入 email + password");

  try{
    const data = await apiFetch(API.login, {
      method:"POST",
      body: JSON.stringify({ email, password })
    });

    setSession({ accessToken: data.accessToken, user: data.user });

    showMsg(msg, "ok", `登入成功：${data.user.userName || data.user.email}`);
    // ✅ 登入後回到上一頁
    setTimeout(()=> goBackFromAuth(), 350);

  }catch(e){
    showMsg(msg, "err", `登入失敗：${e.message}`);
  }
}

async function logout(){
  try{
    await fetch(baseOrigin() + API.logout, {
      method: "POST",
      credentials: "same-origin",
    });
  }catch{
    // ignore
  }

  setSession(null);
  showMsg($("postMsg"), "ok", "已登出");
  loadPosts?.().catch?.(()=>{});
}


/* ===== pages (home/create) ===== */
function showPage(which){
  const isHome = (which === "home");
  const pageHome = $("pageHome");
  const pageCreate = $("pageCreate");
  const navHome = $("navHome");
  const navCreate = $("navCreate");

  if (pageHome) pageHome.style.display = isHome ? "block" : "none";
  if (pageCreate) pageCreate.style.display = isHome ? "none" : "block";
  if (navHome) navHome.classList.toggle("active", isHome);
  if (navCreate) navCreate.classList.toggle("active", !isHome);

  const pageTitle = $("pageTitle");
  const pageDesc = $("pageDesc");
  if (pageTitle) pageTitle.textContent = isHome ? "首頁｜最新貼文" : "發文｜建立新貼文";
  if (pageDesc) pageDesc.textContent = isHome
    ? "顯示所有貼文，依 time/createdAt 由新到舊排序。"
    : "在這裡撰寫貼文，送出後回到 Home。";
}

/* ====== Image upload + preview ====== */
function clearPostImage(){
  const f = $("postFile");
  if (f) f.value = "";
  const previewBox = $("previewBox");
  const previewImg = $("previewImg");
  if (previewBox) previewBox.style.display = "none";
  if (previewImg) previewImg.src = "";
}

function bindFilePreview(){
  const input = $("postFile");
  if (!input) return;
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (!f) return clearPostImage();
    const url = URL.createObjectURL(f);
    const previewImg = $("previewImg");
    const previewBox = $("previewBox");
    if (previewImg) previewImg.src = url;
    if (previewBox) previewBox.style.display = "block";
  });
}

async function uploadImageIfNeeded(){
  const s = getSession();
  const file = $("postFile")?.files?.[0];
  if (!file) return "";

  const fd = new FormData();
  fd.append("file", file);

  const url = baseOrigin() + API.upload;
  const headers = {};
  if (s?.accessToken) headers.Authorization = `Bearer ${s.accessToken}`;

  let res = await fetch(url, { method:"POST", body: fd, headers, credentials:"same-origin" });

  if (res.status === 401){
    const ok = await refreshAccessToken();
    if (ok){
      const s2 = getSession();
      const headers2 = {};
      if (s2?.accessToken) headers2.Authorization = `Bearer ${s2.accessToken}`;
      res = await fetch(url, { method:"POST", body: fd, headers: headers2, credentials:"same-origin" });
    }
  }

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok){
    throw new Error(data?.error || data?.message || "圖片上傳失敗");
  }
  return data?.url || "";
}

/* posts */
async function loadPosts(){
  try{
    const data = await apiFetch(API.posts + "?page=1&pageSize=50", { method:"GET" });
    postsCache = Array.isArray(data) ? data : (data.items || []);

    postsCache.sort((a,b)=>{
      const ta = new Date(a.createdAt || a.time || 0).getTime();
      const tb = new Date(b.createdAt || b.time || 0).getTime();
      return tb - ta;
    });

    // ✅ 建議：整批更新後把 hover 快取清掉
    likesPreviewCache.clear();
    likesHoverState = { postId: null, isOpen: false };
    hideLikesPopover(); // ✅ 你有這個


    renderFeed();
    setApiStatus(true, "後端連線正常");
  }catch(e){
    setApiStatus(false, `抓貼文失敗：${e.message}`);
  }
}

async function createPost(){
  const msg = $("postMsg");
  showMsg(msg, "", "");

  const s = getSession();
  if (!s?.accessToken){
    showMsg(msg, "err", "請先登入（右上角登入 / 註冊）");
    goToAuth();
    return;
  }

  const content = $("postContent")?.value.trim();
  if (!content) return showMsg(msg, "err", "content 不能空");

  try{
    showMsg(msg, "", "正在上傳/送出...");
    const pictureUrl = await uploadImageIfNeeded();

    await apiFetch(API.posts, {
      method:"POST",
      body: JSON.stringify({ content, picture: pictureUrl })
    });

    showMsg(msg, "ok", "發佈成功！");
    $("postContent").value = "";
    clearPostImage();
    updateCharCount();
    showPage("home");
    await loadPosts();
  }catch(e){
    showMsg(msg, "err", `發文失敗：${e.message}`);
  }
}

// ===== likes preview / modal settings =====
const LIKES_PREVIEW_LIMIT = 5; // 想要 10 就改成 10
const LIKES_PAGE_SIZE = 200;   // modal 分頁一次拿幾個（後端有上限 200）

let likesPopoverEl = null;
let likesHideTimer = null;
let activeLikesAnchor = null;
let activeLikesPostId = null;

const likesPreviewCache = new Map();
const LIKES_PREVIEW_CACHE_MS = 15000;

function ensureLikesPopover(){
  if (likesPopoverEl) return likesPopoverEl;

  likesPopoverEl = document.createElement("div");
  likesPopoverEl.className = "likesPopover";
  likesPopoverEl.id = "likesPopover";
  likesPopoverEl.innerHTML = `
    <div class="likesPopoverTitle">載入中…</div>
    <div class="likesPopoverList"></div>
  `;
  document.body.appendChild(likesPopoverEl);

  likesPopoverEl.addEventListener("pointerenter", () => {
    if (likesHideTimer) clearTimeout(likesHideTimer);
    likesHideTimer = null;
  });
  likesPopoverEl.addEventListener("pointerleave", () => scheduleHideLikesPopover());

  window.addEventListener("scroll", () => {
    if (likesPopoverEl?.classList.contains("show") && activeLikesAnchor) positionLikesPopover(activeLikesAnchor);
  }, true);
  window.addEventListener("resize", () => {
    if (likesPopoverEl?.classList.contains("show") && activeLikesAnchor) positionLikesPopover(activeLikesAnchor);
  });

  return likesPopoverEl;
}

function scheduleHideLikesPopover(){
  if (likesHideTimer) clearTimeout(likesHideTimer);
  likesHideTimer = setTimeout(() => hideLikesPopover(), 120);
}

function hideLikesPopover(){
  if (!likesPopoverEl) return;
  likesPopoverEl.classList.remove("show");
  activeLikesAnchor = null;
  activeLikesPostId = null;
}

function positionLikesPopover(anchor){
  const pop = ensureLikesPopover();
  const rect = anchor.getBoundingClientRect();

  const gap = 8;
  let top = rect.bottom + gap;
  let left = rect.left;

  // 防止超出右邊
  const vw = window.innerWidth;
  const popW = Math.min(340, Math.max(260, pop.offsetWidth || 280));
  if (left + popW > vw - 10) left = vw - popW - 10;
  if (left < 10) left = 10;

  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

async function fetchLikesPreview(postId){
  const now = Date.now();
  const cached = likesPreviewCache.get(postId);
  if (cached && (now - cached.ts) < LIKES_PREVIEW_CACHE_MS) return cached.data;

  // 送出 request 前，先記住當下版本
  const ver = likesPreviewVer.get(postId) || 0;

  const qs = new URLSearchParams({ limit: String(LIKES_PREVIEW_LIMIT) });
  const data = await apiFetch(`${API.posts}/${postId}/likes?${qs.toString()}`);

  // 如果 request 飛行途中被 invalidate（ver 變了），就不要把舊資料寫進快取
  if ((likesPreviewVer.get(postId) || 0) !== ver){
    return data; // 仍回傳給呼叫者，但不快取
  }

  likesPreviewCache.set(postId, { ts: Date.now(), data });
  return data;
}


async function fetchLikesPage(postId, page){
  const qs = new URLSearchParams({
    page: String(page),
    pageSize: String(LIKES_PAGE_SIZE),
  });
  return await apiFetch(`${API.posts}/${postId}/likes?${qs.toString()}`);
}

function renderLikeUserRow(u){
  const name = escapeHtml(u.userName || "unknown");
  const pic = normalizeBackendUrl(u.profilePic || "");
  const avatar = pic
    ? `<img class="likeMiniAvatar" src="${escapeHtml(pic)}" alt="avatar" />`
    : `<div class="likeMiniFallback">${name.slice(0,1).toUpperCase()}</div>`;

  return `<div class="likeRow">${avatar}<div class="likeName">${name}</div></div>`;
}

let likesPreviewReqSeq = 0;

async function showLikesPreview(anchorEl){
  const postId = Number(anchorEl.dataset.postId);
  if (!postId) return;

  const pop = ensureLikesPopover();

  if (likesHideTimer) clearTimeout(likesHideTimer);
  likesHideTimer = null;

  activeLikesAnchor = anchorEl;
  activeLikesPostId = postId;

  positionLikesPopover(anchorEl);
  pop.classList.add("show");
  pop.querySelector(".likesPopoverTitle").textContent = "載入中…";
  pop.querySelector(".likesPopoverList").innerHTML = "";

  // ✅ 這次顯示的 request id
  const reqId = ++likesPreviewReqSeq;

  try{
    const data = await fetchLikesPreview(postId);

    // ✅ 如果途中又觸發其他 hover / 或 popover 已切到別篇，就不要用舊結果覆蓋 UI
    if (reqId !== likesPreviewReqSeq) return;
    if (activeLikesPostId !== postId) return;

    const items = data.items || [];
    const total = data.total ?? items.length;

    pop.querySelector(".likesPopoverTitle").textContent = `${total} 人按讚`;
    pop.querySelector(".likesPopoverList").innerHTML = items.length
      ? items.map(renderLikeUserRow).join("")
      : `<div class="msg" style="display:block; padding:6px 0;">目前還沒有人按讚</div>`;

    if (total > LIKES_PREVIEW_LIMIT){
      pop.querySelector(".likesPopoverList").insertAdjacentHTML(
        "beforeend",
        `<div style="opacity:.75; padding:4px 8px;">…以及其他 ${total - LIKES_PREVIEW_LIMIT} 人</div>`
      );
    }
  }catch(e){
    if (reqId !== likesPreviewReqSeq) return;
    if (activeLikesPostId !== postId) return;

    pop.querySelector(".likesPopoverTitle").textContent = "讀取失敗";
    pop.querySelector(".likesPopoverList").innerHTML =
      `<div class="msg" style="display:block;">${escapeHtml(e.message)}</div>`;
  }
}

// ===== likes modal =====
let likesUiInited = false;

function initLikesUi(){
  if (likesUiInited) return;
  likesUiInited = true;

  const feed = $("feed");
  if (feed){
    feed.addEventListener("pointerover", (e) => {
      const a = e.target.closest?.(".likesLink");
      if (!a) return;
      showLikesPreview(a);
    });

    feed.addEventListener("pointerout", (e) => {
      const a = e.target.closest?.(".likesLink");
      if (!a) return;

      // 若移動到 popover 本身，就不要立刻關
      const rt = e.relatedTarget;
      if (rt && likesPopoverEl && likesPopoverEl.contains(rt)) return;

      scheduleHideLikesPopover();
    });

    feed.addEventListener("click", (e) => {
      const a = e.target.closest?.(".likesLink");
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      hideLikesPopover();
      openLikesModal(Number(a.dataset.postId));
    });
  }

  const overlay = $("likesOverlay");
  const modal = $("likesModal");
  const closeBtn = $("likesCloseBtn");

  if (overlay){
    overlay.addEventListener("click", (e) => {
      // 點到 overlay 空白處才關
      if (e.target === overlay) closeLikesModal();
    });
  }
  if (modal){
    modal.addEventListener("click", (e) => e.stopPropagation());
  }
  if (closeBtn){
    closeBtn.addEventListener("click", closeLikesModal);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLikesModal();
  });
}

function openLikesModal(postId){
  const overlay = $("likesOverlay");
  if (!overlay || !postId) return;

  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");

  $("likesModalHeader").textContent = "載入中…";
  $("likesModalList").innerHTML = "";

  loadAllLikesIntoModal(postId).catch(()=>{});
}

function closeLikesModal(){
  const overlay = $("likesOverlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
}

async function loadAllLikesIntoModal(postId){
  const header = $("likesModalHeader");
  const listEl = $("likesModalList");

  let page = 1;
  let all = [];
  let total = 0;

  while (true){
    const data = await fetchLikesPage(postId, page);
    const items = data.items || [];
    total = data.total ?? total;

    all = all.concat(items);

    if (items.length === 0) break;
    if (total && all.length >= total) break;

    page += 1;
    if (page > 200) break; // 極端保護：避免無限迴圈
  }

  header.textContent = total ? `共 ${total} 人按讚` : "目前還沒有人按讚";
  listEl.innerHTML = all.length
    ? all.map(renderLikeUserRow).join("")
    : `<div class="msg" style="display:block;">目前還沒有人按讚</div>`;
}

function renderFeed(){
  const q = ($("search")?.value || "").trim().toLowerCase();
  const feed = $("feed");
  if (!feed) return;
  feed.innerHTML = "";

  const list = (postsCache || []).filter(p=>{
    if (!q) return true;
    const s = `${p.content||""} ${p.author?.userName||""} ${p.author?.email||""}`.toLowerCase();
    return s.includes(q);
  });

  if (list.length === 0){
    const empty = document.createElement("div");
    empty.className = "msg";
    empty.style.display = "block";
    empty.textContent = "目前沒有貼文（或搜尋結果為空）。";
    feed.appendChild(empty);
    return;
  }

  const openCommentsToLoad = [];

  list.forEach(p=>{
    const card = document.createElement("div");
    card.className = "postCard";

    const t = fmtTime(p.created_at);
    const likes = (p.likes ?? 0);

    const meta = document.createElement("div");
    meta.className = "postMeta";

    const author = p.author || {};
    const authorId = Number(author.userId || 0);

    const authorRawName = (author.userName || p.userName || p.user_name || p.authorName || "unknown").trim() || "unknown";
    const authorName = escapeHtml(authorRawName);

    const authorEmail = escapeHtml(author.email || p.Email || "") ;

    const authorPicRaw = author.profilePic || p.profilePic || p.profile_pic || p.authorPic || "";
    const authorPic = normalizeBackendUrl(authorPicRaw);
    const authorInitial = firstLetter(authorRawName);

    const meId = Number(getSession()?.user?.userId || 0);
    const canDeletePost = meId && (meId === authorId);

    const authorAvatarHtml = authorPic
    ? `<img class="authorAvatar" src="${escapeHtml(authorPic)}" alt="avatar" />`
    : `<div class="authorFallback">${escapeHtml(authorInitial)}</div>`;

    meta.innerHTML = `
      <div class="nameLine">
        <span class="authorChip" data-user-id="${authorId}" data-user-name="${escapeHtml(authorRawName)}">
          ${authorAvatarHtml}
          <b>${authorName}</b>
        </span>
      </div>
      <div class="time">${escapeHtml(t)}</div>
    `;

    const body = document.createElement("div");
    body.className = "postBody";
    body.innerHTML = escapeHtml(p.content || "");

    card.appendChild(meta);
    card.appendChild(body);

    const pic = normalizeBackendUrl(p.picture || "");
    if (pic){
      const imgWrap = document.createElement("div");
      imgWrap.className = "imgWrap";
      imgWrap.innerHTML = `<img src="${escapeHtml(pic)}" alt="post image" />`;
      card.appendChild(imgWrap);
    }

    const footer = document.createElement("div");
    footer.className = "footerBar";
    const postId = p.postId;
    const heart = p.likedByMe ? "♥" : "♡";
    const commentCount = Number(p.commentCount ?? 0);
    footer.innerHTML = `
      <span class="likesLink" data-post-id="${postId}">likes: ${likes}</span>
      <button class="btn ghost small toggleCommentsBtn" id="commentsToggleBtn-${postId}" data-post-id="${postId}">💬 留言 (${commentCount})</button>

      <span style="display:flex; gap:8px; align-items:center;">
        <button class="btn ghost" onclick="toggleLike(${postId})">${heart} Like</button>
        ${canDeletePost ? `<button class="btn ghost small postDeleteBtn" data-post-id="${postId}">🗑 刪除貼文</button>` : ""}
      </span>
    `;

    card.appendChild(footer);

    // --- comments panel ---
    const commentsOpen = commentsOpenSet.has(postId);
    const commentsWrap = document.createElement("div");
    commentsWrap.className = "commentsWrap";
    commentsWrap.innerHTML = `
      <div class="commentsPanel" id="commentsPanel-${postId}" style="display:${commentsOpen ? "block" : "none"};">
        <div class="commentsHeader">
          <span class="commentsStatus" id="commentsStatus-${postId}"></span>
        </div>
        <div class="commentsList" id="commentsList-${postId}"></div>
        <div class="commentComposer">
          <textarea class="commentInput" id="commentInput-${postId}" maxlength="1024" placeholder="寫留言…"></textarea>
          <div class="commentActions">
            <button class="btn primary small commentSendBtn" data-post-id="${postId}">送出</button>
            <div class="msg" id="commentMsg-${postId}" style="display:none;"></div>
          </div>
        </div>
      </div>
    `;
    card.appendChild(commentsWrap);

    if (commentsOpen) openCommentsToLoad.push(postId);
    feed.appendChild(card);
  });

  // 如果有維持展開的留言區，重新抓一次（避免 renderFeed 後留言列表是空的）
  openCommentsToLoad.forEach(pid => {
    loadComments(pid).catch(()=>{});
  });
}

async function toggleLike(postId){
    const s = getSession();
    if (!s?.accessToken){
        goToAuth();
        return;
    }


    const p = (postsCache || []).find(x => x.postId === postId);
    if (!p) return;

    const path = `${API.posts}/${postId}/like`;

    try{
    const data = await apiFetch(path, { method: p.likedByMe ? "DELETE" : "POST" });

    // 更新數字與愛心狀態
    p.likedByMe = !!data.liked;
    p.likes = data.likes ?? p.likes;

    // ✅ 關鍵：清掉 hover 名單快取，避免顯示舊資料
    invalidateLikesPreview(postId);

    // 重新渲染畫面
    renderFeed();
    }catch(e){
    setApiStatus(false, `更新 like 失敗：${e.message}`);
    }
}

async function deletePost(postId){
  const s = getSession();
  if (!s?.accessToken){
    goToAuth();
    return;
  }

  if (!confirm("確定要刪除這篇貼文嗎？（留言與按讚也會一起消失）")) return;

  try{
    await apiFetch(`${API.posts}/${postId}`, { method: "DELETE" });

    // 本地快取移除
    postsCache = (postsCache || []).filter(p => p.postId !== postId);

    // 清掉相關快取/狀態
    invalidateLikesPreview(postId);
    invalidateComments(postId);
    commentsOpenSet.delete(postId);

    // 重畫
    renderFeed();
    setApiStatus(true, "已刪除貼文");
  }catch(e){
    setApiStatus(false, `刪除貼文失敗：${e.message}`);
  }
}

async function deleteComment(commentId, postId){
  const s = getSession();
  if (!s?.accessToken){
    goToAuth();
    return;
  }

  if (!confirm("確定要刪除這則留言嗎？")) return;

  try{
    await apiFetch(`${API.comments}/${commentId}`, { method: "DELETE" });

    // 直接強制重抓，讓 commentCount / 已編輯標記等都一致
    invalidateComments(postId);
    await loadComments(postId, { force: true });

    setApiStatus(true, "已刪除留言");
  }catch(e){
    setApiStatus(false, `刪除留言失敗：${e.message}`);
  }
}


/* =========================
   Comments
   ========================= */

const commentsOpenSet = new Set(); // postId
const commentsCache = new Map();   // postId -> {ts, data}
const COMMENTS_CACHE_MS = 15000;

function invalidateComments(postId){
  commentsCache.delete(postId);
}

async function fetchComments(postId, page = 1, pageSize = 200){
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return await apiFetch(`${API.posts}/${postId}/comments?${qs.toString()}`, { method: "GET" });
}

function renderCommentRow(c){
  const author = c.author || {};
  const authorId = Number(author.userId || 0);
  const rawName = author.userName || "unknown";
  const name = escapeHtml(rawName);
  const pic = normalizeBackendUrl(author.profilePic || "");
  const initial = firstLetter(rawName);
  const avatarHtml = pic
    ? `<img class="commentAvatar" src="${escapeHtml(pic)}" alt="avatar" />`
    : `<div class="commentFallback">${escapeHtml(initial)}</div>`;

  const time = escapeHtml(fmtTime(c.createdAt || ""));
  const editedTag = c.edited ? `<span class="commentEditedTag">已編輯</span>` : "";
  const contentHtml = escapeHtml(c.content || "").replaceAll("\n", "<br>");
  const canManage = !!c.editableByMe; // 你的後端目前回 editableByMe（或你已用這個欄位）
  const editBtn = canManage
    ? `<button class="btn ghost tiny commentEditBtn" data-comment-id="${c.commentId}" data-post-id="${c.postId}">編輯</button>`
    : "";

  const delBtn = canManage
    ? `<button class="btn ghost tiny commentDeleteBtn" data-comment-id="${c.commentId}" data-post-id="${c.postId}">刪除</button>`
    : "";


  // 注意：textarea 內容要 escape，避免破壞 HTML
  const textareaValue = escapeHtml(c.content || "");

  return `
    <div class="commentItem" data-comment-id="${c.commentId}" data-post-id="${c.postId}">
      <div class="commentMeta">
        <span class="authorChip" data-user-id="${authorId}" data-user-name="${escapeHtml(rawName)}">
          ${avatarHtml}
          <b>${name}</b>
        </span>

        <div class="commentMetaRight">
          <span class="commentTime">${time}</span>
          ${editedTag}
          ${editBtn}
          ${delBtn}
        </div>
      </div>

      <div class="commentContent">${contentHtml}</div>
      <div class="commentEditArea" style="display:none;">
        <textarea class="commentEditInput" maxlength="1024">${textareaValue}</textarea>
        <div class="commentEditActions">
          <button class="btn primary tiny commentSaveBtn" data-comment-id="${c.commentId}" data-post-id="${c.postId}">儲存</button>
          <button class="btn ghost tiny commentCancelBtn" data-comment-id="${c.commentId}" data-post-id="${c.postId}">取消</button>
        </div>
      </div>
    </div>
  `;
}

async function loadComments(postId, { force = false } = {}){
  const listEl = document.getElementById(`commentsList-${postId}`);
  const statusEl = document.getElementById(`commentsStatus-${postId}`);
  const toggleBtn = document.getElementById(`commentsToggleBtn-${postId}`);
  if (!listEl || !statusEl || !toggleBtn) return;

  statusEl.textContent = "載入中…";
  listEl.innerHTML = "";

  try{
    const now = Date.now();
    const cached = commentsCache.get(postId);
    let data;
    if (!force && cached && (now - cached.ts) < COMMENTS_CACHE_MS){
      data = cached.data;
    }else{
      data = await fetchComments(postId, 1, 200);
      commentsCache.set(postId, { ts: Date.now(), data });
    }

    const items = data.items || [];
    const total = data.total ?? items.length;

    toggleBtn.textContent = `💬 留言 (${total})`;
    statusEl.textContent = "";

    if (items.length === 0){
      listEl.innerHTML = `<div class="msg" style="display:block;">還沒有留言</div>`;
    }else{
      listEl.innerHTML = items.map(renderCommentRow).join("");
    }

    const p = (postsCache || []).find(x => x.postId === postId);
    if (p) p.commentCount = total;

  }catch(e){
    statusEl.textContent = "";
    listEl.innerHTML = `<div class="msg" style="display:block;">${escapeHtml(e.message)}</div>`;
  }
}

async function toggleComments(postId){
  const panel = document.getElementById(`commentsPanel-${postId}`);
  if (!panel) return;
  const opening = panel.style.display === "none";

  if (!opening){
    panel.style.display = "none";
    commentsOpenSet.delete(postId);
    return;
  }

  panel.style.display = "block";
  commentsOpenSet.add(postId);
  await loadComments(postId).catch(()=>{});
}

async function createComment(postId){
  const s = getSession();
  if (!s?.accessToken){
    goToAuth();
    return;
  }

  const inputEl = document.getElementById(`commentInput-${postId}`);
  const msgEl = document.getElementById(`commentMsg-${postId}`);
  const listEl = document.getElementById(`commentsList-${postId}`);
  const toggleBtn = document.getElementById(`commentsToggleBtn-${postId}`);
  if (!inputEl || !listEl || !toggleBtn) return;

  const content = (inputEl.value || "").trim();
  if (!content){
    showMsg(msgEl, "err", "留言不能空");
    return;
  }

  try{
    showMsg(msgEl, "", "送出中…");
    const c = await apiFetch(`${API.posts}/${postId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });

    inputEl.value = "";
    showMsg(msgEl, "ok", "已送出");

    // 若原本是「還沒有留言」的 msg，就先清掉
    if (listEl.querySelector?.(".msg")) listEl.innerHTML = "";

    // 新留言一定是最新的 → 直接 append 在最下面（舊→新排序）
    listEl.insertAdjacentHTML("beforeend", renderCommentRow(c));

    // 更新數量
    const p = (postsCache || []).find(x => x.postId === postId);
    const newTotal = (p?.commentCount ?? 0) + 1;
    if (p) p.commentCount = newTotal;
    toggleBtn.textContent = `💬 留言 (${newTotal})`;

    invalidateComments(postId);

  }catch(e){
    showMsg(msgEl, "err", `送出失敗：${e.message}`);
  }
}

function startEditComment(commentId, postId){
  const item = document.querySelector(`.commentItem[data-comment-id="${commentId}"][data-post-id="${postId}"]`);
  if (!item) return;
  const contentEl = item.querySelector(".commentContent");
  const editEl = item.querySelector(".commentEditArea");
  if (!contentEl || !editEl) return;
  contentEl.style.display = "none";
  editEl.style.display = "block";
  const ta = editEl.querySelector(".commentEditInput");
  ta?.focus?.();
}

function cancelEditComment(commentId, postId){
  const item = document.querySelector(`.commentItem[data-comment-id="${commentId}"][data-post-id="${postId}"]`);
  if (!item) return;
  const contentEl = item.querySelector(".commentContent");
  const editEl = item.querySelector(".commentEditArea");
  if (!contentEl || !editEl) return;
  editEl.style.display = "none";
  contentEl.style.display = "block";
}

async function saveEditComment(commentId, postId){
  const item = document.querySelector(`.commentItem[data-comment-id="${commentId}"][data-post-id="${postId}"]`);
  if (!item) return;
  const editEl = item.querySelector(".commentEditArea");
  const ta = editEl?.querySelector(".commentEditInput");
  const contentEl = item.querySelector(".commentContent");
  if (!ta || !contentEl) return;

  const newContent = (ta.value || "").trim();
  if (!newContent){
    alert("留言不能空");
    return;
  }

  try{
    const updated = await apiFetch(`${API.comments}/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: newContent }),
    });
    // 直接重新載入，讓「已編輯」標記與時間顯示一致
    invalidateComments(postId);
    await loadComments(postId, { force: true });
  }catch(e){
    alert(`編輯失敗：${e.message}`);
  }
}

let commentsUiInited = false;
function initCommentsUi(){
  if (commentsUiInited) return;
  commentsUiInited = true;

  const feed = $("feed");
  if (!feed) return;

  feed.addEventListener("click", (e) => {
    const t = e.target;

    const delPostBtn = t.closest?.(".postDeleteBtn");
    if (delPostBtn){
      const postId = Number(delPostBtn.dataset.postId);
      if (postId) deletePost(postId);
      return;
    }

    const delCommentBtn = t.closest?.(".commentDeleteBtn");
    if (delCommentBtn){
      const commentId = Number(delCommentBtn.dataset.commentId);
      const postId = Number(delCommentBtn.dataset.postId);
      if (commentId && postId) deleteComment(commentId, postId);
      return;
    }

    const toggleBtn = t.closest?.(".toggleCommentsBtn");
    if (toggleBtn){
      const postId = Number(toggleBtn.dataset.postId);
      if (postId) toggleComments(postId);
      return;
    }

    const sendBtn = t.closest?.(".commentSendBtn");
    if (sendBtn){
      const postId = Number(sendBtn.dataset.postId);
      if (postId) createComment(postId);
      return;
    }

    const editBtn = t.closest?.(".commentEditBtn");
    if (editBtn){
      const commentId = Number(editBtn.dataset.commentId);
      const postId = Number(editBtn.dataset.postId);
      if (commentId && postId) startEditComment(commentId, postId);
      return;
    }

    const cancelBtn = t.closest?.(".commentCancelBtn");
    if (cancelBtn){
      const commentId = Number(cancelBtn.dataset.commentId);
      const postId = Number(cancelBtn.dataset.postId);
      if (commentId && postId) cancelEditComment(commentId, postId);
      return;
    }

    const saveBtn = t.closest?.(".commentSaveBtn");
    if (saveBtn){
      const commentId = Number(saveBtn.dataset.commentId);
      const postId = Number(saveBtn.dataset.postId);
      if (commentId && postId) saveEditComment(commentId, postId);
      return;
    }
  });
}

/* =========================
   User popover (for post author)
   ========================= */
const USER_PREVIEW_CACHE_MS = 30000;
const userPreviewCache = new Map(); // userId -> {ts, data}

let userPopoverEl = null;
let userHideTimer = null;
let activeUserAnchor = null;
let activeUserId = null;
let userReqSeq = 0;

function firstLetter(str){
  const s = String(str || "").trim();
  return (s ? s[0] : "U").toUpperCase();
}

function ensureUserPopover(){
  if (userPopoverEl) return userPopoverEl;

  userPopoverEl = document.createElement("div");
  userPopoverEl.className = "userPopover";
  userPopoverEl.id = "userPopover";
  userPopoverEl.innerHTML = `
    <div class="userPopoverTop">
      <div class="userPopFallback">U</div>
      <div class="userPopMeta">
        <div class="name">載入中…</div>
        <div class="email"></div>
      </div>
    </div>
    <div class="userPopBio"></div>
    <div class="userPopHint"></div>
  `;
  document.body.appendChild(userPopoverEl);

  userPopoverEl.addEventListener("pointerenter", () => {
    if (userHideTimer) clearTimeout(userHideTimer);
    userHideTimer = null;
  });
  userPopoverEl.addEventListener("pointerleave", () => scheduleHideUserPopover());

  window.addEventListener("scroll", () => {
    if (userPopoverEl?.classList.contains("show") && activeUserAnchor){
      positionUserPopover(activeUserAnchor);
    }
  }, true);
  window.addEventListener("resize", () => {
    if (userPopoverEl?.classList.contains("show") && activeUserAnchor){
      positionUserPopover(activeUserAnchor);
    }
  });

  return userPopoverEl;
}

function scheduleHideUserPopover(){
  if (userHideTimer) clearTimeout(userHideTimer);
  userHideTimer = setTimeout(() => hideUserPopover(), 120);
}

function hideUserPopover(){
  if (!userPopoverEl) return;
  userPopoverEl.classList.remove("show");
  activeUserAnchor = null;
  activeUserId = null;
}

function positionUserPopover(anchor){
  const pop = ensureUserPopover();
  const rect = anchor.getBoundingClientRect();

  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const popW = 300;
  const popH = pop.offsetHeight || 160;

  // 預設放下方，不夠就放上方
  let top = rect.bottom + gap;
  if (top + popH > vh - 10){
    top = rect.top - gap - popH;
  }
  top = Math.max(10, Math.min(top, vh - popH - 10));

  let left = rect.left;
  if (left + popW > vw - 10) left = vw - popW - 10;
  if (left < 10) left = 10;

  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

async function fetchUserPreview(userId){
  const now = Date.now();
  const cached = userPreviewCache.get(userId);
  if (cached && (now - cached.ts) < USER_PREVIEW_CACHE_MS) return cached.data;

  const data = await apiFetch(`${API.users}/${userId}`, { method: "GET" });
  userPreviewCache.set(userId, { ts: now, data });
  return data;
}

function renderUserPopover(u){
  const pop = ensureUserPopover();

  const name = escapeHtml(u?.userName || "unknown");
  const email = escapeHtml(u?.email || "");
  const bio = escapeHtml(u?.bio || "");

  const pic = normalizeBackendUrl(u?.profilePic || "");
  const avatarHtml = pic
    ? `<img class="userPopAvatar" src="${escapeHtml(pic)}" alt="avatar" />`
    : `<div class="userPopFallback">${escapeHtml(firstLetter(u?.userName || u?.email || "U"))}</div>`;

  pop.querySelector(".userPopoverTop").innerHTML = `
    ${avatarHtml}
    <div class="userPopMeta">
      <div class="name">${name}</div>
      <div class="email">${email}</div>
    </div>
  `;

  pop.querySelector(".userPopBio").textContent = bio ? bio : "";
  pop.querySelector(".userPopHint").textContent = bio ? "" : "（沒有 bio）";
}

async function showUserPopover(anchorEl){
  const userId = Number(anchorEl.dataset.userId);
  if (!userId) return;

  const pop = ensureUserPopover();

  if (userHideTimer) clearTimeout(userHideTimer);
  userHideTimer = null;

  activeUserAnchor = anchorEl;
  activeUserId = userId;

  positionUserPopover(anchorEl);
  pop.classList.add("show");

  // loading
  pop.querySelector(".userPopoverTop").innerHTML = `
    <div class="userPopFallback">${escapeHtml(firstLetter(anchorEl.dataset.userName || "U"))}</div>
    <div class="userPopMeta">
      <div class="name">載入中…</div>
      <div class="email"></div>
    </div>
  `;
  pop.querySelector(".userPopBio").textContent = "";
  pop.querySelector(".userPopHint").textContent = "";

  const seq = ++userReqSeq;
  try{
    const data = await fetchUserPreview(userId);
    if (seq !== userReqSeq) return; // 避免 race condition
    renderUserPopover(data);
  }catch(e){
    if (seq !== userReqSeq) return;
    pop.querySelector(".userPopHint").textContent = `讀取失敗：${e.message}`;
  }
}

function initAuthorHoverUi(){
  const feed = $("feed");
  if (!feed) return;

  feed.addEventListener("pointerover", (e) => {
    const chip = e.target.closest?.(".authorChip");
    if (!chip) return;
    showUserPopover(chip);
  });

  feed.addEventListener("pointerout", (e) => {
    const chip = e.target.closest?.(".authorChip");
    if (!chip) return;

    const rt = e.relatedTarget;
    if (rt && userPopoverEl && userPopoverEl.contains(rt)) return;

    scheduleHideUserPopover();
  });
}

/* helpers */
function updateCharCount(){
  const v = $("postContent")?.value || "";
  const el = $("charCount");
  if (el) el.textContent = `${v.length} / 500`;
}

/* ===== init ===== */
function initHome(){
  syncWhoAmI();
  syncAccountUI();

  showPage("home");
  initLikesUi();
  initAuthorHoverUi();
  initCommentsUi();

  updateCharCount();
  bindFilePreview();

  const postContent = $("postContent");
  if (postContent) postContent.addEventListener("input", updateCharCount);

  pingBackend();
  loadPosts().catch(()=>{});
}

function initAuth(){
  uiSetAuthTab("login");
  pingBackend();
}

(function boot(){
  const page = document.body?.dataset?.page;
  if (page === "home") initHome();
  if (page === "auth") initAuth();
})();
