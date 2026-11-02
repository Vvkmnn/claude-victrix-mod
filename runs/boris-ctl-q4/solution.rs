use std::thread;

const SMALL: usize = 256;
const PAR_MIN: usize = 1 << 18;
const MAX_RANGE: usize = 1 << 22;

fn threads_for(n: usize) -> usize {
    if n < PAR_MIN {
        return 1;
    }
    thread::available_parallelism().map(|x| x.get()).unwrap_or(1).min(8).max(1)
}

fn min_max(s: &[u32]) -> (u32, u32) {
    let mut mn = [u32::MAX; 8];
    let mut mx = [0u32; 8];
    let mut ch = s.chunks_exact(8);
    for c in &mut ch {
        for i in 0..8 {
            mn[i] = mn[i].min(c[i]);
            mx[i] = mx[i].max(c[i]);
        }
    }
    let mut a = *mn.iter().min().unwrap();
    let mut b = *mx.iter().max().unwrap();
    for &x in ch.remainder() {
        a = a.min(x);
        b = b.max(x);
    }
    (a, b)
}

fn par_min_max(v: &[u32], t: usize) -> (u32, u32) {
    if t <= 1 {
        return min_max(v);
    }
    let cs = (v.len() + t - 1) / t;
    thread::scope(|sc| {
        let hs: Vec<_> = v.chunks(cs).map(|c| sc.spawn(move || min_max(c))).collect();
        hs.into_iter().map(|h| h.join().unwrap()).fold((u32::MAX, 0), |a, b| (a.0.min(b.0), a.1.max(b.1)))
    })
}

fn hist(s: &[u32], base: u32, range: usize) -> Vec<u32> {
    // 2 interleaved histograms to reduce store-to-load stalls on repeated values
    let mut h0 = vec![0u32; range];
    let mut h1 = vec![0u32; range];
    let mut ch = s.chunks_exact(2);
    for c in &mut ch {
        h0[(c[0] - base) as usize] += 1;
        h1[(c[1] - base) as usize] += 1;
    }
    for &x in ch.remainder() {
        h0[(x - base) as usize] += 1;
    }
    for (a, b) in h0.iter_mut().zip(h1.iter()) {
        *a += *b;
    }
    h0
}

// Speculative histogram for values < 65536: no min/max pass needed.
// Returns None (and the caller falls back) if any value is >= 65536.
fn hist16(s: &[u32]) -> Option<Vec<u32>> {
    let mut h0 = vec![0u32; 1 << 16];
    let mut h1 = vec![0u32; 1 << 16];
    let mut orr = 0u32;
    let mut ch = s.chunks_exact(2);
    for c in &mut ch {
        orr |= c[0] | c[1];
        h0[(c[0] & 0xFFFF) as usize] += 1;
        h1[(c[1] & 0xFFFF) as usize] += 1;
    }
    for &x in ch.remainder() {
        orr |= x;
        h0[(x & 0xFFFF) as usize] += 1;
    }
    if orr >> 16 != 0 {
        return None;
    }
    for (a, b) in h0.iter_mut().zip(h1.iter()) {
        *a += *b;
    }
    Some(h0)
}

