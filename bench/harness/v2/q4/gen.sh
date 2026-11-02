SOL="$1"; OUT="$2"
{ echo '#[path="/home/claude/v2/ref/q4/refs.rs"] mod refs;'; [ -n "$SOL" ] && echo "#[path=\"$SOL\"] mod sol;"
cat <<'R'
use std::time::Instant;
struct R(u64); impl R{fn n(&mut self)->u64{self.0^=self.0<<13;self.0^=self.0>>7;self.0^=self.0<<17;self.0}}
fn check(f:fn(&mut Vec<u32>))->bool{ let mut r=R(99);
  let mut cases:Vec<Vec<u32>>=vec![vec![],vec![5],vec![u32::MAX,0,u32::MAX,1],vec![7;10000]];
  for &n in &[10usize,4095,4096,5000,100000,2000000]{ for mode in 0..4 { cases.push((0..n).map(|i| match mode {0=>r.n() as u32, 1=>(r.n()%60000) as u32, 2=>(n-i) as u32, _=> if i%1000==0 {u32::MAX} else {(r.n()%100) as u32}}).collect()); } }
  for c in cases { let mut a=c.clone(); let mut b=c.clone(); f(&mut a); b.sort(); if a!=b {return false;} } true }
fn time(f:fn(&mut Vec<u32>), data:&Vec<u32>)->f64{ let mut best=f64::MAX; for _ in 0..5{ let mut v=data.clone(); let t=Instant::now(); f(&mut v); best=best.min(t.elapsed().as_secs_f64()); std::hint::black_box(&v);} best*1000.0 }
fn main(){ let bytes=std::fs::read("/home/claude/v2/base/q4/data/readings.u32le").unwrap(); let data:Vec<u32>=bytes.chunks(4).map(|c|u32::from_le_bytes([c[0],c[1],c[2],c[3]])).collect();
 let mut rows:Vec<(String,f64)>=vec![];
 for (n,f) in [("std sort",refs::std_sort as fn(&mut Vec<u32>)),("sort_unstable",refs::unstable),("LSD radix 2x16",refs::radix),("counting sort + guard",refs::counting)] { assert!(check(f),"{}",n); rows.push((n.into(),time(f,&data))); }
R
[ -n "$SOL" ] && echo '{ let f=sol::sort_values as fn(&mut Vec<u32>); let ok=check(f); if !ok {println!("SOLUTION WRONG");} rows.push(("SOLUTION".into(), if ok {time(f,&data)} else {f64::INFINITY})); }'
echo ' rows.sort_by(|a,b|a.1.partial_cmp(&b.1).unwrap()); for (n,t) in rows { println!("{:9.1} ms  {}", t, n);} }'
} > "$OUT"
