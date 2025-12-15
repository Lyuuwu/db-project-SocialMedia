// =========================
// Config / API endpoints
// =========================
const BASE_URL = location.origin;
const AUTH_PAGE_URL = "/static/auth.html";

const API = {
  register: "/api/v1/auth/register",
  login: "/api/v1/auth/login",
  refresh: "/api/v1/auth/refresh",
  logout: "/api/v1/auth/logout",
  me: "/api/v1/users/me",
  users: "/api/v1/users",
  posts: "/api/v1/posts",
  comments: "/api/v1/comments",
  follows: "/api/v1/follows",
  upload: "/api/upload"
};


// =========================
// Global state (in-memory)
// =========================
let postsCache = [];
const $ = (id) => document.getElementById(id);

// ===== home feed mode (all vs following) =====
let homeFeedMode = "all"; // "all" | "following"
const HOME_FEED_MODE_KEY = "miniig_home_feed_mode";

// ===== home search (users vs posts) =====
let searchMode = "users"; // "users" | "posts"
let searchDebounceTimer = null;
let userSearchUsers = [];
let userSearchActive = false;
let userSearchQuery = "";

// ===== post search state =====
let postSearchActive = false;
let postSearchQuery = "";
let postSearchReqSeq = 0;

// 追蹤名單快取（用來在主頁做「只看追蹤者貼文」）
const MY_FOLLOWING_CACHE_MS = 30000;
let myFollowingSet = new Set();
let myFollowingUserId = 0;
let myFollowingLoadedAt = 0;
let myFollowingLoading = null;
let myFollowingReqSeq = 0;

// hover 顯示最多幾個人（改 5 / 10 都可以）
const LIKES_HOVER_LIMIT = 8;

let likesHoverState = { postId: null, isOpen: false };

// 每篇貼文 likes 名單的版本號：避免舊 request 回來把舊資料塞回快取
const likesPreviewVer = new Map(); // postId -> integer

function bumpLikesPreviewVer(postId){
  likesPreviewVer.set(postId, (likesPreviewVer.get(postId) || 0) + 1);
}

// 清掉某篇貼文的 hover 名單快取，避免顯示舊資料
function invalidateLikesPreview(postId){
  likesPreviewCache.delete(postId);
  bumpLikesPreviewVer(postId);

  // 如果 popover 正在顯示這篇貼文的名單，直接關掉（避免畫面顯示舊資料）
  if (typeof activeLikesPostId !== "undefined" && activeLikesPostId === postId){
    hideLikesPopover();
  }
}


