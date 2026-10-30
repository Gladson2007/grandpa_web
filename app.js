const $ = id => document.getElementById(id);

const filesInput = $("files");
const stage = $("stage");
const mediaList = $("mediaList");
const counter = $("counter");
const audio = $("audio");

const items = [];
let current = 0;
let timer = null;
let playing = false;
let musicUrl = null;

function render() {
  $("heading").textContent =
    $("titleInput").value || "Grandpa's Memories";

  $("dedication").textContent =
    $("dedicationInput").value || "";

  mediaList.innerHTML = "";

  if (items.length === 0) {
    stage.innerHTML = "<div>Add your family photos and videos below</div>";
    counter.textContent = "0 / 0";
    return;
  }

  current = Math.max(0, Math.min(current, items.length - 1));
  const item = items[current];

  stage.innerHTML = "";

  // Blurred copy fills the frame behind the full-size media.
  const background = document.createElement(
    item.type === "video" ? "video" : "img"
  );
  background.src = item.url;
  background.className = "media-background";
  background.setAttribute("aria-hidden", "true");

  const media = document.createElement(
    item.type === "video" ? "video" : "img"
  );
  media.src = item.url;
  media.className = "media-foreground";

  if (item.type === "video") {
    media.controls = true;
    media.playsInline = true;
  } else {
    media.alt = item.file.name;
  }

  stage.append(background, media);

  if (item.caption) {
    const caption = document.createElement("div");
    caption.className = "caption";
    caption.textContent = item.caption;
    stage.appendChild(caption);
  }

  counter.textContent = `${current + 1} / ${items.length}`;

  items.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "item";

    const thumb = document.createElement(
      entry.type === "video" ? "video" : "img"
    );
    thumb.src = entry.url;
    thumb.muted = true;

    const name = document.createElement("span");
    name.className = "filename";
    name.textContent =
      `${entry.type === "video" ? "▶ " : "▧ "}${entry.file.name}`;

    const captionInput = document.createElement("input");
    captionInput.type = "text";
    captionInput.placeholder = "Optional caption";
    captionInput.value = entry.caption;

    captionInput.addEventListener("input", () => {
      entry.caption = captionInput.value;

      if (index === current) {
        const existing = stage.querySelector(".caption");

        if (entry.caption) {
          if (existing) {
            existing.textContent = entry.caption;
          } else {
            const caption = document.createElement("div");
            caption.className = "caption";
            caption.textContent = entry.caption;
            stage.appendChild(caption);
          }
        } else if (existing) {
          existing.remove();
        }
      }
    });

    const up = document.createElement("button");
    up.textContent = "↑";
    up.className = "secondary";
    up.onclick = () => move(index, -1);

    const down = document.createElement("button");
    down.textContent = "↓";
    down.className = "secondary";
    down.onclick = () => move(index, 1);

    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.className = "secondary";
    remove.onclick = () => removeItem(index);

    row.append(thumb, name, captionInput, up, down, remove);

    row.addEventListener("click", event => {
      if (
        !event.target.closest("button") &&
        event.target !== captionInput
      ) {
        current = index;
        render();
      }
    });

    mediaList.appendChild(row);
  });
}

function move(index, direction) {
  const target = index + direction;

  if (target < 0 || target >= items.length) return;

  [items[index], items[target]] = [items[target], items[index]];
  current = target;
  render();
}

function removeItem(index) {
  URL.revokeObjectURL(items[index].url);
  items.splice(index, 1);
  current = Math.max(0, Math.min(current, items.length - 1));
  render();
}

