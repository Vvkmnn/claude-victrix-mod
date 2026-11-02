package main

import (
	"math/bits"
	"runtime"
	"sync"
	"sync/atomic"
)

// Lookup returns, for each query, the balance of the matching key or -1.
//
// Fast path (all keys exactly 8 bytes, as in the production data): each key is
// packed into a uint64 and stored in an open-addressing table split into
// independent power-of-two partitions (so the build can run in parallel with no
// locking). A slot stores key and val+1 (as uint64, no overflow for any int64
// >= 0); a stored value of 0 marks an empty slot, so a miss decodes to -1.
// Queries whose length is not 8 cannot match any key and yield -1.
// Anything else falls back to a plain Go map (still with parallel queries).
func Lookup(keys []string, vals []int64, queries []string) []int64 {
	out := make([]int64, len(queries))
	if len(keys) == 0 {
		for i := range out {
			out[i] = -1
		}
		return out
	}
	for _, k := range keys {
		if len(k) != 8 {
			return lookupGeneric(keys, vals, queries, out)
		}
	}
	return lookupPacked(keys, vals, queries, out)
}

func pack8(s string) uint64 {
	_ = s[7]
	return uint64(s[0]) | uint64(s[1])<<8 | uint64(s[2])<<16 | uint64(s[3])<<24 |
		uint64(s[4])<<32 | uint64(s[5])<<40 | uint64(s[6])<<48 | uint64(s[7])<<56
}

func mix(k uint64) uint64 {
	k ^= k >> 29
	k *= 0xbf58476d1ce4e5b9
	k ^= k >> 32
	k *= 0x94d049bb133111eb
	k ^= k >> 31
	return k
}

var sinkG atomic.Uint64

type slot struct {
	key uint64
	v   uint64 // value+1; 0 = empty
}

const SIZEMUL, SIZEDIV = 8, 5

func workers(n int) int {
	w := runtime.GOMAXPROCS(0)
	if w > 8 {
		w = 8
	}
	if n < 1<<15 {
		w = 1
	}
	if w < 1 {
		w = 1
	}
	return w
}

func lookupPacked(keys []string, vals []int64, queries []string, out []int64) []int64 {
	n := len(keys)
	// partitions: power of two
	parts := 1
	if w := workers(n); w >= 2 {
		parts = 2
		for parts*2 <= w {
			parts *= 2
		}
	}
	pbits := 0
	for 1<<pbits < parts {
		pbits++
	}
	// per-partition size: power of two >= 2*n/parts (load <= 0.5 on average), with slack
	per := (n*SIZEMUL)/(SIZEDIV*parts) + 16
	tab := make([]slot, per*parts)

	build := func(p int) {
		t := tab[p*per : (p+1)*per]
		for i, ks := range keys {
			k := pack8(ks)
			h := mix(k)
			if pbits > 0 && int(h>>(64-uint(pbits))) != p {
				continue
			}
			j, _ := bits.Mul64(h<<pbits, uint64(per))
			for {
				s := &t[j]
				if s.v == 0 {
					s.key = k
					s.v = uint64(vals[i]) + 1
					break
				}
				if s.key == k {
					s.v = uint64(vals[i]) + 1
					break
				}
				j++
				if int(j) == per {
					j = 0
				}
			}
		}
	}
	if parts == 1 {
		build(0)
	} else {
		var wg sync.WaitGroup
		for p := 0; p < parts; p++ {
			wg.Add(1)
			go func(p int) { defer wg.Done(); build(p) }(p)
		}
		wg.Wait()
	}

	shift := uint(64 - pbits)
	query := func(lo, hi int) {
		const B = 16
		var ks [B]uint64
		var js [B]uint64
		var bs [B]int
		var ok [B]bool
		var sink uint64
		for i := lo; i < hi; i += B {
			m := hi - i
			if m > B {
				m = B
			}
			// stage 1: hash and touch the home slot of every query in the block
			// so the cache misses overlap.
			for x := 0; x < m; x++ {
				q := queries[i+x]
				if len(q) != 8 {
					ok[x] = false
					continue
				}
				k := pack8(q)
				h := mix(k)
				base := 0
				if pbits > 0 {
					base = int(h>>shift) * per
				}
				j, _ := bits.Mul64(h<<pbits, uint64(per))
				ks[x], js[x], bs[x], ok[x] = k, j, base, true
				sink += tab[base+int(j)].key
			}
			// stage 2: resolve.
			for x := 0; x < m; x++ {
				if !ok[x] {
					out[i+x] = -1
					continue
				}
				k := ks[x]
				t := tab[bs[x] : bs[x]+per]
				j := js[x]
				for {
					s := &t[j]
					if s.key == k && s.v != 0 {
						out[i+x] = int64(s.v - 1)
						break
					}
					if s.v == 0 {
						out[i+x] = -1
						break
					}
					j++
					if int(j) == per {
						j = 0
					}
				}
			}
		}
		sinkG.Store(sink)
	}
	runParallel(len(queries), query)
	return out
}

func runParallel(n int, f func(lo, hi int)) {
	w := workers(n)
	if w == 1 {
		f(0, n)
		return
	}
	var wg sync.WaitGroup
	chunk := (n + w - 1) / w
	for lo := 0; lo < n; lo += chunk {
		hi := lo + chunk
		if hi > n {
			hi = n
		}
		wg.Add(1)
		go func(lo, hi int) { defer wg.Done(); f(lo, hi) }(lo, hi)
	}
	wg.Wait()
}

func lookupGeneric(keys []string, vals []int64, queries []string, out []int64) []int64 {
	m := make(map[string]int64, len(keys))
	for i, k := range keys {
		m[k] = vals[i]
	}
	runParallel(len(queries), func(lo, hi int) {
		for i := lo; i < hi; i++ {
			if v, ok := m[queries[i]]; ok {
				out[i] = v
			} else {
				out[i] = -1
			}
		}
	})
	return out
}