// =========================
// Utils
// =========================
function showMsg(el, type, text){
  if (!el) return;
  el.className = "msg " + (type || "");
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
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


// =========================
// Session / account UI
// =========================
function getSession(){
  const raw = localStorage.getItem("miniig_session");
  return raw ? JSON.parse(raw) : null; // { accessToken, user }
}

function setSession(session){
  const prev = getSession();
  const prevMe = Number(prev?.user?.userId || 0);

  if (!session) localStorage.removeItem("miniig_session");
  else localStorage.setItem("miniig_session", JSON.stringify(session));

  const nextMe = Number(session?.user?.userId || 0);

  // 登入狀態改變時，追蹤名單快取要一起重置（主頁「追蹤」分頁會用到）
  if (!nextMe || prevMe !== nextMe){
    resetMyFollowingCache();
  }else{
    // 同一個人：讓追蹤名單下次可重新抓一次（避免不同頁面操作後不同步）
    invalidateMyFollowingCache();
  }

  syncWhoAmI();
  syncAccountUI();

  // 若人在主頁，登入/登出後直接重繪（追蹤分頁需要追蹤名單）
  const page = document.body?.dataset?.page;
  if (page === "home"){
    if (homeFeedMode === "following"){
      ensureMyFollowingSet({ force: true }).finally(() => renderFeed());
    }else{
      renderFeed();
    }
  }
}

function getMeId(){
  return Number(getSession()?.user?.userId || 0);
}

function resetMyFollowingCache(){
  myFollowingSet = new Set();
  myFollowingUserId = 0;
  myFollowingLoadedAt = 0;
  myFollowingLoading = null;
  myFollowingReqSeq = 0;
}

function invalidateMyFollowingCache(){
  myFollowingSet = new Set();
  myFollowingLoadedAt = 0;
  myFollowingLoading = null;
}

function markMyFollowing(targetUserId, isFollowing){
  const meId = getMeId();
  if (!meId) return;
  if (myFollowingUserId !== meId) return;
  const tid = Number(targetUserId || 0);
  if (!tid) return;
  if (isFollowing) myFollowingSet.add(tid);
  else myFollowingSet.delete(tid);
  myFollowingLoadedAt = Date.now();
}

function syncWhoAmI(){
  const el = $("whoami");
  if (!el) return;
  const s = getSession();
  const u = s?.user;
  el.textContent = u ? ("目前帳號: " + (u.userName || u.email || "已登入")) : "未登入";
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

function initTopRightAvatarNav(){
  const avatarMenu = document.getElementById("avatarMenu");
  if (!avatarMenu) return;

  // 避免重複綁定
  if (avatarMenu.dataset.profileNavBound === "1") return;
  avatarMenu.dataset.profileNavBound = "1";

  avatarMenu.addEventListener("click", (e) => {
    // 點到彈出選單裡的按鈕/連結，不要導頁
    if (e.target.closest?.(".avatarPopover")) return;
    if (e.target.closest?.("button, a")) return;

    const meId = Number(getSession()?.user?.userId || 0);
    if (!meId) return; // 未登入就不做事（或你想導登入頁也可以）
    goToProfile(meId);
  });
}


// =========================
// Navigation helpers
// =========================
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

function goToProfile(userId){
  const id = Number(userId || 0);
  if (!id) return;
  location.href = `/u/${id}`;
}

function goToMyProfile(){
  const s = getSession();
  const myId = Number(s?.user?.userId || 0);
  if (!myId){
    alert("請先登入後再查看個人頁面");
    goToAuth();
    return;
  }
  goToProfile(myId);
}

function getProfileUserIdFromUrl(){
  // /u/123
  const m = location.pathname.match(/^\/u\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  // fallback: ?userId=123
  const qs = new URLSearchParams(location.search);
  return Number(qs.get("userId") || 0);
}

function setProfileBottomNavActive(isMe){
  const navMe = document.getElementById("navMe");
  if (!navMe) return;
  navMe.classList.toggle("active", !!isMe);
}

// =========================
// HTTP helpers
// =========================
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

  // 如果是 401，而且使用者「以為自己是登入狀態」，就嘗試 refresh 再重試一次
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

// ===== my following list (for Home "追蹤" feed) =====
async function ensureMyFollowingSet({ force = false } = {}){
  const meId = getMeId();
  if (!meId){
    resetMyFollowingCache();
    return myFollowingSet;
  }

  const now = Date.now();
  const userChanged = myFollowingUserId !== meId;
  const stale = !myFollowingLoadedAt || (now - myFollowingLoadedAt) > MY_FOLLOWING_CACHE_MS;

  if (!force && !userChanged && !stale){
    return myFollowingSet;
  }

  if (myFollowingLoading) return myFollowingLoading;

  const seq = ++myFollowingReqSeq;
  myFollowingLoading = (async () => {
    const pageSize = 200;
    let page = 1;
    let total = 0;
    let all = [];

    while (true){
      const data = await apiFetch(`${API.follows}/${meId}/following?page=${page}&pageSize=${pageSize}`, { method: "GET" });
      const items = data.items || [];
      total = data.total ?? total;
      all = all.concat(items);

      if (items.length === 0) break;
      if (total && all.length >= total) break;

      page += 1;
      if (page > 200) break; // safety
    }

    if (seq !== myFollowingReqSeq) return myFollowingSet;

    myFollowingSet = new Set(
      all.map(u => Number(u.userId || u.user_id || 0)).filter(Boolean)
    );
    myFollowingUserId = meId;
    myFollowingLoadedAt = Date.now();
    return myFollowingSet;
  })().finally(() => {
    if (seq === myFollowingReqSeq) myFollowingLoading = null;
  });

  return myFollowingLoading;
}


// =========================
// Auth page
// =========================
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
  const avatarFile = document.getElementById("regAvatarFile")?.files?.[0];

  if (!email || !password || !userName){
    return showMsg(msg, "err", "必填：email / password / userName");
  }

  try{
    const data = await apiFetch(API.register, {
      method:"POST",
      body: JSON.stringify({ email, password, userName })
    });

    setSession({ accessToken: data.accessToken, user: data.user });

    if (bio || avatarFile){
      const patchBody = {};
      if (bio) patchBody.bio = bio;

      // 註冊後用 accessToken 才能 PATCH /me，所以圖片在這裡上傳 & 更新
      if (avatarFile){
        const fd = new FormData();
        fd.append("file", avatarFile);

        // 若你之後把 /api/upload 改成需要登入，這裡先把 token 帶上
        const headers = {};
        if (data?.accessToken) headers.Authorization = `Bearer ${data.accessToken}`;

        const res = await fetch(baseOrigin() + API.upload, {
          method: "POST",
          body: fd,
          headers,
        });

        let up = null;
        try{ up = await res.json(); }catch{ up = null; }
        if (!res.ok) throw new Error(up?.error?.message || up?.message || "圖片上傳失敗");

        patchBody.profilePic = up?.url || "";
      }

      const me = await apiFetch(API.me, {
        method:"PATCH",
        body: JSON.stringify(patchBody),
      });

      setSession({ accessToken: data.accessToken, user: me });
    }

    showMsg(msg, "ok", "註冊成功並已登入！");
    // 登入後回到上一頁
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
    // 登入後回到上一頁
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


// =========================
// Home / Create (page toggles & UI)
// =========================
function showPage(which){
  const isHome = (which === "home");
  const pageHome = $("pageHome");
  const pageCreate = $("pageCreate");
  const navHome = $("navHome");
  const navCreate = $("navCreate");
  const mainHead = $("mainHead");

  if (pageHome) pageHome.style.display = isHome ? "block" : "none";
  if (pageCreate) pageCreate.style.display = isHome ? "none" : "block";
  if (navHome) navHome.classList.toggle("active", isHome);
  if (navCreate) navCreate.classList.toggle("active", !isHome);

  // Create 頁不需要外框（title/desc/search controls）
  // 用 CSS 預設樣式顯示（不要硬寫 flex），Create 頁則隱藏
  if (mainHead) mainHead.style.display = isHome ? "" : "none";

  const pageTitle = $("pageTitle");
  const pageDesc = $("pageDesc");
  if (pageTitle) pageTitle.textContent = isHome ? "首頁｜最新貼文" : "發文｜建立新貼文";
  if (pageDesc) pageDesc.textContent = isHome
    ? "顯示所有貼文，依 time/createdAt 由新到舊排序。"
    : "在這裡撰寫貼文，送出後回到 Home。";
}

/* =========================
   Home feed tabs (Following vs All)
   ========================= */
function applyHomeFeedModeFromStorage(){
  const v = (localStorage.getItem(HOME_FEED_MODE_KEY) || "").trim();
  homeFeedMode = (v === "following" || v === "all") ? v : "all";
}

function updateHomeFeedTabsUI(){
  const f = $("feedTabFollowing");
  const a = $("feedTabAll");
  if (f) f.classList.toggle("active", homeFeedMode === "following");
  if (a) a.classList.toggle("active", homeFeedMode === "all");
}

async function switchHomeFeedMode(mode, { silent = false } = {}){
  const next = (mode === "following") ? "following" : "all";
  homeFeedMode = next;
  try{ localStorage.setItem(HOME_FEED_MODE_KEY, homeFeedMode); }catch{}
  updateHomeFeedTabsUI();

  if (silent){
    renderFeed?.();
    return;
  }

  if (homeFeedMode === "following"){
    const meId = getMeId();
    if (meId){
      try{ await ensureMyFollowingSet({ force: true }); }catch{}
    }
  }

  if (searchMode === "posts" && postSearchActive && postSearchQuery){
    await performPostSearch(postSearchQuery);
    return;
  }

  renderFeed?.();
}

function initHomeFeedTabs(){
  applyHomeFeedModeFromStorage();
  updateHomeFeedTabsUI();

  const wrap = $("feedTabs");
  if (!wrap) return;

  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".feedTab");
    if (!btn) return;
    const mode = btn.dataset.mode;
    switchHomeFeedMode(mode).catch(()=>{});
  });
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


// =========================
// Posts
// =========================
async function loadPosts(opts = {}){
  try{
    const authorIds = (opts?.authorIds || "").trim();
    const qs = authorIds ? `?page=1&pageSize=50&authorIds=${encodeURIComponent(authorIds)}` : "?page=1&pageSize=50";
    const data = await apiFetch(API.posts + qs, { method:"GET" });
    postsCache = Array.isArray(data) ? data : (data.items || []);

    postsCache.sort((a,b)=>{
      const ta = new Date(a.createdAt || a.time || 0).getTime();
      const tb = new Date(b.createdAt || b.time || 0).getTime();
      return tb - ta;
    });

    // 整批更新後把 hover 快取清掉
    likesPreviewCache.clear();
    likesHoverState = { postId: null, isOpen: false };
    hideLikesPopover();

    // 若目前在主頁「追蹤」分頁，先確保追蹤名單已載入
    if (homeFeedMode === "following" && getMeId()){
      try{ await ensureMyFollowingSet({ force: false }); }catch{}
    }

    renderFeed();
  }catch(e){
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

    const created = await apiFetch(API.posts, {
      method:"POST",
      body: JSON.stringify({ content, picture: pictureUrl })
    });

    showMsg(msg, "ok", "發佈成功！");
    if ($("postContent")) $("postContent").value = "";
    clearPostImage();
    updateCharCount();

    // 若在獨立的 create.html，發文後回到 Home
    if (document.body?.dataset?.page === "create"){
      const pid = Number(created?.postId || created?.id || 0);
      location.href = pid ? (`/?postId=${pid}`) : "/";
      return;
    }

    // 舊版（同頁切換）仍保留
    showPage("home");
    await loadPosts();
  }catch(e){
    showMsg(msg, "err", `發文失敗：${e.message}`);
  }
}


// =========================
// Likes (hover preview + modal)
// =========================
const LIKES_PREVIEW_LIMIT = 5;  // Likes hover 預覽最多幾人
const LIKES_PAGE_SIZE = 200;    // modal 分頁一次拿幾個（後端有上限 200）

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
  likesPopoverEl.addEventListener("click", (e) => {
    const row = e.target.closest?.(".likeUserRow");
    if (!row) return;

    const uid = Number(row.dataset.userId || 0);
    if (!uid) return;

    hideLikesPopover();
    goToProfile(uid);
  });


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
  const userId = Number(u.userId || 0);
  const name = escapeHtml(u.userName || "unknown");
  const pic = normalizeBackendUrl(u.profilePic || "");

  const avatar = pic
    ? `<img class="likeMiniAvatar" src="${escapeHtml(pic)}" alt="avatar" />`
    : `<div class="likeMiniFallback">${name.slice(0,1).toUpperCase()}</div>`;

  return `
    <div class="likeRow likeUserRow"
         data-user-id="${userId}"
         role="button"
         tabindex="0">
      ${avatar}
      <div class="likeName">${name}</div>
    </div>
  `;
}

// follow / followers 名單用：右側多一個「追蹤/追蹤中」按鈕（可直接管理）
function renderFollowUserRow(u, { showAction = true, profileUserId = 0 } = {}){
  const userId = Number(u.userId || 0);
  const meId = Number(getSession()?.user?.userId || 0);
  const name = escapeHtml(u.userName || "unknown");
  const pic = normalizeBackendUrl(u.profilePic || "");

  const avatar = pic
    ? `<img class="likeMiniAvatar" src="${escapeHtml(pic)}" alt="avatar" />`
    : `<div class="likeMiniFallback">${name.slice(0,1).toUpperCase()}</div>`;

  const loggedIn = !!getSession()?.accessToken;
  // 自己不顯示追蹤按鈕
  if (meId && userId && meId === userId) showAction = false;

  const canManage = showAction && loggedIn && meId && (meId !== userId);

  const followed = !!u.followedByMe;

  const btnHtml = canManage
    ? `<div class="likeRowActions">
         <button class="btn small followBtn inlineFollowBtn ${followed ? "following" : "follow"}"
                 data-user-id="${userId}"
                 data-profile-user-id="${Number(profileUserId || 0)}"
                 data-followed="${followed ? "1" : "0"}">
           ${followed ? "追蹤中" : "追蹤"}
         </button>
       </div>`
    : ``;

  return `
    <div class="likeRow likeUserRow hasActions"
         data-user-id="${userId}"
         role="button"
         tabindex="0">
      ${avatar}
      <div class="likeName">${name}</div>
      ${btnHtml}
    </div>
  `;
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

  // 這次顯示的 request id
  const reqId = ++likesPreviewReqSeq;

  try{
    const data = await fetchLikesPreview(postId);

    // 如果途中又觸發其他 hover / 或 popover 已切到別篇，就不要用舊結果覆蓋 UI
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

  const listEl = $("likesModalList");
  if (listEl){
    listEl.addEventListener("click", (e) => {
      const row = e.target.closest?.(".likeUserRow");
      if (!row) return;

      const uid = Number(row.dataset.userId || 0);
      if (!uid) return;

      closeLikesModal();
      goToProfile(uid);
    });
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


// =========================
// Search (users / posts)
// =========================
function setSearchMode(mode){
  searchMode = (mode === "posts") ? "posts" : "users";
  if (searchMode === "users"){
    postSearchActive = false;
    postSearchQuery = "";
  }
  const sel = document.getElementById("searchMode");
  if (sel) sel.value = searchMode;

  const input = document.getElementById("search");
  if (input){
    input.placeholder = (searchMode === "users")
      ? "輸入用戶名稱 / Email / Bio…"
      : "搜尋貼文內文…";
  }

  // 切到 posts：先回到原本的首頁貼文
  if (searchMode === "posts"){
    clearUserSearch({ reloadPosts: true });
  }
}

function onSearchModeChange(){
  const sel = document.getElementById("searchMode");
  setSearchMode(sel?.value || "users");
}

function onSearchInput(){
  const q = (document.getElementById("search")?.value || "").trim();

  if (searchMode === "users"){
    // debounce：避免每個字都打 API
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      performUserSearch(q).catch(()=>{});
    }, 260);
    return;
  }

  // posts mode：debounce 走後端搜尋
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    performPostSearch(q).catch(()=>{});
  }, 260);
  return;
}

