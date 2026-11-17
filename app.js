/* =========================================================
   SETTINGS: fill these in to switch the QR gallery on
   ========================================================= */
const CONFIG = {
  SUPABASE_URL: "https://sjfkcivlokgdncivqszj.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_1qBRjRYvUMCaQ9f5cVCLPw_kHH7_0u1",
  BUCKET: "memories",
  PUBLIC_SITE_URL: "https://grandpaweb.vercel.app"
};

const $ = id => document.getElementById(id);
const IS_GALLERY = new URLSearchParams(location.search).has("gallery");

// A secret / service_role key must never be used in a browser
const KEY_IS_SECRET = /^sb_secret_|service_role/i.test(CONFIG.SUPABASE_ANON_KEY);

let sb = null;

// Creates the cloud client when the library is available (also works if the
// internet comes back later). Returns null when the cloud cannot be used.
function ensureCloud() {
  if (sb) return sb;

  if (KEY_IS_SECRET || !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !window.supabase) {
    return null;
  }

  sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  return sb;
}

ensureCloud();

const stage = $("stage");
const mediaList = $("mediaList");
const counter = $("counter");
const slideName = $("slideName");
const progressBar = $("progressBar");
const audio = $("audio");

const PLACEHOLDER =
  '<div class="placeholder">Add photos or videos to start the slideshow</div>';

const BADGES = {
  local: "Saved on this device",
  pending: "Saved · waiting for internet",
  uploading: "Saved · sending to gallery…",
  saved: "Saved · ☁ in QR gallery",
  failed: "Saved · ⚠ gallery failed – click to retry"
};

// each item: { id, name, url, type, caption, file, path, state, badgeEl }
const items = [];

let current = 0;
let advanceTimer = null;
let progressTimer = null;
let playing = false;
let videoMuted = false;
let musicStopped = false;
let musicUrl = null;
let touchStartX = 0;

/* =========================================================
   FADE-THROUGH-BLACK SETTINGS
   ========================================================= */
// Total time of ONE change in milliseconds (1000 = 1 second).
// 3000 = old photo fades slowly into black (1.5 s),
//        then the new photo fades slowly out of the black (1.5 s).
// Try 4000 for even slower, 2200 for a little faster.
const FLIP_DURATION = 800;

let flipTimer = null;
let flipUntil = 0;

stage.style.setProperty("--flip-ms", `${FLIP_DURATION}ms`);

function setStatus(message) {
  $("status").textContent = message;
}

function updateHeader() {
  $("heading").textContent =
    $("titleInput").value.trim() || "Grandpa's Memories";

  $("dedication").textContent =
    $("dedicationInput").value.trim() ||
    "Forever loved, always remembered";
}

function getSeconds() {
  return Math.max(2, Number($("seconds").value) || 5);
}

function getCurrentVideo() {
  return stage.querySelector("video.current-media");
}

function updateCounter() {
  if (!items.length) {
    counter.textContent = "0 / 0";
    slideName.textContent = "No memory selected";
    return;
  }

  counter.textContent = `${current + 1} / ${items.length}`;
  slideName.textContent = items[current].name;
  updateDots();
}

/* =========================================================
   DEVICE STORAGE (IndexedDB)
   Photos and videos are kept inside this browser, so they are still
   here after the site is closed, with or without internet.
   They are removed only by "Remove" or "Remove all".
   ========================================================= */

let dbOk = false;
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("This browser cannot store files"));
        return;
      }

      const request = indexedDB.open("grandpa-memories", 1);

      request.onupgradeneeded = () => {
        ["meta", "blobs", "deletes"].forEach(name => {
          if (!request.result.objectStoreNames.contains(name)) {
            request.result.createObjectStore(name, { keyPath: "key" });
          }
        });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return dbPromise;
}

// Runs several writes in ONE transaction (all saved, or none)
async function dbRun(stores, work) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    work(name => tx.objectStore(name));
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(tx.error || new Error("Could not save on this device"));
  });
}

async function dbGetAll(store) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// The small info (name, caption, order…) is stored apart from the big file,
// so changing a caption or the order never rewrites a whole video.
function metaOf(item, order) {
  return {
    key: item.key,
    name: item.name,
    type: item.type,
    caption: item.caption,
    order,
    cloudId: item.cloudId,
    cloudPath: item.cloudPath
  };
}

