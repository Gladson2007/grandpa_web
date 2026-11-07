const $ = id => document.getElementById(id);

const stage = $("stage");
const mediaList = $("mediaList");
const counter = $("counter");
const slideName = $("slideName");
const progressBar = $("progressBar");
const audio = $("audio");

const items = [];

let current = 0;
let timer = null;
let progressTimer = null;
let playing = false;
let videoMuted = false;
let musicStopped = false;
let shuffleEnabled = false;
let musicUrl = null;
let lastDirection = "next";
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

function updateCounter() {
  if (!items.length) {
    counter.textContent = "0 / 0";
    slideName.textContent = "No memory selected";
    return;
  }

  counter.textContent = `${current + 1} / ${items.length}`;
  slideName.textContent = items[current].file.name;
}

function clearProgress() {
  clearInterval(progressTimer);
  progressBar.style.width = "0%";
}

function startProgress() {
  clearInterval(progressTimer);

  const startedAt = Date.now();
  const duration = getSeconds() * 1000;

  progressTimer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const percent = Math.min(100, elapsed / duration * 100);
    progressBar.style.width = `${percent}%`;
  }, 50);
}

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
    element.muted = videoMuted;
  } else {
    element.alt = item.file.name;
  }

  return element;
}

function createPageAnimation(direction) {
  const oldPage = document.createElement("div");

  oldPage.className =
    direction === "previous"
      ? "memory-page turn-previous"
      : "memory-page turn-next";

  const oldMedia = stage.querySelector(".current-media");

  if (oldMedia) {
    const copy = oldMedia.cloneNode(true);
    copy.controls = false;
    oldPage.appendChild(copy);
    stage.appendChild(oldPage);

    setTimeout(() => oldPage.remove(), 800);
  }
}

function render(animate = false, direction = "next") {
  updateHeader();

  if (!items.length) {
    stage.innerHTML = `
      <div style="color:#61738a;font-style:italic">
        Add photos and videos below
      </div>
    `;
    updateCounter();
    clearProgress();
    mediaList.innerHTML = "";
    return;
  }

  current = Math.max(0, Math.min(current, items.length - 1));

  if (animate) {
    createPageAnimation(direction);
  }

  const item = items[current];
  const media = createMedia(item);

  stage.querySelectorAll(".current-media,.caption").forEach(node => {
    node.remove();
  });

  stage.appendChild(media);

  if (item.caption) {
    const caption = document.createElement("div");
    caption.className = "caption";
    caption.textContent = item.caption;
    stage.appendChild(caption);
  }

  updateCounter();
  renderMediaList();

  if (playing) {
    startProgress();

    if (item.type === "video") {
      media.play().catch(() => {});
    }
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

    caption.addEventListener("input", event => {
      item.caption = event.target.value;

      if (index === current) {
        render(false);
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
      lastDirection = index > current ? "next" : "previous";
      current = index;
      render(true, lastDirection);
    });

    mediaList.appendChild(row);
  });
}

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

  if (items.length === 1) {
    current = 0;
  }

  render();
}

function removeItem(index) {
  URL.revokeObjectURL(items[index].url);
  items.splice(index, 1);

  if (current >= items.length) {
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

  lastDirection = "next";
  render(true, "next");
}

function previousSlide() {
  if (!items.length) return;

  current = (current - 1 + items.length) % items.length;
  lastDirection = "previous";
  render(true, "previous");
}

function stopSlideshow() {
  playing = false;
  clearInterval(timer);
  clearProgress();

  $("play").textContent = "▶ Play slideshow";
  $("play").setAttribute("aria-pressed", "false");

  const video = stage.querySelector("video");
  if (video) video.pause();

  if (musicStopped || audio.src) {
    audio.pause();
  }
}

function startSlideshow() {
  if (!items.length) {
    $("status").textContent = "Add at least one photo or video to start the slideshow.";
    return;
  }

  playing = true;

  $("play").textContent = "❚❚ Pause slideshow";
  $("play").setAttribute("aria-pressed", "true");

  clearInterval(timer);

  timer = setInterval(() => {
    nextSlide();
  }, getSeconds() * 1000);

  startProgress();

  const video = stage.querySelector("video");
  if (video) {
    video.play().catch(() => {});
  }

  if (audio.src && !musicStopped) {
    audio.play().catch(() => {});
  }
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
  videoMuted = !videoMuted;

  const video = stage.querySelector("video");

  if (video) {
    video.muted = videoMuted;
  }

  $("videoMute").textContent = videoMuted
    ? "🔇 Unmute video"
    : "🔊 Mute video";
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

function updateMusicButton() {
  $("musicToggle").textContent = musicStopped
    ? "▶ Play music"
    : "⏹ Stop music";
}

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

$("seconds").addEventListener("change", () => {
  if (playing) {
    stopSlideshow();
    startSlideshow();
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
    audio.play().catch(() => {});
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

  if (musicStopped) {
    audio.pause();
  } else {
    audio.play().catch(() => {});
  }

  updateMusicButton();
});

stage.addEventListener("touchstart", event => {
  touchStartX = event.changedTouches[0].screenX;
}, { passive: true });

stage.addEventListener("touchend", event => {
  const touchEndX = event.changedTouches[0].screenX;
  const distance = touchEndX - touchStartX;

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