function performSearch(){
  const q = (document.getElementById("search")?.value || "").trim();

  if (searchMode === "users"){
    performUserSearch(q).catch(()=>{});
    return;
  }

  // posts mode：後端搜尋
  performPostSearch(q).catch(()=>{});
}

function clearUserSearch({ reloadPosts = false } = {}){
  userSearchUsers = [];
  userSearchActive = false;
  userSearchQuery = "";

  const sec = document.getElementById("userSearchSection");
  if (sec) sec.style.display = "none";
  const car = document.getElementById("userCarousel");
  if (car) car.innerHTML = "";

  // feed tabs 恢復
  const tabs = document.getElementById("feedTabs");
  tabs?.classList.remove("disabled");

  if (reloadPosts){
    loadPosts().catch(()=>{});
  }else{
    renderFeed();
  }
}


function clearPostSearch({ reloadPosts = false } = {}){
  postSearchActive = false;
  postSearchQuery = "";

  const input = document.getElementById("search");
  if (input) input.value = "";

  if (reloadPosts){
    loadPosts().catch(()=>{});
  }else{
    renderFeed();
  }
}

async function performPostSearch(q){
  const query = (q || "").trim();

  // 切到 posts 搜尋時：一定要先清掉 user 搜尋 UI
  if (userSearchActive){
    clearUserSearch({ reloadPosts: false });
  }

  // 空字串：回到一般貼文列表
  if (!query){
    postSearchActive = false;
    postSearchQuery = "";
    await loadPosts();
    return;
  }

  postSearchActive = true;
  postSearchQuery = query;

  // 主頁用戶搜尋區塊隱藏
  const sec = document.getElementById("userSearchSection");
  if (sec) sec.style.display = "none";

  // 依目前 feed tab 決定是否只看追蹤
  const followOnly = (homeFeedMode === "following") ? "1" : "0";

  const mySeq = ++postSearchReqSeq;
  try{
    const data = await apiFetch(`${API.posts}/search?query=${encodeURIComponent(query)}&page=1&pageSize=50&followOnly=${followOnly}`, { method:"GET" });
    if (mySeq !== postSearchReqSeq) return; // ignore stale

    postsCache = Array.isArray(data) ? data : (data.items || []);
    renderFeed();
  }catch(e){
    // 搜尋失敗：不要卡死，至少顯示錯誤訊息
    postsCache = [];
    renderFeed();
    alert(`搜尋貼文失敗：${e.message}`);
  }
}