filesInput.addEventListener("change", event => {
  for (const file of event.target.files) {
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

  event.target.value = "";
  render();
});

$("titleInput").addEventListener("input", render);
$("dedicationInput").addEventListener("input", render);

$("previous").onclick = () => {
  if (!items.length) return;
  current = (current - 1 + items.length) % items.length;
  render();
};

$("next").onclick = () => {
  if (!items.length) return;
  current = (current + 1) % items.length;
  render();
};

$("play").onclick = () => {
  if (!items.length) return;

  playing = !playing;
  $("play").textContent = playing
    ? "❚❚ Pause slideshow"
    : "▶ Play slideshow";

  clearInterval(timer);

  if (playing) {
    const seconds = Math.max(2, Number($("seconds").value) || 5);

    timer = setInterval(() => {
      current = (current + 1) % items.length;
      render();
    }, seconds * 1000);

    if (audio.src) {
      audio.play().catch(() => {});
    }
  } else {
    audio.pause();
  }
};

$("music").addEventListener("change", event => {
  const file = event.target.files[0];
  if (!file) return;

  if (musicUrl) URL.revokeObjectURL(musicUrl);

  musicUrl = URL.createObjectURL(file);
  audio.src = musicUrl;
  audio.volume = Number($("volume").value) / 100;
});

$("volume").addEventListener("input", event => {
  audio.volume = Number(event.target.value) / 100;
});

function drawFitted(ctx, media, width, height) {
  const mediaWidth = media.videoWidth || media.naturalWidth;
  const mediaHeight = media.videoHeight || media.naturalHeight;

  if (!mediaWidth || !mediaHeight) return;

  // Blurred background fills unused space.
  ctx.save();
  ctx.filter = "blur(24px) brightness(0.55)";
  const coverScale = Math.max(width / mediaWidth, height / mediaHeight);
  const coverWidth = mediaWidth * coverScale;
  const coverHeight = mediaHeight * coverScale;

  ctx.drawImage(
    media,
    (width - coverWidth) / 2,
    (height - coverHeight) / 2,
    coverWidth,
    coverHeight
  );
  ctx.restore();

  // Full photo or video fits inside the frame without cropping.
  const fitScale = Math.min(width / mediaWidth, height / mediaHeight);
  const fitWidth = mediaWidth * fitScale;
  const fitHeight = mediaHeight * fitScale;

  ctx.drawImage(
    media,
    (width - fitWidth) / 2,
    (height - fitHeight) / 2,
    fitWidth,
    fitHeight
  );
}

function drawCaption(ctx, text, width, height) {
  if (!text) return;

  ctx.fillStyle = "#0009";
  ctx.fillRect(0, height - 78, width, 78);

  ctx.fillStyle = "white";
  ctx.font = "30px Georgia";
  ctx.textAlign = "center";
  ctx.fillText(text, width / 2, height - 28, width - 50);
}

$("export").onclick = async () => {
  if (!items.length) {
    $("status").textContent = "Add some photos or videos first.";
    return;
  }

  if (
    !window.MediaRecorder ||
    !HTMLCanvasElement.prototype.captureStream
  ) {
    $("status").textContent =
      "Video export is not supported here. Try the latest Chrome or Edge.";
    return;
  }

  $("export").disabled = true;
  $("status").textContent = "Preparing video… Keep this page open.";

  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;

  const context = canvas.getContext("2d");
  const stream = canvas.captureStream(30);
  let audioContext = null;

  // Add the selected music to the exported video.
  if (audio.src) {
    try {
      audioContext = new AudioContext();

      const source = audioContext.createMediaElementSource(audio);
      const gain = audioContext.createGain();
      const destination = audioContext.createMediaStreamDestination();

      gain.gain.value = Number($("volume").value) / 100;
      source.connect(gain);
      gain.connect(audioContext.destination);
      gain.connect(destination);

      destination.stream.getAudioTracks().forEach(track => {
        stream.addTrack(track);
      });

      audio.currentTime = 0;
      await audioContext.resume();
      await audio.play();
    } catch (error) {
      console.error("Could not add music to export:", error);
    }
  }

  const mimeType = MediaRecorder.isTypeSupported(
    "video/webm;codecs=vp9,opus"
  )
    ? "video/webm;codecs=vp9,opus"
    : "video/webm";

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];

  recorder.ondataavailable = event => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const finished = new Promise(resolve => {
    recorder.onstop = resolve;
  });

  recorder.start();

  try {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      current = index;
      render();

      $("status").textContent =
        `Recording memory ${index + 1} of ${items.length}…`;

      if (item.type === "image") {
        const image = new Image();
        image.src = item.url;
        await image.decode();

        context.fillStyle = "#221e1a";
        context.fillRect(0, 0, canvas.width, canvas.height);
        drawFitted(context, image, canvas.width, canvas.height);
        drawCaption(context, item.caption, canvas.width, canvas.height);

        const seconds = Math.max(
          2,
          Number($("seconds").value) || 5
        );

        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      } else {
        const video = document.createElement("video");
        video.src = item.url;
        video.muted = true;
        video.playsInline = true;

        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = reject;
        });

        await video.play();

        await new Promise(resolve => {
          function drawFrame() {
            context.fillStyle = "#221e1a";
            context.fillRect(0, 0, canvas.width, canvas.height);

            drawFitted(context, video, canvas.width, canvas.height);
            drawCaption(context, item.caption, canvas.width, canvas.height);

            if (video.ended) {
              resolve();
            } else {
              requestAnimationFrame(drawFrame);
            }
          }

          drawFrame();
        });

        video.pause();
        video.remove();
      }
    }

    recorder.stop();
    await finished;

    const blob = new Blob(chunks, { type: mimeType });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = downloadUrl;
    link.download = "grandpa-memories.webm";
    link.click();

    setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
    $("status").textContent =
      "Finished. Your slideshow video has downloaded.";
  } catch (error) {
    console.error(error);

    if (recorder.state === "recording") {
      recorder.stop();
      await finished;
    }

    $("status").textContent =
      "Export failed. Try a smaller video file or another browser.";
  } finally {
    $("export").disabled = false;
    audio.pause();

    if (audioContext) {
      await audioContext.close().catch(() => {});
    }

    stream.getTracks().forEach(track => track.stop());
  }
};

render();