function makeItem(blob, name, type, extra = {}) {
  return {
    key: (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name,
    type,
    caption: "",
    blob,
    url: URL.createObjectURL(blob),
    cloudId: null,
    cloudPath: null,
    cloudPos: null,
    state: ensureCloud() ? "pending" : "local",
    ...extra
  };
}

async function saveNewItem(item) {
  if (!dbOk) return;

  await dbRun(["meta", "blobs"], store => {
    store("blobs").put({ key: item.key, blob: item.blob });
    store("meta").put(metaOf(item, items.length));
  });
}

function saveOrderLocal() {
  if (!dbOk) return;

  dbRun(["meta"], store => {
    items.forEach((item, index) => store("meta").put(metaOf(item, index)));
  }).catch(console.error);
}

const dirtyMeta = new Set();
let metaTimer = null;

function scheduleMetaSave(item) {
  dirtyMeta.add(item);
  clearTimeout(metaTimer);
  metaTimer = setTimeout(flushMeta, 300);
}

function flushMeta() {
  clearTimeout(metaTimer);

  const list = [...dirtyMeta].filter(item => items.includes(item));
  dirtyMeta.clear();

  if (!dbOk || !list.length) return;

  dbRun(["meta"], store => {
    list.forEach(item => store("meta").put(metaOf(item, items.indexOf(item))));
  }).catch(console.error);
}

async function loadFromDevice() {
  const [metas, blobs] = await Promise.all([dbGetAll("meta"), dbGetAll("blobs")]);
  const blobOf = new Map(blobs.map(entry => [entry.key, entry.blob]));

  metas
    .sort((a, b) => a.order - b.order)
    .forEach(meta => {
      const blob = blobOf.get(meta.key);
      if (!blob) return;

      items.push({
        key: meta.key,
        name: meta.name,
        type: meta.type,
        caption: meta.caption || "",
        blob,
        url: URL.createObjectURL(blob),
        cloudId: meta.cloudId || null,
        cloudPath: meta.cloudPath || null,
        cloudPos: null,
        state: meta.cloudId ? "saved" : (ensureCloud() ? "pending" : "local")
      });
    });
}

/* =========================================================
   CLOUD (Supabase): only for the QR gallery.
   The slideshow itself NEVER needs internet: it always plays the
   copy saved on this device. The cloud is used in the background,
   and only once per photo/video.
   ========================================================= */

async function fetchMemories() {
  const client = ensureCloud();
  if (!client) throw new Error("The QR gallery is not connected");

  const { data, error } = await client
    .from("memories")
    .select("*")
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data;
}

function setItemState(item, state) {
  item.state = state;

  if (item.badgeEl) {
    item.badgeEl.textContent = BADGES[state];
    item.badgeEl.className = `badge ${state}`;
  }
}

async function uploadItem(item) {
  setItemState(item, "uploading");

  try {
    const client = ensureCloud();

    const ext = (item.name.split(".").pop() || "bin")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "bin";

    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error } = await client.storage
      .from(CONFIG.BUCKET)
      .upload(path, item.blob, {
        contentType: item.blob.type,
        cacheControl: "31536000"
      });

    if (error) throw error;

    const { data } = client.storage.from(CONFIG.BUCKET).getPublicUrl(path);
    const position = items.indexOf(item);

    const { data: row, error: dbError } = await client
      .from("memories")
      .insert({
        url: data.publicUrl,
        path,
        type: item.type,
        name: item.name,
        caption: item.caption,
        position
      })
      .select()
      .single();

    if (dbError) throw dbError;

    item.cloudId = row.id;
    item.cloudPath = path;
    item.cloudPos = position;
    setItemState(item, "saved");

    if (items.includes(item)) {
      scheduleMetaSave(item); // remember on this device that it is uploaded
      syncCaption(item);
    } else {
      queueCloudDelete([{ id: row.id, path }]); // removed while uploading
    }
  } catch (error) {
    console.error(error);
    item.errorMessage = (error && error.message) || String(error);
    setItemState(item, "failed");
  }
}

async function uploadPending() {
  const list = items.filter(item => !item.cloudId && item.state === "pending");
  if (!list.length) return;

  let done = 0;

  for (const item of list) {
    if (!items.includes(item)) continue;
    if (!navigator.onLine) break;

    setStatus(`Sending to the QR gallery… ${done + 1} of ${list.length}`);
    await uploadItem(item);
    done++;
  }

  const failed = list.filter(item => item.state === "failed");
  const waiting = list.filter(item => item.state === "pending" && items.includes(item));

  if (failed.length) {
    setStatus(`${failed.length} file(s) could not be sent to the QR gallery (${failed[0].errorMessage || "unknown error"}). They are safe on this device. Click the red label to try again.`);
  } else if (waiting.length) {
    setStatus("Saved on this device. The QR gallery will update when the internet is back.");
  } else {
    setStatus("All memories are saved on this device and in the QR gallery.");
  }

  syncOrder();
}

function retryUpload(item) {
  setItemState(item, "pending");
  cloudSync();
}

// Deleting from the cloud is remembered on this device, so it still
// happens later if the internet is off right now.
async function queueCloudDelete(list) {
  const entries = list.filter(entry => entry.id || entry.path);
  if (!entries.length || !dbOk) return;

  try {
    await dbRun(["deletes"], store => {
      entries.forEach(entry => {
        store("deletes").put({ key: `${entry.id || ""}|${entry.path || ""}`, id: entry.id || null, path: entry.path || null });
      });
    });
  } catch (error) {
    console.error(error);
  }

  cloudSync();
}

