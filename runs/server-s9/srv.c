// prototype: single-thread epoll, GET /feed + GET /posts/:id only, HMAC verify on none (measure IO+SQL layers)
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
static sqlite3*db; static sqlite3_stmt*sf,*sp; static int MODE;
static int emit(sqlite3_stmt*s,char*p){int n=0;
 while(sqlite3_step(s)==SQLITE_ROW) n+=sprintf(p+n,"{\"id\":%lld,\"body\":\"%s\",\"created_at\":\"%s\",\"author\":\"%s\",\"like_count\":%lld},",
  sqlite3_column_int64(s,0),sqlite3_column_text(s,1),sqlite3_column_text(s,2),sqlite3_column_text(s,3),sqlite3_column_int64(s,4));
 sqlite3_reset(s);return n;}
int main(int c,char**v){
 MODE=atoi(v[2]); // 0 = no sql (static body), 1 = sql
 sqlite3_open_v2(v[1],&db,SQLITE_OPEN_READONLY|SQLITE_OPEN_NOMUTEX,0);
 sqlite3_exec(db,"pragma mmap_size=1073741824;",0,0,0);
 const char*B="SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id ";
 char q[600];sprintf(q,"%sORDER BY p.created_at DESC,p.id DESC LIMIT 20",B);sqlite3_prepare_v2(db,q,-1,&sf,0);
 sprintf(q,"%sWHERE p.id=?",B);sqlite3_prepare_v2(db,q,-1,&sp,0);
 int l=socket(AF_INET,SOCK_STREAM,0);int one=1;setsockopt(l,SOL_SOCKET,SO_REUSEADDR,&one,4);
 struct sockaddr_in a={AF_INET,htons(3999),{htonl(0x7f000001)}};bind(l,(void*)&a,sizeof a);listen(l,4096);fcntl(l,F_SETFL,O_NONBLOCK);
 int ep=epoll_create1(0);struct epoll_event e={EPOLLIN,{.fd=l}};epoll_ctl(ep,EPOLL_CTL_ADD,l,&e);
 static char rb[8192],obb[16640],*ob=obb+256,hd[256];struct epoll_event ev[256];
 for(;;){int n=epoll_wait(ep,ev,256,-1);
  for(int i=0;i<n;i++){int fd=ev[i].data.fd;
   if(fd==l){for(;;){int f=accept4(l,0,0,SOCK_NONBLOCK);if(f<0)break;setsockopt(f,IPPROTO_TCP,TCP_NODELAY,&one,4);struct epoll_event x={EPOLLIN,{.fd=f}};epoll_ctl(ep,EPOLL_CTL_ADD,f,&x);}continue;}
   int r=read(fd,rb,sizeof rb-1);if(r<=0){close(fd);continue;}rb[r]=0;
   int bl;
   if(MODE==0){bl=sprintf(ob,"{\"posts\":[%*s]}",3000,"x");}
   else if(!strncmp(rb,"GET /feed",9)){bl=sprintf(ob,"{\"posts\":[");bl+=emit(sf,ob+bl);ob[bl-1]=']';ob[bl++]='}';}
   else {long id=atol(rb+11);sqlite3_bind_int64(sp,1,id);bl=sprintf(ob,"{\"post\":");bl+=emit(sp,ob+bl);bl--;ob[bl++]='}';}
   int hl=sprintf(hd,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n",bl);
   struct iovec{void*b;size_t l;};
   char*all=ob-hl; // header before body
   memcpy(all,hd,hl); write(fd,all,hl+bl);
  }}}