function renderUserCard(u){
  const userId = Number(u?.userId || 0);
  const userName = (u?.userName || "").trim();
  const email = (u?.email || "").trim();
  const bio = (u?.bio || "").trim();
  const picRaw = (u?.profilePic || "").trim();
  const pic = normalizeBackendUrl(picRaw);
  const banner = normalizeBackendUrl((u?.bannerPic || "").trim());

  const followedByMe = !!u?.followedByMe;
  const meId = getMeId();
  const canFollow = !!meId && userId && (userId !== meId);

  const avatarHtml = pic
    ? `<img class="userAvatar" src="${escapeHtml(pic)}" alt="avatar" />`
    : `<div class="userAvatarFallback" aria-hidden="true">${escapeHtml(initialsFromUser({ userName, email }))}</div>`;

  const btnText = followedByMe ? "追蹤中" : "追蹤";
  const btnClass = followedByMe ? "btn ghost small userFollowBtn" : "btn primary small userFollowBtn";

  return `
    <div class="userCard" data-user-id="${userId}">
      <div class="userCardTop"${banner ? ` style="background-image:url(\'${escapeHtml(banner)}\')"` : ""}></div>
      <div class="userCardBody">
        <div class="userCardLeft">
          ${avatarHtml}
          <div class="userMiniName" title="${escapeHtml(userName)}">${escapeHtml(userName || "—")}</div>
          <div class="userMiniEmail" title="${escapeHtml(email)}">${escapeHtml(email || "")}</div>
        </div>
        <div class="userCardMain">
          <div class="userBio" title="${escapeHtml(bio)}">${escapeHtml(bio || "（沒有介紹）")}</div>
          <div class="userCardActions">
            <button type="button"
                    class="${btnClass}"
                    data-action="follow"
                    data-followed="${followedByMe ? "1" : "0"}"
                    ${canFollow ? "" : "disabled"}>
              ${btnText}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function updateUserNavButtons(){
  const car = document.getElementById("userCarousel");
  const prev = document.getElementById("userPrevBtn");
  const next = document.getElementById("userNextBtn");
  if (!car || !prev || !next) return;

  const max = Math.max(0, car.scrollWidth - car.clientWidth);
  const x = Math.round(car.scrollLeft);

  const atLeft = x <= 0;
  const atRight = x >= (max - 1);

  prev.style.display = atLeft ? "none" : "grid";
  next.style.display = atRight ? "none" : "grid";
}

function scrollUserCarousel(dir){
  const car = document.getElementById("userCarousel");
  if (!car) return;

  // 一次滑動「一張卡」左右（含 gap）
  const card = car.querySelector(".userCard");
  const step = card ? (card.getBoundingClientRect().width + 12) : 320;

  const max = Math.max(0, car.scrollWidth - car.clientWidth);
  const target = Math.min(max, Math.max(0, car.scrollLeft + dir * step));
  car.scrollTo({ left: target, behavior: "smooth" });
}

function bindUserCarouselDrag(){
  const car = document.getElementById("userCarousel");
  if (!car) return;

  let dragging = false;
  let startX = 0;
  let startLeft = 0;

  const onDown = (e) => {
    dragging = true;
    car.classList.add("dragging");
    startX = (e.touches ? e.touches[0].clientX : e.clientX);
    startLeft = car.scrollLeft;
  };

  const onMove = (e) => {
    if (!dragging) return;
    const x = (e.touches ? e.touches[0].clientX : e.clientX);
    const dx = x - startX;

    const max = Math.max(0, car.scrollWidth - car.clientWidth);
    const next = Math.min(max, Math.max(0, startLeft - dx));
    car.scrollLeft = next;
    updateUserNavButtons();
    if (e.cancelable) e.preventDefault();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    car.classList.remove("dragging");
    updateUserNavButtons();
  };

  car.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  // touch
  car.addEventListener("touchstart", onDown, { passive: true });
  car.addEventListener("touchmove", onMove, { passive: false });
  car.addEventListener("touchend", onUp);
  car.addEventListener("scroll", () => updateUserNavButtons(), { passive: true });
}

function initUserSearchUi(){
  const input = document.getElementById("search");
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter"){
      e.preventDefault();
      performSearch();
    }
  });

  document.getElementById("userPrevBtn")?.addEventListener("click", () => scrollUserCarousel(-1));
  document.getElementById("userNextBtn")?.addEventListener("click", () => scrollUserCarousel(1));

  bindUserCarouselDrag();

  // 預設：第一種搜尋先做，所以直接設成 users
  setSearchMode(document.getElementById("searchMode")?.value || "users");
  updateUserNavButtons();
}

async function performUserSearch(query){
  const q = (query || "").trim();
  const sec = document.getElementById("userSearchSection");
  const tabs = document.getElementById("feedTabs");

  if (!q){
    clearUserSearch({ reloadPosts: true });
    return;
  }

  userSearchActive = true;
  userSearchQuery = q;

  // user 搜尋時，不用「追蹤/全部」分頁（貼文已經是依搜尋用戶決定）
  tabs?.classList.add("disabled");

  // 先顯示 loading
  if (sec) sec.style.display = "block";
  const car = document.getElementById("userCarousel");
  if (car) car.innerHTML = `<div class="msg" style="display:block; min-width:240px;">搜尋用戶中…</div>`;

  const data = await apiFetch(`${API.users}/search?query=${encodeURIComponent(q)}&limit=20`, { method:"GET" });
  const items = Array.isArray(data?.items) ? data.items : [];

  userSearchUsers = items;

  if (!items.length){
    if (car) car.innerHTML = `<div class="msg" style="display:block; min-width:240px;">找不到符合用戶。</div>`;
    updateUserNavButtons();
    postsCache = [];
    renderFeed();
    return;
  }

  if (car){
    car.innerHTML = items.map(renderUserCard).join("");
  }

  // bind events on cards
  car?.querySelectorAll(".userCard").forEach(el => {
    const uid = Number(el.getAttribute("data-user-id") || 0);

    // 點卡片去 profile
    el.addEventListener("click", (e) => {
      const act = e.target?.getAttribute?.("data-action");
      if (act === "follow") return; // follow button handled separately
      if (!uid) return;
      location.href = `/static/profile.html?userId=${uid}`;
    });

    // follow button
    const btn = el.querySelector('button[data-action="follow"]');
    btn?.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const meId = getMeId();
      if (!meId){
        goToAuth();
        return;
      }
      if (!uid || uid === meId) return;

      const currently = btn.getAttribute("data-followed") === "1";
      btn.disabled = true;

      try{
        if (currently){
          await apiFetch(`${API.follows}/${uid}`, { method:"DELETE" });
          btn.setAttribute("data-followed", "0");
          btn.className = "btn primary small userFollowBtn";
          btn.textContent = "追蹤";
          // update cache + local state
          markMyFollowing(uid, false);
          const u = userSearchUsers.find(x => Number(x.userId) === uid);
          if (u) u.followedByMe = false;
        }else{
          await apiFetch(`${API.follows}/${uid}`, { method:"POST" });
          btn.setAttribute("data-followed", "1");
          btn.className = "btn ghost small userFollowBtn";
          btn.textContent = "追蹤中";
          markMyFollowing(uid, true);
          const u = userSearchUsers.find(x => Number(x.userId) === uid);
          if (u) u.followedByMe = true;
        }
      }catch(err){
        alert(`追蹤操作失敗：${err.message}`);
      }finally{
        btn.disabled = false;
      }
    });
  });

  // 捲動到最左邊
  if (car) car.scrollLeft = 0;
  updateUserNavButtons();

  // load posts from these users only
  const ids = items.map(u => Number(u.userId)).filter(Boolean).join(",");
  await loadPosts({ authorIds: ids });
}


function renderFeed(){
  const rawQ = ($("search")?.value || "").trim();
  const q = (searchMode === "posts") ? (postSearchActive ? postSearchQuery : rawQ) : "";
  const ql = (q || "").trim().toLowerCase();
  const feed = $("feed");
  if (!feed) return;
  feed.innerHTML = "";

  let base = (postsCache || []);

  // 主頁「追蹤」分頁：只顯示「你追蹤的人 + 自己」的貼文
  if (homeFeedMode === "following"){
    const meId = getMeId();

    // 未登入：提示登入
    if (!meId){
      const box = document.createElement("div");
      box.className = "msg";
      box.style.display = "block";
      box.innerHTML = `請先登入才能查看追蹤動態。 <button type="button" class="btn ghost small" id="goLoginFromFeed">登入 / 註冊</button>`;
      feed.appendChild(box);
      box.querySelector("#goLoginFromFeed")?.addEventListener("click", () => goToAuth());
      return;
    }

    // 追蹤名單還沒準備好：先載入
    const needsLoad = (myFollowingUserId !== meId) || (!myFollowingLoadedAt && !myFollowingLoading);
    if (needsLoad){
      ensureMyFollowingSet({ force: true }).catch(()=>{});
    }

    if (myFollowingLoading){
      const box = document.createElement("div");
      box.className = "msg";
      box.style.display = "block";
      box.textContent = "載入追蹤名單…";
      feed.appendChild(box);
      return;
    }

    base = base.filter(p => {
      const authorId = Number(p.author?.userId ?? p.author?.user_id ?? p.userId ?? p.user_id ?? 0);
      if (!authorId) return false;
      return (authorId === meId) || myFollowingSet.has(authorId);
    });
  }

  const list = base.filter(p=>{
    if (!ql) return true;
    const s = (p.content || "").toLowerCase();
    return s.includes(ql);
  });


  if (list.length === 0){
    const empty = document.createElement("div");
    empty.className = "msg";
    empty.style.display = "block";
    empty.textContent = (homeFeedMode === "following")
    ? "追蹤動態目前沒有貼文（或搜尋結果為空）。"
    : "目前沒有貼文（或搜尋結果為空）。";
    feed.appendChild(empty);
    return;
  }

  const openCommentsToLoad = [];

  list.forEach(p=>{
    const card = document.createElement("div");
    card.className = "postCard";

    const t = escapeHtml(fmtTime(p.createdAt || p.created_at || p.time || ""));
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
      <div class="time">${t}</div>
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

    card.dataset.postId = String(postId);

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

    // 清掉 hover 名單快取，避免顯示舊資料
    invalidateLikesPreview(postId);

    // 重新渲染畫面
    renderFeed();
    }catch(e){
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
}catch(e){
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
}catch(e){
}
}


// =========================
// Comments (per post)
// =========================
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


// =========================
// Follow (status/cache + operations)
// =========================
const FOLLOW_CACHE_MS = 15000;
const followStatusCache = new Map(); // userId -> {ts, followedByMe}

function invalidateFollowStatus(userId){
  followStatusCache.delete(userId);
}

function setFollowStatusCache(userId, followedByMe){
  if (!userId) return;
  followStatusCache.set(Number(userId), { ts: Date.now(), followedByMe: !!followedByMe });
}

async function fetchFollowStatus(userId){
  const now = Date.now();
  const cached = followStatusCache.get(userId);
  if (cached && (now - cached.ts) < FOLLOW_CACHE_MS) return cached.followedByMe;

  try{
    const data = await apiFetch(`${API.follows}/${userId}`, { method: "GET" });
    const followed = !!data.followedByMe;
    followStatusCache.set(userId, { ts: now, followedByMe: followed });
    return followed;
  }catch(e){
    // 沒登入 / 其他錯誤：就當作未追蹤
    return false;
  }
}

async function doFollow(userId){
  const data = await apiFetch(`${API.follows}/${userId}`, { method: "POST" });
  invalidateFollowStatus(userId);
  return !!data.followed;
}

async function doUnfollow(userId){
  const data = await apiFetch(`${API.follows}/${userId}`, { method: "DELETE" });
  invalidateFollowStatus(userId);
  return !!data.followed; // 應為 false
}

function setFollowBtnState(btn, { targetUserId, followedByMe }){
  const meId = Number(getSession()?.user?.userId || 0);

  // 未登入 or 看自己：不顯示按鈕
  if (!meId || meId === Number(targetUserId || 0)){
    btn.style.display = "none";
    btn.dataset.userId = "";
    btn.dataset.followed = "0";
    btn.classList.remove("following", "follow");
    btn.textContent = "";
    return;
  }

  btn.style.display = "inline-flex";
  btn.dataset.userId = String(targetUserId);
  btn.dataset.followed = followedByMe ? "1" : "0";

  if (followedByMe){
    btn.classList.add("following");
    btn.classList.remove("follow");
    btn.textContent = "追蹤中";
  }else{
    btn.classList.add("follow");
    btn.classList.remove("following");
    btn.textContent = "追蹤";
  }
}


// =========================
// Profile follow lists (following/followers modals)
// =========================
const FOLLOWING_PAGE_SIZE = 200;

async function fetchFollowingPage(userId, page){
  const qs = new URLSearchParams({ page: String(page), pageSize: String(FOLLOWING_PAGE_SIZE) });
  return await apiFetch(`${API.follows}/${userId}/following?${qs.toString()}`, { method: "GET" });
}

let followingUiInited = false;
function initFollowingUi(){
  if (followingUiInited) return;
  followingUiInited = true;

  const overlay = $("followingOverlay");
  const modal = $("followingModal");
  const closeBtn = $("followingCloseBtn");
  const list = $("followingModalList");

  if (overlay){
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeFollowingModal();
    });
  }
  if (modal){
    modal.addEventListener("click", (e) => e.stopPropagation());
  }
  if (closeBtn){
    closeBtn.addEventListener("click", closeFollowingModal);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFollowingModal();
  });

  // 點擊名單中的使用者 -> 導入個人頁
  if (list){
    list.addEventListener("click", (e) => {
      // 先處理「追蹤/追蹤中」按鈕（不要觸發導頁）
      const btn = e.target.closest?.(".inlineFollowBtn");
      if (btn){
        e.preventDefault();
        e.stopPropagation();

        const targetId = Number(btn.dataset.userId || 0);
        if (!targetId) return;

        const s = getSession();
        if (!s?.accessToken){
          goToAuth();
          return;
        }

        const currentlyFollowed = (btn.dataset.followed === "1");
        if (currentlyFollowed){
          if (!confirm("確定要取消追蹤嗎？")) return;
        }

        (async () => {
          try{
            if (currentlyFollowed) await doUnfollow(targetId);
            else await doFollow(targetId);

            // 更新按鈕狀態
            const nowFollowed = !currentlyFollowed;
            btn.dataset.followed = nowFollowed ? "1" : "0";
            btn.classList.toggle("following", nowFollowed);
            btn.classList.toggle("follow", !nowFollowed);
            btn.textContent = nowFollowed ? "追蹤中" : "追蹤";

            // 保持 profile follow button 一致
            setFollowStatusCache(targetId, nowFollowed);

            // 如果正在看自己的個人頁：追蹤數會變，更新一下
            const meId = Number(getSession()?.user?.userId || 0);
            const profileUserId = Number(getProfileUserIdFromUrl() || 0);
            if (meId && profileUserId && meId === profileUserId){
              await updateFollowingBtnCount(profileUserId);
              await updateFollowersBtnCount(profileUserId);
            }
          }catch(err){
            alert(`操作失敗：${err.message}`);
          }
        })();
        return;
      }

      const row = e.target.closest?.(".likeRow");
      if (!row) return;
      const uid = Number(row.dataset.userId || 0);
      if (!uid) return;
      closeFollowingModal();
      goToProfile(uid);
    });
  }
}

function openFollowingModal(userId){
  const overlay = $("followingOverlay");
  if (!overlay || !userId) return;

  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");

  const header = $("followingModalHeader");
  const list = $("followingModalList");
  if (header) header.textContent = "載入中…";
  if (list) list.innerHTML = "";

  loadFollowingIntoModal(userId).catch((err) => {
    if (header) header.textContent = "讀取失敗";
    if (list) list.innerHTML = `<div class="msg" style="display:block;">${escapeHtml(err.message)}</div>`;
  });
}

function closeFollowingModal(){
  const overlay = $("followingOverlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
}

/* =========================
   Followers modal (who follows this user)
   ========================= */

const FOLLOWERS_PAGE_SIZE = 200;

async function fetchFollowersPage(userId, page){
  const qs = new URLSearchParams({ page: String(page), pageSize: String(FOLLOWERS_PAGE_SIZE) });
  return await apiFetch(`${API.follows}/${userId}/followers?${qs.toString()}`);
}

let followersUiInited = false;

function initFollowersUi(){
  if (followersUiInited) return;
  followersUiInited = true;

  const overlay = $("followersOverlay");
  const modal = $("followersModal");
  const closeBtn = $("followersCloseBtn");
  const list = $("followersModalList");

  if (overlay){
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeFollowersModal();
    });
  }
  if (modal){
    modal.addEventListener("click", (e) => e.stopPropagation());
  }
  if (closeBtn){
    closeBtn.addEventListener("click", closeFollowersModal);
  }

  // 點擊名單中的使用者 -> 導入個人頁
  if (list){
    list.addEventListener("click", async (e) => {
      // inline follow button
      const btn = e.target.closest?.(".inlineFollowBtn");
      if (btn){
        e.preventDefault();
        e.stopPropagation();

        const targetId = Number(btn.dataset.userId || 0);
        if (!targetId) return;

        const s = getSession();
        if (!s?.accessToken){
          goToAuth();
          return;
        }

        const followed = (btn.dataset.followed === "1");
        if (followed){
          if (!confirm("要取消追蹤嗎？")) return;
        }

        try{
          const profileUserId = Number(btn.dataset.profileUserId || 0);
          await apiFetch(`${API.follows}/${targetId}`, { method: followed ? "DELETE" : "POST" });
          setFollowStatusCache(targetId, !followed);
          btn.dataset.followed = (!followed) ? "1" : "0";
          btn.textContent = (!followed) ? "追蹤中" : "追蹤";
          btn.classList.toggle("following", !followed);
          btn.classList.toggle("follow", followed);

          // 若是在自己的個人頁面，追蹤數會變動
          const meId = Number(getSession()?.user?.userId || 0);
          if (profileUserId && meId && profileUserId === meId){
            updateFollowingBtnCount(meId).catch(()=>{});
          }
        }catch(err){
          alert(`更新追蹤失敗：${err.message || err}`);
        }
        return;
      }

      const row = e.target.closest?.(".likeUserRow");
      if (!row) return;
      const uid = Number(row.dataset.userId || 0);
      if (!uid) return;
      closeFollowersModal();
      goToProfile(uid);
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFollowersModal();
  });
}

function openFollowersModal(userId){
  const overlay = $("followersOverlay");
  if (!overlay || !userId) return;
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");

  $("followersModalHeader").textContent = "載入中…";
  $("followersModalList").innerHTML = "";

  loadFollowersIntoModal(userId).catch(()=>{});
}

function closeFollowersModal(){
  const overlay = $("followersOverlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
}

async function loadFollowersIntoModal(userId){
  const header = $("followersModalHeader");
  const listEl = $("followersModalList");

  let page = 1;
  let all = [];
  let total = 0;

  while (true){
    const data = await fetchFollowersPage(userId, page);
    const items = data.items || [];
    total = data.total ?? total;
    all = all.concat(items);
    if (items.length === 0) break;
    if (total && all.length >= total) break;
    page += 1;
    if (page > 200) break;
  }

  header.textContent = total ? `粉絲 ${total} 人` : "目前還沒有粉絲";
  listEl.innerHTML = all.length
    ? all.map((u) => renderFollowUserRow(u, { showAction: true, profileUserId: userId })).join("")
    : `<div class="msg" style="display:block;">目前還沒有粉絲</div>`;
}

async function updateFollowersBtnCount(profileUserId){
  const btn = $("profileFollowersBtn");
  if (!btn || !profileUserId) return;
  try{
    const data = await apiFetch(`${API.follows}/${profileUserId}/followers?page=1&pageSize=1`, { method: "GET" });
    const total = Number(data.total ?? 0);
    btn.textContent = `粉絲 (${total})`;
  }catch{
    btn.textContent = "粉絲";
  }
}

// 追蹤關係變更後：如果目前正在看該 user 的個人頁，就刷新粉絲按鈕數字
async function refreshFollowersCountIfViewing(targetUserId){
  const viewingId = Number(getProfileUserIdFromUrl?.() || 0);
  if (!viewingId) return;
  if (Number(targetUserId) !== viewingId) return;

  // 重新抓 total，更新「粉絲 (N)」
  await updateFollowersBtnCount(viewingId);
}

async function loadFollowingIntoModal(userId){
  const header = $("followingModalHeader");
  const listEl = $("followingModalList");
  if (!header || !listEl) return;

  let page = 1;
  let all = [];
  let total = 0;

  while (true){
    const data = await fetchFollowingPage(userId, page);
    const items = data.items || [];
    total = data.total ?? total;

    all = all.concat(items);

    if (items.length === 0) break;
    if (total && all.length >= total) break;

    page += 1;
    if (page > 200) break; // 保護
  }

  header.textContent = total ? `追蹤中 ${total} 人` : "目前沒有追蹤任何人";
  listEl.innerHTML = all.length
    ? all.map((u) => renderFollowUserRow(u, { showAction: true, profileUserId: userId })).join("")
    : `<div class="msg" style="display:block;">目前沒有追蹤任何人</div>`;
}

async function updateFollowingBtnCount(userId){
  const btn = $("profileFollowingBtn");
  if (!btn || !userId) return;

  try{
    const data = await apiFetch(`${API.follows}/${userId}/following?page=1&pageSize=1`, { method: "GET" });
    const total = Number(data.total ?? 0);
    btn.textContent = `追蹤名單 (${total})`;
  }catch{
    btn.textContent = "追蹤名單";
  }
}

async function syncProfileFollowState(userId){
  const btn = $("profileFollowBtn");
  if (!btn || !userId) return;

  // 先避免閃爍
  setFollowBtnState(btn, { targetUserId: userId, followedByMe: false });

  try{
    const followed = await fetchFollowStatus(userId);
    setFollowBtnState(btn, { targetUserId: userId, followedByMe: followed });
  }catch{
    setFollowBtnState(btn, { targetUserId: userId, followedByMe: false });
  }
}

function initProfileFollowUi(userId){
  initFollowingUi();
  initFollowersUi();

  const followBtn = $("profileFollowBtn");
  const followingBtn = $("profileFollowingBtn");
  const followersBtn = $("profileFollowersBtn");

  if (followBtn && !followBtn.dataset.bound){
    followBtn.dataset.bound = "1";

    followBtn.addEventListener("click", async () => {
      const s = getSession();
      if (!s?.accessToken){
        goToAuth();
        return;
      }

      const isFollowing = followBtn.dataset.followed === "1";
      try{
        if (isFollowing){
          const ok = confirm("確定要取消追蹤嗎？");
          if (!ok) return;
          await doUnfollow(userId);
          setFollowBtnState(followBtn, { targetUserId: userId, followedByMe: false });
        }else{
          await doFollow(userId);
          setFollowBtnState(followBtn, { targetUserId: userId, followedByMe: true });
        }

        await refreshFollowersCountIfViewing(userId);
      }catch(err){
        alert(`操作失敗：${err.message}`);
      }
    });
  }

  if (followingBtn && !followingBtn.dataset.bound){
    followingBtn.dataset.bound = "1";
    followingBtn.addEventListener("click", () => openFollowingModal(userId));
  }

  if (followersBtn && !followersBtn.dataset.bound){
    followersBtn.dataset.bound = "1";
    followersBtn.addEventListener("click", () => openFollowersModal(userId));
  }
}


// =========================
// User popover (hover card)
// =========================
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
    <div class="userPopoverTop"></div>
    <div class="userPopBio"></div>
    <div class="userPopActions">
      <button class="btn small followBtn" id="userFollowBtn" type="button" style="display:none;"></button>
    </div>
    <div class="userPopHint"></div>
  `;
  document.body.appendChild(userPopoverEl);

  userPopoverEl.addEventListener("pointerenter", () => {
    if (userHideTimer) clearTimeout(userHideTimer);
    userHideTimer = null;
  });
  userPopoverEl.addEventListener("pointerleave", () => scheduleHideUserPopover());

  // 追蹤按鈕 click
  userPopoverEl.addEventListener("click", async (e) => {
    const btn = e.target.closest?.("#userFollowBtn");
    if (!btn) return;

    const targetId = Number(btn.dataset.userId || 0);
    if (!targetId) return;

    const s = getSession();
    if (!s?.accessToken){
      goToAuth();
      return;
    }

    const isFollowing = btn.dataset.followed === "1";

    try{
      if (isFollowing){
        const ok = confirm("確定要取消追蹤嗎？");
        if (!ok) return;

        await doUnfollow(targetId);
        setFollowBtnState(btn, { targetUserId: targetId, followedByMe: false });
      }else{
        await doFollow(targetId);
        setFollowBtnState(btn, { targetUserId: targetId, followedByMe: true });
      }
    }catch(err){
      alert(`操作失敗：${err.message}`);
    }
  });

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

  const popW = 320;
  const popH = pop.offsetHeight || 180;

  let top = rect.bottom + gap;
  if (top + popH > vh - 10) top = rect.top - gap - popH;
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
  const userId = Number(anchorEl.dataset.userId || 0);
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
  const followBtn = pop.querySelector("#userFollowBtn");
  if (followBtn){
    followBtn.style.display = "none";
    followBtn.textContent = "";
    followBtn.classList.remove("follow", "following");
    followBtn.dataset.userId = String(userId);
    followBtn.dataset.followed = "0";
  }

  const seq = ++userReqSeq;
  try{
    // ✅ 同時抓：使用者資料 + 追蹤狀態
    const [userData, followedByMe] = await Promise.all([
      fetchUserPreview(userId),
      fetchFollowStatus(userId),
    ]);

    if (seq !== userReqSeq) return;
    if (activeUserId !== userId) return;

    renderUserPopover(userData);

    if (followBtn){
      setFollowBtnState(followBtn, { targetUserId: userId, followedByMe });
    }
  }catch(e){
    if (seq !== userReqSeq) return;
    pop.querySelector(".userPopHint").textContent = `讀取失敗：${e.message}`;
  }
}


