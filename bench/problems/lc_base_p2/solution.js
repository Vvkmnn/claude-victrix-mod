module.exports = function maxArea(height) {
  let best = 0;
  for (let i = 0; i < height.length; i++)
    for (let j = i + 1; j < height.length; j++)
      best = Math.max(best, (j - i) * Math.min(height[i], height[j]));
  return best;
};
