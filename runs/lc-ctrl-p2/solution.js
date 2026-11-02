module.exports = function maxArea(height) {
  let i = 0, j = height.length - 1, best = 0;
  while (i < j) {
    const a = height[i], b = height[j];
    if (a < b) {
      const w = (j - i) * a;
      if (w > best) best = w;
      i++;
      while (i < j && height[i] <= a) i++;
    } else {
      const w = (j - i) * b;
      if (w > best) best = w;
      j--;
      while (i < j && height[j] <= b) j--;
    }
  }
  return best;
};
