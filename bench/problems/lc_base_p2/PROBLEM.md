# Container With Most Water (medium) — JavaScript (Node 22)

You get an array `height` of n non-negative integers. Pick two indices i < j; the water they hold is
(j - i) * min(height[i], height[j]). Return the maximum water over all pairs (0 if n < 2).

Signature (in solution.js): module.exports = function maxArea(height) { ... }  // height is a plain Array of numbers
Constraints: 0 <= n <= 1_000_000, 0 <= height[i] <= 10_000.
Example: maxArea([1,8,6,2,5,4,8,3,7]) === 49.

Goal: your solution is ranked on a leaderboard by wall-clock time on large random inputs (n = 1,000,000), after passing hidden correctness tests. Make it as fast as you can while staying correct.
Run the visible tests with: node test_visible.js
