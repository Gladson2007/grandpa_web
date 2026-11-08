const $ = id => document.getElementById(id);

const stage = $("stage");
const mediaList = $("mediaList");
const counter = $("counter");
const slideName = $("slideName");
const progressBar = $("progressBar");
const audio = $("audio");

const PLACEHOLDER = `
  <div class="placeholder" style="color:#61738a;font-style:italic">
    Add photos or videos to start the slideshow
  </div>
`;

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
  slideName.textContent = items[current].file.name;
}

/* ---------- timers ---------- */

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

/* ---------- video / music ---------- */

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
        $("status").textContent =
          "Your browser blocked sound, so the video is playing muted. Press Unmute video to hear it.";
        video.play().catch(() => {});
      }
    });
  }
}

// Background music pauses while a video is playing with its own sound
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
  $("status").textContent = `Could not play "${item.file.name}". Skipping it.`;

  if (!playing) return;

  if (items.length > 1) {
    setTimeout(() => {
      if (playing && items[current] === item) nextSlide();
    }, 1500);
  } else {
    stopSlideshow();
  }
}

/* ---------- rendering ---------- */

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
    element.alt = item.file.name;
  }

  return element;
}

function updateCaption() {
  stage.querySelectorAll(".caption").forEach(node => node.remove());

  const item = items[current];
  if (!item || !item.caption) return;

  const caption = document.createElement("div");
  caption.className =
    item.type === "video" ? "caption on-video" : "caption";
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
  copy.classList.remove("current-media"); // so it is not deleted below
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

  // also removes the "add photos or videos" text
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
      `${item.type === "video" ? "▶ " : "▧ "}${item.file.name}`;

    const caption = document.createElement("input");
    caption.type = "text";
    caption.placeholder = "Optional caption";
    caption.value = item.caption;

    caption.addEventListener("click", event => event.stopPropagation());

    // only the caption changes: the video / timer is not restarted
    caption.addEventListener("input", event => {
      item.caption = event.target.value;

      if (index === current) {
        updateCaption();
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

    row.append(thumbnail, filename, caption, up, down, remove);

    row.addEventListener("click", () => {
      const direction = index > current ? "next" : "previous";
      current = index;
      render(true, direction);
    });

    mediaList.appendChild(row);
  });
}

/* ---------- list actions ---------- */

function addFiles(fileList) {
  for (const file of fileList) {
    if (
      !file.type.startsWith("image/") &&
      !file.type.startsWith("video/")
    ) {
      continue;
    }

    items.push({
      file,
      url: URL.createObjectURL(file),
      type: file.type.startsWith("video/") ? "video" : "image",
      caption: ""
    });
  }

  render();
}

function removeItem(index) {
  URL.revokeObjectURL(items[index].url);
  items.splice(index, 1);

  if (index < current) {
    current--;
  } else if (current >= items.length) {
    current = Math.max(0, items.length - 1);
  }

  render();
}

function moveItem(index, direction) {
  const target = index + direction;

  if (target < 0 || target >= items.length) {
    return;
  }

  [items[index], items[target]] = [items[target], items[index]];
  current = target;
  render();
}

/* ---------- navigation ---------- */

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
    $("status").textContent =
      "Add at least one photo or video to start the slideshow.";
    return;
  }

  $("status").textContent = "";
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

/* ---------- events ---------- */

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
    $("status").textContent = "Choose a music file first.";
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

render();
updateHeader();
updateMusicButton();
