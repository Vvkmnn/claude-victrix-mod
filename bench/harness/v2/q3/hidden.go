package main

import ("bufio";"fmt";"math/rand";"os";"sort";"strconv";"strings";"time")

func ref(keys []string, vals []int64, q []string) []int64 { m := make(map[string]int64, len(keys)); for i,k := range keys { m[k]=vals[i] }; o := make([]int64,len(q)); for i,s := range q { if v,ok := m[s]; ok { o[i]=v } else { o[i]=-1 } }; return o }
func dense(keys []string, vals []int64, q []string) []int64 { n:=len(keys); ok:=true; for i,k := range keys { if len(k)!=8||k[0]!='u' { ok=false; break }; x:=0; for j:=1;j<8;j++ { c:=k[j]; if c<'0'||c>'9' { ok=false; break }; x=x*10+int(c-'0') }; if !ok||x!=i { ok=false; break } }
 if !ok { return ref(keys,vals,q) }; o:=make([]int64,len(q)); for i,s := range q { o[i]=-1; if len(s)!=8||s[0]!='u' { continue }; x:=0; good:=true; for j:=1;j<8;j++ { c:=s[j]; if c<'0'||c>'9' { good=false; break }; x=x*10+int(c-'0') }; if good && x<n { o[i]=vals[x] } }; return o }
func eq(a,b []int64) bool { if len(a)!=len(b) {return false}; for i:=range a { if a[i]!=b[i] {return false} }; return true }
func check(f func([]string,[]int64,[]string)[]int64) bool { r:=rand.New(rand.NewSource(3))
 odd := []string{"u0000001x","u+000001","u-000001","U0000001","u٠٠٠٠٠٠1","u000001","u00000001","","u0000000","u9999999","u0000002"}
 for t:=0;t<400;t++ { n:=r.Intn(3000); keys:=make([]string,0,n); seen:=map[string]bool{}
  for len(keys)<n { var k string; switch t%5 { case 0: k=fmt.Sprintf("u%07d",len(keys)); case 1: k=fmt.Sprintf("u%07d",r.Intn(9999999)); case 2: k=fmt.Sprintf("u%07d",len(keys)); if r.Intn(50)==0 { k=odd[r.Intn(len(odd))] }; case 3: k=strconv.Itoa(r.Intn(1e6)); default: k=fmt.Sprintf("u%07d",len(keys)*3) }; if !seen[k] { seen[k]=true; keys=append(keys,k) } }
  if t%7==0 { sort.Slice(keys, func(i,j int) bool { return r.Intn(2)==0 }) }
  vals:=make([]int64,len(keys)); for i:=range vals { vals[i]=r.Int63n(1e12) }
  q:=make([]string,0); for i:=0;i<500;i++ { if len(keys)>0 && r.Intn(2)==0 { q=append(q,keys[r.Intn(len(keys))]) } else if r.Intn(2)==0 { q=append(q,odd[r.Intn(len(odd))]) } else { q=append(q,fmt.Sprintf("u%07d",r.Intn(10000))) } }
  if !eq(f(keys,vals,q),ref(keys,vals,q)) { fmt.Println("mismatch on case",t); return false } }
 big:=make([]string,200000); bv:=make([]int64,200000); for i:=range big { big[i]=fmt.Sprintf("u%07d",i); bv[i]=int64(i) }; big[123456]="u0123456 "; bq:=[]string{"u0123456","u0123456 ","u0199999","u0200000"}
 return eq(f(big,bv,bq),ref(big,bv,bq)) }
func load() ([]string,[]int64,[]string) { var k []string; var v []int64; f,_:=os.Open("/home/claude/v2/base/q3/data/accounts.tsv"); s:=bufio.NewScanner(f); for s.Scan() { p:=strings.SplitN(s.Text(),"\t",2); k=append(k,p[0]); x,_:=strconv.ParseInt(p[1],10,64); v=append(v,x) }; var q []string; g,_:=os.Open("/home/claude/v2/base/q3/data/queries.txt"); s=bufio.NewScanner(g); for s.Scan() { q=append(q,s.Text()) }; return k,v,q }
func tm(f func([]string,[]int64,[]string)[]int64, k []string, v []int64, q []string) float64 { best:=1e18; for i:=0;i<5;i++ { t:=time.Now(); f(k,v,q); d:=float64(time.Since(t).Microseconds())/1000; if d<best {best=d} }; return best }
func main() { k,v,q:=load(); if !check(dense) { fmt.Println("REF BROKEN"); return }
 fmt.Printf("%9.1f ms  ref: map[string]\n%9.1f ms  ref: dense decode + guard\n", tm(ref,k,v,q), tm(dense,k,v,q))
 if check(Lookup) { fmt.Printf("%9.1f ms  SOLUTION\n", tm(Lookup,k,v,q)) } else { fmt.Println("SOLUTION WRONG") } }