fn spec_counting(v: &mut [u32], t: usize) -> bool {
    let n = v.len();
    let counts = if t <= 1 {
        match hist16(v) {
            Some(c) => c,
            None => return false,
        }
    } else {
        let cs = (n + t - 1) / t;
        let parts: Vec<Option<Vec<u32>>> = thread::scope(|sc| {
            let hs: Vec<_> = v.chunks(cs).map(|c| sc.spawn(move || hist16(c))).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let mut acc = vec![0u32; 1 << 16];
        for p in parts {
            match p {
                Some(p) => {
                    for (a, b) in acc.iter_mut().zip(p.iter()) {
                        *a += *b;
                    }
                }
                None => return false,
            }
        }
        acc
    };
    fill_all(v, counts, 0, 1 << 16, t);
    true
}

fn counting_sort(v: &mut [u32], base: u32, range: usize, t: usize) {
    let n = v.len();
    let counts = if t <= 1 {
        hist(v, base, range)
    } else {
        let cs = (n + t - 1) / t;
        let parts: Vec<Vec<u32>> = thread::scope(|sc| {
            let hs: Vec<_> = v.chunks(cs).map(|c| sc.spawn(move || hist(c, base, range))).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let mut it = parts.into_iter();
        let mut acc = it.next().unwrap();
        for p in it {
            for (a, b) in acc.iter_mut().zip(p.iter()) {
                *a += *b;
            }
        }
        acc
    };
    fill_all(v, counts, base, range, t);
}

fn fill_all(v: &mut [u32], mut counts: Vec<u32>, base: u32, range: usize, t: usize) {
    let n = v.len();
    // split buckets into t groups of roughly equal element counts
    let mut bounds = vec![(0usize, 0usize)]; // (bucket start, element start)
    let target = (n + t - 1) / t;
    let mut acc = 0usize;
    for (i, &c) in counts.iter().enumerate() {
        if acc >= target * bounds.len() && bounds.len() < t {
            bounds.push((i, acc));
        }
        acc += c as usize;
    }
    bounds.push((range, n));
    let counts = &mut counts;
    let mut rest: &mut [u32] = v;
    thread::scope(|sc| {
        let mut jobs = Vec::new();
        for w in bounds.windows(2) {
            let (b0, e0) = w[0];
            let (b1, e1) = w[1];
            let (cur, r) = rest.split_at_mut(e1 - e0);
            rest = r;
            jobs.push((cur, b0, b1));
        }
        let counts: &[u32] = counts;
        let mut it = jobs.into_iter();
        let first = it.next().unwrap();
        let hs: Vec<_> = it.map(|(cur, b0, b1)| sc.spawn(move || fill(cur, counts, b0, b1, base))).collect();
        fill(first.0, counts, first.1, first.2, base);
        for h in hs {
            h.join().unwrap();
        }
    });
}

fn fill(out: &mut [u32], counts: &[u32], b0: usize, b1: usize, base: u32) {
    let mut p = 0usize;
    for b in b0..b1 {
        let c = counts[b] as usize;
        if c != 0 {
            out[p..p + c].fill(base + b as u32);
            p += c;
        }
    }
}

fn radix_sort(v: &mut Vec<u32>) {
    let n = v.len();
    const B: usize = 11;
    const M: usize = (1 << B) - 1;
    let mut h = [[0u32; 1 << B]; 3];
    for &x in v.iter() {
        h[0][x as usize & M] += 1;
        h[1][(x >> B) as usize & M] += 1;
        h[2][(x >> (2 * B)) as usize] += 1;
    }
    let mut buf = vec![0u32; n];
    let mut src_is_v = true;
    for p in 0..3 {
        let shift = p * B;
        if h[p].iter().any(|&c| c as usize == n) {
            continue;
        }
        let mut off = [0usize; 1 << B];
        let mut s = 0usize;
        for i in 0..(1 << B) {
            off[i] = s;
            s += h[p][i] as usize;
        }
        let (src, dst): (&[u32], &mut [u32]) = if src_is_v { (&v[..], &mut buf[..]) } else { (&buf[..], &mut v[..]) };
        for &x in src {
            let b = (x >> shift) as usize & M;
            dst[off[b]] = x;
            off[b] += 1;
        }
        src_is_v = !src_is_v;
    }
    if !src_is_v {
        v.copy_from_slice(&buf);
    }
}

pub fn sort_values(v: &mut Vec<u32>) {
    let n = v.len();
    if n < SMALL {
        v.sort_unstable();
        return;
    }
    let t = threads_for(n);
    if v[0] < 65536 && spec_counting(v, t) {
        return;
    }
    let (mn, mx) = par_min_max(v, t);
    let range = (mx - mn) as usize + 1;
    if range == 1 {
        return;
    }
    if range <= MAX_RANGE && range <= 2 * n {
        counting_sort(v, mn, range, t);
    } else {
        radix_sort(v);
    }
}