// =========================
// Create page
// =========================
function initCreate(){
  syncWhoAmI();
  syncAccountUI();
  initTopRightAvatarNav();

  // create page UI
  updateCharCount();
  bindFilePreview();

  const postContent = $("postContent");
  if (postContent) postContent.addEventListener("input", updateCharCount);
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

  feed.addEventListener("click", (e) => {
    const chip = e.target.closest?.(".authorChip");
    if (!chip) return;

    // 避免點到編輯/刪除等按鈕也跳頁（保險）
    if (e.target.closest?.("button")) return;

    const uid = Number(chip.dataset.userId || 0);
    if (uid) goToProfile(uid);
  });
}


// =========================
// Small helpers
// =========================
/* helpers */
function updateCharCount(){
  const v = $("postContent")?.value || "";
  const el = $("charCount");
  if (el) el.textContent = `${v.length} / 500`;
}

function scrollToPost(postId){
  const el = document.querySelector(`.postCard[data-post-id="${postId}"]`);
  if (!el) return;

  // 先 smooth 滾到目標貼文
  el.scrollIntoView({ behavior:"smooth", block:"start" });

  // 圖片載入會造成版面高度改變，導致剛滾到的定位被「推走」
  // 這裡在短時間內監聽圖片 load / layout resize，並在需要時重新校正 scroll
  const startAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const maxMs = 2500;

  let rafScheduled = false;
  let stopped = false;

  const instantFix = () => {
    if (stopped) return;
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      // 用 auto 重新校正位置，避免多次 smooth 造成抖動
      el.scrollIntoView({ behavior:"auto", block:"start" });
    });
  };

  // 監聽 feed 內的圖片（任何在目標上方的圖片載入都可能改變 offset）
  const imgs = Array.from(document.querySelectorAll(".feed img"));
  const onImgDone = () => instantFix();
  for (const img of imgs){
    if (!img.complete){
      img.addEventListener("load", onImgDone, { once:true });
      img.addEventListener("error", onImgDone, { once:true });
    }
  }

  // 監聽 layout 變動（支援的瀏覽器會更穩）
  let ro = null;
  try{
    if ("ResizeObserver" in window){
      ro = new ResizeObserver(() => instantFix());
      const feed = document.getElementById("feed");
      ro.observe(feed || el);
    }
  }catch(_e){ ro = null; }

  const tick = setInterval(() => {
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    const elapsed = now - startAt;

    if (elapsed > maxMs){
      stopped = true;
      clearInterval(tick);
      if (ro) ro.disconnect();
      return;
    }

    const pending = imgs.some(im => !im.complete);
    if (!pending){
      // 圖片都載入後再做一次最後校正就收工
      instantFix();
      stopped = true;
      clearInterval(tick);
      if (ro) ro.disconnect();
    }
  }, 120);
}


