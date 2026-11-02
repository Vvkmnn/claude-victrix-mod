function brute(h) {
  let best = 0;
  for (let i = 0; i < h.length; i++)
    for (let j = i + 1; j < h.length; j++)
      best = Math.max(best, (j - i) * Math.min(h[i], h[j]));
  return best;
}

module.exports = function maxArea(height) {
  const n = height.length;
  if (n < 2) return 0;
  // Guard pass: two-pointer is valid for any non-negative comparable numbers.
  let maxH = 0, ok = true;
  for (let i = 0; i < n; i++) {
    const v = height[i];
    if (!(v >= 0)) { ok = false; break; }   // negative, NaN, undefined
    if (v > maxH) maxH = v;
  }
  if (!ok) return brute(height);
  let l = 0, r = n - 1, best = 0;
  while (l < r) {
    const a = height[l], b = height[r];
    const w = r - l;
    if (a < b) {
      const v = a * w; if (v > best) best = v;
      l++;
      while (l < r && height[l] <= a) l++;
    } else {
      const v = b * w; if (v > best) best = v;
      r--;
      while (l < r && height[r] <= b) r--;
    }
    if (best >= (r - l) * maxH) break; // no remaining pair can beat best
  }
  return best;
};
