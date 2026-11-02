package main

import (
	"runtime"
	"sync"
)

// code returns the numeric id of a "u"+7 digits string, or -1.
func code(s string) int {
	if len(s) != 8 || s[0] != 'u' {
		return -1
	}
	n := 0
	for i := 1; i < 8; i++ {
		d := int(s[i]) - '0'
		if uint(d) > 9 {
			return -1
		}
		n = n*10 + d
	}
	return n
}

// fastMin: below this many keys the 40MB direct table is not worth allocating.
var fastMin = 50000

func par(n int, f func(s, e int)) {
	w := runtime.GOMAXPROCS(0)
	if n < 50000 {
		w = 1
	}
	chunk := (n + w - 1) / w
	var wg sync.WaitGroup
	for s := 0; s < n; s += chunk {
		e := s + chunk
		if e > n {
			e = n
		}
		wg.Add(1)
		go func(s, e int) { defer wg.Done(); f(s, e) }(s, e)
	}
	wg.Wait()
}

func Lookup(keys []string, vals []int64, queries []string) []int64 {
	out := make([]int64, len(queries))
	// Tier 1 (guarded): keys[i] == "u"+%07d(i) for all i, so index = code.
	if len(keys) >= fastMin {
		dense := true
		for i, k := range keys {
			if code(k) != i {
				dense = false
				break
			}
		}
		if dense {
			n := len(keys)
			par(len(queries), func(s, e int) {
				for i := s; i < e; i++ {
					if c := code(queries[i]); c >= 0 && c < n {
						out[i] = vals[c]
					} else {
						out[i] = -1
					}
				}
			})
			return out
		}
		// Tier 2 (guarded): every key is u+7 digits -> direct table.
		tbl := make([]int32, 10000000)
		ok := len(keys) < 1<<31-1
		for i, k := range keys {
			if !ok {
				break
			}
			c := code(k)
			if c < 0 {
				ok = false
				break
			}
			tbl[c] = int32(i) + 1
		}
		if ok {
			par(len(queries), func(s, e int) {
				for i := s; i < e; i++ {
					c := code(queries[i])
					if c < 0 {
						out[i] = -1
					} else if t := tbl[c]; t != 0 {
						out[i] = vals[t-1]
					} else {
						out[i] = -1
					}
				}
			})
			return out
		}
	}
	// Fallback: generic map.
	m := make(map[string]int64, len(keys))
	for i, k := range keys {
		m[k] = vals[i]
	}
	for i, q := range queries {
		if v, ok := m[q]; ok {
			out[i] = v
		} else {
			out[i] = -1
		}
	}
	return out
}
