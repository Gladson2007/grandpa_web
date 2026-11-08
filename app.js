/* =========================================================
   SETTINGS: fill these in to switch the QR gallery on
   ========================================================= */
const CONFIG = {
  SUPABASE_URL: "https://sjfkcivlokgdncivqszj.supabase.co",        // Project URL, e.g. "https://abcdxyz.supabase.co"
  SUPABASE_ANON_KEY: "sb_secret_QJw1hmK-qfzAOsq9ruT3iw_4rCdrfSL",   // anon public key from Project Settings > API
  BUCKET: "memories",      // keep this name (same as in the SQL)
  PUBLIC_SITE_URL: "https://grandpaweb.vercel.app"      // optional, e.g. "https://grandpa-memories.netlify.app/"
};

const $ = id => document.getElementById(id);
const IS_GALLERY = new URLSearchParams(location.search).has("gallery");

const sb =
  CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && window.supabase
    ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY)
    : null;

const stage = $("stage");
const mediaList = $("mediaList");
const counter = $("counter");
const slideName = $("slideName");
const progressBar = $("progressBar");
const audio = $("audio");

const PLACEHOLDER =
  '<div class="placeholder">Add photos or videos to start the slideshow</div>';

const BADGES = {
  local: "On this device only",
  pending: "Waiting…",
  uploading: "Saving…",
  saved: "☁ Saved to QR gallery",
  failed: "⚠ Not saved · Retry"
};

// each item: { id, name, url, type, caption, file, path, state, badgeEl }
const items = [];

let current = 0;
let advanceTimer = null;
let progressTimer = null;
let playing = false;
let videoMuted = false;
let musicStopped = false;
let shuffleEnabled = false;
let musicUrl = null;
let touchStartX = 0;

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
}

/* =========================================================
   CLOUD (Supabase): makes the QR gallery work
   ========================================================= */

async function fetchMemories() {
  const { data, error } = await sb
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
    const ext = (item.name.split(".").pop() || "bin")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "bin";

    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error } = await sb.storage
      .from(CONFIG.BUCKET)
      .upload(path, item.file, {
        contentType: item.file.type,
        cacheControl: "31536000"
      });

    if (error) throw error;

    const { data } = sb.storage.from(CONFIG.BUCKET).getPublicUrl(path);

    const { data: row, error: dbError } = await sb
      .from("memories")
      .insert({
        url: data.publicUrl,
        path,
        type: item.type,
        name: item.name,
        caption: item.caption,
        position: items.indexOf(item)
      })
      .select()
      .single();

    if (dbError) throw dbError;

    item.id = row.id;
    item.path = path;
    item.file = null;
    setItemState(item, "saved");

    if (!items.includes(item)) {
      deleteFromCloud(item); // removed while uploading
    } else {
      syncCaption(item);
    }
  } catch (error) {
    console.error(error);
    setItemState(item, "failed");
  }
}

async function uploadQueue(list) {
  let done = 0;

  for (const item of list) {
    if (!items.includes(item)) continue;

    setStatus(`Saving to cloud… ${done + 1} of ${list.length}`);
    await uploadItem(item);
    done++;
  }

  const failed = list.filter(item => item.state === "failed").length;

  setStatus(
    failed
      ? `${failed} file(s) could not be saved. Click "Not saved" to retry.`
      : "All memories saved. The QR gallery is up to date."
  );

  syncOrder();
}

async function deleteFromCloud(item) {
  if (!sb || !item.id) return;

  await sb.from("memories").delete().eq("id", item.id);

  if (item.path) {
    await sb.storage.from(CONFIG.BUCKET).remove([item.path]);
  }
}

const captionTimers = new Map();

function syncCaption(item) {
  if (!sb || !item.id) return;

  clearTimeout(captionTimers.get(item));

  captionTimers.set(item, setTimeout(() => {
    sb.from("memories")
      .update({ caption: item.caption })
      .eq("id", item.id)
      .then(() => {});
  }, 700));
}

let orderTimer = null;

function syncOrder() {
  if (!sb) return;

  clearTimeout(orderTimer);

  orderTimer = setTimeout(() => {
    items.forEach((item, index) => {
      if (item.id) {
        sb.from("memories")
          .update({ position: index })
          .eq("id", item.id)
          .then(() => {});
      }
    });
  }, 800);
}

async function loadSavedMemories() {
  if (!sb) return;

  try {
    const rows = await fetchMemories();

    rows.forEach(row => {
      items.push({
        id: row.id,
        name: row.name || "memory",
        url: row.url,
        type: row.type,
        caption: row.caption || "",
        file: null,
        path: row.path,
        state: "saved"
      });
    });

    if (rows.length) {
      render();
      setStatus(`${rows.length} saved memories loaded.`);
    }
  } catch (error) {
    console.error(error);
    setStatus("Could not load saved memories. Check your Supabase settings.");
  }
}

/* =========================================================
   QR CODE
   ========================================================= */

