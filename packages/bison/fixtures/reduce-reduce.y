%define lr.type ielr
%token ID
%start start
%%
start: left | right ;
left: ID ;
right: ID ;
%%