async function flushPendingDeletes() {
  const pending = dbOk ? await dbGetAll("deletes") : [];
  if (!pending.length) return true;

  const client = ensureCloud();

  try {
    const ids = pending.map(entry => entry.id).filter(Boolean);
    const paths = pending.map(entry => entry.path).filter(Boolean);

    for (let i = 0; i < ids.length; i += 50) {
      const { error } = await client.from("memories").delete().in("id", ids.slice(i, i + 50));
      if (error) throw error;
    }

    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await client.storage.from(CONFIG.BUCKET).remove(paths.slice(i, i + 100));
      if (error) throw error;
    }

    await dbRun(["deletes"], store => {
      pending.forEach(entry => store("deletes").delete(entry.key));
    });

    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

// New device / empty browser: copy what is in the QR gallery onto this
// device ONCE. After that it is never downloaded again.
async function downloadMissing() {
  const rows = await fetchMemories();
  const known = new Set(items.map(item => String(item.cloudId)));
  const pending = dbOk ? await dbGetAll("deletes") : [];
  const skip = new Set(pending.map(entry => String(entry.id)));

  const missing = rows.filter(row => !known.has(String(row.id)) && !skip.has(String(row.id)));
  let number = 0;

  for (const row of missing) {
    setStatus(`Saving memories on this device… ${++number} of ${missing.length}`);

    try {
      const response = await fetch(row.url);
      if (!response.ok) throw new Error(`Download failed (${response.status})`);

      const raw = await response.blob();
      const kind = row.type === "video" ? "video" : "image";
      const blob = raw.type
        ? raw
        : new Blob([raw], { type: kind === "video" ? "video/mp4" : "image/jpeg" });

      const item = makeItem(blob, row.name || "memory", kind, {
        caption: row.caption || "",
        cloudId: row.id,
        cloudPath: row.path,
        cloudPos: row.position,
        state: "saved"
      });

      await saveNewItem(item);

      const wasEmpty = !items.length;
      items.push(item);
      refreshList(wasEmpty);
    } catch (error) {
      console.error(error);
      break; // most likely the internet is off: try again next time
    }
  }

  if (missing.length) setStatus(`${items.length} memories are saved on this device.`);
}

let syncing = false;
let syncAgain = false;

async function cloudSync() {
  if (IS_GALLERY || !ensureCloud() || !navigator.onLine) return;

  if (syncing) {
    syncAgain = true;
    return;
  }

  syncing = true;

  try {
    if (await flushPendingDeletes()) {
      await uploadPending();
      await downloadMissing();
    }
  } catch (error) {
    console.error(error);
    setStatus("The QR gallery cannot be reached right now. Your photos and videos still play from this device.");
  }

  syncing = false;

  if (syncAgain) {
    syncAgain = false;
    cloudSync();
  }
}

const captionTimers = new Map();

function syncCaption(item) {
  if (!ensureCloud() || !item.cloudId) return;

  clearTimeout(captionTimers.get(item));

  captionTimers.set(item, setTimeout(() => {
    if (!navigator.onLine) return;

    sb.from("memories")
      .update({ caption: item.caption })
      .eq("id", item.cloudId)
      .then(() => {});
  }, 700));
}

let orderTimer = null;

// Only the rows whose position really changed are sent (saves internet)
function syncOrder() {
  if (!ensureCloud() || !navigator.onLine) return;

  clearTimeout(orderTimer);

  orderTimer = setTimeout(() => {
    items.forEach((item, index) => {
      if (item.cloudId && item.cloudPos !== index) {
        item.cloudPos = index;

        sb.from("memories")
          .update({ position: index })
          .eq("id", item.cloudId)
          .then(() => {});
      }
    });
  }, 800);
}

async function bootPresenter() {
  try {
    await openDB();
    dbOk = true;
  } catch (error) {
    console.error(error);
    setStatus("This browser cannot keep files after the page is closed (private window?). Please use a normal window.");
  }

  if (dbOk) {
    try {
      await loadFromDevice();
    } catch (error) {
      console.error(error);
    }

    // ask the browser not to clear our saved files
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  }

  if (items.length) {
    render();
    setStatus(`${items.length} memories loaded from this device.`);
  }

  cloudSync();
}

/* =========================================================
   GUEST GALLERY (page opened by scanning the QR code)
   ========================================================= */

let galleryItems = [];
let lightboxIndex = 0;
let lightboxTouchX = 0;

async function initGallery() {
  document.body.classList.add("gallery-mode");
  document.title = "Grandpa's Memories · Gallery";

  const status = $("galleryStatus");

  if (!sb) {
    status.textContent = "The gallery is not connected yet.";
    return;
  }

  status.textContent = "Loading memories…";

  try {
    galleryItems = await fetchMemories();
  } catch (error) {
    console.error(error);

    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "↻ Try again";
    retry.style.marginTop = "12px";
    retry.addEventListener("click", initGallery);

    status.textContent = "Could not load the memories. Please try again.";

    const detail = document.createElement("small");
    detail.style.display = "block";
    detail.style.marginTop = "10px";
    detail.style.overflowWrap = "anywhere";
    detail.textContent =
      `Details: ${(error && error.message) || "unknown error"} (app v3)`;

    status.appendChild(detail);
    status.appendChild(retry);
    return;
  }

  status.textContent = galleryItems.length
    ? ""
    : "No memories have been added yet.";

  const photos = galleryItems.filter(row => row.type === "image").length;
  const videos = galleryItems.length - photos;

  $("galleryCount").textContent = galleryItems.length
    ? `${photos} PHOTOS · ${videos} VIDEOS`
    : "";

  renderGalleryGrid();
}

function renderGalleryGrid() {
  const grid = $("galleryGrid");
  grid.innerHTML = "";

  galleryItems.forEach((row, index) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    tile.style.animationDelay = `${Math.min(index, 24) * 60}ms`;
    tile.setAttribute("aria-label", row.caption || `Open memory ${index + 1}`);

    if (row.type === "video") {
      const video = document.createElement("video");
      video.src = `${row.url}#t=0.1`;
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      tile.appendChild(video);

      const badge = document.createElement("span");
      badge.className = "play-badge";
      badge.textContent = "▶";
      tile.appendChild(badge);
    } else {
      const img = document.createElement("img");
      img.src = row.url;
      img.loading = "lazy";
      img.alt = row.caption || row.name || "Memory";
      tile.appendChild(img);
    }

    tile.addEventListener("click", () => openLightbox(index));
    grid.appendChild(tile);
  });
}

