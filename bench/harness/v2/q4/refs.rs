pub fn std_sort(v:&mut Vec<u32>){v.sort();}
pub fn unstable(v:&mut Vec<u32>){v.sort_unstable();}
pub fn radix(v:&mut Vec<u32>){ let n=v.len(); if n<2{return;} let mut b=vec![0u32;n]; for sh in [0u32,16]{ let mut c=vec![0usize;65537]; for &x in v.iter(){c[((x>>sh)&0xFFFF) as usize+1]+=1;} for i in 0..65536{c[i+1]+=c[i];} for &x in v.iter(){let k=((x>>sh)&0xFFFF) as usize; b[c[k]]=x; c[k]+=1;} std::mem::swap(v,&mut b);} }
pub fn counting(v:&mut Vec<u32>){ let mx=*v.iter().max().unwrap_or(&0); if v.len()<4096 || mx as usize>4*v.len(){ v.sort_unstable(); return;} let mut c=vec![0u32;mx as usize+1]; for &x in v.iter(){c[x as usize]+=1;} let mut i=0; for (val,&k) in c.iter().enumerate(){ for _ in 0..k{v[i]=val as u32; i+=1;} } }
