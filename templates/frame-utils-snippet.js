  function walkWindowFrames(win, depth, out, seen) {
    if (!win || depth > 14 || seen.has(win)) return;
    seen.add(win);

    try {
      const doc = win.document;
      if (!doc) return;

      const text = doc.documentElement?.innerText || doc.body?.innerText || "";
      const href = win.location?.href || "";

      if (text && text.length > 0 && text.length < 8000) {
        out.push({
          text: text.slice(0, 3500),
          href,
          depth,
          source: depth > 0 ? "frame-walk" : "frame-root",
        });
      }

      for (let i = 0; i < win.frames.length; i++) {
        walkWindowFrames(win.frames[i], depth + 1, out, seen);
      }
    } catch (_) {}
  }

  function collectFrameWalkTexts() {
    const out = [];
    const seen = new Set();
    walkWindowFrames(window, 0, out, seen);
    return out.filter(
      (f) =>
        f.depth > 0 ||
        /\d{1,2}\s*[-–]\s*\d{1,2}/.test(f.text) ||
        /\b\d{2,3}:\d{2}\b/.test(f.text)
    );
  }