function openLightbox(index) {
  if (!galleryItems.length) return;

  lightboxIndex = (index + galleryItems.length) % galleryItems.length;

  const row = galleryItems[lightboxIndex];
  const holder = $("lightboxMedia");
  holder.innerHTML = "";

  const media = document.createElement(row.type === "video" ? "video" : "img");
  media.src = row.url;

  if (row.type === "video") {
    media.controls = true;
    media.autoplay = true;
    media.playsInline = true;
  } else {
    media.alt = row.caption || row.name || "Memory";
  }

  holder.appendChild(media);

  $("lightboxCaption").textContent = row.caption || "";
  $("lightboxCount").textContent = `${lightboxIndex + 1} / ${galleryItems.length}`;
  $("lightbox").hidden = false;
}

function closeLightbox() {
  $("lightbox").hidden = true;
  $("lightboxMedia").innerHTML = "";
}

function handleGalleryKeys(event) {
  if ($("lightbox").hidden) return;

  if (event.key === "Escape") closeLightbox();
  if (event.key === "ArrowRight") openLightbox(lightboxIndex + 1);
  if (event.key === "ArrowLeft") openLightbox(lightboxIndex - 1);
}

$("lbClose").addEventListener("click", closeLightbox);
$("lbPrev").addEventListener("click", () => openLightbox(lightboxIndex - 1));
$("lbNext").addEventListener("click", () => openLightbox(lightboxIndex + 1));

$("lightbox").addEventListener("click", event => {
  if (event.target === $("lightbox") || event.target === $("lightboxMedia")) {
    closeLightbox();
  }
});

$("lightbox").addEventListener("touchstart", event => {
  lightboxTouchX = event.changedTouches[0].screenX;
}, { passive: true });

$("lightbox").addEventListener("touchend", event => {
  const distance = event.changedTouches[0].screenX - lightboxTouchX;

  if (Math.abs(distance) < 60) return;

  openLightbox(lightboxIndex + (distance < 0 ? 1 : -1));
}, { passive: true });

/* =========================================================
   TIMERS
   ========================================================= */

function clearTimers() {
  clearTimeout(advanceTimer);
  clearInterval(progressTimer);
  advanceTimer = null;
  progressTimer = null;
  progressBar.style.width = "0%";
}

// Photos only: change after "Seconds per photo"
function startImageTimer() {
  const duration = getSeconds() * 1000;
  const startedAt = Date.now();

  progressTimer = setInterval(() => {
    const percent = Math.min(100, (Date.now() - startedAt) / duration * 100);
    progressBar.style.width = `${percent}%`;
  }, 50);

  advanceTimer = setTimeout(nextSlide, duration);
}

/* =========================================================
   VIDEO + MUSIC
   ========================================================= */

function setVideoMuted(value) {
  videoMuted = value;

  const video = getCurrentVideo();
  if (video) video.muted = videoMuted;

  $("videoMute").textContent = videoMuted
    ? "🔇 Unmute video"
    : "🔊 Mute video";

  updateMusic();
}

function playVideo(video) {
  video.muted = videoMuted;

  const promise = video.play();

  if (promise && promise.catch) {
    promise.catch(error => {
      if (error.name === "NotAllowedError" && !videoMuted) {
        setVideoMuted(true);
        setStatus("Your browser blocked sound, so the video is playing muted. Press Unmute video to hear it.");
        video.play().catch(() => {});
      }
    });
  }
}

// Background music pauses while a video plays with its own sound
function updateMusic() {
  if (!audio.src) return;

  const item = items[current];
  const videoHasSound =
    playing && item && item.type === "video" && !videoMuted;

  if (musicStopped || videoHasSound) {
    audio.pause();
  } else {
    audio.play().catch(() => {});
  }
}

function updateMusicButton() {
  $("musicToggle").textContent = musicStopped
    ? "▶ Play music"
    : "⏹ Stop music";
}

function handleVideoError(item) {
  setStatus(`Could not play "${item.name}". Skipping it.`);

  if (!playing) return;

  if (items.length > 1) {
    setTimeout(() => {
      if (playing && items[current] === item) nextSlide();
    }, 1500);
  } else {
    stopSlideshow();
  }
}

/* =========================================================
   RENDERING
   ========================================================= */

