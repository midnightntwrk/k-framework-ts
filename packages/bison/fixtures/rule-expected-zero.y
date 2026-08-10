%define lr.type ielr
%token A

%%
start: A %expect 0 ;
