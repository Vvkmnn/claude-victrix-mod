#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
long long ref_scan(const char*,size_t); long long ref_fixed(const char*,size_t); long long sum_qty_price(const char*,size_t);
static double now(void){struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec*1e3+t.tv_nsec/1e6;}
typedef long long (*F)(const char*,size_t);
static int check(F f){ const char *c[]={ "id,name,qty,price\n",
 "id,name,qty,price\n1,a,2,3\n", "id,name,qty,price\n1,a,2,3", "id,name,qty,price\n1,,999999999,999999999\n",
 "id,name,qty,price\n00000001,abcdefghij,000890,029512\n7,hello world,12,5\n00000002,abcdefghij,000001,000002",
 "id,name,qty,price\n00000001,abcdefghi,0000890,029512\n", "id,name,qty,price\n00000001,abcdefghij,000890,02951\n12,x,0,0\n",
 "id,name,qty,price\n1,x y z,10,10\n2,abcdefghijklmnopqrstuvwxyz,000123,000004\n"};
 long long w[]={0,6,6,999999998000000001LL, 890LL*29512+60+2, 890LL*29512, 890LL*2951, 100+492};
 for(int i=0;i<8;i++){ long long g=f(c[i],strlen(c[i])); if(g!=w[i]){ fprintf(stderr,"case %d got %lld want %lld\n",i,g,w[i]); return 0;} } return 1; }
static double tm(F f,const char*b,size_t n){ double best=1e18; for(int i=0;i<7;i++){ double a=now(); volatile long long r=f(b,n); (void)r; double d=now()-a; if(d<best)best=d;} return best; }
int main(void){ FILE*fp=fopen("/home/claude/v2/base/q5/data/orders.csv","rb"); fseek(fp,0,SEEK_END); long n=ftell(fp); rewind(fp); char*b=malloc(n); fread(b,1,n,fp);
 if(!check(ref_scan)||!check(ref_fixed)) {puts("REF BROKEN"); return 1;}
 printf("%9.1f ms  ref: generic hand scan\n%9.1f ms  ref: fixed-offset fast path + guard\n", tm(ref_scan,b,n), tm(ref_fixed,b,n));
 int ok=check(sum_qty_price); if(!ok) puts("SOLUTION WRONG"); else printf("%9.1f ms  SOLUTION (sum=%lld)\n", tm(sum_qty_price,b,n), sum_qty_price(b,n)); return 0; }