function createMedia(item) {
  const element = document.createElement(
    item.type === "video" ? "video" : "img"
  );

  element.src = item.url;
  element.className = "current-media";
  element.setAttribute("draggable", "false");

  if (item.type === "video") {
    element.controls = true;
    element.playsInline = true;
    element.preload = "auto";
    element.muted = videoMuted;

    // Video plays to the very end, then the next slide comes
    element.addEventListener("ended", () => {
      if (playing) nextSlide();
    });

    element.addEventListener("timeupdate", () => {
      if (playing && element.duration) {
        progressBar.style.width =
          `${element.currentTime / element.duration * 100}%`;
      }
    });

    element.addEventListener("error", () => handleVideoError(item));
  } else {
    element.alt = item.name;
  }

  return element;
}

function updateCaption(fade = false) {
  stage.querySelectorAll(".caption").forEach(node => node.remove());

  const item = items[current];
  if (!item || !item.caption) return;

  const caption = document.createElement("div");
  caption.className = item.type === "video" ? "caption on-video" : "caption";
  caption.textContent = item.caption;
  if (fade) caption.classList.add("fade-in");
  stage.appendChild(caption);
}

/* ---------- 3D flip helpers ---------- */

// Respect the device setting "reduce motion"
function canFlip() {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isFlipping() {
  return Date.now() < flipUntil;
}

// Remove everything left over from a flip
function clearFlip() {
  clearTimeout(flipTimer);
  flipTimer = null;
  flipUntil = 0;

  stage.querySelectorAll(".flip-out").forEach(node => node.remove());

  stage.querySelectorAll(".fade-black").forEach(node => node.remove());

  stage.querySelectorAll(".flip-in").forEach(node => {
    node.classList.remove("flip-in", "flip-prev");
  });
}

// Flip finished: clean up, then start the photo timer / video
function endFlip() {
  clearFlip();

  if (playing) scheduleCurrent();
}

// The old photo/video stays in place and turns away
// (it is not copied, so a video keeps its last frame)
function startFlipOut(media, direction) {
  media.classList.remove("current-media");
  media.classList.add("flip-out");

  if (direction === "previous") media.classList.add("flip-prev");

  if (media.tagName === "VIDEO") {
    media.pause();
    media.controls = false;
    media.muted = true;
  }
}

function scheduleCurrent() {
  clearTimers();

  if (!playing || !items.length) return;

  updateMusic();

  // Wait for the flip to finish; endFlip() calls this function again
  if (isFlipping()) return;

  if (items[current].type === "video") {
    const video = getCurrentVideo();
    if (video) playVideo(video);
  } else {
    startImageTimer();
  }
}

/* ---------- Stunning extras: blurred backdrop, slow zoom, dots ---------- */

// A blurred copy of the photo OR video fills the empty sides of the stage
function updateBackdrop(item, media, animate, intro) {
  const olds = Array.from(stage.querySelectorAll(".stage-bg"));

  if (item) {
    const isVideo = item.type === "video";
    const bg = document.createElement(isVideo ? "canvas" : "div");
    bg.className = "stage-bg";

    if (!isVideo) {
      bg.style.backgroundImage = `url("${item.url.replace(/"/g, "%22")}")`;
    }

    if (animate) bg.classList.add("fade");
    if (intro) bg.classList.add("intro");
    stage.appendChild(bg);

    if (isVideo) mirrorVideo(media, bg);
  }

  if (animate) {
    // old backdrop disappears while the screen is fully black
    olds.forEach(node => node.classList.add("leaving"));
    setTimeout(() => olds.forEach(node => node.remove()), FLIP_DURATION + 50);
  } else {
    olds.forEach(node => node.remove());
  }
}

// Copies the playing video into a tiny canvas (CSS blurs it). It uses the
// same video file, so it needs no extra internet and stays in sync.
function mirrorVideo(video, canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let last = 0;
  let lastTime = -1;

  function draw() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (video.readyState < 2 || !vw || !vh) return;

    const h = 72;
    const w = Math.max(16, Math.round(h * vw / vh));

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    try {
      ctx.drawImage(video, 0, 0, w, h);
      lastTime = video.currentTime;
    } catch (error) {}
  }

  function loop(now) {
    if (!canvas.isConnected) return; // backdrop was removed: stop

    if (now - last >= 80) { // about 12 updates per second is plenty
      last = now;
      if (video.currentTime !== lastTime) draw();
    }

    requestAnimationFrame(loop);
  }

  video.addEventListener("loadeddata", draw);
  video.addEventListener("seeked", draw);
  requestAnimationFrame(loop);
}

// Slow zoom on photos (zooms in on one slide, out on the next)
function startKenBurns(media, item, delayed) {
  if (item.type !== "image" || !canFlip() || !media.animate) return;

  const zoomIn = current % 2 === 0;
  const total = Math.max(9000, getSeconds() * 1000 + FLIP_DURATION);

  media.animate(
    [
      { scale: zoomIn ? 1 : 1.08 },
      { scale: zoomIn ? 1.08 : 1 }
    ],
    {
      duration: total,
      delay: delayed ? FLIP_DURATION / 2 : 0,
      easing: "ease-in-out",
      fill: "both"
    }
  );
}