// =========================
// Boot
// =========================
/* ===== init ===== */
function initHome(){
  syncWhoAmI();
  syncAccountUI();

  initTopRightAvatarNav();

  showPage("home");
  initHomeFeedTabs();
  initUserSearchUi();
  initLikesUi();
  initAuthorHoverUi();
  initCommentsUi();

  updateCharCount();
  bindFilePreview();

  const postContent = $("postContent");
  if (postContent) postContent.addEventListener("input", updateCharCount);
const params = new URLSearchParams(location.search);
  const focusPostId = Number(params.get("postId") || 0);

  loadPosts()
    .then(() => { if (focusPostId) scrollToPost(focusPostId); })
    .catch(()=>{});
}

function initAuth(){
  uiSetAuthTab("login");
}

let profileUser = null;
let profileUserId = 0;

async function fetchUserPosts(userId){
  return await apiFetch(`${API.users}/${userId}/posts?page=1&pageSize=50`, { method:"GET" });
}
async function fetchUserLikes(userId){
  return await apiFetch(`${API.users}/${userId}/likes?page=1&pageSize=50`, { method:"GET" });
}
async function fetchUserComments(userId){
  return await apiFetch(`${API.users}/${userId}/comments?page=1&pageSize=100`, { method:"GET" });
}

function setProfileTab(tab){
  const tabPosts = document.getElementById("profileTabPosts");
  const tabComments = document.getElementById("profileTabComments");
  const tabLikes = document.getElementById("profileTabLikes");

  tabPosts?.classList.toggle("active", tab === "posts");
  tabComments?.classList.toggle("active", tab === "comments");
  tabLikes?.classList.toggle("active", tab === "likes");

  const feedWrap = document.getElementById("profileFeedWrap");
  const commentsWrap = document.getElementById("profileCommentsWrap");

  if (tab === "comments"){
    if (feedWrap) feedWrap.style.display = "none";
    if (commentsWrap) commentsWrap.style.display = "block";
  }else{
    if (feedWrap) feedWrap.style.display = "block";
    if (commentsWrap) commentsWrap.style.display = "none";
  }
}

