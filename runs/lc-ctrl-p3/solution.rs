pub fn max_sliding_window(nums: &[i32], k: usize) -> Vec<i32> {
    let n = nums.len();
    if n == 0 || k == 0 || k > n { return vec![]; }
    if k == 1 { return nums.to_vec(); }
    let m = n - k + 1;
    // Small k: max of k shifted slices; branch-free, auto-vectorised.
    if k <= 6 {
        let mut out = nums[..m].to_vec();
        for d in 1..k {
            for (o, &x) in out.iter_mut().zip(&nums[d..d + m]) {
                *o = (*o).max(x);
            }
        }
        return out;
    }
    // van Herk / Gil-Werman: blocks of size k. g[i] = max(nums[i..end of block]).
    let mut g = vec![0i32; n];
    let mut end = n;
    while end > 0 {
        let start = (end - 1) / k * k;
        let mut run = i32::MIN;
        for i in (start..end).rev() {
            run = run.max(nums[i]);
            g[i] = run;
        }
        end = start;
    }
    // out[i] = max(g[i], prefix max of block containing i+k-1 up to i+k-1).
    let mut out = vec![0i32; m];
    let mut bs = 0;
    while bs < n {
        let be = (bs + k).min(n);
        let mut run = i32::MIN;
        for j in bs..be {
            run = run.max(nums[j]);
            if j + 1 >= k {
                let i = j + 1 - k;
                out[i] = g[i].max(run);
            }
        }
        bs = be;
    }
    out
}
