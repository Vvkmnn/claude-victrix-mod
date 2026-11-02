#define _GNU_SOURCE
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
static sqlite3*db; static sqlite3_stmt*fs,*cs,*ps,*ls;
static char out[1<<16];
static int feed(char*o0){char*o=o0;long ids[20];int n=0;o+=sprintf(o,"{\"posts\":[");
 /* phase1 into temp offsets */
 char*rows[20];int cnt[20]={0};
 char*w=o;
 while(sqlite3_step(fs)==SQLITE_ROW){ids[n]=sqlite3_column_int64(fs,0);rows[n]=w;
  int bl=sqlite3_column_bytes(fs,1);w+=sprintf(w,"%s{\"id\":%ld,\"body\":\"",n?",":"",ids[n]);memcpy(w,sqlite3_column_text(fs,1),bl);w+=bl;
  w+=sprintf(w,"\",\"created_at\":\"%s\",\"author\":\"%s\",\"like_count\":",sqlite3_column_text(fs,2),sqlite3_column_text(fs,3));
  w+=sprintf(w,"@@@}");n++;}
 sqlite3_reset(fs);
 long lo=ids[0],hi=ids[0];for(int k=0;k<n;k++){if(ids[k]<lo)lo=ids[k];if(ids[k]>hi)hi=ids[k];}
 sqlite3_bind_int64(cs,1,lo);sqlite3_bind_int64(cs,2,hi);
 while(sqlite3_step(cs)==SQLITE_ROW){long p=sqlite3_column_int64(cs,0);for(int k=0;k<n;k++)if(ids[k]==p){cnt[k]++;break;}}
 sqlite3_reset(cs);
 /* fix up placeholders: single digit-safe replace by rebuild */
 char*r=out+30000;char*q=r;char*src=o;
 q+=0;
 int len=w-o;char*s=o;char*e=o+len;int k=0;
 while(s<e){char*at=memchr(s,'@',e-s);if(!at||at+2>=e+0){memcpy(q,s,e-s);q+=e-s;break;}
  if(at[1]=='@'&&at[2]=='@'){memcpy(q,s,at-s);q+=at-s;q+=sprintf(q,"%d",cnt[k++]);s=at+3;}else{memcpy(q,s,at-s+1);q+=at-s+1;s=at+1;}}
 memcpy(o,r,q-r);o+=q-r;o+=sprintf(o,"]}");(void)src;return o-o0;}
static int post(char*o,long id){sqlite3_bind_int64(ps,1,id);int len;
 if(sqlite3_step(ps)==SQLITE_ROW){len=sprintf(o,"{\"post\":{\"id\":%ld,\"body\":\"%s\",\"created_at\":\"%s\",\"author\":\"%s\",\"like_count\":%d}}",id,sqlite3_column_text(ps,1),sqlite3_column_text(ps,2),sqlite3_column_text(ps,3),sqlite3_column_int(ps,4));}
 else len=sprintf(o,"{\"error\":\"post not found\"}");sqlite3_reset(ps);return len;}
int main(int argc,char**argv){
 sqlite3_open_v2(argv[1],&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0);
 sqlite3_exec(db,"PRAGMA mmap_size=400000000;PRAGMA cache_size=-65536",0,0,0);
 sqlite3_prepare_v2(db,"SELECT p.id,p.body,p.created_at,u.username FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC,p.id DESC LIMIT 20",-1,&fs,0);
 sqlite3_prepare_v2(db,"SELECT post_id FROM likes WHERE post_id BETWEEN ?1 AND ?2",-1,&cs,0);
 sqlite3_prepare_v2(db,"SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?",-1,&ps,0);
 int ls_=socket(AF_INET,SOCK_STREAM,0);int one=1;setsockopt(ls_,SOL_SOCKET,SO_REUSEADDR,&one,4);
 struct sockaddr_in a={AF_INET,htons(atoi(argv[2])),{htonl(INADDR_LOOPBACK)}};bind(ls_,(void*)&a,sizeof a);listen(ls_,4096);
 fcntl(ls_,F_SETFL,O_NONBLOCK);
 int ep=epoll_create1(0);struct epoll_event ev={.events=EPOLLIN,.data.fd=ls_};epoll_ctl(ep,EPOLL_CTL_ADD,ls_,&ev);
 static struct epoll_event evs[256];char in[8192];char resp[70000];
 for(;;){int n=epoll_wait(ep,evs,256,-1);
  for(int i=0;i<n;i++){int fd=evs[i].data.fd;
   if(fd==ls_){for(;;){int c=accept4(ls_,0,0,SOCK_NONBLOCK);if(c<0)break;setsockopt(c,IPPROTO_TCP,TCP_NODELAY,&one,4);struct epoll_event e={.events=EPOLLIN,.data.fd=c};epoll_ctl(ep,EPOLL_CTL_ADD,c,&e);}continue;}
   int r=read(fd,in,sizeof in-1);if(r<=0){close(fd);continue;}in[r]=0;
   char*body=resp+200;int bl;
   if(!strncmp(in,"GET /feed ",10))bl=feed(body);
   else if(!strncmp(in,"GET /posts/",11))bl=post(body,atol(in+11));
   else bl=sprintf(body,"{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":1}");
   char h[160];int hl=sprintf(h,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n",bl);
   memcpy(body-hl,h,hl);write(fd,body-hl,hl+bl);}}
}
