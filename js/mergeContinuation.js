/**
 * Склейка продолжения ответа бота (общая логика для сервера и чата).
 */
(function mergeContinuationModule(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.stripContinuationOverlap = api.stripContinuationOverlap;
    root.mergeContinuationText = api.mergeContinuationText;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  function normalizeForDuplicateCheck(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isMidSentenceCutoff(text) {
    const trimmed = String(text || "").trimEnd();
    if (!trimmed) return false;
    if (/[,\u2014\u2013-]$/.test(trimmed)) return true;
    if (/[.!?…]["»»]?\s*$/.test(trimmed)) return false;
    if (/[A-Za-zА-Яа-яЁё0-9]$/.test(trimmed)) return true;
    return false;
  }

  function continuationJoinSeparator(head, tail) {
    const h = String(head || "").trimEnd();
    if (!h || !tail) return "";

    if (h.endsWith("\n\n")) return "";
    if (h.endsWith("\n")) return "";

    if (isMidSentenceCutoff(h)) {
      return "";
    }

    if (/[.!?…]["»»]?\s*$/.test(h)) {
      if (/^["«*]/.test(String(tail || "").trim())) return " ";
      return "\n\n";
    }

    return " ";
  }

  function stripDuplicateLeadingSentences(rawHead, rawTail) {
    let tail = String(rawTail || "").trim();
    const headNorm = normalizeForDuplicateCheck(rawHead);
    if (!tail || !headNorm) return tail;

    let guard = 0;
    while (tail && guard < 8) {
      guard += 1;
      let removed = false;

      const sentMatch = tail.match(/^(.+?[.!?…]["»»]?)\s+([\s\S]+)$/);
      if (sentMatch) {
        const firstNorm = normalizeForDuplicateCheck(sentMatch[1]);
        if (firstNorm.length >= 18 && headNorm.includes(firstNorm)) {
          tail = sentMatch[2].trim();
          removed = true;
        }
      }

      if (!removed) {
        for (const headChunk of String(rawHead || "").split(/\n{2,}/)) {
          const chunk = headChunk.trim();
          if (chunk.length < 20) continue;
          if (tail.startsWith(chunk)) {
            tail = tail.slice(chunk.length).trimStart();
            removed = true;
            break;
          }
          const chunkNorm = normalizeForDuplicateCheck(chunk);
          if (chunkNorm.length < 20) continue;
          const tailStartNorm = normalizeForDuplicateCheck(tail.slice(0, Math.min(tail.length, chunk.length + 40)));
          if (tailStartNorm.startsWith(chunkNorm) || chunkNorm.startsWith(tailStartNorm.slice(0, Math.min(chunkNorm.length, tailStartNorm.length)))) {
            const idx = tail.toLowerCase().indexOf(chunk.slice(0, Math.min(40, chunk.length)).toLowerCase());
            if (idx === 0) {
              tail = tail.slice(chunk.length).trimStart();
              removed = true;
              break;
            }
          }
        }
      }

      if (!removed) break;
    }

    return tail;
  }

  function stripAllDuplicateParagraphs(rawHead, rawTail) {
    const headChunks = String(rawHead || "")
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean);
    const headNorms = headChunks.map((chunk) => normalizeForDuplicateCheck(chunk));

    const kept = [];
    for (const tp of String(rawTail || "").split(/\n{2,}/)) {
      const trimmed = tp.trim();
      if (!trimmed) continue;
      const tpNorm = normalizeForDuplicateCheck(trimmed);
      let isDup = false;

      for (const hpNorm of headNorms) {
        if (!hpNorm || hpNorm.length < 12) continue;
        if (tpNorm === hpNorm) {
          isDup = true;
          break;
        }
        if (hpNorm.length > 22 && tpNorm.startsWith(hpNorm.slice(0, Math.min(90, hpNorm.length)))) {
          isDup = true;
          break;
        }
        if (tpNorm.length > 22 && hpNorm.startsWith(tpNorm.slice(0, Math.min(90, tpNorm.length)))) {
          isDup = true;
          break;
        }
      }

      if (!isDup) kept.push(trimmed);
    }

    return kept.join("\n\n").trim();
  }

  function stripContinuationOverlap(head, tail) {
    let rawTail = String(tail || "").trim();
    const rawHead = String(head || "").trimEnd();
    if (!rawHead || !rawTail) return rawTail;

    rawTail = stripDuplicateLeadingSentences(rawHead, rawTail);
    if (!rawTail) return rawTail;

    const headParas = rawHead.split(/\n{2,}/);
    const tailParas = rawTail.split(/\n{2,}/);

    while (tailParas.length && headParas.length) {
      const hp = headParas[headParas.length - 1].trim();
      const tp = tailParas[0].trim();
      const hpNorm = normalizeForDuplicateCheck(hp);
      const tpNorm = normalizeForDuplicateCheck(tp);
      if (!tpNorm) {
        tailParas.shift();
        continue;
      }
      if (hpNorm && hpNorm === tpNorm) {
        tailParas.shift();
        continue;
      }
      if (hpNorm.length > 30 && tpNorm.startsWith(hpNorm.slice(0, Math.min(90, hpNorm.length)))) {
        tailParas.shift();
        continue;
      }
      if (headParas.length > 1) {
        const firstHeadNorm = normalizeForDuplicateCheck(headParas[0]);
        if (firstHeadNorm.length > 40 && firstHeadNorm === tpNorm) {
          tailParas.shift();
          continue;
        }
      }
      for (const hpItem of headParas) {
        const item = hpItem.trim();
        const itemNorm = normalizeForDuplicateCheck(item);
        if (itemNorm.length >= 25 && itemNorm === tpNorm) {
          tailParas.shift();
          break;
        }
      }
      if (!tailParas.length || tailParas[0].trim() !== tp) {
        continue;
      }
      break;
    }

    rawTail = tailParas.join("\n\n").trim();
    if (!rawTail) return rawTail;

    rawTail = stripAllDuplicateParagraphs(rawHead, rawTail);
    if (!rawTail) return rawTail;

    const maxOverlap = Math.min(rawHead.length, rawTail.length, 200);
    for (let size = maxOverlap; size >= 8; size -= 1) {
      const suffix = rawHead.slice(-size);
      if (rawTail.startsWith(suffix)) {
        rawTail = rawTail.slice(size).trimStart();
        break;
      }
    }

    return rawTail;
  }

  function mergeContinuationText(partial, addition) {
    const head = String(partial || "").trimEnd();
    let tail = String(addition || "").trim();
    if (!tail) return head;
    if (!head) return tail;

    tail = stripContinuationOverlap(head, tail);
    if (!tail) return head;

    const sep = continuationJoinSeparator(head, tail);
    return head + sep + tail;
  }

  return {
    stripContinuationOverlap,
    mergeContinuationText,
    continuationJoinSeparator,
    isMidSentenceCutoff,
  };
});