// Little dots at the bottom of the slideshow (up to 12 memories)
function updateDots() {
  let dots = stage.querySelector(".dots");

  const show =
    items.length > 1 &&
    items.length <= 12 &&
    items[current] &&
    items[current].type !== "video";

  if (!show) {
    if (dots) dots.remove();
    return;
  }

  if (!dots || dots.children.length !== items.length) {
    if (dots) dots.remove();

    dots = document.createElement("div");
    dots.className = "dots";

    for (let i = 0; i < items.length; i++) {
      dots.appendChild(document.createElement("span"));
    }

    stage.appendChild(dots);
  }

  Array.from(dots.children).forEach((dot, i) => {
    dot.classList.toggle("on", i === current);
  });
}

function render(animate = false, direction = "next") {
  updateHeader();

  if (!items.length) {
    clearFlip();
    stopSlideshow();
    stage.innerHTML = PLACEHOLDER;
    updateCounter();
    mediaList.innerHTML = "";
    return;
  }

  current = Math.max(0, Math.min(current, items.length - 1));

  clearFlip();

  const oldMedia = stage.querySelector(".current-media");
  const doFlip = animate && Boolean(oldMedia) && canFlip();

  const oldVideo = getCurrentVideo();
  if (oldVideo) oldVideo.pause();

  stage
    .querySelectorAll(".placeholder,.caption")
    .forEach(node => node.remove());

  if (doFlip) {
    startFlipOut(oldMedia, direction);
  } else {
    stage.querySelectorAll(".current-media").forEach(node => node.remove());
  }

  const newMedia = createMedia(items[current]);

  // very first photo: glides into the panel
  const isIntro = !oldMedia && canFlip();
  if (isIntro) {
    newMedia.classList.add("intro");
    newMedia.addEventListener("animationend", () => {
      newMedia.classList.remove("intro");
    }, { once: true });
  }

  if (doFlip) {
    newMedia.classList.add("flip-in");
    if (direction === "previous") newMedia.classList.add("flip-prev");

    // small extra time so the animation is completely finished
    flipUntil = Date.now() + FLIP_DURATION + 50;
    flipTimer = setTimeout(endFlip, FLIP_DURATION + 50);

    // black veil: screen goes slowly black, then slowly clears
    const veil = document.createElement("div");
    veil.className = "fade-black";
    stage.appendChild(veil);
  }

  stage.appendChild(newMedia);

  updateBackdrop(items[current], newMedia, doFlip, isIntro);
  startKenBurns(newMedia, items[current], doFlip);

  updateCaption(doFlip);
  updateCounter();
  renderMediaList();

  if (playing) {
    scheduleCurrent();
  } else {
    clearTimers();
  }
}

function renderMediaList() {
  mediaList.innerHTML = "";

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "item";

    if (index === current) {
      row.classList.add("active");
    }

    const thumbnail = document.createElement(
      item.type === "video" ? "video" : "img"
    );

    thumbnail.src = item.url;
    thumbnail.muted = true;
    thumbnail.playsInline = true;

    const filename = document.createElement("span");
    filename.className = "filename";
    filename.textContent =
      `${item.type === "video" ? "▶ " : "▧ "}${item.name}`;

    const caption = document.createElement("input");
    caption.type = "text";
    caption.placeholder = "Optional caption";
    caption.value = item.caption;

    caption.addEventListener("click", event => event.stopPropagation());

    // only the caption changes: the video / timer is not restarted
    caption.addEventListener("input", event => {
      item.caption = event.target.value;
      scheduleMetaSave(item);
      syncCaption(item);

      if (index === current) {
        updateCaption();
      }
    });

    const badge = document.createElement("span");
    item.badgeEl = badge;
    setItemState(item, item.state);

    badge.addEventListener("click", event => {
      event.stopPropagation();

      if (item.state === "failed") {
        retryUpload(item);
      }
    });

    const up = document.createElement("button");
    up.className = "secondary";
    up.textContent = "↑";
    up.onclick = event => {
      event.stopPropagation();
      moveItem(index, -1);
    };

    const down = document.createElement("button");
    down.className = "secondary";
    down.textContent = "↓";
    down.onclick = event => {
      event.stopPropagation();
      moveItem(index, 1);
    };

    const remove = document.createElement("button");
    remove.className = "secondary";
    remove.textContent = "Remove";
    remove.onclick = event => {
      event.stopPropagation();
      removeItem(index);
    };

    row.append(thumbnail, filename, caption, badge, up, down, remove);

    row.addEventListener("click", () => {
      if (isFlipping() || index === current) return;

      const direction = index > current ? "next" : "previous";
      current = index;
      render(true, direction);
    });

    mediaList.appendChild(row);
  });
}

/* =========================================================
   LIST ACTIONS
   ========================================================= */

// After adding: the very first item needs a full render, otherwise only the
// list and counter change (a playing video is not restarted).
function refreshList(wasEmpty) {
  if (wasEmpty) {
    render();
  } else {
    updateCounter();
    renderMediaList();
  }
}

