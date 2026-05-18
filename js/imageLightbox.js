(function () {
  function closeLightbox(overlay) {
    if (!overlay) return;
    overlay.classList.remove("open");
    window.setTimeout(() => overlay.remove(), 160);
    document.body.classList.remove("image-lightbox-open");
  }

  window.openImageLightbox = function openImageLightbox(src, alt) {
    const url = String(src || "").trim();
    if (!url) return;

    document.querySelector(".image-lightbox-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "image-lightbox-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", alt || "Изображение");
    overlay.innerHTML = `
      <button type="button" class="image-lightbox-close" aria-label="Закрыть">×</button>
      <img class="image-lightbox-img" src="" alt="" />
    `;

    const img = overlay.querySelector(".image-lightbox-img");
    img.src = url;
    img.alt = alt || "";

    overlay.querySelector(".image-lightbox-close").addEventListener("click", () => {
      closeLightbox(overlay);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeLightbox(overlay);
    });

    document.body.appendChild(overlay);
    document.body.classList.add("image-lightbox-open");
    requestAnimationFrame(() => overlay.classList.add("open"));

    const onKey = (e) => {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        closeLightbox(overlay);
      }
    };
    document.addEventListener("keydown", onKey);
  };

  window.initAvatarZoom = function initAvatarZoom(root) {
    const scope = root || document;
    scope.addEventListener("click", (event) => {
      const img = event.target.closest("img.avatar-zoomable");
      if (!img || !scope.contains(img)) return;
      const src = img.currentSrc || img.src;
      if (!src) return;
      event.preventDefault();
      event.stopPropagation();
      openImageLightbox(src, img.alt || "");
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initAvatarZoom(document));
  } else {
    initAvatarZoom(document);
  }
})();
