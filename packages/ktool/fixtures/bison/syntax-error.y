%define lr.type ielr
%token ID
%start start
%%
start: ID ;
this is not a bison rule
%%
