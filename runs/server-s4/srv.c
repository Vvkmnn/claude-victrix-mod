// prototype: epoll single thread, GET /feed, /posts/:id, /health only
#include <sqlite3.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
static sqlite3*db;static sqlite3_stmt*sf,*sp;
static char out[65536];
static int jput(char*o,const unsigned char*s,int n){ // escape guard
 int k=0;for(int i=0;i<n;i++){unsigned char c=s[i];
  if(c=='"'||c=='\\'){o[k++]='\\';o[k++]=c;}else if(c<0x20){k+=sprintf(o+k,"\\u%04x",c);}else o[k++]=c;}return k;}
static int post(char*o,sqlite3_stmt*s){int k=sprintf(o,"{\"id\":%d,\"body\":\"",sqlite3_column_int(s,0));
 k+=jput(o+k,sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));
 k+=sprintf(o+k,"\",\"created_at\":\"%s\",\"author\":\"%s\",\"like_count\":%d}",sqlite3_column_text(s,2),sqlite3_column_text(s,3),sqlite3_column_int(s,4));return k;}
static int resp(char*buf,const char*status,const char*body,int bl){return sprintf(buf,"HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%.*s",status,bl,bl,body);}
int main(){
 sqlite3_open_v2(getenv("SQLITE_PATH"),&db,SQLITE_OPEN_READWRITE,0);
 sqlite3_exec(db,"PRAGMA mmap_size=1000000000;PRAGMA synchronous=NORMAL;",0,0,0);
 sqlite3_prepare_v2(db,"SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC,p.id DESC LIMIT 20",-1,&sf,0);
 sqlite3_prepare_v2(db,"SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?",-1,&sp,0);
 int ls=socket(AF_INET,SOCK_STREAM,0),one=1;setsockopt(ls,SOL_SOCKET,SO_REUSEADDR,&one,4);
 struct sockaddr_in a={AF_INET,htons(atoi(getenv("PORT"))),{htonl(INADDR_ANY)}};bind(ls,(void*)&a,sizeof a);listen(ls,4096);fcntl(ls,F_SETFL,O_NONBLOCK);
 int ep=epoll_create1(0);struct epoll_event ev={EPOLLIN,{.fd=ls}};epoll_ctl(ep,EPOLL_CTL_ADD,ls,&ev);
 static struct epoll_event evs[512];char rb[4096];static char ob[70000];
 for(;;){int n=epoll_wait(ep,evs,512,-1);
  for(int i=0;i<n;i++){int fd=evs[i].data.fd;
   if(fd==ls){for(;;){int c=accept4(ls,0,0,SOCK_NONBLOCK);if(c<0)break;setsockopt(c,IPPROTO_TCP,TCP_NODELAY,&one,4);struct epoll_event e={EPOLLIN,{.fd=c}};epoll_ctl(ep,EPOLL_CTL_ADD,c,&e);}continue;}
   int r=read(fd,rb,sizeof rb-1);if(r<=0){close(fd);continue;}rb[r]=0;
   int bl=0,ol;
   if(!strncmp(rb,"GET /feed ",10)){bl=sprintf(out,"{\"posts\":[");int f=1;while(sqlite3_step(sf)==SQLITE_ROW){if(!f)out[bl++]=',';f=0;bl+=post(out+bl,sf);}sqlite3_reset(sf);bl+=sprintf(out+bl,"]}");ol=resp(ob,"200 OK",out,bl);}
   else if(!strncmp(rb,"GET /posts/",11)){sqlite3_bind_int(sp,1,atoi(rb+11));if(sqlite3_step(sp)==SQLITE_ROW){bl=sprintf(out,"{\"post\":");bl+=post(out+bl,sp);out[bl++]='}';ol=resp(ob,"200 OK",out,bl);}else ol=resp(ob,"404 Not Found","{\"error\":\"post not found\"}",26);sqlite3_reset(sp);}
   else ol=resp(ob,"200 OK","{\"status\":\"ok\"}",15);
   write(fd,ob,ol);}}
}