async function addFiles(fileList) {
  // copy first: the file input is cleared right after this call
  const files = Array.from(fileList).filter(file => /^(image|video)\//.test(file.type));
  if (!files.length) return;

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  const wasEmpty = !items.length;
  let saved = 0;

  for (const file of files) {
    setStatus(`Saving on this device… ${saved + 1} of ${files.length}`);

    const item = makeItem(file, file.name, file.type.startsWith("video/") ? "video" : "image");

    try {
      await saveNewItem(item);
    } catch (error) {
      console.error(error);
      URL.revokeObjectURL(item.url);
      setStatus(`Could not save "${file.name}". This device may be out of storage space. ${saved} file(s) were saved.`);
      break;
    }

    items.push(item);
    saved++;
  }

  if (!saved) return;

  refreshList(wasEmpty && items.length > 0);
  saveOrderLocal();
  setStatus(`${saved} file(s) saved on this device.`);
  cloudSync();
}

function removeItem(index) {
  const [item] = items.splice(index, 1);
  if (!item) return;

  URL.revokeObjectURL(item.url);

  if (dbOk) {
    dbRun(["meta", "blobs"], store => {
      store("meta").delete(item.key);
      store("blobs").delete(item.key);
    }).catch(console.error);
  }

  queueCloudDelete([{ id: item.cloudId, path: item.cloudPath }]);

  if (index < current) {
    current--;
  } else if (current >= items.length) {
    current = Math.max(0, items.length - 1);
  }

  render();
  saveOrderLocal();
  syncOrder();
}

async function removeAll() {
  if (!items.length) {
    setStatus("There is nothing to remove.");
    return;
  }

  const count = items.length;

  const sure = confirm(
    `Remove all ${count} photos and videos from this site?\n\nThey will also be removed from the QR gallery. This cannot be undone.`
  );

  if (!sure) return;

  stopSlideshow();

  const all = items.splice(0, items.length);
  all.forEach(item => URL.revokeObjectURL(item.url));

  current = 0;
  render();

  try {
    await dbRun(["meta", "blobs"], store => {
      store("meta").clear();
      store("blobs").clear();
    });
  } catch (error) {
    console.error(error);
  }

  await queueCloudDelete(all.map(item => ({ id: item.cloudId, path: item.cloudPath })));

  setStatus(`Removed all ${count} photos and videos.`);
}

function moveItem(index, direction) {
  const target = index + direction;

  if (target < 0 || target >= items.length) {
    return;
  }

  [items[index], items[target]] = [items[target], items[index]];
  current = target;
  render();
  saveOrderLocal();
  syncOrder();
}

/* =========================================================
   NAVIGATION + CONTROLS
   ========================================================= */

function nextSlide() {
  if (!items.length || isFlipping()) return;

  // The list is already in (shuffled) order, so every photo/video plays
  // exactly once, and after the last one it starts again from the 1st.
  current = (current + 1) % items.length;

  render(true, "next");
}

function previousSlide() {
  if (!items.length || isFlipping()) return;

  current = (current - 1 + items.length) % items.length;
  render(true, "previous");
}

function stopSlideshow() {
  playing = false;
  clearTimers();

  $("play").textContent = "▶ Play slideshow";
  $("play").setAttribute("aria-pressed", "false");

  const video = getCurrentVideo();
  if (video) video.pause();

  audio.pause();
}

function startSlideshow() {
  if (!items.length) {
    setStatus("Add at least one photo or video to start the slideshow.");
    return;
  }

  setStatus("");
  playing = true;

  $("play").textContent = "❚❚ Pause slideshow";
  $("play").setAttribute("aria-pressed", "true");

  scheduleCurrent();
}

function toggleSlideshow() {
  if (playing) {
    stopSlideshow();
  } else {
    startSlideshow();
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    stage.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

function toggleMute() {
  setVideoMuted(!videoMuted);
}

function togglePresentationMode() {
  document.body.classList.toggle("presentation-mode");

  $("presentation").textContent =
    document.body.classList.contains("presentation-mode")
      ? "☀ Normal mode"
      : "◐ Presentation mode";
}

/* =========================================================
   SHUFFLE
   - mixes photos and videos together
   - photos are spread between videos (same type is kept apart)
   - every item appears exactly once (no duplicates)
   - nothing comes again until the whole list has been shown;
     after the last one the slideshow starts again from the 1st
   - pressing the button again makes a brand new shuffle
   ========================================================= */

// Fisher–Yates: a true random order, each item used exactly once
function shuffleArray(list) {
  const copy = list.slice();

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

// Shuffle photos and videos separately, then spread the smaller group
// (usually videos) evenly between the bigger group so that two photos or
// two videos only touch when there is no other choice.
function buildMixedOrder() {
  const photos = shuffleArray(items.filter(item => item.type !== "video"));
  const videos = shuffleArray(items.filter(item => item.type === "video"));

  const major = photos.length >= videos.length ? photos : videos;
  const minor = major === photos ? videos : photos;

  if (!minor.length) return major; // only one kind of file

  // minor items sit between "gaps" of major items
  const gapCount = minor.length + 1;
  const sizes = new Array(gapCount).fill(0);
  let left = major.length;

  // 1) every gap between two minor items gets one, so they never touch
  for (let g = 1; g < gapCount - 1 && left > 0; g++) {
    sizes[g] = 1;
    left--;
  }

  // 2) share the rest evenly over all gaps; leftovers go to random gaps
  const base = Math.floor(left / gapCount);
  for (let g = 0; g < gapCount; g++) sizes[g] += base;

  const extra = left - base * gapCount;
  const randomGaps = shuffleArray([...Array(gapCount).keys()]);
  for (let k = 0; k < extra; k++) sizes[randomGaps[k]]++;

  // 3) build the final order
  const mixed = [];
  let used = 0;

  for (let g = 0; g < gapCount; g++) {
    for (let k = 0; k < sizes[g]; k++) mixed.push(major[used++]);
    if (g < minor.length) mixed.push(minor[g]);
  }

  return mixed;
}

function sameOrder(a, b) {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

// Re-orders the real list, so the counter, the list on the page and the
// slideshow all follow the new order. Nothing is added or copied.
function shuffleItems() {
  const before = items.slice();
  let mixed = buildMixedOrder();

  // pressing Shuffle again must give a different order
  for (let tries = 0; tries < 10 && items.length > 2 && sameOrder(mixed, before); tries++) {
    mixed = buildMixedOrder();
  }

  items.splice(0, items.length, ...mixed);
}

// Shuffle button: shuffle everything, go to the 1st slide, and play
function shuffleAndPlay() {
  if (!items.length) {
    setStatus("Add at least one photo or video to shuffle.");
    return;
  }

  const canShuffle = items.length > 1;

  if (canShuffle) {
    shuffleItems();
    saveOrderLocal();
  }

  current = 0;
  render(canShuffle, "next");

  // if the slideshow is already playing, render() has restarted it
  if (!playing) startSlideshow();

  setStatus(
    canShuffle
      ? `Shuffled ${items.length} memories. Each one plays once, then it starts again from the 1st.`
      : ""
  );
}

/* =========================================================
   EVENTS
   ========================================================= */

$("filesInput").addEventListener("change", event => {
  addFiles(event.target.files);
  event.target.value = "";
});

$("folderInput").addEventListener("change", event => {
  addFiles(event.target.files);
  event.target.value = "";
});

$("titleInput").addEventListener("input", updateHeader);
$("dedicationInput").addEventListener("input", updateHeader);

$("previous").addEventListener("click", previousSlide);
$("next").addEventListener("click", nextSlide);
$("play").addEventListener("click", toggleSlideshow);
$("fullscreen").addEventListener("click", toggleFullscreen);
$("videoMute").addEventListener("click", toggleMute);
$("presentation").addEventListener("click", togglePresentationMode);
$("shuffle").addEventListener("click", shuffleAndPlay);
$("removeAll").addEventListener("click", removeAll);

// Internet comes and goes: the slideshow keeps playing from this device
window.addEventListener("online", () => {
  items.forEach(item => {
    if (item.state === "failed") setItemState(item, "pending");
  });

  cloudSync();
});

window.addEventListener("offline", () => {
  setStatus("No internet. That is fine: everything plays from this device.");
});

window.addEventListener("pagehide", flushMeta);

// Seconds only affects photos; a playing video is never interrupted
$("seconds").addEventListener("change", () => {
  if (playing && items[current] && items[current].type === "image") {
    scheduleCurrent();
  }
});

$("music").addEventListener("change", event => {
  const file = event.target.files[0];

  if (!file) return;

  if (musicUrl) {
    URL.revokeObjectURL(musicUrl);
  }

  musicUrl = URL.createObjectURL(file);
  audio.src = musicUrl;
  audio.volume = Number($("volume").value) / 100;
  musicStopped = false;

  $("musicName").textContent = `Selected: ${file.name}`;
  updateMusicButton();

  if (playing) {
    updateMusic();
  }

  event.target.value = "";
});

$("volume").addEventListener("input", event => {
  audio.volume = Number(event.target.value) / 100;
});

$("musicToggle").addEventListener("click", () => {
  if (!audio.src) {
    setStatus("Choose a music file first.");
    return;
  }

  musicStopped = !musicStopped;
  updateMusicButton();
  updateMusic();
});

stage.addEventListener("touchstart", event => {
  touchStartX = event.changedTouches[0].screenX;
}, { passive: true });

stage.addEventListener("touchend", event => {
  const distance = event.changedTouches[0].screenX - touchStartX;

  if (Math.abs(distance) < 50) return;

  if (distance < 0) {
    nextSlide();
  } else {
    previousSlide();
  }
}, { passive: true });

document.addEventListener("keydown", event => {
  if (IS_GALLERY) {
    handleGalleryKeys(event);
    return;
  }

  const active = document.activeElement;
  const typing =
    active &&
    ["INPUT", "TEXTAREA"].includes(active.tagName);

  if (typing) return;

  if (event.key === "ArrowRight") {
    nextSlide();
  }

  if (event.key === "ArrowLeft") {
    previousSlide();
  }

  if (event.code === "Space") {
    event.preventDefault();
    toggleSlideshow();
  }

  if (event.key.toLowerCase() === "f") {
    toggleFullscreen();
  }

  if (event.key.toLowerCase() === "m") {
    toggleMute();
  }

  if (event.key === "Escape" && playing) {
    stopSlideshow();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && playing) {
    stopSlideshow();
  }
});

document.addEventListener("fullscreenchange", () => {
  $("fullscreen").textContent =
    document.fullscreenElement
      ? "⤢ Exit fullscreen"
      : "⛶ Fullscreen";
});

/* =========================================================
   START
   ========================================================= */

if (IS_GALLERY) {
  initGallery();
} else {
  render();
  updateHeader();
  updateMusicButton();
  bootPresenter();
}

// Lets the page open even with no internet (see sw.js)
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}