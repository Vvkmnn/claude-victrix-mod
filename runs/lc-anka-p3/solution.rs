// Van Herk / Gil-Werman: split input into blocks of k. For a window starting at
// block offset j, max = max(suffix_max_in_block[j], prefix_max_in_next_block[j-1]).
// Only a k-sized suffix buffer is kept (cache friendly); the prefix is a running value.
pub fn max_sliding_window(nums: &[i32], k: usize) -> Vec<i32> {
    let n = nums.len();
    // Guard: outside the stated contract, return empty instead of panicking.
    if n == 0 || k == 0 || k > n { return vec![]; }
    if k == 1 { return nums.to_vec(); }
    let m = n - k + 1;
    if k <= 24 { return small_k(nums, k); }
    let mut out = vec![0i32; m];
    let mut suf = vec![0i32; k];
    let mut s = 0usize;
    while s < m {
        // block [s, s+k) is fully inside nums since s <= n-k
        let blk = &nums[s..s + k];
        let mut cur = i32::MIN;
        for (d, &x) in suf.iter_mut().zip(blk.iter()).rev() {
            if x > cur { cur = x; }
            *d = cur;
        }
        let cnt = (m - s).min(k);
        let o = &mut out[s..s + cnt];
        // j = 0: window is exactly the block
        o[0] = suf[0];
        if cnt > 1 {
            // next-block elements nums[s+k .. s+k+cnt-1]
            let nxt = &nums[s + k..s + k + cnt - 1];
            let mut p = i32::MIN;
            for ((dst, &sv), &x) in o[1..].iter_mut().zip(suf[1..cnt].iter()).zip(nxt.iter()) {
                if x > p { p = x; }
                *dst = if sv > p { sv } else { p };
            }
        }
        s += k;
    }
    out
}

// Small k: doubling (sparse-table style) passes are branch-free and auto-vectorize.
// After covering width c, cur[i] = max(nums[i..i+c]); finish with two overlapping spans.
fn small_k(nums: &[i32], k: usize) -> Vec<i32> {
    let n = nums.len();
    let m = n - k + 1;
    let mut a = nums.to_vec();
    let mut b = vec![0i32; n];
    let mut c = 1usize;
    let mut len = n; // valid prefix length of a: n - c + 1
    while 2 * c <= k {
        let nl = len - c;
        {
            let (x, y) = (&a[..nl], &a[c..c + nl]);
            for ((d, &p), &q) in b[..nl].iter_mut().zip(x).zip(y) { *d = if p > q { p } else { q }; }
        }
        std::mem::swap(&mut a, &mut b);
        len = nl;
        c *= 2;
    }
    let mut out = vec![0i32; m];
    let off = k - c;
    for ((d, &p), &q) in out.iter_mut().zip(&a[..m]).zip(&a[off..off + m]) { *d = if p > q { p } else { q }; }
    out
}
