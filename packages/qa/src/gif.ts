/**
 * The replay GIF is encoded inside the QA browser (its canvas decodes and scales the JPEGs), so the
 * Worker does no image work. Both are plain-JS strings on purpose: a bundler that keeps function
 * names (wrangler's esbuild) would inject helpers into a stringified function that don't exist in
 * the page.
 *
 * Encoder: a fixed 6×7×6 colour cube (+ 4 greys) as the global palette, no dithering (UI
 * screenshots), LZW with variable code size as in GIF89a, looping forever.
 */

/** `gifEncode(frames: {rgba: Uint8ClampedArray}[], w, h, delayCs) → Uint8Array`. */
export const GIF_ENCODER_SOURCE = String.raw`
function gifEncode(frames, w, h, delayCs) {
  var out = [];
  function b(x) { out.push(x & 255); }
  function u16(x) { b(x); b(x >> 8); }
  function str(s) { for (var i = 0; i < s.length; i++) b(s.charCodeAt(i)); }
  var R = [0, 51, 102, 153, 204, 255], G = [0, 42, 85, 128, 170, 213, 255];
  str("GIF89a"); u16(w); u16(h); b(0xf7); b(0); b(0);
  for (var r = 0; r < 6; r++) for (var g = 0; g < 7; g++) for (var bl = 0; bl < 6; bl++) { b(R[r]); b(G[g]); b(R[bl]); }
  var greys = [32, 96, 160, 224];
  for (var k = 0; k < 4; k++) { b(greys[k]); b(greys[k]); b(greys[k]); }
  b(0x21); b(0xff); b(11); str("NETSCAPE2.0"); b(3); b(1); u16(0); b(0);
  for (var f = 0; f < frames.length; f++) {
    var px = frames[f].rgba, n = w * h, idx = new Uint8Array(n);
    for (var p = 0; p < n; p++) {
      var o = p * 4;
      idx[p] = Math.round(px[o] / 51) * 42 + Math.round(px[o + 1] / 42.5) * 6 + Math.round(px[o + 2] / 51);
    }
    b(0x21); b(0xf9); b(4); b(0); u16(delayCs); b(0); b(0);
    b(0x2c); u16(0); u16(0); u16(w); u16(h); b(0);
    b(8);
    var data = lzw(idx, 8);
    for (var s = 0; s < data.length; s += 255) {
      var len = Math.min(255, data.length - s); b(len);
      for (var t = 0; t < len; t++) out.push(data[s + t]);
    }
    b(0);
  }
  b(0x3b);
  return new Uint8Array(out);
}
function lzw(index, minCodeSize) {
  var clear = 1 << minCodeSize, eoi = clear + 1, next = eoi + 1, size = minCodeSize + 1;
  var table = new Map(), bytes = [], cur = 0, bits = 0;
  function emit(code) { cur |= code << bits; bits += size; while (bits >= 8) { bytes.push(cur & 255); cur >>>= 8; bits -= 8; } }
  emit(clear);
  var prefix = index[0];
  for (var i = 1; i < index.length; i++) {
    var k = index[i], key = (prefix << 8) | k, hit = table.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next === 4096) { emit(clear); next = eoi + 1; size = minCodeSize + 1; table = new Map(); }
    else { if (next >= (1 << size)) size++; table.set(key, next++); }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (bits > 0) bytes.push(cur & 255);
  return bytes;
}`;

/**
 * Evaluated as `(<this>)(framesBase64, width, delayMs)` in a blank page: decodes the JPEGs, draws
 * them scaled to `width`, encodes, and resolves to the GIF as base64.
 */
export const REPLAY_PAGE_SCRIPT = String.raw`async function (frames, width, delayMs) {
  ${GIF_ENCODER_SOURCE}
  var imgs = [];
  for (var i = 0; i < frames.length; i++) {
    var img = new Image(); img.src = "data:image/jpeg;base64," + frames[i]; await img.decode(); imgs.push(img);
  }
  // Frames can differ in size (screenshots are cropped to content): each is drawn top-left,
  // scaled to fit a 16:10 canvas, on white.
  var w = width, h = Math.round(width * 10 / 16);
  var canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  var c2d = canvas.getContext("2d", { willReadFrequently: true });
  var out = [];
  for (var j = 0; j < imgs.length; j++) {
    var k = Math.min(w / imgs[j].naturalWidth, h / imgs[j].naturalHeight);
    c2d.fillStyle = "#fff"; c2d.fillRect(0, 0, w, h);
    c2d.drawImage(imgs[j], 0, 0, Math.round(imgs[j].naturalWidth * k), Math.round(imgs[j].naturalHeight * k));
    out.push({ rgba: c2d.getImageData(0, 0, w, h).data });
  }
  var gif = gifEncode(out, w, h, Math.max(2, Math.round(delayMs / 10)));
  var s = ""; for (var q = 0; q < gif.length; q += 0x8000) s += String.fromCharCode.apply(null, gif.subarray(q, q + 0x8000));
  return btoa(s);
}`;