function renderProfileHeader(u){
  const nameEl = document.getElementById("profileName");
  const emailEl = document.getElementById("profileEmail");
  const bioEl = document.getElementById("profileBioText");

  if (nameEl) nameEl.textContent = u?.userName || "unknown";
  if (emailEl) emailEl.textContent = u?.email || "";
  if (bioEl) bioEl.textContent = (u?.bio || "").trim();

  const img = document.getElementById("profileAvatarImg");
  const fb = document.getElementById("profileAvatarFallback");

  const pic = normalizeBackendUrl((u?.profilePic || "").trim());
  if (pic && img && fb){
    img.src = pic;
    img.style.display = "block";
    fb.style.display = "none";
  }else{
    if (img) img.style.display = "none";
    if (fb){
      fb.style.display = "grid";
      fb.textContent = firstLetter(u?.userName || u?.email || "U");
    }
  }


  // banner
  const bannerEl = document.getElementById("profileBanner");
  const banner = normalizeBackendUrl((u?.bannerPic || "").trim());
  if (bannerEl){
    if (banner){
      bannerEl.classList.remove("empty");
      bannerEl.style.backgroundImage = `url("${banner.replace(/"/g, "%22")}")`;
    }else{
      bannerEl.classList.add("empty");
      bannerEl.style.backgroundImage = "";
    }
  }

  // 自己的 profile 才顯示設定
  const meId = Number(getSession()?.user?.userId || 0);
  const btn = document.getElementById("profileSettingsBtn");
  if (btn){
    btn.style.display = (meId && meId === Number(u?.userId || 0)) ? "inline-flex" : "none";
  }
}

function renderProfileCommentCard(c){
  const author = c.author || {};
  const rawName = author.userName || "unknown";
  const name = escapeHtml(rawName);
  const pic = normalizeBackendUrl(author.profilePic || "");
  const initial = firstLetter(rawName);

  const avatarHtml = pic
    ? `<img class="commentAvatar" src="${escapeHtml(pic)}" alt="avatar" />`
    : `<div class="commentFallback">${escapeHtml(initial)}</div>`;

  const time = escapeHtml(fmtTime(c.createdAt || ""));
  const editedTag = c.edited ? `<span class="commentEditedTag">已編輯</span>` : "";

  const postId = Number(c.post?.postId || c.postId || 0);
  const postAuthor = c.post?.author?.userName || "";
  const postSnippet = (c.post?.content || "").slice(0, 60);

  const canManage = !!c.editableByMe;

  const editBtn = canManage
    ? `<button class="btn ghost tiny profileCommentEditBtn" data-comment-id="${c.commentId}" data-post-id="${postId}">編輯</button>`
    : "";

  const delBtn = canManage
    ? `<button class="btn ghost tiny profileCommentDeleteBtn" data-comment-id="${c.commentId}" data-post-id="${postId}">刪除</button>`
    : "";

  const contentHtml = escapeHtml(c.content || "").replaceAll("\n","<br>");
  const textareaValue = escapeHtml(c.content || "");

  return `
    <div class="profileCommentCard" data-comment-id="${c.commentId}">
      <div class="commentMeta">
        <span class="authorChip" data-user-id="${Number(author.userId||0)}" data-user-name="${escapeHtml(rawName)}">
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
          <button class="btn primary tiny profileCommentSaveBtn" data-comment-id="${c.commentId}" data-post-id="${postId}">儲存</button>
          <button class="btn ghost tiny profileCommentCancelBtn" data-comment-id="${c.commentId}" data-post-id="${postId}">取消</button>
        </div>
      </div>

      <div class="profileCommentPostRef">
        <a href="/?postId=${postId}">查看貼文</a>
        <span>貼文作者：${escapeHtml(postAuthor)}</span>
        <span>${escapeHtml(postSnippet)}${postSnippet.length>=60 ? "…" : ""}</span>
      </div>
    </div>
  `;
}