function getGalleryUrl() {
  let base = CONFIG.PUBLIC_SITE_URL.trim();

  if (!base && /^https?:$/.test(location.protocol)) {
    base = location.origin + location.pathname;
  }

  return base ? base.split(/[?#]/)[0] + "?gallery" : "";
}

function drawQR(target, size) {
  target.innerHTML = "";

  const url = getGalleryUrl();
  if (!url || !window.QRCode) return false;

  new QRCode(target, {
    text: url,
    width: size,
    height: size,
    colorDark: "#16243b",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });

  return true;
}

function setupQR() {
  const size = window.innerWidth <= 700 ? 84 : 104;
  const ready = Boolean(sb) && drawQR($("qrCode"), size);

  $("qrCard").classList.toggle("inactive", !ready);
  $("qrLabel").textContent = ready
    ? "Scan to see all memories"
    : "QR not active yet";

  if (!sb) {
    $("cloudNote").textContent =
      "The QR gallery is off. Add SUPABASE_URL and SUPABASE_ANON_KEY at the top of app.js, then open this page from your online website link.";
  } else if (!getGalleryUrl()) {
    $("cloudNote").textContent =
      "Open this page from your online website link (or set PUBLIC_SITE_URL in app.js) so the QR code can work.";
  } else {
    $("cloudNote").textContent =
      "Everything you add here is saved online and appears in the QR gallery.";
  }
}

$("qrCard").addEventListener("click", () => {
  if ($("qrCard").classList.contains("inactive")) {
    setStatus($("cloudNote").textContent);
    return;
  }

  drawQR($("qrBig"), 300);
  $("qrUrl").textContent = getGalleryUrl();
  $("qrModal").hidden = false;
});

$("qrModal").addEventListener("click", () => {
  $("qrModal").hidden = true;
});

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
    status.textContent = "Could not load the memories. Please try again.";
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
  const startedAt = Date.now();
  const duration = getSeconds() * 1000;

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

function updateCaption() {
  stage.querySelectorAll(".caption").forEach(node => node.remove());

  const item = items[current];
  if (!item || !item.caption) return;

  const caption = document.createElement("div");
  caption.className = item.type === "video" ? "caption on-video" : "caption";
  caption.textContent = item.caption;
  stage.appendChild(caption);
}

function createPageAnimation(direction) {
  const oldMedia = stage.querySelector(".current-media");
  if (!oldMedia) return;

  const oldPage = document.createElement("div");

  oldPage.className =
    direction === "previous"
      ? "memory-page turn-previous"
      : "memory-page turn-next";

  const copy = oldMedia.cloneNode(true);
  copy.classList.remove("current-media");
  copy.controls = false;
  copy.muted = true;

  oldPage.appendChild(copy);
  stage.appendChild(oldPage);

  setTimeout(() => oldPage.remove(), 800);
}

function scheduleCurrent() {
  clearTimers();

  if (!playing || !items.length) return;

  if (items[current].type === "video") {
    const video = getCurrentVideo();
    if (video) playVideo(video);
  } else {
    startImageTimer();
  }

  updateMusic();
}

function render(animate = false, direction = "next") {
  updateHeader();

  if (!items.length) {
    stopSlideshow();
    stage.innerHTML = PLACEHOLDER;
    updateCounter();
    mediaList.innerHTML = "";
    return;
  }

  current = Math.max(0, Math.min(current, items.length - 1));

  if (animate) {
    createPageAnimation(direction);
  }

  const oldVideo = getCurrentVideo();
  if (oldVideo) oldVideo.pause();

  stage
    .querySelectorAll(".placeholder,.current-media,.caption")
    .forEach(node => node.remove());

  stage.appendChild(createMedia(items[current]));

  updateCaption();
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
        uploadQueue([item]);
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

function addFiles(fileList) {
  const added = [];

  for (const file of fileList) {
    if (!/^(image|video)\//.test(file.type)) continue;

    const item = {
      id: null,
      name: file.name,
      url: URL.createObjectURL(file),
      type: file.type.startsWith("video/") ? "video" : "image",
      caption: "",
      file,
      path: null,
      state: sb ? "pending" : "local"
    };

    items.push(item);
    added.push(item);
  }

  render();

  if (sb && added.length) {
    uploadQueue(added);
  }
}

function removeItem(index) {
  const [item] = items.splice(index, 1);

  if (item.url.startsWith("blob:")) {
    URL.revokeObjectURL(item.url);
  }

  deleteFromCloud(item);

  if (index < current) {
    current--;
  } else if (current >= items.length) {
    current = Math.max(0, items.length - 1);
  }

  render();
  syncOrder();
}

function moveItem(index, direction) {
  const target = index + direction;

  if (target < 0 || target >= items.length) {
    return;
  }

  [items[index], items[target]] = [items[target], items[index]];
  current = target;
  render();
  syncOrder();
}

/* =========================================================
   NAVIGATION + CONTROLS
   ========================================================= */

function nextSlide() {
  if (!items.length) return;

  const oldIndex = current;

  if (shuffleEnabled && items.length > 1) {
    do {
      current = Math.floor(Math.random() * items.length);
    } while (current === oldIndex);
  } else {
    current = (current + 1) % items.length;
  }

  render(true, "next");
}

function previousSlide() {
  if (!items.length) return;

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

function toggleShuffle() {
  shuffleEnabled = !shuffleEnabled;

  $("shuffle").textContent =
    shuffleEnabled ? "🔀 Shuffle: On" : "🔀 Shuffle: Off";
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
$("shuffle").addEventListener("click", toggleShuffle);

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

  if (event.key === "Escape" && !$("qrModal").hidden) {
    $("qrModal").hidden = true;
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
  setupQR();
  loadSavedMemories();
}
