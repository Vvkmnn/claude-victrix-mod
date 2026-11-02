# usage: gen_driver.sh <solution.rs or ""> <out.rs>
SOL="$1"; OUT="$2"
{ echo '#[path="/home/claude/lc/ref/p3/refs.rs"] mod refs;'
  [ -n "$SOL" ] && echo "#[path=\"$SOL\"] mod sol;"
  cat <<'R'
use std::time::Instant;
fn brute(n:&[i32],k:usize)->Vec<i32>{ if n.is_empty(){return vec![];} (0..=n.len()-k).map(|i|*n[i..i+k].iter().max().unwrap()).collect() }
struct R(u64); impl R{fn n(&mut self)->u64{self.0^=self.0<<13;self.0^=self.0>>7;self.0^=self.0<<17;self.0}}
fn check(f:fn(&[i32],usize)->Vec<i32>)->bool{ let mut r=R(42); for _ in 0..4000{ let n=(r.n()%60) as usize; let v:Vec<i32>=(0..n).map(|_| match r.n()%4 {0=>i32::MIN,1=>i32::MAX,_=> (r.n()%7) as i32 -3}).collect(); if n==0 { if !f(&v,1).is_empty(){return false;} continue;} let k=1+(r.n() as usize)%n; if f(&v,k)!=brute(&v,k){return false;} } true }
fn time(f:fn(&[i32],usize)->Vec<i32>, data:&[Vec<i32>])->f64{ let ks=[1usize,3,100,1000,100000]; let mut best=f64::MAX; for _ in 0..3{ let t=Instant::now(); let mut s=0i64; for d in data{ for &k in &ks{ let o=f(d,k); s+=o[o.len()/2] as i64; } } std::hint::black_box(s); best=best.min(t.elapsed().as_secs_f64()); } best*1000.0 }
fn main(){ let mut r=R(7); let rand:Vec<i32>=(0..10_000_000).map(|_| r.n() as i32).collect(); let desc:Vec<i32>=(0..10_000_000).map(|i| -(i as i32)).collect(); let data=vec![rand,desc];
  let mut rows:Vec<(String,f64)>=vec![];
  for (name,f) in [("heap (lazy delete)",refs::heap as fn(&[i32],usize)->Vec<i32>),("monotonic deque",refs::deque),("van Herk/Gil-Werman blocks",refs::vhgw)] { assert!(check(f)); rows.push((name.into(),time(f,&data))); }
R
  [ -n "$SOL" ] && echo '  { let f=sol::max_sliding_window as fn(&[i32],usize)->Vec<i32>; let ok=check(f); rows.push(("SOLUTION".into(), if ok {time(f,&data)} else {f64::INFINITY})); if !ok {println!("SOLUTION WRONG");} }'
  cat <<'R'
  rows.sort_by(|a,b|a.1.partial_cmp(&b.1).unwrap()); for (n,t) in rows { println!("{:10.1} ms  {}", t, n); } }
R
} > "$OUT"