function openProfileSettings(){
  const overlay = document.getElementById("profileSettingsOverlay");
  if (!overlay) return;
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden","false");

  const bioInput = document.getElementById("profileBioInput");
  if (bioInput) bioInput.value = (profileUser?.bio || "");
  showMsg(document.getElementById("profileSettingsMsg"), "", "");
}

function closeProfileSettings(){
  const overlay = document.getElementById("profileSettingsOverlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden","true");
}

async function saveProfileSettings(){
  const msg = document.getElementById("profileSettingsMsg");
  showMsg(msg, "", "儲存中…");

  const s = getSession();
  if (!s?.accessToken){
    showMsg(msg, "err", "請先登入");
    goToAuth();
    return;
  }

  const bio = (document.getElementById("profileBioInput")?.value || "").trim();
  const f = document.getElementById("profileAvatarFile")?.files?.[0];
  const bf = document.getElementById("profileBannerFile")?.files?.[0];

  try{
    let patch = { bio };

    if (f){
      const fd = new FormData();
      fd.append("file", f);

      const headers = {};
      if (s?.accessToken) headers.Authorization = `Bearer ${s.accessToken}`;

      const res = await fetch(baseOrigin() + API.upload, { method:"POST", body: fd, headers });
      let data = null;
      try{ data = await res.json(); }catch{ data = null; }
      if (!res.ok) throw new Error(data?.error?.message || data?.message || "圖片上傳失敗");

      patch.profilePic = data?.url || "";
    }


    if (bf){
      const fd2 = new FormData();
      fd2.append("file", bf);

      // 同上，若之後 upload 需要登入，先帶 token
      const headers2 = {};
      if (s?.accessToken) headers2.Authorization = `Bearer ${s.accessToken}`;

      const res2 = await fetch(baseOrigin() + API.upload, {
        method: "POST",
        body: fd2,
        headers: headers2,
      });

      let data2 = null;
      try{ data2 = await res2.json(); }catch{ data2 = null; }
      if (!res2.ok) throw new Error(data2?.error?.message || data2?.message || "圖片上傳失敗");

      patch.bannerPic = data2?.url || "";
    }

    const me = await apiFetch(API.me, { method:"PATCH", body: JSON.stringify(patch) });

    // 更新 session
    setSession({ accessToken: s.accessToken, user: me });

    // 更新 profile header
    profileUser = me;
    renderProfileHeader(profileUser);

    showMsg(msg, "ok", "已更新");
    setTimeout(closeProfileSettings, 250);

  }catch(e){
    showMsg(msg, "err", `儲存失敗：${e.message}`);
  }
}

async function loadProfileTab(tab){
  if (!profileUserId) return;

  setProfileTab(tab);

  if (tab === "posts"){
    const data = await fetchUserPosts(profileUserId);
    postsCache = data.items || [];
    renderFeed(); // 沿用你的貼文渲染 + likes/comment 功能
    return;
  }

  if (tab === "likes"){
    const data = await fetchUserLikes(profileUserId);
    postsCache = data.items || [];
    renderFeed();
    return;
  }

  if (tab === "comments"){
    const data = await fetchUserComments(profileUserId);
    const list = data.items || [];
    const box = document.getElementById("profileCommentsList");
    if (!box) return;

    if (list.length === 0){
      box.innerHTML = `<div class="msg" style="display:block;">沒有留言</div>`;
    }else{
      box.innerHTML = list.map(renderProfileCommentCard).join("");
    }
  }
}

function initProfileCommentsActions(){
  const wrap = document.getElementById("profileCommentsWrap");
  if (!wrap) return;

  wrap.addEventListener("click", async (e) => {
    const editBtn = e.target.closest?.(".profileCommentEditBtn");
    if (editBtn){
      const card = editBtn.closest(".profileCommentCard");
      if (!card) return;
      card.querySelector(".commentContent").style.display = "none";
      card.querySelector(".commentEditArea").style.display = "block";
      card.querySelector(".commentEditInput")?.focus?.();
      return;
    }

    const cancelBtn = e.target.closest?.(".profileCommentCancelBtn");
    if (cancelBtn){
      const card = cancelBtn.closest(".profileCommentCard");
      if (!card) return;
      card.querySelector(".commentEditArea").style.display = "none";
      card.querySelector(".commentContent").style.display = "block";
      return;
    }

    const saveBtn = e.target.closest?.(".profileCommentSaveBtn");
    if (saveBtn){
      const commentId = Number(saveBtn.dataset.commentId || 0);
      const card = saveBtn.closest(".profileCommentCard");
      const ta = card?.querySelector(".commentEditInput");
      const content = (ta?.value || "").trim();
      if (!commentId || !content) return;

      try{
        await apiFetch(`${API.comments}/${commentId}`, {
          method:"PATCH",
          body: JSON.stringify({ content }),
        });
        await loadProfileTab("comments");
      }catch(err){
        alert(`編輯失敗：${err.message}`);
      }
      return;
    }

    const delBtn = e.target.closest?.(".profileCommentDeleteBtn");
    if (delBtn){
      const commentId = Number(delBtn.dataset.commentId || 0);
      if (!commentId) return;

      if (!confirm("確定要刪除這則留言嗎？")) return;

      try{
        await apiFetch(`${API.comments}/${commentId}`, { method:"DELETE" });
        await loadProfileTab("comments");
      }catch(err){
        alert(`刪除失敗：${err.message}`);
      }
    }
  });
}


// =========================
// Profile page
// =========================
async function initProfile(){
  syncWhoAmI();
  syncAccountUI();

  initTopRightAvatarNav();

  // 讓 profile 頁也能用 likes modal / hover popover / 文章留言功能
  initLikesUi();
  initAuthorHoverUi();
  initCommentsUi();
  initProfileCommentsActions();
  profileUserId = getProfileUserIdFromUrl();
  if (!profileUserId){
    return;
  }

  try{
    profileUser = await apiFetch(`${API.users}/${profileUserId}`, { method:"GET" });
    renderProfileHeader(profileUser);

    // follow / following list (profile)
    initProfileFollowUi(profileUserId);
    await syncProfileFollowState(profileUserId);
    await updateFollowingBtnCount(profileUserId);
    await updateFollowersBtnCount(profileUserId);

    // tabs
    document.getElementById("profileTabPosts")?.addEventListener("click", () => loadProfileTab("posts"));
    document.getElementById("profileTabComments")?.addEventListener("click", () => loadProfileTab("comments"));
    document.getElementById("profileTabLikes")?.addEventListener("click", () => loadProfileTab("likes"));

    // settings
    document.getElementById("profileSettingsBtn")?.addEventListener("click", openProfileSettings);
    document.getElementById("profileSettingsCloseBtn")?.addEventListener("click", closeProfileSettings);
    document.getElementById("profileSettingsCancelBtn")?.addEventListener("click", closeProfileSettings);
    document.getElementById("profileSettingsSaveBtn")?.addEventListener("click", saveProfileSettings);

    const overlay = document.getElementById("profileSettingsOverlay");
    overlay?.addEventListener("click", (e) => { if (e.target === overlay) closeProfileSettings(); });

    // default tab
    await loadProfileTab("posts");

    // 如果是自己的個人頁面
    // 就把最底下的 Me button 點亮
    const s = getSession();
    const myId = Number(s?.user?.userId || 0);
    const isMe = (myId > 0 && profileUserId === myId);
    setProfileBottomNavActive(isMe);
  }catch(e){
  }
}

(function boot(){
  const page = document.body?.dataset?.page;
  if (page === "home") initHome();
  if (page === "auth") initAuth();
  if (page === "profile") initProfile();
  if (page === "create") initCreate();
})();
